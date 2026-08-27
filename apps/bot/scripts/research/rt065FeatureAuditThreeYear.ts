import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkNoTradeZone } from '../../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../../src/noTradeZone/types.js';
import { createEmaTracker } from '../../src/regime/ema.js';
import { createAtrTracker } from '../../src/noTradeZone/atr.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import type { Direction } from '../../src/entry/types.js';
import { calculatePositionSize } from '../../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
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

// TICKET-RT-065 Part D step 1: feature-set-v2 dataset (same 14 features as xgbFeatureAuditV2/V3.ts,
// RT-059/061, frozen — NOT imported, NOT modified) recomputed on the 3-year data (RT-065 Part A),
// using the same offset-aware/incremental design as rt065ThreeYearBacktest.ts (RT-065 Part C) —
// checkGridsAlignExactly() + createEmaTracker/createAtrTracker instead of repeated full-window
// computeEma/computeAtr calls. Audit-only, no production file touched.
//
// Self-check, two layers: (1) rerun on the EXISTING 1y data, assert exact match to RT-056/057
// (n=1217, PnL=$2628.76, PF=1.551) — same as every prior feature-audit script; (2) on the 3y data,
// assert the underlying trade set (n/PnL/PF, ignoring features) matches RT-065 Part C's own
// independently-confirmed 3-year numbers (n=3468, PnL=$6638.77, PF=1.429) — proving the feature
// extraction added here doesn't change any entry/exit/admission decision from Part C's simulation.

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
const ATR_PERCENTILE_WINDOW = 100;
const ROLLING_WIN_RATE_WINDOW = 20;

const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

const FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;
const BALANCE = 500;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
const REFERENCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

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

export async function loadAllSymbolData(dataDir: string, suffix: string): Promise<Map<string, SymbolData>> {
  const out = new Map<string, SymbolData>();
  for (const symbol of SYMBOLS) {
    const m15All = await readCsv(path.join(dataDir, `${symbol}_15m_${suffix}.csv`));
    const h1All = await readCsv(path.join(dataDir, `${symbol}_1h_${suffix}.csv`));
    out.set(symbol, { symbol, m15All, h1All });
  }
  return out;
}

export interface GridCheckResult {
  m15Offset: Map<string, number>;
  h1Offset: Map<string, number>;
  referenceM15Length: number;
}

