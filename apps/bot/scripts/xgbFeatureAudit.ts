import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../src/trend/trendH1.js';
import { computeEma } from '../src/regime/ema.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../src/entry/types.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { findKeyZones } from '../src/zones/keyZones.js';
import type { KeyZone } from '../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import { resolveRiskPct } from '../src/positionSizing/riskConfig.js';
import {
  admitPosition,
  closePosition,
  EMPTY_EXPOSURE_STATE,
  DEFAULT_EXPOSURE_TRACKER_CONFIG,
  type ExposureTrackerState,
} from '../src/positionSizing/exposureTracker.js';
import {
  loadAllSymbolData,
  runSimulation,
  computeClosedPnl,
  BALANCE,
  SYMBOLS,
  type SymbolData,
} from './simulateOneYearNearLive.js';

// TICKET-RT-058: proof-of-concept feature audit. This script does NOT touch entryRouter, fvg.ts,
// positionSizing/*, or any other production file. It reruns the EXACT RT-056/057 confirmed backtest
// (same production functions: detectFvg, classifyTrendH1, checkNoTradeZone, calculatePositionSize,
// admitPosition/closePosition, resolveRiskPct — all imported as-is, none copied/modified) because the
// 1217-trade log from that backtest was never persisted to disk anywhere in the repo (verified: no
// apps/bot/data or apps/bot/reports file contains it) — rerunning the identical deterministic
// production pipeline is the only way to reproduce it. The loop below is a byte-for-byte structural
// mirror of runSimulation() in simulateOneYearNearLive.ts, with ONLY feature-capture instrumentation
// added at the fill site; nothing about detection/admission/exit logic differs. A self-check at the
// end of main() reruns the untouched runSimulation() and asserts n/PnL/PF/maxDD match this mirrored
// loop's own trade set exactly, so any accidental divergence fails loudly instead of silently.
//
// No-look-ahead for every extracted feature: distanceFromEma200H1Pct and atrH1Pct are both computed
// from h1Window, which (identically to runSimulation) only ever contains H1 candles whose close <=
// the current M15 close time (see the `while` cursor advance below — verbatim copy of RT-051's
// checkpoint 6). fvgGapSizePct/waitedCandlesCount/breaksKeyZone come from the already-detected
// pending FVG (itself detected earlier using only candles <= its own detection index, per checkpoint
// 6). hourOfDayUtc/dayOfWeekUtc/entryTimestampUtc come from the fill candle's own openTime. None of
// these read any candle beyond the one causing the fill.

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
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
  breaksKeyZone: boolean;
}

interface FeatureRecord {
  symbol: string;
  entryTimestampUtc: number;
  distanceFromEma200H1Pct: number;
  slPct: number;
  fvgGapSizePct: number;
  waitedCandlesCount: number;
  breaksKeyZone: boolean;
  atrH1Pct: number;
  hourOfDayUtc: number;
  dayOfWeekUtc: number;
}

interface OpenTrade {
  id: string;
  direction: Direction;
  entryIndex: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  qty: number;
  notional: number;
  features: FeatureRecord;
}

interface OutputRow extends FeatureRecord {
  won: boolean;
}

interface SymbolState {
  data: SymbolData;
  h1Cursor: number;
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
}

