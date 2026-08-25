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

// TICKET-RT-036: simulate partial-TP1 + breakeven-stop candle-by-candle on the raw M15 path of the
// same 358 FVG trades confirmed in RT-033/RT-034 (minCandle2BodyRatio=0.7, targetRMultiple=1.5,
// minSlPctFloor=0.5%). Entry detection is duplicated verbatim from strategy1MeasureFvg.ts/
// measureMfeMae.ts (same detectFvg/checkNoTradeZone/classifyTrendH1/calculatePositionSize calls,
// same config imports) for the same reason as RT-034: findTrades()/Trade there aren't exported and
// don't carry entryIndex or the raw candle array needed to re-walk the path. No entry/exit condition
// differs from fvg.ts/fvgStrategyConfig.ts. This script proposes no TP1 level, %size, or buffer —
// it only measures the matrix asked for in the ticket.
//
// DEVIATION FROM TICKET TEXT (flagged to Vinh Tam, confirmed before running): the ticket says
// feeBuffer should come from "executionCostEngine" — no such module exists anywhere in apps/bot/src
// (checked via full src file listing). Confirmed with Vinh Tam to instead reuse FEE_PCT_SUM (0.2% =
// entry fee + entry slippage + exit fee + exit slippage, 0.05 each), the exact round-trip cost
// constant already used identically by every sibling script since RT-027 — not a new/guessed number.
// feeBufferPrice = entryPrice * (FEE_PCT_SUM / 100), i.e. the price distance whose fee cost on the
// remaining leg's notional equals FEE_PCT_SUM% of that notional (see cost formulas below).

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
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 1.5 — original TP2 level, unchanged
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: TARGET_R,
};

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as strategy1MeasureFvg.ts et al.
const FEE_ENTRY_SIDE = 0.1; // entry fee + entry slippage
const FEE_EXIT_SIDE = 0.1; // exit fee + exit slippage

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
  slPrice: number; // original invalidation price
  tpPrice: number; // original TP2 = 1.5R
  slDistance: number; // R, in price units
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
      void cachedZones; // kept only to mirror the identical upstream scan; not used in this ticket

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

