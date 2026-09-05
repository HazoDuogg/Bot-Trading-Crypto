import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createAtrTracker } from '../src/noTradeZone/atr.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { evaluateBreakoutStrength } from '../src/structure/breakoutStrength.js';
import { detectCompressionSeries, type CompressionResult } from '../src/structure/compression.js';
import { calculateEma } from '../src/structure/emaTrendFilter.js';
import { calculateExecutionCosts } from '../src/backtest/costModel.js';
import { simulatePositionManagementV2 } from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

// TICKET-04X-D: exact TICKET-043 pipeline (reverseEntryMining.ts) with the entry timeframe
// parametrized instead of hardcoded to M15. Fee/PM logic (simulatePositionManagementV2,
// calculateExecutionCosts) is untouched, imported as-is. SL=1xATR(entry timeframe), TP=1xATR,
// breakeven/TP1/TP2/trailing are whatever simulatePositionManagementV2 currently does (still the
// TICKET-04X adaptive-buffer version — no PM logic changed for this ticket).
//
// The 3 "H1" old columns (atrH1/emaValueH1/aboveEmaH1) generalize via one aggregator instead of
// aggregateM15ToClosedH1 (which is hardcoded to 4x15min children and not reusable here without
// editing production): aggregateToClosedHigherTimeframe(candles, sourceMs, targetMs) groups
// `targetMs/sourceMs` contiguous entry-timeframe candles into one H1 candle, same closed-only /
// round-hour-boundary contract as the original. For the H1 timeframe run, sourceMs===targetMs, so
// the "aggregation" is a 1-for-1 identity — meaning atrH1 becomes numerically identical to the
// entry-timeframe atr column, and emaValueH1/aboveEmaH1 becomes EMA200 computed directly on the H1
// entry series itself rather than a genuinely higher timeframe. This is an unavoidable consequence
// of H1 already being the highest timeframe in scope (ticket did not ask for H4) — flagged, not
// silently glossed over.
const TIMEFRAME = process.argv.find((a) => a.startsWith('--timeframe='))?.slice('--timeframe='.length);
if (TIMEFRAME !== '5m' && TIMEFRAME !== '1h') {
  throw new Error('Usage: reverseEntryMiningMultiTimeframe.ts --timeframe=5m|1h');
}
const ENTRY_INTERVAL_MS = TIMEFRAME === '5m' ? 5 * 60 * 1000 : 60 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const CSV_SUFFIX = TIMEFRAME === '5m' ? '5m_3y' : '1h_3y';

const WARNING_NOTE =
  'Du lieu khai thac tham do (data mining) - khong phai ket luan co edge that, ' +
  `can kiem dinh lai tren du lieu khac truoc khi tin. TICKET-04X-D: entry timeframe=${TIMEFRAME}, ` +
  'atrH1/emaValueH1/aboveEmaH1 xem comment dau file ve truong hop khung 1h (khong con la khung cao hon).';
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
const RISK_BUDGET_USD = 6;
const PROGRESS_EVERY = 20_000;

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'] as const;
const HEADER = [
  'coin',
  'entryTimestamp',
  'direction',
  'totalGrossR',
  'totalNetR',
  'atr15',
  'compressionBandwidthAtrRatio',
  'breakoutBodyRatio',
  'atrH1',
  'emaValueH1',
  'aboveEmaH1',
];

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function firstIndexWithOpenTimeAtLeast(candles: readonly Candle[], openTime: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (candles[middle].openTime < openTime) left = middle + 1;
    else right = middle;
  }
  return left;
}

