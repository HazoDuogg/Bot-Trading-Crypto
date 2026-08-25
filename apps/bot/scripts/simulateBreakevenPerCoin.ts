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

// TICKET-RT-041: final breakeven-direction test — per-coin buffer instead of one shared number.
// Same design as RT-038/039 (full size, no partial, trigger fixed at 1.2R, 2 fee legs), the only
// change is the buffer, taken from each coin's OWN median pullback depth measured in RT-040 on its
// 82-trade "cat non" subset (per-coin n: BTC=5, ETH=14, SOL=19, HYPE=33, XRP=11). Entry detection
// duplicated verbatim from RT-034/036/037/038/039/040 (same detectFvg/checkNoTradeZone/
// classifyTrendH1/calculatePositionSize/config imports) for the same reason each time:
// strategy1MeasureFvg.ts's findTrades()/Trade aren't exported and don't carry entryIndex/raw path.
// fvg.ts/fvgStrategyConfig.ts untouched. Runs on the FULL 358-trade set, not RT-040's 82-trade subset.
//
// SAMPLE-SIZE WARNING (required by the ticket, repeated at every print of a per-coin number below):
// the per-coin buffer values themselves come from RT-040 subsets as small as n=5 (BTC) and n=11
// (XRP) — any single coin's result here can easily be noise from that small a sample, not a real
// per-coin effect. Do not read a win on 1-2 coins as a confirmed finding without a robustness check
// (explicitly out of scope for this ticket).
//
// Buffer unit: R-multiple * that TRADE's own slDistance (price units), NOT a fixed % of entry price
// — per the ticket, avoiding the fixed-% scale mismatch RT-039/040 flagged.

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

const TRIGGER_R = 1.2; // Sweep A's best, RT-039

// Per-coin buffer, in R-multiple — RT-040's median pullback depth for that coin's own "cat non" subset.
const BUFFER_R_BY_COIN: Record<string, number> = {
  BTCUSDT: 0.68,
  ETHUSDT: 0.801,
  SOLUSDT: 0.822,
  HYPEUSDT: 1.112,
  XRPUSDT: 1.083,
};
const BUFFER_SAMPLE_N_BY_COIN: Record<string, number> = {
  BTCUSDT: 5,
  ETHUSDT: 14,
  SOLUSDT: 19,
  HYPEUSDT: 33,
  XRPUSDT: 11,
};

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

function simulateTrade(m15All: Candle[], t: BaseTrade): SimResult {
  const triggerPrice = t.direction === 'LONG' ? t.entryPrice + TRIGGER_R * t.slDistance : t.entryPrice - TRIGGER_R * t.slDistance;
  const bufferR = BUFFER_R_BY_COIN[t.symbol];
  const bufferPrice = bufferR * t.slDistance; // R-multiple of THIS trade's own slDistance, not a fixed % of price
  const breakevenSlPrice = t.direction === 'LONG' ? t.entryPrice + bufferPrice : t.entryPrice - bufferPrice;
  const cost = (t.notional * FEE_PCT_SUM) / 100; // full size throughout, 2 legs, same as baseline

  const phase1 = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, triggerPrice);

  if (phase1.outcome === 'SL') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.slPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'NEVER_TRIGGERED_SL' };
  }
  if (phase1.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'NEVER_TRIGGERED_STILL_OPEN' };
  }

  const phase2 = scanTouch(m15All, phase1.index, t.direction, breakevenSlPrice, t.tpPrice);

  if (phase2.outcome === 'TP') {
    const pnl = t.qty * directedDelta(t.direction, t.entryPrice, t.tpPrice) - cost;
    return { pnl, isWin: pnl > 0, isDecided: true, classLabel: 'UNAFFECTED_WIN' };
  }
  if (phase2.outcome === 'STILL_OPEN') {
    return { pnl: 0, isWin: false, isDecided: false, classLabel: 'TRIGGERED_STILL_OPEN' };
  }

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

