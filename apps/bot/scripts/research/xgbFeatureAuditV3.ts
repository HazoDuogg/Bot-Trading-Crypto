import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkNoTradeZone } from '../../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../../src/noTradeZone/types.js';
import { classifyTrendH1 } from '../../src/trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../../src/entry/types.js';
import { calculatePositionSize } from '../../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
import { computeAtr } from '../../src/noTradeZone/atr.js';
import { findKeyZones } from '../../src/zones/keyZones.js';
import type { KeyZone } from '../../src/zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../../src/regime/types.js';
import { resolveRiskPct } from '../../src/positionSizing/riskConfig.js';
import {
  admitPosition,
  closePosition,
  EMPTY_EXPOSURE_STATE,
  DEFAULT_EXPOSURE_TRACKER_CONFIG,
  type ExposureTrackerState,
} from '../../src/positionSizing/exposureTracker.js';

// TICKET-RT-061 Part A step 1: identical to xgbFeatureAuditV2.ts (RT-059, frozen — NOT modified,
// NOT imported, to avoid both editing a frozen file and re-triggering its own compute), plus one
// addition: each trade's `closeTime` (the M15 candle-close timestamp at which SL/TP actually
// touched — same definition RT-058's original xgbFeatureAudit.ts and RT-060's purgeEmbargoAudit.ts
// both used) is now captured and (a) exported on the internal ClosedTradeInternal record for
// xgbWalkForwardAuditV3.ts to purge trains with, and (b) written as an extra CSV column. `pnl` is
// also carried on ClosedTradeInternal (as V2 already did) — needed by RT-061 Part B's $-based
// group metrics (winrate/PF/expectancy/drawdown/losing-streak), NOT written to the CSV since it
// isn't one of the ticket's specified "14 feature + won + closeTime" columns.
//
// Self-check at the end reproduces the RT-056/057 confirmed constants directly, same as
// xgbFeatureAudit.ts/xgbFeatureAuditV2.ts before it.

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
const EMA_K = 2 / (EMA_PERIOD_H1 + 1);
const ATR_PERCENTILE_WINDOW = 100;
const ROLLING_WIN_RATE_WINDOW = 20;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

export const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;
export const BALANCE = 500;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

export interface SymbolData {
  symbol: string;
  m15All: Candle[];
  h1All: Candle[];
}