// Same SL-before-TP touch priority as strategy1MeasureFvg.ts's scanOutcome(). tpPrice === null means
// "no TP cap" (used only for the uncapped-run measurement).
function scanTouch(
  m15All: Candle[],
  fromIndex: number,
  direction: Direction,
  slPrice: number,
  tpPrice: number | null,
): { outcome: Outcome; index: number } {
  for (let j = fromIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = tpPrice !== null && (direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice);
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'STILL_OPEN', index: m15All.length - 1 };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

type ClassLabel = 'FULL_LOSS' | 'FULL_WIN_UNCHANGED' | 'SAVED' | 'CUT_SHORT' | 'STILL_OPEN';

interface SimResult {
  pnl: number;
  isWin: boolean; // by realized PnL sign (decided trades only)
  isDecided: boolean;
  classLabel: ClassLabel;
}

// Core 2-phase partial-TP simulation for one trade under one (tp1R, pctClose) config.
function simulateTrade(m15All: Candle[], t: BaseTrade, tp1R: number, pctClose: number): SimResult {
  const tp1Price = t.direction === 'LONG' ? t.entryPrice + tp1R * t.slDistance : t.entryPrice - tp1R * t.slDistance;
  const feeBufferPrice = t.entryPrice * (FEE_PCT_SUM / 100);
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + feeBufferPrice : t.entryPrice - feeBufferPrice;

  // Phase 1: from entry, does price reach original SL or TP1 first?
  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, tp1Price);

  if (phase1.outcome === 'SL') {
    // Never reached TP1 — identical single-exit event as baseline. 2 fee legs (entry+exit), same as
    // strategy1MeasureFvg.ts's computePnl formula.
    const cost = (t.notional * FEE_PCT_SUM) / 100;
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.slPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'FULL_LOSS' };
  }

  if (phase1.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'STILL_OPEN' };
  }

  // TP1 hit: close pctClose% here, move remaining stop to breakeven+feeBuffer, keep watching for
  // original TP2 (1.5R) vs the new breakeven stop. 3 fee legs total: entry, TP1 partial exit, final exit.
  const qtyPartial = t.qty * (pctClose / 100);
  const qtyRemaining = t.qty - qtyPartial;
  const notionalEntry = t.notional;
  const notionalPartialExit = notionalEntry * (pctClose / 100);

  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);

  let finalExitPrice: number;
  let cutShort = false;
  let saved = false;

  if (phase2.outcome === 'TP') {
    finalExitPrice = t.tpPrice; // reached TP2 anyway — full win, just realized in two pieces
  } else if (phase2.outcome === 'SL') {
    finalExitPrice = breakevenSlPrice;
    if (t.baselineOutcome === 'TP') cutShort = true; // baseline would have run to TP2; this config stopped it
    else if (t.baselineOutcome === 'SL') saved = true; // baseline was a full loss; this config avoided it
  } else {
    // STILL_OPEN for the remainder after a partial fill — treat as undecided for PF/winRate, same as
    // baseline's STILL_OPEN handling (there are none in this dataset, kept for completeness).
    const partialPnl = qtyPartial * directedDelta(t.direction, t.entryPrice, tp1Price);
    const costSoFar = (notionalEntry * FEE_ENTRY_SIDE) / 100 + (notionalPartialExit * FEE_EXIT_SIDE) / 100;
    return { pnl: partialPnl - costSoFar, isWin: false, isDecided: false, classLabel: 'STILL_OPEN' };
  }

  const notionalFinalExit = qtyRemaining * finalExitPrice;
  const cost =
    (notionalEntry * FEE_ENTRY_SIDE) / 100 + (notionalPartialExit * FEE_EXIT_SIDE) / 100 + (notionalFinalExit * FEE_EXIT_SIDE) / 100;
  const pnl =
    qtyPartial * directedDelta(t.direction, t.entryPrice, tp1Price) + qtyRemaining * directedDelta(t.direction, t.entryPrice, finalExitPrice) - cost;

  const classLabel: ClassLabel = cutShort ? 'CUT_SHORT' : saved ? 'SAVED' : 'FULL_WIN_UNCHANGED';
  return { pnl, isWin: pnl > 0, isDecided: true, classLabel };
}

interface ConfigStats {
  n: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  cutShortCount: number;
  savedCount: number;
}

function summarizeConfig(results: SimResult[]): ConfigStats {
  const decided = results.filter((r) => r.isDecided);
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const r of decided) {
    pnl += r.pnl;
    if (r.pnl > 0) {
      wins++;
      grossProfit += r.pnl;
    } else if (r.pnl < 0) {
      losses++;
      grossLoss += Math.abs(r.pnl);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const cutShortCount = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
  const savedCount = results.filter((r) => r.classLabel === 'SAVED').length;
  return { n: decided.length, pnl, winRate, profitFactor, cutShortCount, savedCount };
}

function computeBaselinePnl(t: BaseTrade): number {
  if (t.baselineOutcome === 'STILL_OPEN') return 0;
  const cost = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.baselineOutcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
}

function summarizeBaseline(trades: BaseTrade[]): ConfigStats {
  const decided = trades.filter((t) => t.baselineOutcome !== 'STILL_OPEN');
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of decided) {
    const p = computeBaselinePnl(t);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += Math.abs(p);
    }
  }
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: decided.length, pnl, winRate, profitFactor, cutShortCount: 0, savedCount: 0 };
}