export function checkGridsAlignExactly(allData: Map<string, SymbolData>): GridCheckResult {
  const ref = allData.get(REFERENCE_SYMBOLS[0])!;
  for (const sym of REFERENCE_SYMBOLS.slice(1)) {
    const d = allData.get(sym)!;
    if (d.m15All.length !== ref.m15All.length || d.h1All.length !== ref.h1All.length) {
      throw new Error(`CORRECTION_REQUIRED: ${sym} co do dai grid khac ${REFERENCE_SYMBOLS[0]} — dung lai.`);
    }
    for (let i = 0; i < ref.m15All.length; i++) {
      if (d.m15All[i].openTime !== ref.m15All[i].openTime) throw new Error(`CORRECTION_REQUIRED: ${sym} M15 grid lech tai index ${i} — dung lai.`);
    }
    for (let i = 0; i < ref.h1All.length; i++) {
      if (d.h1All[i].openTime !== ref.h1All[i].openTime) throw new Error(`CORRECTION_REQUIRED: ${sym} H1 grid lech tai index ${i} — dung lai.`);
    }
  }

  const m15Offset = new Map<string, number>();
  const h1Offset = new Map<string, number>();
  for (const sym of REFERENCE_SYMBOLS) {
    m15Offset.set(sym, 0);
    h1Offset.set(sym, 0);
  }

  for (const [sym, data] of allData) {
    if (REFERENCE_SYMBOLS.includes(sym)) continue;
    if (data.m15All.length === 0 || data.h1All.length === 0) throw new Error(`CORRECTION_REQUIRED: ${sym} khong co du lieu — dung lai.`);
    const m15Idx = ref.m15All.findIndex((c) => c.openTime === data.m15All[0].openTime);
    const h1Idx = ref.h1All.findIndex((c) => c.openTime === data.h1All[0].openTime);
    if (m15Idx < 0 || h1Idx < 0) throw new Error(`CORRECTION_REQUIRED: khong tim thay candle dau tien cua ${sym} trong grid tham chieu — dung lai.`);
    if (m15Idx + data.m15All.length !== ref.m15All.length) throw new Error(`CORRECTION_REQUIRED: ${sym} M15 khong phai doan lien tuc o cuoi grid — dung lai.`);
    if (h1Idx + data.h1All.length !== ref.h1All.length) throw new Error(`CORRECTION_REQUIRED: ${sym} H1 khong phai doan lien tuc o cuoi grid — dung lai.`);
    for (let i = 0; i < data.m15All.length; i++) {
      if (data.m15All[i].openTime !== ref.m15All[m15Idx + i].openTime) throw new Error(`CORRECTION_REQUIRED: ${sym} M15 khong khop tai local index ${i} — dung lai.`);
    }
    for (let i = 0; i < data.h1All.length; i++) {
      if (data.h1All[i].openTime !== ref.h1All[h1Idx + i].openTime) throw new Error(`CORRECTION_REQUIRED: ${sym} H1 khong khop tai local index ${i} — dung lai.`);
    }
    m15Offset.set(sym, m15Idx);
    h1Offset.set(sym, h1Idx);
  }

  return { m15Offset, h1Offset, referenceM15Length: ref.m15All.length };
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
export interface ClosedTradeInternal {
  symbol: string;
  outcome: Outcome;
  pnl: number;
  closeTime: number;
  features: FeatureRecordV2;
}
interface SymbolState {
  data: SymbolData;
  m15Offset: number;
  h1Cursor: number;
  cachedH1CursorForZones: number;
  cachedZones: KeyZone[];
  pending: PendingFvg | null;
  open: OpenTrade | null;
  nextId: number;
  emaTracker: ReturnType<typeof createEmaTracker>;
  atrTracker: ReturnType<typeof createAtrTracker>;
  currentEma: number | null;
  currentAtr: number | null;
  trend: 'UPTREND' | 'DOWNTREND' | null;
  trendChangeH1Cursor: number;
  atrHistory: number[]; // ring-ish buffer, last ATR_PERCENTILE_WINDOW values
  pastOutcomes: boolean[];
}

export function runInstrumentedSimulation(allData: Map<string, SymbolData>, grid: GridCheckResult, targetRMultiple: number): { rows: OutputRow[]; closed: ClosedTradeInternal[] } {
  const states: SymbolState[] = SYMBOLS.map((symbol) => ({
    data: allData.get(symbol)!,
    m15Offset: grid.m15Offset.get(symbol)!,
    h1Cursor: 0,
    cachedH1CursorForZones: -1,
    cachedZones: [],
    pending: null,
    open: null,
    nextId: 0,
    emaTracker: createEmaTracker(EMA_PERIOD_H1),
    atrTracker: createAtrTracker(ATR_PERIOD),
    currentEma: null,
    currentAtr: null,
    trend: null,
    trendChangeH1Cursor: 0,
    atrHistory: [],
    pastOutcomes: [],
  }));

  const referenceM15 = allData.get(REFERENCE_SYMBOLS[0])!.m15All;
  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const rows: OutputRow[] = [];
  const closed: ClosedTradeInternal[] = [];

  for (let i = 2; i < grid.referenceM15Length; i++) {
    const m15CloseTime = referenceM15[i].openTime + M15_MS;

    for (const st of states) {
      const { symbol, m15All, h1All } = st.data;
      const localI = i - st.m15Offset;
      if (localI < 2 || localI >= m15All.length) continue;

      while (st.h1Cursor < h1All.length && h1All[st.h1Cursor].openTime + H1_MS <= m15CloseTime) {
        const h1Candle = h1All[st.h1Cursor];
        st.currentEma = st.emaTracker.next(h1Candle.close);
        st.currentAtr = st.atrTracker.next(h1Candle);
        if (st.currentAtr !== null) {
          st.atrHistory.push(st.currentAtr);
          if (st.atrHistory.length > ATR_PERCENTILE_WINDOW) st.atrHistory.shift();
        }
        st.h1Cursor++;
        if (st.currentEma !== null) {
          const newTrend: 'UPTREND' | 'DOWNTREND' = h1Candle.close >= st.currentEma ? 'UPTREND' : 'DOWNTREND';
          if (newTrend !== st.trend) {
            st.trend = newTrend;
            st.trendChangeH1Cursor = st.h1Cursor;
          }
        }
      }
      if (st.h1Cursor === 0) continue;

      const h1Window = h1All.slice(0, st.h1Cursor);
      const m15Window = m15All.slice(0, localI + 1);
      const closePrice = h1Window[h1Window.length - 1].close;
      const candle = m15All[localI];

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
                const atrH1 = st.currentAtr ?? 0;
                const atrH1Pct = (atrH1 / closePrice) * 100;
                const atrPercentileH1 = st.atrHistory.length > 0 ? (st.atrHistory.filter((v) => v <= atrH1).length / st.atrHistory.length) * 100 : NaN;

                st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
                const keyZoneDistancePct = st.cachedZones.length > 0 ? Math.min(...st.cachedZones.map((z) => (Math.abs(z.price - entryPrice) / entryPrice) * 100)) : null;

                const rollingWinRateSameSymbol20 =
                  st.pastOutcomes.length >= ROLLING_WIN_RATE_WINDOW ? st.pastOutcomes.slice(-ROLLING_WIN_RATE_WINDOW).filter(Boolean).length / ROLLING_WIN_RATE_WINDOW : null;

                const features: FeatureRecordV2 = {
                  symbol,
                  entryTimestampUtc: candle.openTime,
                  distanceFromEma200H1Pct: st.currentEma !== null ? ((closePrice - st.currentEma) / st.currentEma) * 100 : NaN,
                  slPct,
                  fvgGapSizePct: ((st.pending.gapHigh - st.pending.gapLow) / entryPrice) * 100,
                  waitedCandlesCount: st.pending.waitCount,
                  breaksKeyZone: st.pending.breaksKeyZone,
                  atrH1Pct,
                  hourOfDayUtc: new Date(candle.openTime).getUTCHours(),
                  dayOfWeekUtc: new Date(candle.openTime).getUTCDay(),
                  trendAgeH1Candles: st.h1Cursor - st.trendChangeH1Cursor,
                  atrPercentileH1,
                  momentumM15Pct3Candles: st.pending.momentumM15Pct3Candles,
                  keyZoneDistancePct,
                  rollingWinRateSameSymbol20,
                  concurrentOpenPositionsCount,
                };

                st.open = { id, direction, entryPrice, slPrice, tpPrice, slDistance, qty: result.qty, notional: result.notional, features };
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
      if (st.currentEma === null) continue;

      const trendDirection: Direction = closePrice >= st.currentEma ? 'LONG' : 'SHORT';
      const fvg = detectFvg(m15All[localI - 2], m15All[localI - 1], m15All[localI], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
      if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
        if (st.h1Cursor !== st.cachedH1CursorForZones) {
          st.cachedH1CursorForZones = st.h1Cursor;
          const atrH1 = st.currentAtr ?? 0;
          st.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, FVG_KEY_ZONE_CONFIG) : [];
        }
        const gapLow = fvg.gapLow;
        const gapHigh = fvg.gapHigh;
        const breaksKeyZone = st.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);
        const momentumM15Pct3Candles = localI - 4 >= 0 && m15All[localI - 4].close !== 0 ? ((m15All[localI - 1].close - m15All[localI - 4].close) / m15All[localI - 4].close) * 100 : NaN;

        st.pending = { direction: fvg.direction, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, invalidationPrice: fvg.invalidationPrice, waitCount: 0, breaksKeyZone, momentumM15Pct3Candles };
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

  console.log('=== Self-check lop 1: chay tren du lieu 1 nam hien co, doi chieu RT-056/057 ===');
  const data1y = await loadAllSymbolData(dataDir, '1y');
  const grid1y = checkGridsAlignExactly(data1y);
  const { closed: closed1y } = runInstrumentedSimulation(data1y, grid1y, targetR);
  const s1y = summarizeForCheck(closed1y);
  console.log(`n=${s1y.n}  PnL=$${s1y.pnl.toFixed(2)}  PF=${s1y.profitFactor.toFixed(3)} (doi chieu: n=1217, PnL=$2628.76, PF=1.551)`);
  const matches1y = s1y.n === 1217 && Math.abs(s1y.pnl - 2628.76) < 0.01 && Math.abs(s1y.profitFactor - 1.551) < 0.001;
  if (!matches1y) {
    console.error('CORRECTION_REQUIRED: khong khop RT-056/057 tren du lieu 1 nam — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  console.log('=== Self-check lop 2: chay tren du lieu 3 nam, doi chieu RT-065 Part C ===');
  const data3y = await loadAllSymbolData(dataDir, '3y');
  const grid3y = checkGridsAlignExactly(data3y);
  const startTime = Date.now();
  const { rows, closed } = runInstrumentedSimulation(data3y, grid3y, targetR);
  console.log(`Chay xong trong ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);
  const s3y = summarizeForCheck(closed);
  console.log(`n=${s3y.n}  PnL=$${s3y.pnl.toFixed(2)}  PF=${s3y.profitFactor.toFixed(3)} (doi chieu RT-065 Part C: n=3468, PnL=$6638.77, PF=1.429)`);
  const matches3y = s3y.n === 3468 && Math.abs(s3y.pnl - 6638.77) < 0.01 && Math.abs(s3y.profitFactor - 1.429) < 0.001;
  if (!matches3y) {
    console.error('CORRECTION_REQUIRED: khong khop RT-065 Part C tren du lieu 3 nam — feature extraction co the da lam thay doi quyet dinh admission — DUNG lai, khong ghi dataset.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%: feature extraction khong lam thay doi tap lenh cua Part C.\n');

  const outPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDatasetThreeYear.csv');
  await writeFile(outPath, toCsv(rows), 'utf8');
  console.log(`Da ghi ${rows.length} dong vao ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