export async function loadAllSymbolData(dataDir: string): Promise<SymbolData[]> {
  const out: SymbolData[] = [];
  for (const symbol of SYMBOLS) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_1y.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_1y.csv`));
    out.push({ symbol, m15All, h1All });
  }
  return out;
}

type Outcome = 'TP' | 'SL';

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
  breaksKeyZone: boolean;
  momentumM15Pct3Candles: number;
}

export interface FeatureRecordV2 {
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
  trendAgeH1Candles: number;
  atrPercentileH1: number;
  momentumM15Pct3Candles: number;
  keyZoneDistancePct: number | null;
  rollingWinRateSameSymbol20: number | null;
  concurrentOpenPositionsCount: number;
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
  features: FeatureRecordV2;
}

interface OutputRow extends FeatureRecordV2 {
  closeTime: number;
  won: boolean;
}

interface Ema200Tracker {
  buffer: number[];
  seeded: boolean;
  value: number;
  trend: 'UPTREND' | 'DOWNTREND' | null;
  trendChangeH1Cursor: number;
}

interface SymbolState {
  data: SymbolData;
  h1Cursor: number;
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
  ema200: Ema200Tracker;
  pastOutcomes: boolean[];
}

export interface ClosedTradeInternal {
  symbol: string;
  outcome: Outcome;
  pnl: number;
  closeTime: number;
  features: FeatureRecordV2;
}

export function runInstrumentedSimulation(allData: SymbolData[], targetRMultiple: number): { rows: OutputRow[]; closed: ClosedTradeInternal[] } {
  const states: SymbolState[] = allData.map((data) => ({
    data,
    h1Cursor: 0,
    cachedH1CursorForZones: -1,
    cachedZones: [],
    pending: null,
    open: null,
    nextId: 0,
    ema200: { buffer: [], seeded: false, value: 0, trend: null, trendChangeH1Cursor: 0 },
    pastOutcomes: [],
  }));

  const nCandles = states[0].data.m15All.length;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const rows: OutputRow[] = [];
  const closed: ClosedTradeInternal[] = [];

  for (let i = 2; i < nCandles; i++) {
    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const m15CloseTime = m15All[i].openTime + M15_MS;

      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) {
        const closePrice = h1All[st.h1Cursor].close;
        const tr = st.ema200;
        if (!tr.seeded) {
          tr.buffer.push(closePrice);
          if (tr.buffer.length === EMA_PERIOD_H1) {
            tr.value = tr.buffer.reduce((a, b) => a + b, 0) / EMA_PERIOD_H1;
            tr.seeded = true;
          }
        } else {
          tr.value = closePrice * EMA_K + tr.value * (1 - EMA_K);
        }
        st.h1Cursor++;
        if (tr.seeded) {
          const newTrend: 'UPTREND' | 'DOWNTREND' = closePrice >= tr.value ? 'UPTREND' : 'DOWNTREND';
          if (newTrend !== tr.trend) {
            tr.trend = newTrend;
            tr.trendChangeH1Cursor = st.h1Cursor;
          }
        }
      }
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
          const outcome: Outcome = slTouched ? 'SL' : 'TP';
          const cost = (o.notional * FEE_PCT_SUM) / 100;
          const exitPrice = outcome === 'TP' ? o.tpPrice : o.slPrice;
          const pnl = o.qty * directedDelta(o.direction, o.entryPrice, exitPrice) - cost;
          closed.push({ symbol, outcome, pnl, closeTime: m15CloseTime, features: o.features });
          rows.push({ ...o.features, closeTime: m15CloseTime, won: outcome === 'TP' });
          st.pastOutcomes.push(outcome === 'TP');
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
              const concurrentOpenPositionsCount = exposureState.openPositions.length;
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
                const atrValues = computeAtr(h1Window, ATR_PERIOD);
                const atrH1 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
                const atrH1Pct = (atrH1 / closePrice) * 100;

                const recentAtrValues = atrValues.slice(-ATR_PERCENTILE_WINDOW);
                const atrPercentileH1 =
                  recentAtrValues.length > 0 ? (recentAtrValues.filter((v) => v <= atrH1).length / recentAtrValues.length) * 100 : NaN;

                st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
                const keyZoneDistancePct =
                  st.cachedZones.length > 0
                    ? Math.min(...st.cachedZones.map((z) => (Math.abs(z.price - entryPrice) / entryPrice) * 100))
                    : null;

                const rollingWinRateSameSymbol20 =
                  st.pastOutcomes.length >= ROLLING_WIN_RATE_WINDOW
                    ? st.pastOutcomes.slice(-ROLLING_WIN_RATE_WINDOW).filter(Boolean).length / ROLLING_WIN_RATE_WINDOW
                    : null;

                const features: FeatureRecordV2 = {
                  symbol,
                  entryTimestampUtc: candle.openTime,
                  distanceFromEma200H1Pct: st.ema200.seeded ? ((closePrice - st.ema200.value) / st.ema200.value) * 100 : NaN,
                  slPct,
                  fvgGapSizePct: ((st.pending.gapHigh - st.pending.gapLow) / entryPrice) * 100,
                  waitedCandlesCount: st.pending.waitCount,
                  breaksKeyZone: st.pending.breaksKeyZone,
                  atrH1Pct,
                  hourOfDayUtc: new Date(candle.openTime).getUTCHours(),
                  dayOfWeekUtc: new Date(candle.openTime).getUTCDay(),
                  trendAgeH1Candles: st.h1Cursor - st.ema200.trendChangeH1Cursor,
                  atrPercentileH1,
                  momentumM15Pct3Candles: st.pending.momentumM15Pct3Candles,
                  keyZoneDistancePct,
                  rollingWinRateSameSymbol20,
                  concurrentOpenPositionsCount,
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

        const momentumM15Pct3Candles = i - 4 >= 0 && m15All[i - 4].close !== 0 ? ((m15All[i - 1].close - m15All[i - 4].close) / m15All[i - 4].close) * 100 : NaN;

        st.pending = {
          direction: fvg.direction,
          gapLow: fvg.gapLow,
          gapHigh: fvg.gapHigh,
          invalidationPrice: fvg.invalidationPrice,
          waitCount: 0,
          breaksKeyZone,
          momentumM15Pct3Candles,
        };
      }
    }
  }

  return { rows, closed };
}

function summarizeForCheck(closed: ClosedTradeInternal[]) {
  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of closed) {
    pnl += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return { n: closed.length, pnl, profitFactor };
}

function computeMaxDrawdownPct(closed: ClosedTradeInternal[], startCapital: number): number {
  let equity = startCapital;
  let peak = startCapital;
  let maxDrawdownDollar = 0;
  for (const t of closed) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownDollar) maxDrawdownDollar = drawdown;
  }
  return (maxDrawdownDollar / startCapital) * 100;
}

const CSV_COLUMNS: (keyof OutputRow)[] = [
  'symbol',
  'entryTimestampUtc',
  'closeTime',
  'distanceFromEma200H1Pct',
  'slPct',
  'fvgGapSizePct',
  'waitedCandlesCount',
  'breaksKeyZone',
  'atrH1Pct',
  'hourOfDayUtc',
  'dayOfWeekUtc',
  'trendAgeH1Candles',
  'atrPercentileH1',
  'momentumM15Pct3Candles',
  'keyZoneDistancePct',
  'rollingWinRateSameSymbol20',
  'concurrentOpenPositionsCount',
  'won',
];

function cell(v: unknown): string {
  if (v === null || (typeof v === 'number' && Number.isNaN(v))) return '';
  return String(v);
}

function toCsv(rows: OutputRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => cell((r as any)[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('Dang load du lieu 1 nam (5 coin x H1+M15)...');
  const allData = await loadAllSymbolData(dataDir);
  console.log(`Da load: n=${allData[0].m15All.length} nen M15/coin, 5 coin.`);

  console.log('\nDang chay mirrored simulation (feature set v2 + closeTime, khong qua simulateOneYearNearLive.ts, khong sua xgbFeatureAuditV2.ts)...');
  const { rows, closed } = runInstrumentedSimulation(allData, targetR);

  const s = summarizeForCheck(closed);
  const maxDD = computeMaxDrawdownPct(closed, 10000);
  console.log(`\nKet qua: n=${s.n}  PnL=$${s.pnl.toFixed(2)}  PF=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : 'inf'}  maxDD=${maxDD.toFixed(2)}%`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%');

  const matches = s.n === 1217 && Math.abs(s.pnl - 2628.76) < 0.01 && Math.abs(s.profitFactor - 1.551) < 0.001 && Math.abs(maxDD - 1.24) < 0.01;
  if (!matches) {
    console.error('\nCORRECTION_REQUIRED: mirrored v3 loop KHONG khop voi con so RT-056/057 da chot — DUNG lai, khong ghi dataset.');
    process.exitCode = 1;
    return;
  }
  console.log('\n-> KHOP 100%: feature-set-v2+closeTime trade set == RT-056/057 Config B da chot.');

  const outPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDatasetV3.csv');
  await writeFile(outPath, toCsv(rows), 'utf8');
  console.log(`\nDa ghi ${rows.length} dong (14 feature + closeTime + won) vao ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