// Uncapped-run measurement (independent of the TP1/%size sweep): re-scan each trade's path with the
// ORIGINAL SL as the only stop (no TP cap at all — genuinely continuing past where baseline exits),
// tracking the true maximum favorable R reached until that SL is touched or the data ends. Reuses only
// the already-established original SL price; invents no new exit level ("TP3"), per RT-034/036's
// no-invented-threshold constraint — see final report for why a fixed TP3 price was not used.
function measureUncappedMaxR(m15All: Candle[], t: BaseTrade): number {
  let maxFavorable = 0;
  for (let j = t.entryIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const favorable = t.direction === 'LONG' ? candle.high - t.entryPrice : t.entryPrice - candle.low;
    if (favorable > maxFavorable) maxFavorable = favorable;
    const slTouched = t.direction === 'LONG' ? candle.low <= t.slPrice : candle.high >= t.slPrice;
    if (slTouched) break;
  }
  return maxFavorable / t.slDistance;
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct(count: number, total: number): string {
  return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : 'n/a';
}

function printConfigRow(label: string, s: ConfigStats): void {
  console.log(
    label.padEnd(16) +
      String(s.n).padEnd(6) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${s.winRate.toFixed(1)}%`.padEnd(10) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
      String(s.cutShortCount).padEnd(12) +
      String(s.savedCount),
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
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033/034)`);

  const baseline = summarizeBaseline(filled);
  console.log(
    `\nBASELINE (khong partial, full size, TP=${TARGET_R}R): n=${baseline.n}  PnL=$${baseline.pnl.toFixed(2)}  winRate=${baseline.winRate.toFixed(1)}%  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}  (doi chieu RT-033: $474.22, 61.5%, PF=1.54)`,
  );

  const TP1_LEVELS = [0.5, 0.7, 1.0];
  const PCT_CLOSE_LEVELS = [30, 50, 70];

  console.log('\n=== Ma tran partial-TP1 + breakeven-stop (feeBuffer = entryPrice * FEE_PCT_SUM%, 3 phi legs khi co partial) ===');
  console.log('config'.padEnd(16) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'cutShort'.padEnd(12) + 'saved');
  printConfigRow('BASELINE', baseline);

  for (const tp1R of TP1_LEVELS) {
    for (const pctClose of PCT_CLOSE_LEVELS) {
      const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t, tp1R, pctClose));
      const s = summarizeConfig(results);
      printConfigRow(`TP1=${tp1R}R,${pctClose}%`, s);
    }
  }

  console.log('\n=== Breakdown theo tung coin (mot config vi du: TP1=0.7R, dong 50%) ===');
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'cutShort'.padEnd(12) + 'saved');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const results = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t, 0.7, 50));
    const s = summarizeConfig(results);
    printConfigRow(symbol, s);
  }

  console.log('\n=== Chi tiet cutShort/saved cho tung config (ma tran day du) ===');
  for (const tp1R of TP1_LEVELS) {
    for (const pctClose of PCT_CLOSE_LEVELS) {
      console.log(`\n--- TP1=${tp1R}R, dong ${pctClose}% ---`);
      for (const symbol of symbols) {
        const symbolTrades = filled.filter((t) => t.symbol === symbol);
        const results = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t, tp1R, pctClose));
        const s = summarizeConfig(results);
        console.log(`  ${symbol.padEnd(10)} n=${s.n}  cutShort=${s.cutShortCount}  saved=${s.savedCount}`);
      }
    }
  }

  // Uncapped-run measurement — independent of the sweep above.
  console.log('\n=== Chay qua khoi 1.5R goc (uncapped, chi dung SL goc lam stop, khong dat TP3 gia dinh) ===');
  const uncappedR = filled.map((t) => measureUncappedMaxR(m15Map.get(t.symbol)!, t));
  const beyond15 = uncappedR.filter((r) => r > TARGET_R).length;
  console.log(
    `  n=${filled.length}  % co gia chay qua ${TARGET_R}R (uncapped MFE): ${pct(beyond15, filled.length)} (${beyond15}/${filled.length})`,
  );
  console.log(`  uncapped-R mean=${mean(uncappedR).toFixed(3)}R  median=${median(uncappedR).toFixed(3)}R`);
  for (const bucket of [2.0, 2.5, 3.0]) {
    const c = uncappedR.filter((r) => r >= bucket).length;
    console.log(`  % dat >= ${bucket}R: ${pct(c, filled.length)} (${c}/${filled.length})`);
  }

  console.log('\n=== Breakdown uncapped-run theo tung coin ===');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const rs = symbolTrades.map((t) => measureUncappedMaxR(m15Map.get(symbol)!, t));
    const c = rs.filter((r) => r > TARGET_R).length;
    console.log(`  ${symbol.padEnd(10)} n=${symbolTrades.length}  % qua ${TARGET_R}R: ${pct(c, symbolTrades.length)} (${c}/${symbolTrades.length})  mean=${mean(rs).toFixed(3)}R median=${median(rs).toFixed(3)}R`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
