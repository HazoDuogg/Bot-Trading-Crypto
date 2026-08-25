import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';

// TICKET-RT-037: simulate a 3-tier exit (TP1 40% / TP2 30% / TP3 30%) with SL-by-tier and full
// per-leg fees, on the raw M15 path of the same 358 FVG trades used since RT-032/033/034/036. Entry
// detection is duplicated verbatim from those scripts (same detectFvg/checkNoTradeZone/
// classifyTrendH1/calculatePositionSize/config imports) — findTrades()/Trade in
// strategy1MeasureFvg.ts aren't exported and don't carry entryIndex/raw path, same reason as RT-034/
// RT-036. fvg.ts/fvgStrategyConfig.ts are untouched; no entry logic differs.
//
// feeBuffer = entryPrice * FEE_PCT_SUM% (0.2%), confirmed with Vinh Tam in RT-036 — no
// executionCostEngine module exists in this codebase (checked again here; still absent).
//
// STEP 0 (required before any TP2/TP3 number is chosen, per ticket): full percentile distribution of
// MFE (R-multiple, capped at the trade's actual TP/SL touch — same definition as RT-034's
// measureMfeMae.ts), split by baseline outcome. Recomputed here directly from the raw candle path
// (not read from RT-034's CSV) so this script is self-contained and reproducible from a fresh pull.
//
// TP3 = 2.3R, chosen as Step 0's p75 of the winning (TP) group — cross-checked against RT-036's
// independently-computed *uncapped* run median (2.33R): two different measurement methods landing on
// almost the same number. p75 is reachable (25% of past winners already got there or further) without
// reaching into the thin p90 tail (2.85R). This is ONE test config, not a chosen final level — see
// ticket's "Khong lam" section.

const FVG_KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const EMA_PERIOD_H1 = 200;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 1.5 — TP2 level, unchanged
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles; // 20, reused as the TP3-watch cap per ticket
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: MAX_WAIT_CANDLES,
  targetRMultiple: TARGET_R,
};

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027
const FEE_ENTRY_SIDE = 0.1;
const FEE_EXIT_SIDE = 0.1;

// This ticket's one test configuration (NOT chosen as final — see "Khong lam"):
const TP1_R = 1.0;
const TP1_PCT = 40;
const TP2_R = TARGET_R; // 1.5
const TP2_PCT = 30;
const TP3_R = 2.3; // Step 0 p75 of thang group, see header comment
const TP3_PCT = 30;

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

type Outcome = 'TP' | 'SL' | 'STILL_OPEN';

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
}

interface BaseTrade {
  symbol: string;
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number; // original TP = 1.5R
  slDistance: number;
  qty: number;
  notional: number;
  baselineOutcome: Outcome;
}

async function findBaseTrades(symbol: string, dataDir: string, m15AllOut: Map<string, Candle[]>): Promise<BaseTrade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  m15AllOut.set(symbol, m15All);
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  const trades: BaseTrade[] = [];
  let pending: PendingFvg | null = null;

  let cachedH1Cursor = -1;
  let cachedZones: KeyZone[] = [];

  for (let i = 2; i < m15All.length; i++) {
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

    if (pending) {
      pending.waitCount++;
      const candle = m15All[i];
      const touchedGap = candle.low <= pending.gapHigh && candle.high >= pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const entryPrice = pending.direction === 'LONG' ? pending.gapLow : pending.gapHigh;
        const slPrice = pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);

        if (slDistance > 0) {
          const tpPrice =
            pending.direction === 'LONG' ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const baselineOutcome = scanTouch(m15All, i, pending.direction, slPrice, tpPrice).outcome;
            trades.push({
              symbol,
              direction: pending.direction,
              entryIndex: i,
              entryPrice,
              slPrice,
              tpPrice,
              slDistance,
              qty: sizing.qty,
              notional: sizing.notional,
              baselineOutcome,
            });
          }
        }
        pending = null;
      } else if (pending.waitCount >= SWEEP_CONFIG.maxWaitCandles) {
        pending = null;
      }
    }

    if (ntz.blocked) continue;

    const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
    if (trend === null) continue;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: SWEEP_CONFIG.minCandle2BodyRatio });
    if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
      if (h1Cursor !== cachedH1Cursor) {
        cachedH1Cursor = h1Cursor;
        const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
        cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
      }
      void cachedZones;

      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        waitCount: 0,
      };
    }
  }

  return trades;
}

