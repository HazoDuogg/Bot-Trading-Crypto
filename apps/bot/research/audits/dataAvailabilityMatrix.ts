import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TICKET-04X-R: one-time existence probe (HEAD only, zero content downloaded) across every
// data.binance.vision UM-futures BTCUSDT daily dataset this roadmap might use, at 1 date per
// quarter for the ~3 years of history in scope. Purpose: catch archive-retention gaps (like the
// bookTicker cutoff found in TICKET-04X-Q) BEFORE building against a dataset, not mid-build.
const BASE_URL = 'https://data.binance.vision/data/futures/um/daily';
const SYMBOL = 'BTCUSDT';

interface DataType {
  name: string;
  urlSegment: string; // path segment under .../daily/<segment>/BTCUSDT/
  fileInfix: string; // BTCUSDT-<infix>-<date>.zip
}

const DATA_TYPES: DataType[] = [
  { name: 'bookTicker', urlSegment: 'bookTicker', fileInfix: 'bookTicker' },
  { name: 'bookDepth', urlSegment: 'bookDepth', fileInfix: 'bookDepth' },
  { name: 'aggTrades', urlSegment: 'aggTrades', fileInfix: 'aggTrades' },
  { name: 'trades', urlSegment: 'trades', fileInfix: 'trades' },
  { name: 'metrics', urlSegment: 'metrics', fileInfix: 'metrics' },
  { name: 'liquidationSnapshot', urlSegment: 'liquidationSnapshot', fileInfix: 'liquidationSnapshot' },
];

// Explicit range Q3/2023 .. Q3/2026 inclusive = 13 quarter-start dates, not 12 — the ticket said
// "12 mốc" but also said "từ Q3/2023 tới Q3/2026" inclusive, which is 13 quarters. Reporting the
// full inclusive range transparently rather than silently dropping one to force a count of 12.
function quarterStartDates(): string[] {
  const dates: string[] = [];
  for (let year = 2023; year <= 2026; year += 1) {
    for (const month of [0, 3, 6, 9]) {
      if (year === 2023 && month < 6) continue; // start at Q3/2023 (July)
      if (year === 2026 && month > 6) continue; // end at Q3/2026 (July)
      dates.push(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10));
    }
  }
  return dates;
}

async function probeExists(url: string): Promise<boolean> {
  const res = await fetch(url, { method: 'HEAD' });
  // Consume/close any body defensively even though HEAD responses have none, to avoid leaking
  // sockets across ~78 sequential requests.
  await res.body?.cancel().catch(() => undefined);
  return res.status === 200;
}

async function main(): Promise<void> {
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));
  const dates = quarterStartDates();
  console.info(`Probing ${DATA_TYPES.length} data types x ${dates.length} quarter-start dates (HEAD only)...`);

  const matrix: Record<string, Record<string, boolean>> = {};
  for (const dataType of DATA_TYPES) {
    matrix[dataType.name] = {};
    for (const date of dates) {
      const url = `${BASE_URL}/${dataType.urlSegment}/${SYMBOL}/${SYMBOL}-${dataType.fileInfix}-${date}.zip`;
      const exists = await probeExists(url);
      matrix[dataType.name][date] = exists;
    }
  }

  const colWidth = 12;
  const header = `${'dataType'.padEnd(20)} | ${dates.map((d) => d.padEnd(colWidth)).join('')}`;
  console.info(`\n${header}`);
  console.info('-'.repeat(header.length));
  for (const dataType of DATA_TYPES) {
    const row = dates.map((d) => (matrix[dataType.name][d] ? 'YES' : 'no').padEnd(colWidth)).join('');
    console.info(`${dataType.name.padEnd(20)} | ${row}`);
  }

  console.info('\nFirst/last available quarter-start date per data type:');
  for (const line of summarizeAvailability(matrix, dates, DATA_TYPES)) {
    console.info(`  ${line}`);
  }

  const output = {
    warning:
      'TICKET-04X-R: existence-only probe (HTTP HEAD, no content downloaded) at 1 date per quarter — NOT a guarantee every day within an ' +
      '"available" quarter exists (see TICKET-04X-Q, where bookTicker had a hard cutoff mid-quarter, 2024-03-30). Treat a YES quarter as ' +
      '"worth investigating further", not as "fully available"; treat a NO quarter as a hard blocker for that data type in that window.',
    generatedAt: new Date().toISOString(),
    symbol: SYMBOL,
    dates,
    matrix,
  };

  const outputPath = resolve(auditsDirectory, 'dataAvailabilityMatrix.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nMatrix: ${outputPath}`);
}

function summarizeAvailability(
  matrix: Record<string, Record<string, boolean>>,
  dates: string[],
  dataTypes: DataType[],
): string[] {
  return dataTypes.map((dt) => {
    const availableDates = dates.filter((d) => matrix[dt.name][d]);
    if (availableDates.length === 0) return `${dt.name}: NONE available (all ${dates.length} probes 404)`;
    return `${dt.name}: ${availableDates[0]} .. ${availableDates.at(-1)} (${availableDates.length}/${dates.length} quarter-starts YES)`;
  });
}

await main();
