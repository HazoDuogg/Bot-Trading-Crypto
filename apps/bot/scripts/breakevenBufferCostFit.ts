import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';

// TICKET-04X: fit predictedCostR(entryPrice, riskPerUnit) = C * (riskPerUnit/entryPrice)^alpha via
// log-log OLS on TICKET-043's reverse-entry mining population (costR = totalGrossR - totalNetR,
// an exact identity since totalNetR = totalGrossR - fee - spread - slippage in that pipeline).
// Fit on the first calendar half of the 3y window only; the second half is held out and evaluated
// here (item 5) and used again for the before/after simulation in breakevenBufferOosCompare.ts.

const REPORTS_FILES: Array<{ file: string; sheet: string }> = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];

interface Row {
  coin: string;
  entryTimestamp: number;
  atr15: number;
  costR: number;
}

async function loadCsvOpenTimeToClose(csvPath: string): Promise<Map<number, number>> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  const map = new Map<number, number>();
  for (const row of rows) {
    const [openTime, , , , close] = row.split(',').map(Number);
    map.set(openTime, close);
  }
  return map;
}

async function readGroupRows(path: string, sheetName: string): Promise<Row[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: Row[] = [];
  let negativeOrZeroCostSkips = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    const totalGrossR = Number(v[4]);
    const totalNetR = Number(v[5]);
    const costR = totalGrossR - totalNetR;
    if (!(costR > 0)) {
      negativeOrZeroCostSkips += 1;
      return;
    }
    out.push({ coin: String(v[1]), entryTimestamp: Number(v[2]), atr15: Number(v[6]), costR });
  });
  if (negativeOrZeroCostSkips > 0) {
    console.info(`${sheetName}: skipped ${negativeOrZeroCostSkips} rows with costR <= 0 (should be ~0, fee/spread/slippage are all non-negative)`);
  }
  return out;
}

function ols(x: readonly number[], y: readonly number[]): { alpha: number; logC: number; r2: number } {
  const n = x.length;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - meanX) * (y[i] - meanY);
    sxx += (x[i] - meanX) ** 2;
  }
  const alpha = sxy / sxx;
  const logC = meanY - alpha * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const yHat = logC + alpha * x[i];
    ssRes += (y[i] - yHat) ** 2;
    ssTot += (y[i] - meanY) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;
  return { alpha, logC, r2 };
}

function evaluate(x: readonly number[], y: readonly number[], alpha: number, logC: number) {
  const n = x.length;
  let ssRes = 0;
  let ssTot = 0;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let sumAbsPctError = 0;
  for (let i = 0; i < n; i += 1) {
    const yHat = logC + alpha * x[i];
    ssRes += (y[i] - yHat) ** 2;
    ssTot += (y[i] - meanY) ** 2;
    const actual = Math.exp(y[i]);
    const predicted = Math.exp(yHat);
    sumAbsPctError += Math.abs(predicted - actual) / actual;
  }
  return {
    r2: 1 - ssRes / ssTot,
    rmseLog: Math.sqrt(ssRes / n),
    meanAbsPctError: sumAbsPctError / n,
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));

  const allRows: Row[] = [];
  for (const { file, sheet } of REPORTS_FILES) {
    const rows = await readGroupRows(resolve(reportsDirectory, file), sheet);
    console.info(`${sheet}: ${rows.length} usable rows`);
    for (const row of rows) allRows.push(row);
  }
  console.info(`Total usable rows: ${allRows.length}`);

  // Calendar midpoint of the combined 3y CSV window (2023-08-28 .. 2026-08-27), computed from the
  // BTC/ETH/SOL/DOGE CSVs (HYPE starts later and so falls entirely in the OOS half below).
  const splitTimestamp = 1_740_536_100_000;
  console.info(`splitTimestamp=${splitTimestamp} (${new Date(splitTimestamp).toISOString()})`);

  const priceCacheByCoin = new Map<string, Map<number, number>>();
  async function priceOf(coin: string, entryTimestamp: number): Promise<number | undefined> {
    let map = priceCacheByCoin.get(coin);
    if (map === undefined) {
      map = await loadCsvOpenTimeToClose(resolve(dataDirectory, `${coin}_15m_3y.csv`));
      priceCacheByCoin.set(coin, map);
    }
    return map.get(entryTimestamp);
  }

  const inSampleX: number[] = [];
  const inSampleY: number[] = [];
  const oosX: number[] = [];
  const oosY: number[] = [];
  let priceMisses = 0;

  for (const row of allRows) {
    const price = await priceOf(row.coin, row.entryTimestamp);
    if (price === undefined) {
      priceMisses += 1;
      continue;
    }
    const x = Math.log(row.atr15 / price);
    const y = Math.log(row.costR);
    if (row.entryTimestamp < splitTimestamp) {
      inSampleX.push(x);
      inSampleY.push(y);
    } else {
      oosX.push(x);
      oosY.push(y);
    }
  }
  if (priceMisses > 0) console.info(`priceMisses=${priceMisses} (entry candle not found in CSV)`);
  console.info(`inSample n=${inSampleX.length}, oos n=${oosX.length}`);

  const fit = ols(inSampleX, inSampleY);
  const inSampleEval = evaluate(inSampleX, inSampleY, fit.alpha, fit.logC);
  const oosEval = evaluate(oosX, oosY, fit.alpha, fit.logC);

  console.info(`alpha=${fit.alpha.toFixed(6)}, logC=${fit.logC.toFixed(6)}, C=${Math.exp(fit.logC).toExponential(6)}`);
  console.info(`in-sample R2=${inSampleEval.r2.toFixed(4)}, rmseLog=${inSampleEval.rmseLog.toFixed(4)}, meanAbsPctError=${(100 * inSampleEval.meanAbsPctError).toFixed(2)}%`);
  console.info(`OOS       R2=${oosEval.r2.toFixed(4)}, rmseLog=${oosEval.rmseLog.toFixed(4)}, meanAbsPctError=${(100 * oosEval.meanAbsPctError).toFixed(2)}%`);

  const output = {
    note: 'log(costR) = logC + alpha * log(atr15/price); predictedCostR = C * (atr15/price)^alpha',
    splitTimestamp,
    splitTimestampIso: new Date(splitTimestamp).toISOString(),
    nInSample: inSampleX.length,
    nOos: oosX.length,
    priceMisses,
    alpha: fit.alpha,
    logC: fit.logC,
    C: Math.exp(fit.logC),
    inSample: inSampleEval,
    oos: oosEval,
  };
  const outputPath = resolve(dataDirectory, 'nukida-ticket04x-cost-fit.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`Output: ${outputPath}`);
}

await main();
