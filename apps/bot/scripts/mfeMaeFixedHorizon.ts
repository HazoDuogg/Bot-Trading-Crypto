import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';
import { M15_CANDLE_DURATION_MS } from '../src/backtest/intrabarExecution.js';

// TICKET-04X-G: fixed-horizon MFE/MAE, fully independent of simulatePositionManagementV2 —
// pure price path from entryFillTimestamp to entryFillTimestamp+H, no SL/TP/trailing/force-close.
type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const REPORTS_FILES: Array<{ file: string; sheet: Group }> = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];
const OLD_HEADER = [
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
const HORIZONS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000, '24h': 86_400_000 };
const HORIZON_KEYS = ['1h', '4h', '12h', '24h'];

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// First index with openTime > timestamp — same binary-search convention as the other mining scripts.
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

interface HorizonResult {
  mfeR: number | null;
  maeR: number | null;
  dataStatus: 'OK' | 'INSUFFICIENT_DATA';
}

function computeHorizon(
  m1Candles: readonly Candle[],
  startIdx: number,
  entryFillTimestamp: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'BULL' | 'BEAR',
  horizonMs: number,
): HorizonResult {
  const cutoffTimestamp = entryFillTimestamp + horizonMs;
  const endIdx = firstM1After(m1Candles, cutoffTimestamp);
  const expectedCandleCount = horizonMs / 60_000;
  const actualCandleCount = endIdx - startIdx;
  if (actualCandleCount !== expectedCandleCount) return { mfeR: null, maeR: null, dataStatus: 'INSUFFICIENT_DATA' };

  let runningMFE_R = 0;
  let runningMAE_R = 0;
  for (let k = startIdx; k < endIdx; k += 1) {
    const candle = m1Candles[k];
    const favorable = direction === 'BULL' ? (candle.high - entryPrice) / riskPerUnit : (entryPrice - candle.low) / riskPerUnit;
    const adverse = direction === 'BULL' ? (entryPrice - candle.low) / riskPerUnit : (candle.high - entryPrice) / riskPerUnit;
    runningMFE_R = Math.max(runningMFE_R, favorable);
    runningMAE_R = Math.max(runningMAE_R, adverse);
  }
  return { mfeR: runningMFE_R, maeR: runningMAE_R, dataStatus: 'OK' };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const outputPath = resolve(reportsDirectory, 'nukida-ticket04x-g-mfe-mae-fixed-horizon.xlsx');
  const startedAt = Date.now();

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });
  const insufficientCountByHorizon: Record<string, number> = { '1h': 0, '4h': 0, '12h': 0, '24h': 0 };
  let totalRows = 0;

  let currentCoin: string | null = null;
  let m1Candles: Candle[] = [];
  let m15CloseByOpenTime = new Map<number, number>();

  for (const { file, sheet: sheetName } of REPORTS_FILES) {
    console.info(`Reading ${file} [${sheetName}]...`);
    const source = new ExcelJS.Workbook();
    await source.xlsx.readFile(resolve(reportsDirectory, file));
    const sourceSheet = source.getWorksheet(sheetName);
    if (sourceSheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${file}`);

    const rows: Array<{ values: unknown[]; coin: string; entryTimestamp: number; direction: 'BULL' | 'BEAR'; riskPerUnit: number }> = [];
    sourceSheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;
      const v = row.values as unknown[];
      rows.push({
        values: OLD_HEADER.map((_, i) => v[i + 1]),
        coin: String(v[1]),
        entryTimestamp: Number(v[2]),
        direction: v[3] as 'BULL' | 'BEAR',
        riskPerUnit: Number(v[6]),
      });
    });
    // Group by coin so each coin's CSVs load once, not once per row.
    rows.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));

    const outSheet = workbook.addWorksheet(sheetName);
    const newHeader = HORIZON_KEYS.flatMap((h) => [`mfeR_${h}`, `maeR_${h}`, `dataStatus_${h}`]);
    outSheet.addRow([...OLD_HEADER, ...newHeader]).commit();

    let written = 0;
    for (const row of rows) {
      if (row.coin !== currentCoin) {
        currentCoin = row.coin;
        const m15Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_15m_3y.csv`));
        m1Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_rt094_1m.csv`));
        m15CloseByOpenTime = new Map(m15Candles.map((c) => [c.openTime, c.close]));
      }
      const entryPrice = m15CloseByOpenTime.get(row.entryTimestamp);
      if (entryPrice === undefined) throw new Error(`entryTimestamp ${row.entryTimestamp} not found in ${row.coin} M15 CSV`);
      const entryFillTimestamp = row.entryTimestamp + M15_CANDLE_DURATION_MS - 1;
      const startIdx = firstM1After(m1Candles, entryFillTimestamp);

      const outValues: unknown[] = [...row.values];
      for (const h of HORIZON_KEYS) {
        const result = computeHorizon(m1Candles, startIdx, entryFillTimestamp, entryPrice, row.riskPerUnit, row.direction, HORIZONS[h]);
        if (result.dataStatus === 'INSUFFICIENT_DATA') insufficientCountByHorizon[h] += 1;
        outValues.push(result.mfeR, result.maeR, result.dataStatus);
      }
      totalRows += 1;
      written += 1;
      const excelRow = outSheet.addRow(outValues);
      if (written % 500 === 0) excelRow.commit();

      if (totalRows % 40_000 === 0) {
        console.info(`${totalRows} rows processed, elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
      }
    }
    outSheet.commit();
    console.info(`  wrote ${written} rows`);
  }

  await workbook.commit();

  console.info(`\nTong so dong: ${totalRows}`);
  for (const h of HORIZON_KEYS) {
    console.info(`INSUFFICIENT_DATA (${h}): ${insufficientCountByHorizon[h]}/${totalRows} (${((100 * insufficientCountByHorizon[h]) / totalRows).toFixed(4)}%)`);
  }
  console.info(`\nOutput: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
