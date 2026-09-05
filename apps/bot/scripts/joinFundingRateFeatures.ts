import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

// TICKET-04X-E item 2/3: joins fetchFundingRateHistory.ts's output onto TICKET-043's 927,994-row
// reverse-entry mining population by (coin, entryTimestamp) -> most recent funding event with
// fundingTime <= entryTimestamp. No discriminating-power analysis performed here (item 4) — this
// script only joins and reports null rates.
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
const NEW_COLUMNS = ['fundingRateAtEntry', 'fundingRateChange8h'] as const;

interface FundingEvent {
  fundingTime: number;
  fundingRate: number;
}

async function loadFundingCsv(csvPath: string): Promise<FundingEvent[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [fundingTime, fundingRate] = row.split(',');
    return { fundingTime: Number(fundingTime), fundingRate: Number(fundingRate) };
  });
}

// Index of the last event with fundingTime <= timestamp, or -1 if none (entry occurs before the
// coin's first known funding event — a real edge case near a new listing, not a bug).
function lastIndexAtOrBefore(events: readonly FundingEvent[], timestamp: number): number {
  let left = 0;
  let right = events.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (events[middle].fundingTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left - 1;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const startedAt = Date.now();

  const fundingByCoin = new Map<string, FundingEvent[]>();
  for (const coin of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT']) {
    fundingByCoin.set(coin, await loadFundingCsv(resolve(dataDirectory, `${coin}_funding_3y.csv`)));
  }

  const outputPath = resolve(reportsDirectory, 'nukida-ticket04x-e-funding-rate-joined.xlsx');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });

  let totalRows = 0;
  let nullAtEntry = 0;
  let nullChange8h = 0;

  for (const { file, sheet: sheetName } of REPORTS_FILES) {
    console.info(`Reading ${file} [${sheetName}]...`);
    const source = new ExcelJS.Workbook();
    await source.xlsx.readFile(resolve(reportsDirectory, file));
    const sourceSheet = source.getWorksheet(sheetName);
    if (sourceSheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${file}`);

    const outSheet = workbook.addWorksheet(sheetName);
    outSheet.addRow([...OLD_HEADER, ...NEW_COLUMNS]).commit();

    let written = 0;
    sourceSheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;
      const v = row.values as unknown[];
      const coin = String(v[1]);
      const entryTimestamp = Number(v[2]);
      const events = fundingByCoin.get(coin)!;
      const idx = lastIndexAtOrBefore(events, entryTimestamp);
      const fundingRateAtEntry = idx >= 0 ? events[idx].fundingRate : null;
      const fundingRateChange8h = idx >= 1 ? events[idx].fundingRate - events[idx - 1].fundingRate : null;
      if (fundingRateAtEntry === null) nullAtEntry += 1;
      if (fundingRateChange8h === null) nullChange8h += 1;
      totalRows += 1;

      const excelRow = outSheet.addRow([
        ...OLD_HEADER.map((_, i) => v[i + 1]),
        fundingRateAtEntry,
        fundingRateChange8h,
      ]);
      written += 1;
      if (written % 500 === 0) excelRow.commit();
    });
    outSheet.commit();
    console.info(`  wrote ${written} rows, elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
  }

  await workbook.commit();

  console.info('\n########## NULL RATE ##########');
  console.info(`fundingRateAtEntry: ${nullAtEntry}/${totalRows} null (${((100 * nullAtEntry) / totalRows).toFixed(4)}%)`);
  console.info(`fundingRateChange8h: ${nullChange8h}/${totalRows} null (${((100 * nullChange8h) / totalRows).toFixed(4)}%)`);
  console.info(`\nOutput: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
