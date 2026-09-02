import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadM1CandlesBetween } from './controlTest.js';
import {
  DAY_MS,
  M15_MS,
  buildRollingWindows,
} from './runNukidaWalkForwardRolling.js';
import {
  TICK_ALIGNMENT_TOLERANCE,
  inferTickSize,
} from './tickSizeInference.js';

const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;

async function readM15Bounds(csvPath: string): Promise<{ first: number; last: number }> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u);
  if (rows.length < 2) throw new Error('M15 CSV contains no data rows');
  return {
    first: Number(rows[1].split(',')[0]),
    last: Number(rows.at(-1)!.split(',')[0]),
  };
}

function isAligned(price: number, tickSize: number): boolean {
  const scaled = price / tickSize;
  return Math.abs(scaled - Math.round(scaled)) <= TICK_ALIGNMENT_TOLERANCE;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const btc = await readM15Bounds(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const windows = buildRollingWindows(btc.first, btc.last);
  const rows: Array<Record<string, unknown>> = [];
  for (const coin of COINS) {
    for (const window of windows) {
      try {
        const candles = await loadM1CandlesBetween(
          resolve(dataDirectory, `${coin}_rt094_1m.csv`),
          window.startInclusive,
          window.endExclusive,
        );
        const inference = inferTickSize(candles.map((candle) => candle.close));
        const outliers = candles
          .filter((candle) => !isAligned(candle.close, inference.tickSize))
          .map((candle) => ({
            timestamp: candle.openTime,
            timestampIso: new Date(candle.openTime).toISOString(),
            close: candle.close,
          }));
        rows.push({
          coin,
          windowIndex: window.index,
          startInclusive: window.startInclusive,
          endExclusive: window.endExclusive,
          m1Candles: candles.length,
          inferredTickSize: inference.tickSize,
          outlierCount: outliers.length,
          outlierRate: outliers.length / candles.length,
          outliers,
          status: 'SCANNED',
        });
      } catch (error) {
        rows.push({
          coin,
          windowIndex: window.index,
          startInclusive: window.startInclusive,
          endExclusive: window.endExclusive,
          m1Candles: 0,
          outlierCount: null,
          outliers: [],
          status: 'NO_DATA',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const scanned = rows.filter((row) => row.status === 'SCANNED');
  const distribution = Object.fromEntries(
    [...new Set(scanned.map((row) => row.outlierCount as number))]
      .sort((left, right) => left - right)
      .map((count) => [String(count), scanned.filter((row) => row.outlierCount === count).length]),
  );
  const outputPath = resolve(dataDirectory, 'nukida-tick-outlier-diagnostic.json');
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        diagnosticOnly: true,
        windowDays: 180,
        dayMs: DAY_MS,
        m15Ms: M15_MS,
        scannedCoinWindows: scanned.length,
        noDataCoinWindows: rows.length - scanned.length,
        distribution,
        rows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  for (const row of rows) {
    console.info(
      `${row.coin} W${row.windowIndex}: ${row.status} M1=${row.m1Candles} ` +
        `tick=${row.inferredTickSize ?? 'N/A'} outliers=${row.outlierCount ?? 'N/A'}`,
    );
  }
  console.info(`Distribution: ${JSON.stringify(distribution)}`);
  console.info(`Diagnostic: ${outputPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