function scanTouch(m15All: Candle[], fromIndex: number, direction: Direction, slPrice: number, tpPrice: number | null): { outcome: Outcome; index: number } {
  for (let j = fromIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = tpPrice !== null && (direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice);
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'STILL_OPEN', index: m15All.length - 1 };
}

// Same as scanTouch but bounded to at most maxCandles candles from fromIndex — used only for the
// TP3-watch phase, per the ticket's explicit "trong maxWaitCandles hien tai" timeout clause.
function scanTouchBounded(
  m15All: Candle[],
  fromIndex: number,
  direction: Direction,
  slPrice: number,
  tpPrice: number,
  maxCandles: number,
): { outcome: Outcome | 'TIMEOUT'; index: number } {
  const limit = Math.min(m15All.length - 1, fromIndex + maxCandles);
  for (let j = fromIndex + 1; j <= limit; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'TIMEOUT', index: limit };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

// Number of tiers actually filled at their target price (0..3). A timeout-close or an SL-stop after
// TP2 both still count as "2 tang" (TP3 itself was never hit) — TP3-hit is the only way to reach 3.
type TierCount = 0 | 1 | 2 | 3;

interface SimResult {
  pnl: number;
  isWin: boolean;
  isDecided: boolean;
  tiers: TierCount;
  cutShortLikeRt036: boolean; // baseline was TP (>=1.5R) but this config stopped at breakeven after TP1 only
}

function simulateTrade(m15All: Candle[], t: BaseTrade): SimResult {
  const tp1Price = t.direction === 'LONG' ? t.entryPrice + TP1_R * t.slDistance : t.entryPrice - TP1_R * t.slDistance;
  const tp2Price = t.tpPrice; // 1.5R, already computed at entry time
  const tp3Price = t.direction === 'LONG' ? t.entryPrice + TP3_R * t.slDistance : t.entryPrice - TP3_R * t.slDistance;
  const feeBufferPrice = t.entryPrice * (FEE_PCT_SUM / 100);
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + feeBufferPrice : t.entryPrice - feeBufferPrice;

  const notionalFull = t.notional;
  const qtyTp1 = t.qty * (TP1_PCT / 100);
  const qtyTp2 = t.qty * (TP2_PCT / 100);
  const qtyTp3 = t.qty - qtyTp1 - qtyTp2; // remaining 30%, avoids float-sum drift

  // Phase 1: entry -> original SL or TP1
  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, tp1Price);

  if (phase1.outcome === 'SL') {
    const cost = (notionalFull * FEE_PCT_SUM) / 100;
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.slPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, tiers: 0, cutShortLikeRt036: false };
  }
  if (phase1.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, tiers: 0, cutShortLikeRt036: false };
  }

  // TP1 hit: close 40% here, move remaining 60% stop to breakeven+feeBuffer.
  const pnlTp1Leg = qtyTp1 * directedDelta(t.direction, t.entryPrice, tp1Price);
  const notionalTp1Exit = qtyTp1 * tp1Price;

  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, tp2Price);

  if (phase2.outcome === 'SL') {
    const notionalFinalExit = (t.qty - qtyTp1) * breakevenSlPrice;
    const cost = (notionalFull * FEE_ENTRY_SIDE) / 100 + (notionalTp1Exit * FEE_EXIT_SIDE) / 100 + (notionalFinalExit * FEE_EXIT_SIDE) / 100;
    const pnlRemainder = (t.qty - qtyTp1) * directedDelta(t.direction, t.entryPrice, breakevenSlPrice);
    const pnl = pnlTp1Leg + pnlRemainder - cost;
    const cutShort = t.baselineOutcome === 'TP';
    return { pnl, isWin: pnl > 0, isDecided: true, tiers: 1, cutShortLikeRt036: cutShort };
  }
  if (phase2.outcome === 'STILL_OPEN') {
    const cost = (notionalFull * FEE_ENTRY_SIDE) / 100 + (notionalTp1Exit * FEE_EXIT_SIDE) / 100;
    return { pnl: pnlTp1Leg - cost, isWin: false, isDecided: false, tiers: 1, cutShortLikeRt036: false };
  }

  // TP2 hit: close 30% here (cumulative 70%), move remaining 30% stop up to TP1 level (never below it).
  const pnlTp2Leg = qtyTp2 * directedDelta(t.direction, t.entryPrice, tp2Price);
  const notionalTp2Exit = qtyTp2 * tp2Price;
  const newStopPrice = tp1Price;

  const phase3 = scanTouchBounded(m15All, phase2.index, t.direction, newStopPrice, tp3Price, MAX_WAIT_CANDLES);

  let finalExitPrice: number;
  let tiers: TierCount;
  if (phase3.outcome === 'TP') {
    finalExitPrice = tp3Price;
    tiers = 3;
  } else if (phase3.outcome === 'SL') {
    finalExitPrice = newStopPrice;
    tiers = 2;
  } else {
    // TIMEOUT: close remaining 30% at the close price of the last candle in the bounded window.
    finalExitPrice = m15All[phase3.index].close;
    tiers = 2;
  }

  const notionalFinalExit = qtyTp3 * finalExitPrice;
  const cost =
    (notionalFull * FEE_ENTRY_SIDE) / 100 +
    (notionalTp1Exit * FEE_EXIT_SIDE) / 100 +
    (notionalTp2Exit * FEE_EXIT_SIDE) / 100 +
    (notionalFinalExit * FEE_EXIT_SIDE) / 100;
  const pnlFinalLeg = qtyTp3 * directedDelta(t.direction, t.entryPrice, finalExitPrice);
  const pnl = pnlTp1Leg + pnlTp2Leg + pnlFinalLeg - cost;

  return { pnl, isWin: pnl > 0, isDecided: true, tiers, cutShortLikeRt036: false };
}

