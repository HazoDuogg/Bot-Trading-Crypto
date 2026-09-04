import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';
import { calculateExecutionCosts } from '../src/backtest/costModel.js';
import { simulatePositionManagementV2 } from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

// TICKET-04X item 4/5: before/after comparison of the adaptive breakeven buffer, held out to the
// OOS half of TICKET-043's reverse-entry mining population (entryTimestamp >= splitTimestamp, the
// same split breakevenBufferCostFit.ts fit on). "Before" is read directly off the existing mining
// files (fixed 0.05R buffer); "after" re-simulates the same (coin, entryTimestamp, direction)
// population with the now-adaptive simulatePositionManagementV2 and reclassifies WIN_NET_PROFIT /
// WIN_FEE_EATEN / LOSS exactly as reverseEntryMining.ts does.
const RISK_BUDGET_USD = 6;
const SPLIT_TIMESTAMP = 1_740_536_100_000;

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS: readonly Group[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'];
const REPORTS_FILES: Array<{ file: string; sheet: Group }> = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];

interface SourceRow {
  originalGroup: Group;
  coin: string;
  entryTimestamp: number;
  direction: 'BULL' | 'BEAR';
  totalGrossR: number;
  totalNetR: number;
  atr15: number;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
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

async function readOosRows(path: string, sheetName: Group): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: SourceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    const entryTimestamp = Number(v[2]);
    if (entryTimestamp < SPLIT_TIMESTAMP) return;
    out.push({
      originalGroup: sheetName,
      coin: String(v[1]),
      entryTimestamp,
      direction: v[3] as 'BULL' | 'BEAR',
      totalGrossR: Number(v[4]),
      totalNetR: Number(v[5]),
      atr15: Number(v[6]),
    });
  });
  return out;
}

interface Accumulator {
  count: number;
  sumGrossR: number;
  sumNetR: number;
}

function emptyAcc(): Accumulator {
  return { count: 0, sumGrossR: 0, sumNetR: 0 };
}

function addTo(acc: Accumulator, grossR: number, netR: number): void {
  acc.count += 1;
  acc.sumGrossR += grossR;
  acc.sumNetR += netR;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const startedAt = Date.now();

  const allRows: SourceRow[] = [];
  for (const { file, sheet } of REPORTS_FILES) {
    const rows = await readOosRows(resolve(reportsDirectory, file), sheet);
    console.info(`${sheet}: ${rows.length} OOS rows (entryTimestamp >= ${SPLIT_TIMESTAMP})`);
    for (const row of rows) allRows.push(row);
  }
  console.info(`Total OOS rows: ${allRows.length}`);

  const beforeByGroup: Record<Group, Accumulator> = {
    WIN_NET_PROFIT: emptyAcc(),
    WIN_FEE_EATEN: emptyAcc(),
    LOSS: emptyAcc(),
  };
  const afterByGroup: Record<Group, Accumulator> = {
    WIN_NET_PROFIT: emptyAcc(),
    WIN_FEE_EATEN: emptyAcc(),
    LOSS: emptyAcc(),
  };
  // transition[before][after] = count
  const transition: Record<Group, Record<Group, number>> = {
    WIN_NET_PROFIT: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
    WIN_FEE_EATEN: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
    LOSS: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 },
  };

  let currentCoin: string | null = null;
  let m1Candles: Candle[] = [];
  let m15CloseByOpenTime = new Map<number, number>();
  let unresolved = 0;

  for (let idx = 0; idx < allRows.length; idx += 1) {
    const row = allRows[idx];
    addTo(beforeByGroup[row.originalGroup], row.totalGrossR, row.totalNetR);

    if (row.coin !== currentCoin) {
      currentCoin = row.coin;
      const m15Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_15m_3y.csv`));
      m1Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_rt094_1m.csv`));
      m15CloseByOpenTime = new Map(m15Candles.map((c) => [c.openTime, c.close]));
    }
    const entryPrice = m15CloseByOpenTime.get(row.entryTimestamp);
    if (entryPrice === undefined) {
      unresolved += 1;
      continue;
    }

    const sign = row.direction === 'BULL' ? 1 : -1;
    const tradePlan: TradePlan = {
      direction: row.direction,
      entryPrice,
      stopLoss: entryPrice - sign * row.atr15,
      takeProfit: entryPrice + sign * row.atr15,
      riskPerUnit: row.atr15,
      positionSize: RISK_BUDGET_USD / row.atr15,
      requiredMargin: 0,
    };
    const entryFillTimestamp = row.entryTimestamp + M15_CANDLE_DURATION_MS - 1;
    const postFillM1 = m1Candles.slice(firstM1After(m1Candles, entryFillTimestamp));
    const entryM1Candle = postFillM1[0];
    const execution = simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 });
    if (execution.outcome === 'OPEN_DATA_END' || entryM1Candle === undefined) {
      unresolved += 1;
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
    const afterGroup: Group = totalGrossR <= 0 ? 'LOSS' : totalNetR > 0 ? 'WIN_NET_PROFIT' : 'WIN_FEE_EATEN';
    addTo(afterByGroup[afterGroup], totalGrossR, totalNetR);
    transition[row.originalGroup][afterGroup] += 1;

    if (idx % 40_000 === 0) {
      console.info(`${idx}/${allRows.length} elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
    }
  }

  if (unresolved > 0) console.info(`unresolved=${unresolved} (entry candle/data-end not found)`);

  function summarize(acc: Accumulator) {
    return {
      count: acc.count,
      avgGrossR: acc.count === 0 ? null : acc.sumGrossR / acc.count,
      avgNetR: acc.count === 0 ? null : acc.sumNetR / acc.count,
      sumNetR: acc.sumNetR,
    };
  }

  const report = {
    splitTimestamp: SPLIT_TIMESTAMP,
    totalOosRows: allRows.length,
    unresolved,
    before: Object.fromEntries(GROUPS.map((g) => [g, summarize(beforeByGroup[g])])),
    after: Object.fromEntries(GROUPS.map((g) => [g, summarize(afterByGroup[g])])),
    transitionCountsBeforeGroupToAfterGroup: transition,
    overallSumNetRBefore: GROUPS.reduce((s, g) => s + beforeByGroup[g].sumNetR, 0),
    overallSumNetRAfter: GROUPS.reduce((s, g) => s + afterByGroup[g].sumNetR, 0),
  };

  console.info(JSON.stringify(report, null, 2));
  const outputPath = resolve(dataDirectory, 'nukida-ticket04x-oos-before-after.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(`Output: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
