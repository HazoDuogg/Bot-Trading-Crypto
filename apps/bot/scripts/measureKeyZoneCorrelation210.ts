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

// TICKET-RT-048: re-measure the RT-030 breaksKeyZone/outcome correlation on the CURRENT production
// config (targetRMultiple=2.10, set in RT-045) — RT-030's original numbers were measured at
// targetRMultiple=1.5, now stale. Reuses findKeyZones() (src/zones/keyZones.ts) UNMODIFIED, and the
// exact same breaksKeyZone computation (FVG_KEY_ZONE_CONFIG, H1-KeyZone-containment-in-the-gap check,
// per-H1-cursor zone caching) verbatim from strategy1MeasureFvg.ts/RT-030 — not redefined. Only the
// exit price (tpPrice) changes to reflect the current 2.10R target; everything else about entry
// detection is duplicated verbatim from RT-034/036-047 for the same reason each time:
// strategy1MeasureFvg.ts's findTrades()/Trade aren't exported and don't carry entryIndex/breaksKeyZone
// together with the fields this measurement needs. fvg.ts/fvgStrategyConfig.ts untouched — reading
// the current (already RT-045-updated) production targetRMultiple, not overriding it. No sizing
// formula is proposed here, per the ticket's "Khong lam".

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
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple; // 2.1, production as of RT-045
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
  breaksKeyZone: boolean;
}

interface Trade {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  slPct: number;
  breaksKeyZone: boolean;
}

async function findTrades(symbol: string, dataDir: string): Promise<Trade[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const leverage = LEVERAGE[symbol];

  let h1Cursor = 0;
  const trades: Trade[] = [];
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
            pending.direction === 'LONG'
              ? entryPrice + SWEEP_CONFIG.targetRMultiple * slDistance
              : entryPrice - SWEEP_CONFIG.targetRMultiple * slDistance;
          const sizing = calculatePositionSize({
            balance: BALANCE,
            riskUsd: RISK_USD,
            entryPrice,
            slPrice,
            leverage,
            maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
          });
          if (sizing) {
            const outcome = scanOutcome(m15All, i, pending.direction, slPrice, tpPrice);
            trades.push({
              symbol,
              direction: pending.direction,
              entryPrice,
              slPrice,
              tpPrice,
              qty: sizing.qty,
              notional: sizing.notional,
              outcome,
              slPct: (slDistance / entryPrice) * 100,
              breaksKeyZone: pending.breaksKeyZone,
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
      // Same RT-030 caching: recompute H1 KeyZones only when h1Cursor advances.
      if (h1Cursor !== cachedH1Cursor) {
        cachedH1Cursor = h1Cursor;
        const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
        cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
      }
      const gapLow = fvg.gapLow;
      const gapHigh = fvg.gapHigh;
      const breaksKeyZone = cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);

      pending = {
        direction: fvg.direction,
        gapLow: fvg.gapLow,
        gapHigh: fvg.gapHigh,
        invalidationPrice: fvg.invalidationPrice,
        waitCount: 0,
        breaksKeyZone,
      };
    }
  }

  return trades;
}

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

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function computePnl(t: Trade): number {
  if (t.outcome === 'STILL_OPEN') return 0;
  const costDollars = (t.notional * FEE_PCT_SUM) / 100;
  const exitPrice = t.outcome === 'TP' ? t.tpPrice : t.slPrice;
  return t.qty * directedDelta(t.direction, t.entryPrice, exitPrice) - costDollars;
}

interface Summary {
  n: number;
  tp: number;
  sl: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(trades: Trade[]): Summary {
  const decided = trades.filter((t) => t.outcome !== 'STILL_OPEN');
  const tp = decided.filter((t) => t.outcome === 'TP').length;
  const sl = decided.filter((t) => t.outcome === 'SL').length;

  let pnl = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of decided) {
    const p = computePnl(t);
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
  return { n: trades.length, tp, sl, pnl, winRate, profitFactor };
}

function printRow(label: string, s: Summary, totalN: number): void {
  console.log(
    label.padEnd(14) +
      String(s.n).padEnd(6) +
      `${totalN > 0 ? ((s.n / totalN) * 100).toFixed(1) : '0.0'}%`.padEnd(8) +
      `$${s.pnl.toFixed(2)}`.padEnd(14) +
      `${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`.padEnd(8) +
      `${s.winRate.toFixed(1)}%`.padEnd(10) +
      `TP=${s.tp}/SL=${s.sl}`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allTrades: Trade[] = [];
  for (const symbol of symbols) {
    const trades = await findTrades(symbol, dataDir);
    allTrades = allTrades.concat(trades);
  }

  const filled = allTrades.filter((t) => t.slPct >= FLOOR_PCT);
  console.log(
    `Tong lenh da fill (targetRMultiple=${TARGET_R}, production RT-045): n=${filled.length} (ky vong 358, doi chieu RT-045: $653.72, PF=1.61, winRate=52.8%)`,
  );

  const withZone = filled.filter((t) => t.breaksKeyZone);
  const withoutZone = filled.filter((t) => !t.breaksKeyZone);

  console.log(`\n=== Bang so sanh breaksKeyZone (targetRMultiple=${TARGET_R}R) ===`);
  console.log('nhom'.padEnd(14) + 'n'.padEnd(6) + '%tong'.padEnd(8) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP/SL');
  const sTrue = summarize(withZone);
  const sFalse = summarize(withoutZone);
  printRow('breaksKZ=true', sTrue, filled.length);
  printRow('breaksKZ=false', sFalse, filled.length);

  const correlationHolds = sTrue.profitFactor > sFalse.profitFactor && sTrue.winRate > sFalse.winRate;
  console.log(
    `\n  -> Tuong quan duong (breaksKeyZone=true tot hon ca PF lan winRate) o targetR=${TARGET_R}R: ${correlationHolds ? 'VAN GIU' : 'KHONG con giu nhu cu — DA DOI KHAC so voi RT-030 (targetR=1.5)'}`,
  );
  console.log(`  Doi chieu RT-030 (targetR=1.5, floor=0.5%): breaksKZ=true PF cao hon breaksKZ=false (xem bao cao RT-030 goc).`);

  console.log('\n=== Breakdown 5 coin cho breaksKeyZone=true ===');
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP/SL');
  for (const symbol of symbols) {
    const symbolTrades = withZone.filter((t) => t.symbol === symbol);
    const s = summarize(symbolTrades);
    printRow(symbol, s, withZone.length);
  }

  console.log('\n=== Breakdown 5 coin cho breaksKeyZone=false ===');
  console.log('symbol'.padEnd(12) + 'n'.padEnd(6) + 'PnL$'.padEnd(14) + 'PF'.padEnd(8) + 'winRate'.padEnd(10) + 'TP/SL');
  for (const symbol of symbols) {
    const symbolTrades = withoutZone.filter((t) => t.symbol === symbol);
    const s = summarize(symbolTrades);
    printRow(symbol, s, withoutZone.length);
  }

  const smallSampleCoins = symbols.filter((s) => withZone.filter((t) => t.symbol === s).length < 5);
  if (smallSampleCoins.length > 0) {
    console.log(
      `\n  LUU Y CO MAU (nhu RT-030 da canh bao): breaksKeyZone=true co n<5 o cac coin: ${smallSampleCoins.join(', ')} — doc PF/winRate cua nhung coin nay voi than trong, co the la nhieu.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
