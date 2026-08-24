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

// TICKET-RT-023: measures "Chien luoc 1" (H1 trend + H1 key zones + M5 Pin Bar/Engulfing + M5
// structural SL/TP + volume confirm + net R:R floor) end to end on real data. Does NOT touch
// noTradeZone/* or positionSizing/* (used as-is). No partial TP — single TP per the source doc.
//
// EVERY TODO_CONFIRM below is a placeholder, not a backtest-chosen number — see the printed
// distributions at the end of this run for the raw data to actually pick them from. Values chosen
// here are documented with their (non-empirical) rationale, per ticket instruction not to silently
// "just pick a number":
//   EMA_PERIOD_H1 = 200            — spec-named ("EMA200"), not a free parameter.
//   clusterToleranceAtrMultiplier = 0.5  — starting guess for clustering H1 swings into H1 zones,
//     same order of magnitude as the ORIGINAL (pre-RT-020-correction) pullback-zone default. Unlike
//     that bug, this compares H1-swing-price gaps against H1's OWN ATR (matching timeframe/scale),
//     so it doesn't carry RT-019's cross-timeframe mismatch — but it's still just a guess.
//   minTouches = 2                 — ticket's own stated placeholder.
//   maxZoneAgeCandles = 500        — ~3 weeks of H1 candles (500/24≈21 days); arbitrary "recent
//     enough to still matter" guess, no data basis yet.
//   zone-proximity ("M5 price is AT the zone") reuses clusterToleranceAtrMultiplier × atrH1 — the
//     ticket gives no separate field for this, and a zone's own definition is already "prices within
//     that same H1-ATR tolerance band", so testing current price against the same band is the
//     natural extension of that definition rather than inventing an unrelated third tolerance.
//   volumeConfirmMultiplier = 1.5, volumeLookback = 20  — same values already used for
//     DEFAULT_BREAKOUT_CONFIG in RT-021, reused as a starting point for M5 signal-candle volume.
//   minSlPctFloor = 0.05 (%)       — rough guess near the low end of SL% distributions measured in
//     earlier tickets (RT-006/RT-020) for M5-structural stops; needs its own recheck under this
//     strategy's specific SL logic (nearest-by-price, not most-recent-chronologically).
//   minNetRMultiple = 1.2          — reused from every prior R:R floor in this project's history
//     (RT-006 onward), well precedented, not re-derived here.
//   fee: entryFeePct=entrySlippagePct=exitFeePct=exitSlippagePct=0.05 — reconstructs the old
//     TAKER_ONLY_FEE_CONFIG's numbers locally (single entry + single exit leg, no partial split).

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;

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

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // entry fee + entry slippage + exit fee + exit slippage, once each

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

function candlestickDirection(m5Window: Candle[]): Direction | null {
  const current = m5Window[m5Window.length - 1];
  const pinBar = detectPinBar(current);
  if (pinBar.isPinBar && pinBar.direction) return pinBar.direction;

  if (m5Window.length >= 2) {
    const prev = m5Window[m5Window.length - 2];
    const engulfing = detectEngulfing(prev, current);
    if (engulfing.isEngulfing && engulfing.direction) return engulfing.direction;
  }
  return null;
}

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

function scanOutcome(m5All: Candle[], entryIndex: number, direction: Direction, slPrice: number, tpPrice: number): Outcome {
  for (let j = entryIndex + 1; j < m5All.length; j++) {
    const candle = m5All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return 'SL'; // SL-first on same-candle tie, established convention
    if (tpTouched) return 'TP';
  }
  return 'STILL_OPEN';
}

interface Candidate {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  distanceAtr: number | null; // null = no zone of the needed type existed at all
  touchCount: number | null;
  volumeRatio: number | null;
  slPctRaw: number | null; // from structuralSlTp with floor=0, for distribution purposes
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
}

