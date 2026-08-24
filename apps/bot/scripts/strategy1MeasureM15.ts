import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import { calculateStructuralSlTp } from '../src/risk/structuralSlTp.js';
import type { Direction } from '../src/risk/structuralSlTp.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeStochastic, DEFAULT_STOCHASTIC_CONFIG } from '../src/indicators/stochastic.js';
import { computeFibZone } from '../src/indicators/fibonacci.js';

// TICKET-RT-026: EXPERIMENTAL VARIANT, NOT per the source doc (which specifies M5 for entry/SL/TP —
// see strategy1Measure.ts, left untouched). This is Vinh Tam's own idea test: does moving the
// entry/SL/TP decision timeframe from M5 to M15 shrink the fee-vs-SL% ratio that killed PF at M5
// (RT-023/024 — fee ~0.2% round-trip completely dominated M5's tiny structural SL%)? H1 trend/key
// zones and the Fibonacci pairing are UNCHANGED (still H1-based, timeframe-agnostic). Only the
// M5-specific pieces move to M15: entry signal candle, volume confirmation, calculateStructuralSlTp's
// input candles, Stochastic, and the decision cadence itself (checked at every M15 close, not M5).
//
// calculateStructuralSlTp()/computeStochastic()/detectPinBar()/detectEngulfing() are NOT modified —
// they're generic over Candle[], so passing m15Candles instead of m5Candles needs no code change
// there, only at the call site here (per ticket instruction).
//
// Thresholds kept IDENTICAL to RT-023/024/025 for a fair initial comparison (clusterToleranceAtrMultiplier,
// minTouches, volumeConfirmMultiplier, volumeLookback, minSlPctFloor, minNetRMultiple) — NONE of these
// were re-derived for M15. In particular minSlPctFloor=0.05% was picked in RT-023 from M5 SL%
// distributions; M15 structural SL% will likely run wider by construction (candles are 3x "heavier"),
// so this floor may end up doing nothing meaningful here. Re-measure for M15 specifically in a later
// ticket if this variant's results look promising enough to pursue — not done here per scope.

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth; // H1 key-zone swing width — unchanged from RT-023

const EMA_PERIOD_H1 = 200;
const KEY_ZONE_CONFIG = {
  swingPivotWidth: SWING_WIDTH,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};
const VOLUME_CONFIRM_MULTIPLIER = 1.5;
const VOLUME_LOOKBACK = 20;
const MIN_SL_PCT_FLOOR = 0.05;
const MIN_NET_R_MULTIPLE = 1.2;

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;