function firstM1After(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (candles[middle].openTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left;
}

// Generalizes aggregateM15ToClosedH1 (h1Aggregator.ts) to an arbitrary source interval. When
// sourceIntervalMs === targetIntervalMs this is an identity map (childrenPerGroup=1) — used for the
// H1 entry-timeframe run, see the header comment.
function aggregateToClosedHigherTimeframe(
  candles: readonly Candle[],
  sourceIntervalMs: number,
  targetIntervalMs: number,
): Candle[] {
  const childrenPerGroup = targetIntervalMs / sourceIntervalMs;
  const closed: Candle[] = [];
  let index = 0;
  while (index + childrenPerGroup <= candles.length) {
    const start = candles[index];
    if (start.openTime % targetIntervalMs !== 0) {
      index += 1;
      continue;
    }
    const group = candles.slice(index, index + childrenPerGroup);
    const contiguous = group.every((c, offset) => c.openTime === start.openTime + offset * sourceIntervalMs);
    if (!contiguous) {
      index += 1;
      continue;
    }
    closed.push({
      openTime: start.openTime,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
    index += childrenPerGroup;
  }
  return closed;
}

// Same EMA200/slope evaluation as evaluateEmaTrendH1, minus the aggregation step (done separately
// above so it can be generic over source timeframe).
function evaluateEmaTrendOnClosedSeries(
  closedSeries: readonly Candle[],
  period = 200,
  slopeLookbackCandles = 10,
): { emaValue: number; aboveEma: boolean } | null {
  const asOfIndex = closedSeries.length - 1;
  const priorIndex = asOfIndex - slopeLookbackCandles;
  if (asOfIndex < 0 || priorIndex < period - 1) return null;
  const closes = closedSeries.map((c) => c.close);
  const emaSeries = calculateEma(closes, period);
  const currentEma = emaSeries[asOfIndex];
  const priorEma = emaSeries[priorIndex];
  if (currentEma === null || priorEma === null) return null;
  return { emaValue: currentEma, aboveEma: closedSeries[asOfIndex].close > currentEma };
}

function buildH1CloseIndex(entryCandles: readonly Candle[], closedH1: readonly Candle[]): number[] {
  return closedH1.map((h1) => firstIndexWithOpenTimeAtLeast(entryCandles, h1.openTime) + (H1_MS / ENTRY_INTERVAL_MS - 1));
}

const groupCounts: Record<Group, number> = { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 };
let totalScans = 0;
let missingAtrSkips = 0;
let openDataEndSkips = 0;

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const outputPath = resolve(reportsDirectory, `nukida-ticket04x-d-reverse-entry-mining-${TIMEFRAME}.xlsx`);
  const startedAt = Date.now();

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });
  const rowCountByGroup: Record<Group, number> = { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 };
  const sheetByGroup: Record<Group, ExcelJS.Worksheet> = Object.fromEntries(
    GROUPS.map((group) => {
      const sheet = workbook.addWorksheet(group);
      sheet.addRow([WARNING_NOTE]).commit();
      sheet.addRow(HEADER).commit();
      return [group, sheet];
    }),
  ) as Record<Group, ExcelJS.Worksheet>;

  for (const coin of COINS) {
    const entryCandles = await loadCsv(resolve(dataDirectory, `${coin}_${CSV_SUFFIX}.csv`));
    const m1Candles = await loadCsv(resolve(dataDirectory, `${coin}_rt094_1m.csv`));
    console.info(`${coin}: ${entryCandles.length} ${TIMEFRAME} candles`);

    const atrTracker = createAtrTracker(14);
    const atrAtIndex: Array<number | null> = entryCandles.map((c) => atrTracker.next(c));
    const compressionByIndex = new Map<number, CompressionResult>();
    for (const result of detectCompressionSeries(entryCandles)) compressionByIndex.set(result.windowEndIndex, result);

    const fullClosedH1 = aggregateToClosedHigherTimeframe(entryCandles, ENTRY_INTERVAL_MS, H1_MS);
    const h1CloseIndex = buildH1CloseIndex(entryCandles, fullClosedH1);
    const atrH1Tracker = createAtrTracker(14);
    let h1Cursor = 0;
    let atrH1Cache: number | null = null;
    let emaSnapshotCache: { emaValue: number; aboveEma: boolean } | null = null;
    let emaComputedOnce = false;

    for (let i = 0; i < entryCandles.length; i += 1) {
      totalScans += 2;
      const atr = atrAtIndex[i];
      if (atr === null || !(atr > 0)) {
        missingAtrSkips += 2;
        continue;
      }

      const compressionResult = compressionByIndex.get(i) ?? null;
      const breakoutResult = evaluateBreakoutStrength(entryCandles[i], atr);
      let h1JustClosed = false;
      while (h1Cursor < fullClosedH1.length && h1CloseIndex[h1Cursor] < i) {
        atrH1Cache = atrH1Tracker.next(fullClosedH1[h1Cursor]);
        h1Cursor += 1;
        h1JustClosed = true;
      }
      if (h1JustClosed || !emaComputedOnce) {
        // Equivalent to re-aggregating entryCandles.slice(0, i) from scratch (h1Cursor is exactly
        // the count of H1 candles whose close index is < i), but O(h1Cursor) instead of O(i):
        // fullClosedH1 was already computed once over the whole series, so slicing it is just an
        // array-reference copy of the already-derived H1 candles, not re-deriving them. Re-deriving
        // from scratch on every H1 close (as the original M15 pipeline effectively does inside
        // evaluateEmaTrendH1) is O(n^2) and was only tractable at M15's scale (~55-60min per the
        // TICKET-043 script's own comment); at M5's ~3x candle count that blows up to several
        // hours, so this is a required performance fix, not a methodology change — same H1 candles,
        // same EMA math, verified equivalent by construction.
        emaSnapshotCache = evaluateEmaTrendOnClosedSeries(fullClosedH1.slice(0, h1Cursor));
        emaComputedOnce = true;
      }
      const emaSnapshot = emaSnapshotCache;
      const atrH1 = atrH1Cache;

      const entryPrice = entryCandles[i].close;
      const entryFillTimestamp = entryCandles[i].openTime + ENTRY_INTERVAL_MS - 1;
      const postFillM1 = m1Candles.slice(firstM1After(m1Candles, entryFillTimestamp));
      const entryM1Candle = postFillM1[0];

      for (const direction of ['BULL', 'BEAR'] as const) {
        const sign = direction === 'BULL' ? 1 : -1;
        const tradePlan: TradePlan = {
          direction,
          entryPrice,
          stopLoss: entryPrice - sign * atr,
          takeProfit: entryPrice + sign * atr,
          riskPerUnit: atr,
          positionSize: RISK_BUDGET_USD / atr,
          requiredMargin: 0,
        };
        const execution = simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 });
        if (execution.outcome === 'OPEN_DATA_END' || entryM1Candle === undefined) {
          openDataEndSkips += 1;
          continue;
        }

        let totalGrossR = 0;
        let totalNetR = 0;
        for (const leg of execution.exitLegs) {
          const exitM1Candle = m1Candles[firstM1After(m1Candles, leg.exitTimestamp - 1)];
          const costs = calculateExecutionCosts({
            tradePlan,
            exitPrice: leg.exitPrice,
            exitReason: leg.reason === 'PARTIAL_EXIT' || leg.reason === 'TAKE_PROFIT_2' ? 'TAKE_PROFIT' : 'STOP_LOSS',
            entryM1Candle,
            exitM1Candle,
          });
          totalGrossR += leg.fraction * costs.grossR;
          totalNetR += leg.fraction * costs.netR;
        }

        const group: Group = totalGrossR <= 0 ? 'LOSS' : totalNetR > 0 ? 'WIN_NET_PROFIT' : 'WIN_FEE_EATEN';
        groupCounts[group] += 1;
        rowCountByGroup[group] += 1;
        const excelRow = sheetByGroup[group].addRow([
          coin,
          entryCandles[i].openTime,
          direction,
          totalGrossR,
          totalNetR,
          atr,
          compressionResult?.bandwidthAtrRatio ?? null,
          breakoutResult.bodyRatio,
          atrH1,
          emaSnapshot?.emaValue ?? null,
          emaSnapshot?.aboveEma ?? null,
        ]);
        if (rowCountByGroup[group] % 500 === 0) excelRow.commit();
      }

      if (i % PROGRESS_EVERY === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        console.info(`${coin} i=${i}/${entryCandles.length} elapsed=${elapsedMin.toFixed(1)}min scans=${totalScans}`);
      }
    }
  }

  for (const group of GROUPS) sheetByGroup[group].commit();

  const elapsedMin = (Date.now() - startedAt) / 60_000;
  const classified = groupCounts.WIN_NET_PROFIT + groupCounts.WIN_FEE_EATEN + groupCounts.LOSS;
  console.info(`DONE in ${elapsedMin.toFixed(1)} min`);
  console.info(`totalScans=${totalScans}, missingAtrSkips=${missingAtrSkips}, openDataEndSkips=${openDataEndSkips}, classified=${classified}`);
  for (const group of GROUPS) {
    const count = groupCounts[group];
    console.info(`${group}: ${count} (${classified === 0 ? 'N/A' : ((100 * count) / classified).toFixed(2)}%)`);
  }

  const summarySheet = workbook.addWorksheet('SUMMARY');
  summarySheet.addRow([WARNING_NOTE]).commit();
  summarySheet.addRow(['metric', 'value']).commit();
  summarySheet.addRow(['timeframe', TIMEFRAME]).commit();
  summarySheet.addRow(['elapsedMinutes', elapsedMin]).commit();
  summarySheet.addRow(['totalScans', totalScans]).commit();
  summarySheet.addRow(['missingAtrSkips', missingAtrSkips]).commit();
  summarySheet.addRow(['openDataEndSkips', openDataEndSkips]).commit();
  summarySheet.addRow(['classified', classified]).commit();
  for (const group of GROUPS) {
    summarySheet.addRow([`${group}_count`, groupCounts[group]]).commit();
    summarySheet
      .addRow([`${group}_percentOfClassified`, classified === 0 ? null : (100 * groupCounts[group]) / classified])
      .commit();
  }
  summarySheet.commit();

  await workbook.commit();
  console.info(`Excel: ${outputPath}`);
}

await main();