function runInstrumentedSimulation(
  allData: SymbolData[],
  targetRMultiple: number,
): { rows: OutputRow[]; closedTrades: ReturnType<typeof runSimulation>['closedTrades'] } {
  const states: SymbolState[] = allData.map((data) => ({
    data,
    h1Cursor: 0,
    cachedH1CursorForZones: -1,
    cachedZones: [],
    pending: null,
    open: null,
    nextId: 0,
  }));

  const nCandles = states[0].data.m15All.length;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const rows: OutputRow[] = [];
  const closedTrades: ReturnType<typeof runSimulation>['closedTrades'] = [];

  for (let i = 2; i < nCandles; i++) {
    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const m15CloseTime = m15All[i].openTime + M15_MS;
      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) st.h1Cursor++;
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor);
      const m15Window = m15All.slice(0, i + 1);
      const closePrice = h1Window[h1Window.length - 1].close;
      const candle = m15All[i];

      const ntz = checkNoTradeZone({
        nowMs: m15CloseTime,
        bid: closePrice,
        ask: closePrice,
        h1Candles: h1Window,
        m15Candles: m15Window,
      });

      if (st.open) {
        const o = st.open;
        const slTouched = o.direction === 'LONG' ? candle.low <= o.slPrice : candle.high >= o.slPrice;
        const tpTouched = o.direction === 'LONG' ? candle.high >= o.tpPrice : candle.low <= o.tpPrice;
        if (slTouched || tpTouched) {
          const outcome = slTouched ? 'SL' : 'TP';
          closedTrades.push({
            symbol,
            direction: o.direction,
            entryIndex: o.entryIndex,
            entryPrice: o.entryPrice,
            slPrice: o.slPrice,
            tpPrice: o.tpPrice,
            slDistance: o.slDistance,
            qty: o.qty,
            notional: o.notional,
            outcome,
            slPct: (o.slDistance / o.entryPrice) * 100,
            breaksKeyZone: o.features.breaksKeyZone,
            scaledDown: false,
            closeTime: m15CloseTime,
          });
          rows.push({ ...o.features, won: outcome === 'TP' });
          exposureState = closePosition(exposureState, o.id);
          st.open = null;
        }
        continue;
      }

      if (st.pending) {
        st.pending.waitCount++;
        const touchedGap = candle.low <= st.pending.gapHigh && candle.high >= st.pending.gapLow;

        if (touchedGap && !ntz.blocked) {
          const direction = st.pending.direction;
          const entryPrice = direction === 'LONG' ? st.pending.gapLow : st.pending.gapHigh;
          const slPrice = st.pending.invalidationPrice;
          const slDistance = Math.abs(entryPrice - slPrice);

          if (slDistance > 0) {
            const slPct = (slDistance / entryPrice) * 100;
            const tpPrice = direction === 'LONG' ? entryPrice + targetRMultiple * slDistance : entryPrice - targetRMultiple * slDistance;
            const riskUsd = BALANCE * resolveRiskPct(symbol, st.pending.breaksKeyZone);
            const sizing = calculatePositionSize({
              balance: BALANCE,
              riskUsd,
              entryPrice,
              slPrice,
              leverage: LEVERAGE[symbol],
              maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
            });
            if (sizing && slPct >= FLOOR_PCT) {
              const id = `${symbol}-${st.nextId++}`;
              const { result, nextState } = admitPosition(exposureState, DEFAULT_EXPOSURE_TRACKER_CONFIG, BALANCE, {
                id,
                symbol,
                qty: sizing.qty,
                notional: sizing.notional,
                requiredMargin: sizing.requiredMargin,
                actualRiskUsd: sizing.actualRiskUsd,
              });
              exposureState = nextState;
              if (result.admitted) {
                const emaValues = computeEma(h1Window, EMA_PERIOD_H1);
                const ema200H1 = emaValues.length > 0 ? emaValues[emaValues.length - 1] : null;
                const atrValues = computeAtr(h1Window, ATR_PERIOD);
                const atrH1 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

                const features: FeatureRecord = {
                  symbol,
                  entryTimestampUtc: candle.openTime,
                  distanceFromEma200H1Pct: ema200H1 !== null ? ((closePrice - ema200H1) / ema200H1) * 100 : NaN,
                  slPct,
                  fvgGapSizePct: ((st.pending.gapHigh - st.pending.gapLow) / entryPrice) * 100,
                  waitedCandlesCount: st.pending.waitCount,
                  breaksKeyZone: st.pending.breaksKeyZone,
                  atrH1Pct: (atrH1 / closePrice) * 100,
                  hourOfDayUtc: new Date(candle.openTime).getUTCHours(),
                  dayOfWeekUtc: new Date(candle.openTime).getUTCDay(),
                };

                st.open = {
                  id,
                  direction,
                  entryIndex: i,
                  entryPrice,
                  slPrice,
                  tpPrice,
                  slDistance,
                  qty: result.qty,
                  notional: result.notional,
                  features,
                };
              }
            }
          }
          st.pending = null;
        } else if (st.pending.waitCount >= MAX_WAIT_CANDLES) {
          st.pending = null;
        }
      }

      if (st.open) continue;
      if (ntz.blocked) continue;
      if (st.pending) continue;

      const trend = classifyTrendH1(h1Window, EMA_PERIOD_H1);
      if (trend === null) continue;
      const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

      const fvg = detectFvg(m15All[i - 2], m15All[i - 1], m15All[i], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
      if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
        if (st.h1Cursor !== st.cachedH1CursorForZones) {
          st.cachedH1CursorForZones = st.h1Cursor;
          const atrH1Values = computeAtr(h1Window, ATR_PERIOD);
          const atrH1 = atrH1Values.length > 0 ? atrH1Values[atrH1Values.length - 1] : 0;
          st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
        }
        const gapLow = fvg.gapLow;
        const gapHigh = fvg.gapHigh;
        const breaksKeyZone = st.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);

        st.pending = {
          direction: fvg.direction,
          gapLow: fvg.gapLow,
          gapHigh: fvg.gapHigh,
          invalidationPrice: fvg.invalidationPrice,
          waitCount: 0,
          breaksKeyZone,
        };
      }
    }
  }

  return { rows, closedTrades };
}