const BALANCE = 500;
const RISK_PCT = 0.01;
const RISK_USD = BALANCE * RISK_PCT;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return {
      openTime: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

function candlestickDirection(m15Window: Candle[]): Direction | null {
  const current = m15Window[m15Window.length - 1];
  const pinBar = detectPinBar(current);
  if (pinBar.isPinBar && pinBar.direction) return pinBar.direction;

  if (m15Window.length >= 2) {
    const prev = m15Window[m15Window.length - 2];
    const engulfing = detectEngulfing(prev, current);
    if (engulfing.isEngulfing && engulfing.direction) return engulfing.direction;
  }
  return null;
}

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

function scanOutcome(m15All: Candle[], entryIndex: number, direction: Direction, slPrice: number, tpPrice: number): Outcome {
  for (let j = entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return 'SL';
    if (tpTouched) return 'TP';
  }
  return 'STILL_OPEN';
}

interface Candidate {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  distanceAtr: number | null;
  touchCount: number | null;
  volumeRatio: number | null;
  slPctRaw: number | null;
  netRMultiple: number | null;
  qty: number | null;
  notional: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  outcome: Outcome | null;
  passesZone: boolean;
  passesVolume: boolean;
  passesSlFloor: boolean;
  passesNetR: boolean;
  stochCrossSignal: boolean;
  retracementPct: number | null;
  inFibZone: boolean;
}

async function findCandidates(symbol: string, dataDir: string, swingPivotWidthM15: number): Promise<Candidate[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const leverage = LEVERAGE[symbol];

  const candidates: Candidate[] = [];
  let h1Cursor = 0;

  let cachedH1Cursor = -1;
  let cachedTrend: 'UPTREND' | 'DOWNTREND' | null = null;
  let cachedAtrH1 = 0;
  let cachedZones: KeyZone[] = [];

  // Decision cadence: every M15 close (per ticket), not M5 — the outer loop is over m15All directly.
  for (let i = 0; i < m15All.length; i++) {
    const m15CloseTime = m15All[i].openTime + M15_MS;

    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m15CloseTime) h1Cursor++;
    if (h1Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, i + 1);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m15CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });
    if (ntz.blocked) continue;

    if (h1Cursor !== cachedH1Cursor) {
      cachedH1Cursor = h1Cursor;
      cachedTrend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
      const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
      cachedAtrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
      cachedZones = cachedAtrH1 > 0 ? findKeyZones(h1Window, cachedAtrH1, KEY_ZONE_CONFIG) : [];
    }
    if (cachedTrend === null || cachedAtrH1 <= 0) continue;

    const direction: Direction = cachedTrend === 'UPTREND' ? 'LONG' : 'SHORT';
    const zoneType = direction === 'LONG' ? 'support' : 'resistance';
    const relevantZones = cachedZones.filter((z) => z.type === zoneType);

    const m15Price = m15Window[m15Window.length - 1].close;

    const signalDir = candlestickDirection(m15Window);
    if (signalDir !== direction) continue;

    let nearestZone: KeyZone | null = null;
    let distanceAtr: number | null = null;
    if (relevantZones.length > 0) {
      nearestZone = relevantZones.reduce((closest, z) =>
        Math.abs(z.price - m15Price) < Math.abs(closest.price - m15Price) ? z : closest,
      );
      distanceAtr = Math.abs(m15Price - nearestZone.price) / cachedAtrH1;
    }

    const oppositeZoneType = zoneType === 'support' ? 'resistance' : 'support';
    const oppositeZones = cachedZones.filter((z) => z.type === oppositeZoneType);
    let retracementPct: number | null = null;
    let inFibZone = false;
    if (nearestZone && oppositeZones.length > 0) {
      const oppositeZone = oppositeZones.reduce((closest, z) =>
        Math.abs(z.price - m15Price) < Math.abs(closest.price - m15Price) ? z : closest,
      );
      const swingLowPrice = direction === 'LONG' ? nearestZone.price : oppositeZone.price;
      const swingHighPrice = direction === 'LONG' ? oppositeZone.price : nearestZone.price;
      const fib = computeFibZone(swingLowPrice, swingHighPrice, m15Price);
      if (!Number.isNaN(fib.retracementPct)) {
        retracementPct = fib.retracementPct;
        inFibZone = direction === 'LONG' ? fib.inDiscountZone : fib.inPremiumZone;
      }
    }

    const stochWindow = m15Window.slice(-(DEFAULT_STOCHASTIC_CONFIG.kPeriod + DEFAULT_STOCHASTIC_CONFIG.smoothK + DEFAULT_STOCHASTIC_CONFIG.dPeriod + 5));
    const { k: stochKArr, d: stochDArr } = computeStochastic(stochWindow, DEFAULT_STOCHASTIC_CONFIG);
    let stochCrossSignal = false;
    if (stochKArr.length >= 2 && stochDArr.length >= 2) {
      const currK = stochKArr[stochKArr.length - 1];
      const currD = stochDArr[stochDArr.length - 1];
      const prevK = stochKArr[stochKArr.length - 2];
      const prevD = stochDArr[stochDArr.length - 2];
      if (direction === 'LONG') {
        stochCrossSignal = prevK <= prevD && currK > currD && currK < 20;
      } else {
        stochCrossSignal = prevK >= prevD && currK < currD && currK > 80;
      }
    }

    const lookbackCandles = m15Window.slice(-1 - VOLUME_LOOKBACK, -1);
    const volumeRatio =
      lookbackCandles.length === VOLUME_LOOKBACK
        ? m15Window[m15Window.length - 1].volume / (lookbackCandles.reduce((s, c) => s + c.volume, 0) / VOLUME_LOOKBACK)
        : null;

    const entryPrice = m15Price;
    // m5Candles field reused for the M15 window — calculateStructuralSlTp is generic over Candle[],
    // no change to the function itself (per ticket instruction).
    const structuralRaw = calculateStructuralSlTp({
      direction,
      entryPrice,
      m5Candles: m15Window,
      swingPivotWidth: swingPivotWidthM15,
      minSlPctFloor: 0,
    });

    let slPctRaw: number | null = null;
    let netRMultiple: number | null = null;
    let qty: number | null = null;
    let notional: number | null = null;
    let outcome: Outcome | null = null;

    if (structuralRaw) {
      const slDistance = Math.abs(entryPrice - structuralRaw.slPrice);
      slPctRaw = (slDistance / entryPrice) * 100;
      const cost = (entryPrice * FEE_PCT_SUM) / 100;
      netRMultiple = (structuralRaw.rMultiple * slDistance - cost) / slDistance;

      const sizing = calculatePositionSize({
        balance: BALANCE,
        riskUsd: RISK_USD,
        entryPrice,
        slPrice: structuralRaw.slPrice,
        leverage,
        maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
      });
      if (sizing) {
        qty = sizing.qty;
        notional = sizing.notional;
        outcome = scanOutcome(m15All, i, direction, structuralRaw.slPrice, structuralRaw.tpPrice);
      }
    }

    candidates.push({
      symbol,
      direction,
      entryPrice,
      distanceAtr,
      touchCount: nearestZone?.touchCount ?? null,
      volumeRatio,
      slPctRaw,
      netRMultiple,
      qty,
      notional,
      slPrice: structuralRaw?.slPrice ?? null,
      tpPrice: structuralRaw?.tpPrice ?? null,
      outcome,
      passesZone: distanceAtr !== null && distanceAtr <= KEY_ZONE_CONFIG.clusterToleranceAtrMultiplier,
      passesVolume: volumeRatio !== null && volumeRatio >= VOLUME_CONFIRM_MULTIPLIER,
      passesSlFloor: slPctRaw !== null && slPctRaw >= MIN_SL_PCT_FLOOR,
      passesNetR: netRMultiple !== null && netRMultiple >= MIN_NET_R_MULTIPLE,
      stochCrossSignal,
      retracementPct,
      inFibZone,
    });
  }

  return candidates;
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function computePnl(c: Candidate): number {
  if (!c.qty || !c.notional || !c.slPrice || !c.tpPrice || !c.outcome || c.outcome === 'STILL_OPEN') return 0;
  const costDollars = (c.notional * FEE_PCT_SUM) / 100;
  const exitPrice = c.outcome === 'TP' ? c.tpPrice : c.slPrice;
  return c.qty * directedDelta(c.direction, c.entryPrice, exitPrice) - costDollars;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function printDistribution(label: string, values: number[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: n=0`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${sorted.length}  p25=${percentile(sorted, 0.25).toFixed(3)}  median=${percentile(sorted, 0.5).toFixed(3)}  p75=${percentile(sorted, 0.75).toFixed(3)}  min=${sorted[0].toFixed(3)}  max=${sorted[sorted.length - 1].toFixed(3)}`,
  );
}

function summarizeOutcome(label: string, candidates: Candidate[], spanDays: number, symbolCount: number): void {
  const n = candidates.length;
  const tp = candidates.filter((c) => c.outcome === 'TP').length;
  const sl = candidates.filter((c) => c.outcome === 'SL').length;
  const open = candidates.filter((c) => c.outcome === 'STILL_OPEN').length;

  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const c of candidates) {
    if (c.outcome === 'STILL_OPEN' || c.outcome === null) continue;
    const p = computePnl(c);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += Math.abs(p);
    }
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const tradesPerDayPerCoin = spanDays > 0 ? n / spanDays / symbolCount : 0;

  console.log(`\n=== ${label} ===`);
  console.log(`  n=${n}  (${tradesPerDayPerCoin.toFixed(3)} lenh/ngay/coin, ${spanDays.toFixed(1)} ngay x ${symbolCount} coin)`);
  console.log(`  TP: ${tp} (${n > 0 ? ((tp / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  SL: ${sl} (${n > 0 ? ((sl / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  STILL_OPEN: ${open} (${n > 0 ? ((open / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(
    `  PnL=$${pnl.toFixed(2)}  winRate=${winRate.toFixed(1)}%  PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}  wins=${wins}  losses=${losses}`,
  );
}

const SWING_WIDTH_M15_SWEEP = [2, 3, 5, 8];

interface SweepResult {
  width: number;
  candidates: Candidate[];
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  const firstM15 = await readCsv(path.join(dataDir, `${symbols[0]}_15m.csv`));
  const spanDays = (firstM15[firstM15.length - 1].openTime - firstM15[0].openTime) / (24 * 60 * 60 * 1000);

  const results: SweepResult[] = [];
  for (const width of SWING_WIDTH_M15_SWEEP) {
    console.log(`\n########## swingPivotWidthM15 = ${width} ##########`);
    let allCandidates: Candidate[] = [];
    for (const symbol of symbols) {
      const candidates = await findCandidates(symbol, dataDir, width);
      console.log(`  ${symbol}: ${candidates.length} raw signals`);
      allCandidates = allCandidates.concat(candidates);
    }
    console.log(`  Total raw candidates: ${allCandidates.length}`);

    console.log('\n  --- Phan phoi (tat ca candidate, chua loc) ---');
    printDistribution('  SL% (structural, chua ap floor)', allCandidates.filter((c) => c.slPctRaw !== null).map((c) => c.slPctRaw as number));
    printDistribution('  netRMultiple (chua ap san)', allCandidates.filter((c) => c.netRMultiple !== null).map((c) => c.netRMultiple as number));

    const noStructural = allCandidates.filter((c) => c.slPrice === null).length;
    console.log(`  Khong tinh duoc structural SL/TP: ${noStructural}/${allCandidates.length}`);

    summarizeOutcome(`  width=${width}: TAT CA candidate (khong loc gi)`, allCandidates.filter((c) => c.outcome !== null), spanDays, symbols.length);

    const filtered = allCandidates.filter((c) => c.passesZone && c.passesVolume && c.passesSlFloor && c.passesNetR && c.outcome !== null);
    summarizeOutcome(
      `  width=${width}: SAU KHI loc du 4 dieu kien (minSlPctFloor=${MIN_SL_PCT_FLOOR}, minNetRMultiple=${MIN_NET_R_MULTIPLE}, khong doi tu RT-023/024/025)`,
      filtered,
      spanDays,
      symbols.length,
    );

    results.push({ width, candidates: allCandidates });
  }

  console.log('\n\n=== SO SANH TONG HOP M15 (sau khi loc du 4 dieu kien) ===\n');
  console.log(`Doi chieu M5 tot nhat (RT-024, width=20): n=40, ${spanDays.toFixed(1)} ngay x 5 coin ~= 0.09 lenh/ngay/coin, PnL=-$198.63, winRate=12.5%, PF=0.17\n`);
  console.log('width'.padEnd(8) + 'n'.padEnd(6) + 'lenh/ngay/coin'.padEnd(16) + 'TP%'.padEnd(8) + 'SL%'.padEnd(8) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF');
  for (const { width, candidates } of results) {
    const filtered = candidates.filter((c) => c.passesZone && c.passesVolume && c.passesSlFloor && c.passesNetR && c.outcome !== null);
    const n = filtered.length;
    const tp = filtered.filter((c) => c.outcome === 'TP').length;
    const sl = filtered.filter((c) => c.outcome === 'SL').length;
    let pnl = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const c of filtered) {
      const p = computePnl(c);
      pnl += p;
      if (p > 0) {
        wins++;
        grossProfit += p;
      } else if (p < 0) {
        losses++;
        grossLoss += Math.abs(p);
      }
    }
    const decided = wins + losses;
    const winRate = decided > 0 ? (wins / decided) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const tradesPerDayPerCoin = spanDays > 0 ? n / spanDays / symbols.length : 0;
    console.log(
      String(width).padEnd(8) +
        String(n).padEnd(6) +
        tradesPerDayPerCoin.toFixed(3).padEnd(16) +
        `${n > 0 ? ((tp / n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `${n > 0 ? ((sl / n) * 100).toFixed(0) : '0'}%`.padEnd(8) +
        `$${pnl.toFixed(2)}`.padEnd(14) +
        `${winRate.toFixed(1)}%`.padEnd(10) +
        `${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
