import { config as loadEnv } from 'dotenv';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONTEXT_CANDLES,
  INTERVAL,
  INTERVAL_MS,
  SYMBOLS,
  type AnnotationDataset,
  type AnnotationSegment,
  type Candle,
  isMain,
  parseFlags,
  positiveIntegerFlag,
  shuffled,
  stringFlag,
} from './shared.js';

loadEnv();

const DEFAULT_SEGMENTS_PER_COIN = 30;
const DEFAULT_MONTHS_BACK = 6;

function parseCsv(csv: string): Candle[] {
  const rows = csv.trim().split(/\r?\n/).slice(1);
  const byOpenTime = new Map<number, Candle>();
  for (const row of rows) {
    const [openTimeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = row.split(',');
    const candle: Candle = {
      openTime: Number(openTimeRaw),
      open: Number(openRaw),
      high: Number(highRaw),
      low: Number(lowRaw),
      close: Number(closeRaw),
      volume: Number(volumeRaw),
    };
    if (!Object.values(candle).every(Number.isFinite)) throw new Error(`Invalid OHLCV row: ${row}`);
    byOpenTime.set(candle.openTime, candle);
  }
  return [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
}

function isContinuousWindow(candles: readonly Candle[], start: number, length: number): boolean {
  for (let index = start + 1; index < start + length; index += 1) {
    if (candles[index].openTime - candles[index - 1].openTime !== INTERVAL_MS) return false;
  }
  return true;
}

function overlapCount(leftStart: number, rightStart: number, length: number): number {
  return Math.max(0, Math.min(leftStart + length, rightStart + length) - Math.max(leftStart, rightStart));
}

export function selectSegmentStarts(
  candles: readonly Candle[],
  count: number,
  candlesPerSegment: number,
  seed: string,
): number[] {
  if (candlesPerSegment < 2) throw new Error('A segment must contain context plus one decision candle');
  const candidates: number[] = [];
  for (let start = 0; start + candlesPerSegment <= candles.length; start += 1) {
    if (isContinuousWindow(candles, start, candlesPerSegment)) candidates.push(start);
  }

  const maxOverlap = Math.floor(candlesPerSegment * 0.5);
  const selected: number[] = [];
  for (const candidate of shuffled(candidates, seed)) {
    if (selected.every((existing) => overlapCount(existing, candidate, candlesPerSegment) <= maxOverlap)) {
      selected.push(candidate);
      if (selected.length === count) return selected.sort((left, right) => left - right);
    }
  }
  throw new Error(
    `Only ${selected.length}/${count} non-overlapping-enough continuous segments are available ` +
      `(candles=${candles.length}, segmentLength=${candlesPerSegment})`,
  );
}

export function buildSegments(
  symbol: string,
  candles: readonly Candle[],
  count: number,
  contextCandles: number,
  seed: string,
  cutoffTime: number,
): AnnotationSegment[] {
  const candlesPerSegment = contextCandles + 1;
  const eligible = candles.filter((candle) => candle.openTime + INTERVAL_MS <= cutoffTime);
  const starts = selectSegmentStarts(eligible, count, candlesPerSegment, `${seed}:sample:${symbol}`);
  return starts.map((start, ordinal) => {
    const window = eligible.slice(start, start + candlesPerSegment);
    return {
      sourceId: `${symbol}:${ordinal + 1}`,
      symbol,
      sourceStartIndex: start,
      decisionOpenTime: window[window.length - 1].openTime,
      // slice creates a new array whose final element is the decision candle. No later candle is serialized.
      candles: window,
    };
  });
}

async function runFetchOhlcv(symbol: string, monthsBack: number, temporaryRoot: string): Promise<Candle[]> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fetchScript = path.resolve(currentDir, '..', 'fetchOhlcv.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fetchScript, symbol, INTERVAL, String(monthsBack)], {
      cwd: temporaryRoot,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`fetchOhlcv.ts failed for ${symbol} with exit code ${String(code)}`));
    });
  });
  const csvPath = path.join(temporaryRoot, 'apps', 'bot', 'data', `${symbol}_${INTERVAL}.csv`);
  return parseCsv(await readFile(csvPath, 'utf8'));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const segmentsPerCoin = positiveIntegerFlag(flags, 'per-coin', DEFAULT_SEGMENTS_PER_COIN);
  const contextCandles = positiveIntegerFlag(flags, 'context-candles', DEFAULT_CONTEXT_CANDLES);
  const monthsBack = positiveIntegerFlag(flags, 'months-back', DEFAULT_MONTHS_BACK);
  const seed = stringFlag(flags, 'seed', `annotation-${Date.now()}`);
  const outputDir = path.resolve(stringFlag(flags, 'output-dir', 'apps/bot/annotation-output/private'));
  const cutoffRaw = stringFlag(flags, 'cutoff-time', new Date().toISOString());
  const cutoffTime = Date.parse(cutoffRaw);
  if (!Number.isFinite(cutoffTime)) throw new Error(`--cutoff-time must be an ISO-8601 timestamp; received ${cutoffRaw}`);
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const samplingStartTime = cutoffTime - monthsBack * monthMs;
  const cutoffAgeMonths = Math.max(0, Math.ceil((Date.now() - cutoffTime) / monthMs));
  // fetchOhlcv accepts whole months and always ends at "now". Rounding the cutoff age upward
  // guarantees its fetched start precedes our fixed sampling window without changing that window.
  const effectiveFetchMonths = monthsBack + cutoffAgeMonths;

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'nukida-annotation-'));
  try {
    const segments: AnnotationSegment[] = [];
    const sourceSha256BySymbol: Record<string, string> = {};
    for (const symbol of SYMBOLS) {
      console.log(`Fetching ${symbol} through the existing fetchOhlcv script...`);
      const fetched = await runFetchOhlcv(symbol, effectiveFetchMonths, temporaryRoot);
      const candles = fetched.filter(
        (candle) => candle.openTime >= samplingStartTime && candle.openTime + INTERVAL_MS <= cutoffTime,
      );
      sourceSha256BySymbol[symbol] = createHash('sha256').update(JSON.stringify(candles)).digest('hex');
      segments.push(...buildSegments(symbol, candles, segmentsPerCoin, contextCandles, seed, cutoffTime));
    }

    const dataset: AnnotationDataset = {
      schemaVersion: 1,
      seed,
      interval: INTERVAL,
      intervalMs: INTERVAL_MS,
      contextCandles,
      candlesPerSegment: contextCandles + 1,
      segmentsPerCoin,
      cutoffTime,
      samplingStartTime,
      sourceMonthsBack: monthsBack,
      sourceSha256BySymbol,
      generatedAt: new Date().toISOString(),
      symbols: [...SYMBOLS],
      segments,
    };
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'segments.private.json');
    await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${segments.length} future-truncated segments to ${outputPath}`);
    console.log(`Reproduction seed: ${seed}; cutoff: ${new Date(cutoffTime).toISOString()}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