interface Stats {
  n: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(results: SimResult[]): Stats {
  const decided = results.filter((r) => r.isDecided);
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of decided) {
    pnl += r.pnl;
    if (r.pnl > 0) {
      wins++;
      grossProfit += r.pnl;
    } else if (r.pnl < 0) {
      grossLoss += Math.abs(r.pnl);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: decided.length, pnl, winRate, profitFactor };
}

function computeBaselinePnl(t: BaseTrade): number {
  if (t.baselineOutcome === 'STILL_OPEN') return 0;
  const cost = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.baselineOutcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
}

function summarizeBaseline(trades: BaseTrade[]): Stats {
  const decided = trades.filter((t) => t.baselineOutcome !== 'STILL_OPEN');
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of decided) {
    const p = computeBaselinePnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: decided.length, pnl, winRate, profitFactor };
}

function printStatsRow(label: string, s: Stats): void {
  console.log(
    label.padEnd(14) + String(s.n).padEnd(6) + `$${s.pnl.toFixed(2)}`.padEnd(14) + `${s.winRate.toFixed(1)}%`.padEnd(10) + `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`,
  );
}

// Step 0: capped MFE (bounded at the trade's own TP/SL touch, same definition as RT-034), recomputed
// here from the raw candle path (not read from RT-034's CSV) so this script stands alone.
function measureCappedMfeR(m15All: Candle[], t: BaseTrade): number {
  let maxFavorable = 0;
  for (let j = t.entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const favorable = t.direction === 'LONG' ? candle.high - t.entryPrice : t.entryPrice - candle.low;
    if (favorable > maxFavorable) maxFavorable = favorable;
    const slTouched = t.direction === 'LONG' ? candle.low <= t.slPrice : candle.high >= t.slPrice;
    const tpTouched = t.direction === 'LONG' ? candle.high >= t.tpPrice : candle.low <= t.tpPrice;
    if (slTouched || tpTouched) break;
  }
  return maxFavorable / t.slDistance;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function printPercentileRow(label: string, values: number[]): void {
  const s = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}: n=${s.length}  p10=${percentile(s, 0.1).toFixed(3)}  p25=${percentile(s, 0.25).toFixed(3)}  p50=${percentile(s, 0.5).toFixed(3)}  ` +
      `p75=${percentile(s, 0.75).toFixed(3)}  p90=${percentile(s, 0.9).toFixed(3)}  p95=${percentile(s, 0.95).toFixed(3)}  max=${s[s.length - 1].toFixed(3)}`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const m15Map = new Map<string, Candle[]>();

  let allTrades: BaseTrade[] = [];
  for (const symbol of symbols) {
    const trades = await findBaseTrades(symbol, dataDir, m15Map);
    allTrades = allTrades.concat(trades);
  }

  const filled = allTrades.filter((t) => (t.slDistance / t.entryPrice) * 100 >= FLOOR_PCT);
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033/034/036)`);

  const baseline = summarizeBaseline(filled);
  console.log(
    `\nBASELINE (full TP=${TARGET_R}R, khong tiered): n=${baseline.n}  PnL=$${baseline.pnl.toFixed(2)}  winRate=${baseline.winRate.toFixed(1)}%  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}  (doi chieu RT-033: $474.22, 61.5%, PF=1.54)`,
  );

  console.log('\n=== BUOC 0: Phan phoi percentile day du cua MFE (R, capped tai TP/SL cua chinh lenh), tach thang/thua ===');
  const cappedMfe = filled.map((t) => ({ outcome: t.baselineOutcome, mfe: measureCappedMfeR(m15Map.get(t.symbol)!, t) }));
  printPercentileRow('TP (thang)', cappedMfe.filter((r) => r.outcome === 'TP').map((r) => r.mfe));
  printPercentileRow('SL (thua) ', cappedMfe.filter((r) => r.outcome === 'SL').map((r) => r.mfe));
  console.log(`  -> TP3 = ${TP3_R}R (p75 cua nhom thang, doi chieu RT-036 uncapped median=2.332R)`);

  console.log(`\n=== Mo phong 3 tang: TP1=${TP1_R}R/${TP1_PCT}%, TP2=${TP2_R}R/${TP2_PCT}%, TP3=${TP3_R}R/${TP3_PCT}% ===`);
  const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t));
  const tiered = summarize(results);
  console.log('config'.padEnd(14) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF');
  printStatsRow('BASELINE', baseline);
  printStatsRow('TIERED', tiered);

  console.log('\n=== Breakdown so tang an duoc ===');
  const tierCounts = [0, 1, 2, 3].map((tier) => results.filter((r) => r.tiers === tier).length);
  console.log(`  Full SL tu dau (0 tang):        ${tierCounts[0]}`);
  console.log(`  Chi 1 tang (TP1 roi breakeven): ${tierCounts[1]}`);
  console.log(`  2 tang (TP1+TP2, khong toi TP3):${tierCounts[2]}`);
  console.log(`  Du ca 3 tang (TP1+TP2+TP3):     ${tierCounts[3]}`);
  const stillOpenCount = results.filter((r) => !r.isDecided).length;
  if (stillOpenCount > 0) console.log(`  STILL_OPEN (chua co outcome cuoi): ${stillOpenCount}`);

  const cutShortCount = results.filter((r) => r.cutShortLikeRt036).length;
  console.log(
    `\n=== "Cat non" kieu RT-036 o muc TP1=${TP1_R}R: lenh dang le toi TP2=1.5R nhung bi da ve breakeven-buffer o tang duoi ===`,
  );
  console.log(`  n=${cutShortCount} / ${filled.filter((t) => t.baselineOutcome === 'TP').length} lenh THANG goc (baseline TP)`);

  console.log('\n=== Breakdown theo tung coin ===');
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + '0tang'.padEnd(7) + '1tang'.padEnd(7) + '2tang'.padEnd(7) + '3tang'.padEnd(7) + 'cutShort');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const symbolResults = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t));
    const s = summarize(symbolResults);
    const tc = [0, 1, 2, 3].map((tier) => symbolResults.filter((r) => r.tiers === tier).length);
    const cs = symbolResults.filter((r) => r.cutShortLikeRt036).length;
    console.log(
      symbol.padEnd(12) +
        String(s.n).padEnd(6) +
        `$${s.pnl.toFixed(2)}`.padEnd(14) +
        `${s.winRate.toFixed(1)}%`.padEnd(10) +
        `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
        String(tc[0]).padEnd(7) +
        String(tc[1]).padEnd(7) +
        String(tc[2]).padEnd(7) +
        String(tc[3]).padEnd(7) +
        String(cs),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
