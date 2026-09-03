import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createAtrTracker } from '../src/noTradeZone/atr.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { evaluateBreakoutStrength } from '../src/structure/breakoutStrength.js';
import { detectCompressionSeries, type CompressionResult } from '../src/structure/compression.js';
import { evaluateEmaTrendH1, type EmaTrendSnapshot } from '../src/structure/emaTrendFilterH1.js';
import { aggregateM15ToClosedH1 } from '../src/structure/h1Aggregator.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';
import { calculateExecutionCosts } from '../src/backtest/costModel.js';
import { simulatePositionManagementV2 } from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

const WARNING_NOTE =
  'Du lieu khai thac tham do (data mining) - khong phai ket luan co edge that, ' +
  'can kiem dinh lai tren du lieu khac truoc khi tin.';
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
const RISK_BUDGET_USD = 6;
// User-authorized single-run completion for this run (observed throughput needs ~55-60min total,
// past the ticket's original 30min checkpoint) — kept as a safety ceiling, not a normal stop.
const TIME_BUDGET_MS = 120 * 60 * 1000;
const PROGRESS_EVERY = 1000;

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

// Causal H1/EMA caching: aggregateM15ToClosedH1(m15Candles.slice(0, i)) and evaluateEmaTrendH1's
// own internal re-aggregation both redo O(i) work at every single M15 index — recomputing this
// once per coin (O(n)) and reusing the cached value until the next H1 candle actually closes is
// a strict optimization: aggregateM15ToClosedH1 never looks past the candles it has scanned, so
// its result for any prefix < the next H1 close index is provably identical every step. The H1
// boundary index for each already-closed H1 candle is derived only from that candle's own
// openTime (binary search into m15Candles) — no reimplementation of h1Aggregator's alignment/gap
// logic, so there is nothing here that can silently diverge from it.
function buildH1CloseIndex(m15Candles: readonly Candle[], closedH1: readonly Candle[]): number[] {
  return closedH1.map((h1) => firstIndexWithOpenTimeAtLeast(m15Candles, h1.openTime) + 3);
}

