import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createAtrTracker } from '../src/noTradeZone/atr.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { evaluateBreakoutStrength } from '../src/structure/breakoutStrength.js';
import { detectCompressionSeries, type CompressionResult } from '../src/structure/compression.js';
import { calculateEma } from '../src/structure/emaTrendFilter.js';
import { evaluateEmaTrendH1, type EmaTrendSnapshot } from '../src/structure/emaTrendFilterH1.js';
import { aggregateM15ToClosedH1 } from '../src/structure/h1Aggregator.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';
import { calculateExecutionCosts } from '../src/backtest/costModel.js';
import { simulatePositionManagementV2 } from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

// Follow-up to TICKET-043: same random-M15-entry / fixed-1xATR15-stop / position-management-V2
// simulation, with a wider set of causal, per-trade indicators recorded for edge-hunting.
// Data mining only — not a source-backed edge until re-validated on held-out data.
const WARNING_NOTE =
  'Du lieu khai thac tham do (data mining) - khong phai ket luan co edge that, ' +
  'can kiem dinh lai tren du lieu khac truoc khi tin.';
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
const RISK_BUDGET_USD = 6;
const EMA_M15_PERIOD = 50;
const MOMENTUM_LOOKBACKS = [5, 10, 20] as const;
const ROLLING_WINDOW = 20;
// Safety ceiling, not a normal stop — the ticket's original mining run needed ~38min for the base
// indicator set; this run adds only O(1)/O(window) indicators so should be in the same ballpark.
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
  'distFromEmaH1Atr',
  'emaValueM15',
  'aboveEmaM15',
  'distFromEmaM15Atr',
  'momentum5Atr',
  'momentum10Atr',
  'momentum20Atr',
  'consecutiveSameColor',
  'relativeVolume20',
  'atrExpansionRatio20',
  'distToHigh20Atr',
  'distToLow20Atr',
  'hourUtc',
  'dayOfWeekUtc',
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

// Same provably-safe H1/EMA-H1 caching as reverseEntryMining.ts — see that file's comment for
// the correctness argument (derived only from aggregateM15ToClosedH1's own openTime output via
// binary search, no reimplementation of its alignment/gap logic).
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
  const outputPath = resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining-v2.xlsx');
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

  coinLoop: for (const coin of COINS) {
    const m15Candles = await loadCsv(resolve(dataDirectory, `${coin}_15m_3y.csv`));
    const m1Candles = await loadCsv(resolve(dataDirectory, `${coin}_rt094_1m.csv`));

    const atrTracker = createAtrTracker(14);
    const atr15AtIndex: Array<number | null> = m15Candles.map((candle) => atrTracker.next(candle));
    const compressionByIndex = new Map<number, CompressionResult>();
    for (const result of detectCompressionSeries(m15Candles)) compressionByIndex.set(result.windowEndIndex, result);

    const fullClosedH1 = aggregateM15ToClosedH1(m15Candles);
    const h1CloseIndex = buildH1CloseIndex(m15Candles, fullClosedH1);
    const atrH1Tracker = createAtrTracker(14);
    let h1Cursor = 0;
    let atrH1Cache: number | null = null;
    let emaSnapshotCache: EmaTrendSnapshot | null = null;
    let emaComputedOnce = false;

    // calculateEma is a single O(n) batch pass over the full closing-price series — no per-index
    // recomputation risk (unlike H1 aggregation, this needs no window truncation to stay causal:
    // each entry only ever depends on candles at or before its own index).
    const closes = m15Candles.map((c) => c.close);
    const emaM15Series = calculateEma(closes, EMA_M15_PERIOD);

    let streak = 0; // signed: positive = up-close streak length, negative = down-close streak
    let volumeWindowSum = 0;

    for (let i = 0; i < m15Candles.length; i += 1) {
      totalScans += 2;
      const current = m15Candles[i];
      volumeWindowSum += current.volume;
      if (i >= ROLLING_WINDOW) volumeWindowSum -= m15Candles[i - ROLLING_WINDOW].volume;

      if (current.close > current.open) streak = streak > 0 ? streak + 1 : 1;
      else if (current.close < current.open) streak = streak < 0 ? streak - 1 : -1;
      else streak = 0;

      const atr15 = atr15AtIndex[i];
      if (atr15 === null || !(atr15 > 0)) {
        missingAtrSkips += 2;
        continue;
      }

      const compressionResult = compressionByIndex.get(i) ?? null;
      const breakoutResult = evaluateBreakoutStrength(current, atr15);
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

      const entryPrice = current.close;
      const emaM15Value = emaM15Series[i];
      const distFromEmaM15Atr = emaM15Value === null ? null : (entryPrice - emaM15Value) / atr15;
      const distFromEmaH1Atr = emaSnapshot === null ? null : (entryPrice - emaSnapshot.emaValue) / atr15;

      const momenta = MOMENTUM_LOOKBACKS.map((n) => (i >= n ? (entryPrice - closes[i - n]) / atr15 : null));

      const windowStart = Math.max(0, i - ROLLING_WINDOW + 1);
      let windowHigh = Number.NEGATIVE_INFINITY;
      let windowLow = Number.POSITIVE_INFINITY;
      for (let w = windowStart; w <= i; w += 1) {
        windowHigh = Math.max(windowHigh, m15Candles[w].high);
        windowLow = Math.min(windowLow, m15Candles[w].low);
      }
      const distToHigh20Atr = (windowHigh - entryPrice) / atr15;
      const distToLow20Atr = (entryPrice - windowLow) / atr15;

      const relativeVolume20 = i >= ROLLING_WINDOW - 1 ? current.volume / (volumeWindowSum / Math.min(i + 1, ROLLING_WINDOW)) : null;
      const atr15Lookback = i >= ROLLING_WINDOW ? atr15AtIndex[i - ROLLING_WINDOW] : null;
      const atrExpansionRatio20 = atr15Lookback !== null && atr15Lookback > 0 ? atr15 / atr15Lookback : null;

      const date = new Date(current.openTime);
      const hourUtc = date.getUTCHours();
      const dayOfWeekUtc = date.getUTCDay();

      const entryFillTimestamp = current.openTime + M15_CANDLE_DURATION_MS - 1;
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
          current.openTime,
          direction,
          totalGrossR,
          totalNetR,
          atr15,
          compressionResult?.bandwidthAtrRatio ?? null,
          breakoutResult.bodyRatio,
          atrH1,
          emaSnapshot?.emaValue ?? null,
          emaSnapshot?.aboveEma ?? null,
          distFromEmaH1Atr,
          emaM15Value,
          emaM15Value === null ? null : entryPrice > emaM15Value,
          distFromEmaM15Atr,
          momenta[0],
          momenta[1],
          momenta[2],
          streak,
          relativeVolume20,
          atrExpansionRatio20,
          distToHigh20Atr,
          distToLow20Atr,
          hourUtc,
          dayOfWeekUtc,
        ]);
        if (rowCountByGroup[group] % 500 === 0) excelRow.commit();
      }

      if (i % PROGRESS_EVERY === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        console.info(`${coin} i=${i}/${m15Candles.length} elapsed=${elapsedMin.toFixed(1)}min scans=${totalScans}`);
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          budgetExceeded = true;
          console.info(`TIME BUDGET EXCEEDED at coin=${coin} i=${i}/${m15Candles.length} — stopping.`);
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
