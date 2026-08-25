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

// TICKET-RT-042: sweep targetRMultiple only — same 358-trade entry set as RT-032/033
// (minCandle2BodyRatio=0.7, minSlPctFloor=0.5%), same entryPrice/slPrice/qty/notional for every
// trade at every sweep value (fill logic never reads tpPrice, so the entry set is identical by
// construction — see findBaseTrades() below, unchanged from RT-034/036-041's boilerplate). Only the
// TP price and therefore the TP/SL outcome are recomputed per sweep value. No SL move, no breakeven,
// no partial close — a single full-size, single-exit trade, exactly like the current baseline.
//
// Entry detection duplicated verbatim from RT-034/036-041 (same detectFvg/checkNoTradeZone/
// classifyTrendH1/calculatePositionSize/config imports) for the same reason each time:
// strategy1MeasureFvg.ts's findTrades()/Trade aren't exported. fvg.ts/fvgStrategyConfig.ts untouched.

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
const BASELINE_TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 1.5
const SWEEP_CONFIG = {
  minCandle2BodyRatio: DEFAULT_FVG_CONFIG.minCandle2BodyRatio,
  maxWaitCandles: DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles,
  targetRMultiple: BASELINE_TARGET_R, // used only to fill entries; outcome is rescanned per sweep value below
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
  slPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
}

// Fill logic never reads tpPrice — entry detection, wait-for-fill, floor, and sizing are all
// unaffected by targetRMultiple, so this produces the SAME 358-trade set for every sweep value.
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
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            trades.push({
              symbol,
              direction: pending.direction,
              entryIndex: i,
              entryPrice,
              slPrice,
              slDistance,
              qty: sizing.qty,
              notional: sizing.notional,
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

interface Stats {
  n: number;
  tp: number;
  sl: number;
  stillOpen: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function evaluateTargetR(m15Map: Map<string, Candle[]>, trades: BaseTrade[], targetR: number): Stats {
  let tp = 0;
  let sl = 0;
  let stillOpen = 0;
  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    const m15All = m15Map.get(t.symbol)!;
    const tpPrice = t.direction === 'LONG' ? t.entryPrice + targetR * t.slDistance : t.entryPrice - targetR * t.slDistance;
    const scan = scanTouch(m15All, t.entryIndex, t.direction, t.slPrice, tpPrice);

    if (scan.outcome === 'STILL_OPEN') {
      stillOpen++;
      continue;
    }
    if (scan.outcome === 'TP') tp++;
    else sl++;

    const exitPrice = scan.outcome === 'TP' ? tpPrice : t.slPrice;
    const cost = (t.notional * FEE_PCT_SUM) / 100;
    const p = t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - cost;
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      grossLoss += Math.abs(p);
    }
  }

  const decided = tp + sl;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: trades.length, tp, sl, stillOpen, pnl, winRate, profitFactor };
}

function printRow(label: string, s: Stats): void {
  console.log(
    label.padEnd(12) +
      String(s.n).padEnd(6) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
      `${s.winRate.toFixed(1)}%`.padEnd(10) +
      `${s.n > 0 ? ((s.tp / s.n) * 100).toFixed(1) : '0.0'}%`.padEnd(8) +
      `${s.n > 0 ? ((s.sl / s.n) * 100).toFixed(1) : '0.0'}%`.padEnd(8) +
      (s.stillOpen > 0 ? `STILL_OPEN=${s.stillOpen}` : ''),
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
  console.log(`Tong lenh da fill (floor=${FLOOR_PCT}%): n=${filled.length} (ky vong 358, doi chieu RT-033)`);

  const TARGET_R_SWEEP = [1.5, 1.6, 1.7, 1.8, 2.0];

  console.log('\n=== Sweep targetRMultiple (cung 358 setup goc, chi doi TP) ===');
  console.log('targetR'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP%'.padEnd(8) + 'SL%'.padEnd(8) + '');
  let best: { targetR: number; stats: Stats } | null = null;
  for (const targetR of TARGET_R_SWEEP) {
    const s = evaluateTargetR(m15Map, filled, targetR);
    printRow(`${targetR}R`, s);
    if (targetR === BASELINE_TARGET_R) {
      console.log(`  (doi chieu baseline RT-033: $474.22, PF=1.54, winRate=61.5%, TP=61.5%, SL=38.5%)`);
    }
    if (best === null || s.pnl > best.stats.pnl) best = { targetR, stats: s };
  }
  console.log(`\n  -> Muc tot nhat theo PnL$: targetRMultiple=${best!.targetR}R ($${best!.stats.pnl.toFixed(2)})`);

  console.log(`\n=== Breakdown 5 coin cho muc tot nhat (targetRMultiple=${best!.targetR}R) ===`);
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP%'.padEnd(8) + 'SL%');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const s = evaluateTargetR(m15Map, symbolTrades, best!.targetR);
    printRow(symbol, s);
  }

  console.log(`\n=== Doi chieu: breakdown 5 coin cho baseline 1.5R (de so sanh truc tiep) ===`);
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP%'.padEnd(8) + 'SL%');
  for (const symbol of symbols) {
    const symbolTrades = filled.filter((t) => t.symbol === symbol);
    const s = evaluateTargetR(m15Map, symbolTrades, BASELINE_TARGET_R);
    printRow(symbol, s);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