const groupCounts: Record<Group, number> = { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 };
let totalScans = 0;
let missingAtrSkips = 0;
let openDataEndSkips = 0;
let budgetExceeded = false;

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const outputPath = resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining.xlsx');
  const startedAt = Date.now();

  // Streaming writer: ~928k rows overflowed the default in-memory Workbook's heap (confirmed by
  // a real OOM crash), so rows are written to disk as they are classified, not buffered first.
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

  coinLoop: for (const coin of COINS) {
    const m15Candles = await loadCsv(resolve(dataDirectory, `${coin}_15m_3y.csv`));
    const m1Candles = await loadCsv(resolve(dataDirectory, `${coin}_rt094_1m.csv`));

    const atrTracker = createAtrTracker(14);
    const atr15AtIndex: Array<number | null> = m15Candles.map((candle) => atrTracker.next(candle));
    // detectCompressionSeries is mathematically identical to calling detectCompression(m15Candles, i)
    // per index (same Wilder-ATR-freeze math) but computes the whole causal series in one O(n) pass.
    const compressionByIndex = new Map<number, CompressionResult>();
    for (const result of detectCompressionSeries(m15Candles)) compressionByIndex.set(result.windowEndIndex, result);

    const fullClosedH1 = aggregateM15ToClosedH1(m15Candles);
    const h1CloseIndex = buildH1CloseIndex(m15Candles, fullClosedH1);
    const atrH1Tracker = createAtrTracker(14);
    let h1Cursor = 0;
    let atrH1Cache: number | null = null;
    let emaSnapshotCache: EmaTrendSnapshot | null = null;
    let emaComputedOnce = false;

    for (let i = 0; i < m15Candles.length; i += 1) {
      totalScans += 2;
      const atr15 = atr15AtIndex[i];
      if (atr15 === null || !(atr15 > 0)) {
        missingAtrSkips += 2;
        continue;
      }

      const compressionResult = compressionByIndex.get(i) ?? null;
      const breakoutResult = evaluateBreakoutStrength(m15Candles[i], atr15);
      let h1JustClosed = false;
      while (h1Cursor < fullClosedH1.length && h1CloseIndex[h1Cursor] < i) {
        atrH1Cache = atrH1Tracker.next(fullClosedH1[h1Cursor]);
        h1Cursor += 1;
        h1JustClosed = true;
      }
      if (h1JustClosed || !emaComputedOnce) {
        emaSnapshotCache = evaluateEmaTrendH1(m15Candles, i);
        emaComputedOnce = true;
      }
      const emaSnapshot = emaSnapshotCache;
      const atrH1 = atrH1Cache;

      const entryPrice = m15Candles[i].close;
      const entryFillTimestamp = m15Candles[i].openTime + M15_CANDLE_DURATION_MS - 1;
      const postFillM1 = m1Candles.slice(firstM1After(m1Candles, entryFillTimestamp));
      const entryM1Candle = postFillM1[0];

      for (const direction of ['BULL', 'BEAR'] as const) {
        const sign = direction === 'BULL' ? 1 : -1;
        const tradePlan: TradePlan = {
          direction,
          entryPrice,
          stopLoss: entryPrice - sign * atr15,
          takeProfit: entryPrice + sign * atr15,
          riskPerUnit: atr15,
          positionSize: RISK_BUDGET_USD / atr15,
          requiredMargin: 0,
        };
        const execution = simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 });
        if (execution.outcome === 'OPEN_DATA_END') {
          openDataEndSkips += 1;
          continue;
        }
        if (entryM1Candle === undefined) {
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
          m15Candles[i].openTime,
          direction,
          totalGrossR,
          totalNetR,
          atr15,
          compressionResult?.bandwidthAtrRatio ?? null,
          breakoutResult.bodyRatio,
          atrH1,
          emaSnapshot?.emaValue ?? null,
          emaSnapshot?.aboveEma ?? null,
        ]);
        // Row.commit() flushes every buffered row up to and including this one, in order (verified
        // against exceljs's own worksheet-writer.js) — batching this instead of committing every
        // single row cuts stream/zip write syscalls ~500x while keeping peak memory bounded.
        if (rowCountByGroup[group] % 500 === 0) excelRow.commit();
      }

      if (i % PROGRESS_EVERY === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        console.info(
          `${coin} i=${i}/${m15Candles.length} elapsed=${elapsedMin.toFixed(1)}min scans=${totalScans}`,
        );
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          budgetExceeded = true;
          console.info(`TIME BUDGET EXCEEDED (30min) at coin=${coin} i=${i}/${m15Candles.length} — stopping.`);
          break coinLoop;
        }
      }
    }
  }

  for (const group of GROUPS) sheetByGroup[group].commit();

  const elapsedMin = (Date.now() - startedAt) / 60_000;
  const classified = groupCounts.WIN_NET_PROFIT + groupCounts.WIN_FEE_EATEN + groupCounts.LOSS;
  console.info(`DONE${budgetExceeded ? ' (PARTIAL — time budget exceeded)' : ''} in ${elapsedMin.toFixed(1)} min`);
  console.info(`totalScans=${totalScans}, missingAtrSkips=${missingAtrSkips}, openDataEndSkips=${openDataEndSkips}, classified=${classified}`);
  for (const group of GROUPS) {
    const count = groupCounts[group];
    console.info(`${group}: ${count} (${classified === 0 ? 'N/A' : ((100 * count) / classified).toFixed(2)}%)`);
  }

  const summarySheet = workbook.addWorksheet('SUMMARY');
  summarySheet.addRow([WARNING_NOTE]).commit();
  summarySheet.addRow(['metric', 'value']).commit();
  summarySheet.addRow(['partialRun_timeBudgetExceeded', budgetExceeded]).commit();
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