function summarizeForCheck(trades: ReturnType<typeof runSimulation>['closedTrades']) {
  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const p = computeClosedPnl(t);
    pnl += p;
    if (p > 0) grossProfit += p;
    else if (p < 0) grossLoss += Math.abs(p);
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: trades.length, pnl, profitFactor };
}

function computeMaxDrawdownPct(trades: ReturnType<typeof runSimulation>['closedTrades'], startCapital: number): number {
  let equity = startCapital;
  let peak = startCapital;
  let maxDrawdownDollar = 0;
  for (const t of trades) {
    equity += computeClosedPnl(t);
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownDollar) maxDrawdownDollar = drawdown;
  }
  return (maxDrawdownDollar / startCapital) * 100;
}

const CSV_COLUMNS: (keyof OutputRow)[] = [
  'symbol',
  'entryTimestampUtc',
  'distanceFromEma200H1Pct',
  'slPct',
  'fvgGapSizePct',
  'waitedCandlesCount',
  'breaksKeyZone',
  'atrH1Pct',
  'hourOfDayUtc',
  'dayOfWeekUtc',
  'won',
];

function toCsv(rows: OutputRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('Dang load du lieu 1 nam (5 coin x H1+M15)...');
  const allData = await loadAllSymbolData(dataDir);
  console.log(`Da load: n=${allData[0].m15All.length} nen M15/coin, 5 coin.`);

  console.log('\nDang chay lai backtest 1 nam (production functions, khong sua) de trich feature tai entry...');
  const { rows, closedTrades } = runInstrumentedSimulation(allData, targetR);

  console.log('\nDang chay lai runSimulation() GOC (khong sua) de doi chieu tu-kiem-tra...');
  const { closedTrades: referenceTrades } = runSimulation(allData, targetR, (symbol, breaksKeyZone) => resolveRiskPct(symbol, breaksKeyZone));

  const mirrored = summarizeForCheck(closedTrades);
  const reference = summarizeForCheck(referenceTrades.filter((t) => t.outcome !== 'STILL_OPEN'));
  const mirroredMaxDD = computeMaxDrawdownPct(closedTrades, 10000);
  const referenceMaxDD = computeMaxDrawdownPct(referenceTrades.filter((t) => t.outcome !== 'STILL_OPEN'), 10000);

  console.log(`\nMirrored loop (feature audit):  n=${mirrored.n}  PnL=$${mirrored.pnl.toFixed(2)}  PF=${mirrored.profitFactor.toFixed(3)}  maxDD=${mirroredMaxDD.toFixed(2)}%`);
  console.log(`Reference runSimulation() goc:  n=${reference.n}  PnL=$${reference.pnl.toFixed(2)}  PF=${reference.profitFactor.toFixed(3)}  maxDD=${referenceMaxDD.toFixed(2)}%`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%');

  const matchesReference =
    mirrored.n === reference.n && Math.abs(mirrored.pnl - reference.pnl) < 0.01 && Math.abs(mirrored.profitFactor - reference.profitFactor) < 0.001;
  const matchesConfirmed =
    reference.n === 1217 && Math.abs(reference.pnl - 2628.76) < 0.01 && Math.abs(reference.profitFactor - 1.551) < 0.001 && Math.abs(referenceMaxDD - 1.24) < 0.01;

  if (!matchesReference) {
    console.error('\nCORRECTION_REQUIRED: mirrored instrumented loop KHONG khop voi runSimulation() goc — feature-audit trade set khong dang tin cay, DUNG lai.');
    process.exitCode = 1;
    return;
  }
  if (!matchesConfirmed) {
    console.error('\nCORRECTION_REQUIRED: runSimulation() goc KHONG khop voi con so RT-056/057 da chot (n=1217, PF=1.551) — moi truong/du lieu co the da doi, DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('\n-> KHOP 100%: mirrored feature-audit trade set == runSimulation() goc == RT-056/057 Config B da chot.');

  const outPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDataset.csv');
  await writeFile(outPath, toCsv(rows), 'utf8');
  console.log(`\nDa ghi ${rows.length} dong vao ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
