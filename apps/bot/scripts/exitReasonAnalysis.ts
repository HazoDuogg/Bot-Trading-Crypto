import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';
import { simulatePositionManagementV2 } from '../src/risk/positionManagementV2.js';
import type { TradePlan } from '../src/risk/tradePlan.js';

// TICKET-046: re-simulate TICKET-043's WIN_FEE_EATEN and LOSS mining outputs to attach the final
// exit-leg's reason and how many minutes it took to resolve. Read-only analysis, no source edits.
const RISK_BUDGET_USD = 6;

type BigGroup = 'WIN_FEE_EATEN' | 'LOSS';
const BIG_GROUPS = ['WIN_FEE_EATEN', 'LOSS'] as const;
// Real filenames (with spaces, under reports/) confirmed via `ls` — the ticket's data/ + underscore
// naming does not match what TICKET-043 actually produced.
const INPUT_FILES: Record<BigGroup, string> = {
  WIN_FEE_EATEN: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx',
  LOSS: 'nukida-ticket043-reverse-entry-mining -loss.xlsx',
};

interface SourceRow {
  coin: string;
  entryTimestamp: number;
  direction: 'BULL' | 'BEAR';
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

async function readSourceRows(path: string, sheetName: string): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: SourceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    out.push({
      coin: String(v[1]),
      entryTimestamp: Number(v[2]),
      direction: v[3] as 'BULL' | 'BEAR',
      totalNetR: Number(v[5]),
      atr15: Number(v[6]),
    });
  });
  return out;
}

function resolveRow(
  row: SourceRow,
  m15CloseByOpenTime: ReadonlyMap<number, number>,
  m1Candles: readonly Candle[],
): { finalExitReason: string; minutesToResolve: number } | null {
  const entryPrice = m15CloseByOpenTime.get(row.entryTimestamp);
  if (entryPrice === undefined) return null;
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
  const execution = simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 });
  const lastLeg = execution.exitLegs[execution.exitLegs.length - 1];
  if (lastLeg === undefined) return null;
  const finalExitReason = lastLeg.reasonCode === 'AMBIGUOUS_FORCED_LOSS' ? 'AMBIGUOUS_FORCED_LOSS' : execution.outcome;
  return { finalExitReason, minutesToResolve: (lastLeg.exitTimestamp - entryFillTimestamp) / 60_000 };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const outputPath = resolve(dataDirectory, 'nukida-ticket046-exit-reason-breakdown.xlsx');
  const outputWorkbook = new ExcelJS.Workbook();

  for (const bigGroup of BIG_GROUPS) {
    const startedAt = Date.now();
    const sourcePath = resolve(reportsDirectory, INPUT_FILES[bigGroup]);
    console.info(`Reading ${sourcePath}...`);
    const sourceRows = await readSourceRows(sourcePath, bigGroup);
    console.info(`${bigGroup}: ${sourceRows.length} rows loaded`);

    const byReason = new Map<string, { netR: number[]; minutes: number[] }>();
    let currentCoin: string | null = null;
    let m1Candles: Candle[] = [];
    let m15CloseByOpenTime = new Map<number, number>();
    let unresolved = 0;

    for (let idx = 0; idx < sourceRows.length; idx += 1) {
      const row = sourceRows[idx];
      if (row.coin !== currentCoin) {
        currentCoin = row.coin;
        const m15Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_15m_3y.csv`));
        m1Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_rt094_1m.csv`));
        m15CloseByOpenTime = new Map(m15Candles.map((c) => [c.openTime, c.close]));
      }

      const resolved = resolveRow(row, m15CloseByOpenTime, m1Candles);
      if (resolved === null) {
        unresolved += 1;
        continue;
      }
      const bucket = byReason.get(resolved.finalExitReason) ?? { netR: [], minutes: [] };
      bucket.netR.push(row.totalNetR);
      bucket.minutes.push(resolved.minutesToResolve);
      byReason.set(resolved.finalExitReason, bucket);

      if (idx % 20_000 === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        console.info(`${bigGroup} ${idx}/${sourceRows.length} elapsed=${elapsedMin.toFixed(1)}min`);
      }
    }

    if (unresolved > 0) {
      console.info(`${bigGroup}: ${unresolved} rows could not be re-resolved (entry candle not found in CSV)`);
    }
    const totalResolved = sourceRows.length - unresolved;

    const sheet = outputWorkbook.addWorksheet(bigGroup);
    sheet.addRow([
      'finalExitReason',
      'count',
      'percentOfGroup',
      'avgNetR',
      'avgMinutesToResolve',
      'medianMinutesToResolve',
    ]);
    const orderedReasons = [...byReason.entries()].sort((a, b) => b[1].netR.length - a[1].netR.length);
    for (const [reason, bucket] of orderedReasons) {
      sheet.addRow([
        reason,
        bucket.netR.length,
        (100 * bucket.netR.length) / totalResolved,
        mean(bucket.netR),
        mean(bucket.minutes),
        median(bucket.minutes),
      ]);
    }
    sheet.addRow([]);
    sheet.addRow(['TOTAL_RESOLVED', totalResolved]);
    sheet.addRow(['UNRESOLVED_ROWS', unresolved]);

    const elapsedMin = (Date.now() - startedAt) / 60_000;
    console.info(`${bigGroup} done in ${elapsedMin.toFixed(1)} min`);
  }

  await outputWorkbook.xlsx.writeFile(outputPath);
  console.info(`Excel: ${outputPath}`);
}

await main();