async function findCandidates(symbol: string, dataDir: string): Promise<Candidate[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));
  const leverage = LEVERAGE[symbol];

  const candidates: Candidate[] = [];
  let h1Cursor = 0;
  let m15Cursor = 0;

  let cachedH1Cursor = -1;
  let cachedTrend: 'UPTREND' | 'DOWNTREND' | null = null;
  let cachedAtrH1 = 0;
  let cachedZones: KeyZone[] = [];

  for (let i = 0; i < m5All.length; i++) {
    const m5CloseTime = m5All[i].openTime + M5_MS;

    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m5CloseTime) h1Cursor++;
    while (m15Cursor < m15All.length && m15All[m15Cursor].openTime + M15_MS <= m5CloseTime) m15Cursor++;
    if (h1Cursor === 0 || m15Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, m15Cursor);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m5CloseTime,
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

    const m5Window = m5All.slice(0, i + 1);
    const m5Price = m5Window[m5Window.length - 1].close;

    const signalDir = candlestickDirection(m5Window);
    if (signalDir !== direction) continue;

    let nearestZone: KeyZone | null = null;
    let distanceAtr: number | null = null;
    if (relevantZones.length > 0) {
      nearestZone = relevantZones.reduce((closest, z) =>
        Math.abs(z.price - m5Price) < Math.abs(closest.price - m5Price) ? z : closest,
      );
      distanceAtr = Math.abs(m5Price - nearestZone.price) / cachedAtrH1;
    }

    const lookbackCandles = m5Window.slice(-1 - VOLUME_LOOKBACK, -1);
    const volumeRatio =
      lookbackCandles.length === VOLUME_LOOKBACK
        ? m5Window[m5Window.length - 1].volume / (lookbackCandles.reduce((s, c) => s + c.volume, 0) / VOLUME_LOOKBACK)
        : null;

    const entryPrice = m5Price;
    const structuralRaw = calculateStructuralSlTp({
      direction,
      entryPrice,
      m5Candles: m5Window,
      swingPivotWidth: SWING_WIDTH,
      minSlPctFloor: 0, // no floor here — floor applied as a separate boolean below, for distribution purposes
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
        outcome = scanOutcome(m5All, i, direction, structuralRaw.slPrice, structuralRaw.tpPrice);
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
    });
  }

  return candidates;
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function computePnl(c: Candidate): number {
  if (!c.qty || !c.notional || !c.slPrice || !c.tpPrice || !c.outcome || c.outcome === 'STILL_OPEN') return 0;
  // Fee is charged on notional (qty*entryPrice), not on a single unit of price — must scale by qty
  // to get a dollar cost, same as every other script in this project's PnL formulas.
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

function summarizeOutcome(label: string, candidates: Candidate[]): void {
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

  console.log(`\n=== ${label} ===`);
  console.log(`  n=${n}`);
  console.log(`  TP: ${tp} (${n > 0 ? ((tp / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  SL: ${sl} (${n > 0 ? ((sl / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  STILL_OPEN: ${open} (${n > 0 ? ((open / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(
    `  PnL=$${pnl.toFixed(2)}  winRate=${winRate.toFixed(1)}%  PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}  wins=${wins}  losses=${losses}`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allCandidates: Candidate[] = [];
  for (const symbol of symbols) {
    console.log(`Processing ${symbol}...`);
    const candidates = await findCandidates(symbol, dataDir);
    console.log(`  ${candidates.length} raw Pin Bar/Engulfing signals in trend direction (before zone/volume/SL-floor/R:R filters)`);
    allCandidates = allCandidates.concat(candidates);
  }
  console.log(`\nTotal raw candidates: ${allCandidates.length}\n`);

  console.log('=== Phan phoi cho tung TODO_CONFIRM (tat ca candidate, chua loc) ===\n');
  printDistribution('distanceAtr (ATR H1) toi vung H1 gan nhat', allCandidates.filter((c) => c.distanceAtr !== null).map((c) => c.distanceAtr as number));
  printDistribution('touchCount cua vung duoc dung', allCandidates.filter((c) => c.touchCount !== null).map((c) => c.touchCount as number));
  printDistribution('volumeRatio (nen tin hieu M5)', allCandidates.filter((c) => c.volumeRatio !== null).map((c) => c.volumeRatio as number));
  printDistribution('SL% (structural, chua ap floor)', allCandidates.filter((c) => c.slPctRaw !== null).map((c) => c.slPctRaw as number));
  printDistribution('netRMultiple (chua ap san)', allCandidates.filter((c) => c.netRMultiple !== null).map((c) => c.netRMultiple as number));

  const noZone = allCandidates.filter((c) => c.distanceAtr === null).length;
  const noStructural = allCandidates.filter((c) => c.slPrice === null).length;
  console.log(`\n  Khong co vung H1 phu hop: ${noZone}/${allCandidates.length}`);
  console.log(`  Khong tinh duoc structural SL/TP (thieu swing M5 phu hop): ${noStructural}/${allCandidates.length}`);

  summarizeOutcome('TAT CA candidate (khong loc gi, chi can co outcome)', allCandidates.filter((c) => c.outcome !== null));

  const filtered = allCandidates.filter((c) => c.passesZone && c.passesVolume && c.passesSlFloor && c.passesNetR && c.outcome !== null);
  summarizeOutcome('SAU KHI loc du 4 dieu kien (zone + volume + SL floor + net R:R, dung placeholder TODO_CONFIRM o tren)', filtered);

  console.log('\n=== Breakdown loc rieng tung dieu kien (tren tap co outcome) ===');
  const withOutcome = allCandidates.filter((c) => c.outcome !== null);
  console.log(`  passesZone: ${withOutcome.filter((c) => c.passesZone).length}/${withOutcome.length}`);
  console.log(`  passesVolume: ${withOutcome.filter((c) => c.passesVolume).length}/${withOutcome.length}`);
  console.log(`  passesSlFloor: ${withOutcome.filter((c) => c.passesSlFloor).length}/${withOutcome.length}`);
  console.log(`  passesNetR: ${withOutcome.filter((c) => c.passesNetR).length}/${withOutcome.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
