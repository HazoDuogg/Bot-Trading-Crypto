import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { runNukidaWalkForwardRolling } from '../src/backtest/runNukidaWalkForwardRolling.js';

const BOOTSTRAP_ITERATIONS = 10_000;
// Ticket text assumed apps/bot/data/; the real TICKET-043 output files live in apps/bot/reports/
// (confirmed via `ls`) — same content the ticket describes, just the actual location.
const REPORTS_FILES = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

function percentile(sortedValues: readonly number[], p: number): number {
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.round(p * (sortedValues.length - 1))));
  return sortedValues[idx];
}

async function readTotalNetRColumn(path: string, sheetName: string): Promise<number[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: number[] = [];
  // Header: coin,entryTimestamp,direction,totalGrossR,totalNetR,... -> totalNetR is column 5.
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    out.push(Number((row.values as unknown[])[5]));
  });
  return out;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));

  console.info('Running real D1-D8 pipeline (D5=1.95) across all 7 windows / 5 coins...');
  const result = await runNukidaWalkForwardRolling(dataDirectory, {
    fsmConfigOverride: { compressionMaxBandwidthAtrRatioOverride: 1.95 },
  });
  const realTradesNetR: number[] = result.windows
    .flatMap((window) => window.tradeLogs)
    .filter((trade) => trade.costs !== null)
    .map((trade) => trade.costs!.netR);
  console.info(`realTradesNetR: ${realTradesNetR.length} trades`);

  console.info('Reading TICKET-043 random-entry population (totalNetR column, 3 sheets)...');
  const randomPoolNetR: number[] = [];
  for (const { file, sheet } of REPORTS_FILES) {
    const values = await readTotalNetRColumn(resolve(reportsDirectory, file), sheet);
    // Plain loop, not push(...values) — spreading a ~400k-element array as call args overflows
    // the stack.
    for (const value of values) randomPoolNetR.push(value);
    console.info(`  ${sheet}: ${values.length} rows`);
  }
  console.info(`randomPoolNetR: ${randomPoolNetR.length} entries`);

  const N = realTradesNetR.length;
  const realMeanNetR = mean(realTradesNetR);
  const structureFloorMeanNetR = mean(randomPoolNetR);

  console.info(`Bootstrapping ${BOOTSTRAP_ITERATIONS} samples of size N=${N}...`);
  const poolSize = randomPoolNetR.length;
  const bootstrapMeans: number[] = new Array(BOOTSTRAP_ITERATIONS);
  for (let iter = 0; iter < BOOTSTRAP_ITERATIONS; iter += 1) {
    let sum = 0;
    for (let draw = 0; draw < N; draw += 1) {
      sum += randomPoolNetR[Math.floor(Math.random() * poolSize)];
    }
    bootstrapMeans[iter] = sum / N;
  }
  const sortedMeans = [...bootstrapMeans].sort((a, b) => a - b);
  const belowReal = sortedMeans.filter((v) => v < realMeanNetR).length;
  const percentileRank = (100 * belowReal) / BOOTSTRAP_ITERATIONS;

  const output = {
    warning:
      'randomPool co tuong quan/chong lan giua cac entry lien ke (cung dung chung doan gia), ' +
      'nen phep bootstrap nay chi mang tinh tham khao tuong doi, khong phai kiem dinh thong ke ' +
      'chat che theo dung nghia co dien.',
    N,
    realMeanNetR,
    realTotalTradesUsed: N,
    structureFloorMeanNetR,
    bootstrap: {
      mean: mean(bootstrapMeans),
      std: stdDev(bootstrapMeans),
      p5: percentile(sortedMeans, 0.05),
      p25: percentile(sortedMeans, 0.25),
      p50: percentile(sortedMeans, 0.5),
      p75: percentile(sortedMeans, 0.75),
      p95: percentile(sortedMeans, 0.95),
    },
    percentileRank,
  };

  const outputPath = resolve(dataDirectory, 'nukida-ticket044-bootstrap-comparison.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  const elapsedMin = (Date.now() - startedAt) / 60_000;
  console.info(`N=${N}, realMeanNetR=${realMeanNetR.toFixed(4)}, structureFloorMeanNetR=${structureFloorMeanNetR.toFixed(4)}`);
  console.info(`percentileRank=${percentileRank.toFixed(2)}%`);
  console.info(`Elapsed: ${elapsedMin.toFixed(1)} min`);
  console.info(`Output: ${outputPath}`);
}

await main();