function statsRow(s: Stats, saved: number, cutShort: number): string {
  return (
    String(s.n).padEnd(6) +
    `$${s.pnl.toFixed(2)}`.padEnd(14) +
    `${s.winRate.toFixed(1)}%`.padEnd(10) +
    `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
    `${saved}`.padEnd(8) +
    `${cutShort}`
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
  console.log(`Tong lenh da fill: n=${filled.length} (ky vong 358, day du, khong phai tap con 82)`);

  console.log(
    '\n*** CANH BAO CO MAU (bat buoc theo ticket): buffer per-coin lay tu RT-040 tren tap con 82 lenh "cat non",' +
      ' co mau tung coin RAT NHO (BTC n=5, ETH n=14, SOL n=19, HYPE n=33, XRP n=11). Ket qua tung coin rieng le' +
      ' DUOI DAY CO THE CHI LA NHIEU NGAU NHIEN do mau nho, khong phai quy luat that. Doc ket qua voi canh bao nay.',
  );

  const baseline = summarizeBaseline(filled);
  console.log(
    `\nBASELINE GOP (full TP=${TARGET_R}R, khong breakeven): n=${baseline.n}  PnL=$${baseline.pnl.toFixed(2)}  winRate=${baseline.winRate.toFixed(1)}%  PF=${Number.isFinite(baseline.profitFactor) ? baseline.profitFactor.toFixed(2) : 'inf'}  (doi chieu RT-033: $474.22, 61.5%, PF=1.54)`,
  );

  const results = filled.map((t) => simulateTrade(m15Map.get(t.symbol)!, t));
  const perCoinStats = summarize(results);
  const savedTotal = results.filter((r) => r.classLabel === 'SAVED').length;
  const cutShortTotal = results.filter((r) => r.classLabel === 'CUT_SHORT').length;

  console.log(`\n=== BANG TONG: buffer rieng theo coin (trigger=${TRIGGER_R}R) vs BASELINE GOP ===`);
  console.log('config'.padEnd(20) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'winRate'.padEnd(10) + 'PF'.padEnd(8) + 'saved'.padEnd(8) + 'cutShort');
  console.log('BASELINE GOP'.padEnd(20) + statsRow(baseline, 0, 0));
  console.log('PER-COIN BUFFER'.padEnd(20) + statsRow(perCoinStats, savedTotal, cutShortTotal));
  console.log(
    `\n  -> ${perCoinStats.pnl > baseline.pnl ? 'VUOT' : 'KHONG vuot'} baseline gop ve PnL$ ($${perCoinStats.pnl.toFixed(2)} vs $${baseline.pnl.toFixed(2)}).`,
  );

  console.log('\n=== Breakdown 5 coin: PER-COIN BUFFER so voi BASELINE CUA CHINH COIN DO (khong phai baseline gop) ===');
  console.log(
    'symbol'.padEnd(12) + 'bufferR'.padEnd(10) + 'buf.n(RT040)'.padEnd(14) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'vs coin baseline',
  );
  let coinsBeatOwnBaseline = 0;
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const symbolBaseline = summarizeBaseline(symbolTrades);
    const symbolResults = symbolTrades.map((t) => simulateTrade(m15Map.get(symbol)!, t));
    const symbolPerCoin = summarize(symbolResults);
    const saved = symbolResults.filter((r) => r.classLabel === 'SAVED').length;
    const cutShort = symbolResults.filter((r) => r.classLabel === 'CUT_SHORT').length;
    const beats = symbolPerCoin.pnl > symbolBaseline.pnl;
    if (beats) coinsBeatOwnBaseline++;
    console.log(
      symbol.padEnd(12) +
        `${BUFFER_R_BY_COIN[symbol]}R`.padEnd(10) +
        `n=${BUFFER_SAMPLE_N_BY_COIN[symbol]}`.padEnd(14) +
        String(symbolPerCoin.n).padEnd(6) +
        `$${symbolPerCoin.pnl.toFixed(2)}`.padEnd(14) +
        `${Number.isFinite(symbolPerCoin.profitFactor) ? symbolPerCoin.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
        `${beats ? 'VUOT' : 'KHONG vuot'} coin-baseline ($${symbolBaseline.pnl.toFixed(2)}, PF=${Number.isFinite(symbolBaseline.profitFactor) ? symbolBaseline.profitFactor.toFixed(2) : 'inf'}, saved=${saved}, cutShort=${cutShort})`,
    );
  }

  console.log(`\n=== Ket luan (chi bao cao, khong tu chot huong) ===`);
  console.log(`  Gop 5 coin: PER-COIN BUFFER $${perCoinStats.pnl.toFixed(2)} vs BASELINE GOP $${baseline.pnl.toFixed(2)} -> ${perCoinStats.pnl > baseline.pnl ? 'VUOT' : 'KHONG VUOT'}`);
  console.log(`  So coin rieng le vuot duoc baseline cua chinh no: ${coinsBeatOwnBaseline}/5`);
  console.log(
    '  NHAC LAI CANH BAO: neu co 1-2 coin "vuot" o tren, day CO THE la nhieu do mau nho (n=5-33 tren tap 82 lenh RT-040),' +
      ' KHONG phai bang chung chac chan. Neu ca gop lan tung coin deu khong vuot -> du bang chung de dung hoan toan huong breakeven-only.' +
      ' Neu co dau hieu kha quan (gop hoac 1-2 coin) -> theo dung "Khong lam" cua ticket, KHONG chot so nay, can them buoc xac nhan robustness rieng.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
