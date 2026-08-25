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

// TICKET-RT-038: breakeven-ONLY, no partial size — full 100% size runs the whole trade, the only
// change from baseline is moving SL to entry+feeBuffer once price reaches a trigger R (swept
// {0.5R,0.6R,0.7R,0.8R,1.0R}), keeping TP fixed at the original 1.5R. Entry detection duplicated
// verbatim from RT-034/036/037 (same detectFvg/checkNoTradeZone/classifyTrendH1/
// calculatePositionSize/config imports) for the same reason: strategy1MeasureFvg.ts's findTrades()/
// Trade aren't exported and don't carry entryIndex/raw path. fvg.ts/fvgStrategyConfig.ts untouched.
//
// feeBuffer = entryPrice * FEE_PCT_SUM% (0.2%), same as RT-036/037 — no executionCostEngine module
// exists in this codebase.
//
// No partial close anywhere in this ticket -> notional never changes mid-trade -> exactly 2 fee legs
// (entry+exit) throughout, same formula/rate as baseline's computePnl, unlike RT-036/037's 3-4 leg
// partial-close accounting.

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
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 1.5, unchanged
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: TARGET_R,
};

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05; // same constant as every sibling script since RT-027

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
  tpPrice: number; // 1.5R, unchanged
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

function scanTouch(m15All: Candle[], fromIndex: number, direction: Direction, slPrice: number, tpPrice: number): { outcome: Outcome; index: number } {
  for (let j = fromIndex + 1; j < m15All.length; j++) {
    const candle = m15All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tpTouched = direction === 'LONG' ? candle.high >= tpPrice : candle.low <= tpPrice;
    if (slTouched) return { outcome: 'SL', index: j };
    if (tpTouched) return { outcome: 'TP', index: j };
  }
  return { outcome: 'STILL_OPEN', index: m15All.length - 1 };
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

type ClassLabel = 'NEVER_TRIGGERED_SL' | 'NEVER_TRIGGERED_STILL_OPEN' | 'UNAFFECTED_WIN' | 'SAVED' | 'CUT_SHORT' | 'TRIGGERED_STILL_OPEN';

interface SimResult {
  pnl: number;
  isWin: boolean;
  isDecided: boolean;
  classLabel: ClassLabel;
}

function simulateTrade(m15All: Candle[], t: BaseTrade, triggerR: number): SimResult {
  const triggerPrice = t.direction === 'LONG' ? t.entryPrice + triggerR * t.slDistance : t.entryPrice - triggerR * t.slDistance;
  const feeBufferPrice = t.entryPrice * (FEE_PCT_SUM / 100);
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + feeBufferPrice : t.entryPrice - feeBufferPrice;
  const cost = (t.notional * FEE_PCT_SUM) / 100; // full size throughout, 2 legs, same as baseline

  // Phase 1: entry -> original SL or trigger.
  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, triggerPrice);

  if (phase1.outcome === 'SL') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.slPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'NEVER_TRIGGERED_SL' };
  }
  if (phase1.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'NEVER_TRIGGERED_STILL_OPEN' };
  }

  // Trigger hit: SL moves to breakeven+feeBuffer, TP unchanged at 1.5R.
  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);

  if (phase2.outcome === 'TP') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.tpPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'UNAFFECTED_WIN' };
  }
  if (phase2.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'TRIGGERED_STILL_OPEN' };
  }

  // phase2.outcome === 'SL': stopped at breakeven+buffer instead of the original exit.
  const pnl = t.qty * directedDelta(t.direction, t.entryPrice, breakevenSlPrice) - cost;
  const classLabel: ClassLabel = t.baselineOutcome === 'SL' ? 'SAVED' : 'CUT_SHORT';
  return { pnl, isWin: pnl > 0, isDecided: true, classLabel };
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

function printStatsRow(label: string, s: Stats, extra = ''): void {
  console.log(
    label.padEnd(12) +
      String(s.n).padEnd(6) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${s.winRate.toFixed(1)}%`.padEnd(10) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
      extra,
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
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033/034/036/037)`);

  const baseline = summarizeBaseline(filled);
  console.log(
    `\nBASELINE (full TP=${TARGET_R}R, khong breakeven): n=${baseline.n}  PnL=$${baseline.pnl.toFixed(2)}  winRate=${baseline.winRate.toFixed(1)}%  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}  (doi chieu RT-033: $474.22, 61.5%, PF=1.54)`,
  );

  const TRIGGER_LEVELS = [0.5, 0.6, 0.7, 0.8, 1.0];

  console.log('\n=== Sweep breakeven trigger R (full size, KHONG partial) ===');
  console.log('trigger'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(8) + 'cutShort'.padEnd(10) + 'neverTrig(SL)');
  printStatsRow('BASELINE', baseline);
  for (const trig of TRIGGER_LEVELS) {
    const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t, trig));
    const s = summarize(results);
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    const neverTrigSl = results.filter((r) => r.classLabel === 'NEVER_TRIGGERED_SL').length;
    console.log(
      `${trig}R`.padEnd(12) +
        String(s.n).padEnd(6) +
        `$${s.pnl.toFixed(2)}`.padEnd(14) +
        `${s.winRate.toFixed(1)}%`.padEnd(10) +
        `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
        String(saved).padEnd(8) +
        String(cutShort).padEnd(10) +
        String(neverTrigSl),
    );
  }

  console.log('\n=== Xac nhan ky vong: cutShort co thuc su = 0 khong, o tung muc trigger? ===');
  for (const trig of TRIGGER_LEVELS) {
    const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t, trig));
    const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
    const saved = results.filter((r) => r.classLabel === 'SAVED').length;
    const baselineWinCount = filled.filter((t) => t.baselineOutcome === 'TP').length;
    const baselineLossCount = filled.filter((t) => t.baselineOutcome === 'SL').length;
    console.log(
      `  trigger=${trig}R: cutShort=${cutShort}/${baselineWinCount} lenh THANG goc, saved=${saved}/${baselineLossCount} lenh THUA goc`,
    );
  }

  console.log('\n=== Breakdown theo tung coin (moi muc trigger) ===');
  for (const trig of TRIGGER_LEVELS) {
    console.log(`\n--- trigger=${trig}R ---`);
    console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(8) + 'cutShort');
    for (const symbol of symbols) {
      const symbolTrades = filled.filter((t) => t.symbol === symbol);
      const results = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t, trig));
      const s = summarize(results);
      const saved = results.filter((r) => r.classLabel === 'SAVED').length;
      const cutShort = results.filter((r) => r.classLabel === 'CUT_SHORT').length;
      console.log(
        symbol.padEnd(12) +
          String(s.n).padEnd(6) +
          `$${s.pnl.toFixed(2)}`.padEnd(14) +
          `${s.winRate.toFixed(1)}%`.padEnd(10) +
          `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
          String(saved).padEnd(8) +
          String(cutShort),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
