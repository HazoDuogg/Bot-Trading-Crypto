import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import type { Candle } from '../../../backtest/engine/noTradeZone/types.js';
import { computeMeanReversionSignals } from '../../../core/entry/meanReversionSignal.js';
import { inferTickSize } from '../../../backtest/engine/tickSizeInference.js';
import {
  createEventDrivenEntryFillTracker,
  type EventDrivenEntryFillResult,
  type EventDrivenEntryFillTracker,
} from '../../../backtest/engine/eventDrivenEntryFill.js';

// TICKET-04X-Q Step 1: downloads daily bookTicker archives from data.binance.vision for exactly
// the 9 weeks locked in Step 0's manifest (eventDrivenStressWeeks.json), streams each day's ~1.4GB
// decompressed CSV without ever buffering it whole. Raw-data quality (out-of-order / duplicate
// timestamp / bid>ask / non-positive price-or-qty) is checked on every row of every day (a free
// byproduct of the mandatory linear decompression pass), logged, never silently auto-corrected.
//
// DESIGN NOTE (revised after two crashes on the first real run): the ticket's Step 2 describes
// eventDrivenEntryFill.ts as its own file consuming a raw event array — an earlier version of this
// script buffered every raw tick inside each signal's 5-minute TTL window and wrote them all out
// at the end. For a week with ~230 signals that never fill, that is tens of millions of retained
// rows — first an OOM (all 9 weeks held in RAM), then a `JSON.stringify` RangeError (a single
// week's buffered events exceeded V8's ~536MB max string length) even after fixing the first
// problem. The actual fix: feed each raw event straight into that signal's
// createEventDrivenEntryFillTracker() (backtest/engine/eventDrivenEntryFill.ts) as it streams past,
// keep O(1) state per active signal, and persist only the resolved outcome — never the raw ticks.
// This still runs the exact same canonical algorithm (cross-checked for equivalence with the batch
// function in that file's test), just incrementally instead of after full buffering.
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 5 * 60 * 1000;
const DECISION_OFFSET_MS = 200;
const N = 1; // locked in TICKET-04X-M
const TICK_SAMPLE_TARGET = 2000; // inferTickSize() only needs a handful of repeated-decimal observations

interface ParsedRow {
  bestBidPrice: number;
  bestBidQty: number;
  bestAskPrice: number;
  bestAskQty: number;
  eventTime: number;
}

interface SignalWindow {
  index: number; // index into the full m5Candles/signals arrays, used as a stable id
  direction: 'LONG' | 'SHORT';
  decisionAt: number;
  ttlEndExclusive: number;
  tracker: EventDrivenEntryFillTracker;
  result: EventDrivenEntryFillResult | null;
}

interface DayQualityFlags {
  date: string;
  rowCount: number;
  outOfOrder: number;
  duplicateTimestamp: number;
  bidGreaterThanAsk: number;
  nonPositivePriceOrQty: number;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function dateStringUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function* fetchDayCsvLines(dateStr: string): AsyncGenerator<string> {
  const url = `https://data.binance.vision/data/futures/um/daily/bookTicker/BTCUSDT/BTCUSDT-bookTicker-${dateStr}.zip`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (res.body === null) throw new Error(`Empty response body for ${url}`);
      const nodeStream = Readable.fromWeb(res.body as never);
      const zipEntryStream = nodeStream.pipe(unzipper.ParseOne());
      const rl = createInterface({ input: zipEntryStream, crlfDelay: Infinity });
      let first = true;
      for await (const line of rl) {
        if (first) {
          first = false;
          continue; // header row
        }
        if (line.trim().length === 0) continue;
        yield line;
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt}/3 failed for ${dateStr}: ${(err as Error).message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw new Error(`Failed to fetch ${dateStr} after 3 attempts: ${(lastErr as Error)?.message}`);
}

function parseRow(line: string): ParsedRow | null {
  const parts = line.split(',');
  if (parts.length !== 7) return null;
  const [, bestBidPrice, bestBidQty, bestAskPrice, bestAskQty, , eventTime] = parts.map(Number);
  if ([bestBidPrice, bestBidQty, bestAskPrice, bestAskQty, eventTime].some((v) => !Number.isFinite(v))) return null;
  return { bestBidPrice, bestBidQty, bestAskPrice, bestAskQty, eventTime };
}

// Quick partial read of just the first needed day, aborted as soon as enough samples exist —
// this is a separate, much cheaper pass than the full-week fill-tracking pass below, needed
// because the tracker requires tickSize up front but inferTickSize() needs observed prices first.
async function inferWeekTickSize(firstDateStr: string): Promise<ReturnType<typeof inferTickSize>> {
  const sample: number[] = [];
  for await (const line of fetchDayCsvLines(firstDateStr)) {
    const row = parseRow(line);
    if (row === null) continue;
    sample.push(row.bestBidPrice, row.bestAskPrice);
    if (sample.length >= TICK_SAMPLE_TARGET) break;
  }
  return inferTickSize(sample);
}

async function processDay(dateStr: string, activeWindows: SignalWindow[]): Promise<DayQualityFlags> {
  const flags: DayQualityFlags = { date: dateStr, rowCount: 0, outOfOrder: 0, duplicateTimestamp: 0, bidGreaterThanAsk: 0, nonPositivePriceOrQty: 0 };
  let previousEventTime = -Infinity;

  for await (const line of fetchDayCsvLines(dateStr)) {
    const row = parseRow(line);
    if (row === null) continue;
    flags.rowCount += 1;

    if (row.eventTime < previousEventTime) flags.outOfOrder += 1;
    else if (row.eventTime === previousEventTime) flags.duplicateTimestamp += 1;
    previousEventTime = row.eventTime;
    if (row.bestBidPrice > row.bestAskPrice) flags.bidGreaterThanAsk += 1;
    if (row.bestBidPrice <= 0 || row.bestAskPrice <= 0 || row.bestBidQty <= 0 || row.bestAskQty <= 0) {
      flags.nonPositivePriceOrQty += 1;
    }

    const event = { eventTime: row.eventTime, bestBidPrice: row.bestBidPrice, bestAskPrice: row.bestAskPrice };
    for (const window of activeWindows) {
      if (window.result !== null) continue;
      if (row.eventTime < window.decisionAt || row.eventTime >= window.ttlEndExclusive) continue;
      const outcome = window.tracker.next(event);
      if (outcome !== null) window.result = outcome;
    }
  }

  if (flags.outOfOrder > 0) {
    console.warn(
      `  WARNING: ${dateStr} has ${flags.outOfOrder} out-of-order row(s) in the raw file — trackers were fed in raw stream ` +
        'order (no buffering-then-stable-sort possible without reintroducing the OOM this design avoids); flagged, not silently corrected.',
    );
  }
  return flags;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('../../audits/', import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(auditsDirectory, 'eventDrivenStressWeeks.json'), 'utf8')) as {
    weeks: Array<{ periodLabel: string; selectionReason: string; weekStartTimestamp: number; weekEndTimestampExclusive: number }>;
  };

  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const m5Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_5m_3y.csv'));
  const signals = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);

  for (const week of manifest.weeks) {
    const weekOutputPath = resolve(dataDirectory, `bookTickerStressWeek-${week.periodLabel}-${week.selectionReason}.json`);
    try {
      await readFile(weekOutputPath, 'utf8');
      console.info(`\nSkipping ${week.periodLabel}/${week.selectionReason} — output already exists (resume): ${weekOutputPath}`);
      continue;
    } catch {
      // does not exist yet, proceed
    }
    console.info(`\n########## Week ${week.periodLabel} / ${week.selectionReason} (${new Date(week.weekStartTimestamp).toISOString()}) ##########`);

    const rawSignals: Array<{ index: number; direction: 'LONG' | 'SHORT'; decisionAt: number; ttlEndExclusive: number }> = [];
    for (let i = 0; i < m5Candles.length; i += 1) {
      if (signals[i].signal === 'NONE') continue;
      const decisionAt = m5Candles[i].openTime + M5_MS + DECISION_OFFSET_MS;
      if (decisionAt < week.weekStartTimestamp || decisionAt >= week.weekEndTimestampExclusive) continue;
      rawSignals.push({ index: i, direction: signals[i].signal as 'LONG' | 'SHORT', decisionAt, ttlEndExclusive: decisionAt + TTL_MS });
    }
    console.info(`  ${rawSignals.length} signals in this week`);

    // Days needed: the week's 7 calendar days, PLUS one extra day if any signal's TTL window
    // pushes past the week boundary (rare — only signals within the last 5 minutes of Sunday UTC).
    const lastTtlEnd = rawSignals.length > 0 ? Math.max(...rawSignals.map((w) => w.ttlEndExclusive)) : week.weekEndTimestampExclusive;
    const daysNeeded: string[] = [];
    for (let t = week.weekStartTimestamp; t < Math.max(week.weekEndTimestampExclusive, lastTtlEnd); t += DAY_MS) {
      daysNeeded.push(dateStringUtc(t));
    }

    console.info(`  Inferring tickSize from ${daysNeeded[0]} (partial read, up to ${TICK_SAMPLE_TARGET} samples)...`);
    const tickResult = await inferWeekTickSize(daysNeeded[0]);
    console.info(`  Inferred tickSize=${tickResult.tickSize} (supporting=${tickResult.supportingPrices}, outliers=${tickResult.outlierPrices})`);

    const windows: SignalWindow[] = rawSignals.map((s) => ({
      ...s,
      tracker: createEventDrivenEntryFillTracker({ direction: s.direction, decisionAt: s.decisionAt, tickSize: tickResult.tickSize, n: N, ttlMs: TTL_MS }),
      result: null,
    }));

    const dayFlags: DayQualityFlags[] = [];
    for (const dateStr of daysNeeded) {
      console.info(`  Fetching ${dateStr}...`);
      const startedAt = Date.now();
      const flags = await processDay(dateStr, windows);
      dayFlags.push(flags);
      console.info(
        `    rows=${flags.rowCount} outOfOrder=${flags.outOfOrder} duplicateTs=${flags.duplicateTimestamp} ` +
          `bidGtAsk=${flags.bidGreaterThanAsk} nonPositive=${flags.nonPositivePriceOrQty} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    }

    for (const window of windows) {
      if (window.result === null) window.result = window.tracker.finalize();
    }
    const outcomeCounts = { FILLED: 0, EXPIRED: 0, DATA_GAP_ABORT: 0 };
    for (const window of windows) outcomeCounts[window.result!.outcome] += 1;
    console.info(`  Outcomes: FILLED=${outcomeCounts.FILLED} EXPIRED=${outcomeCounts.EXPIRED} DATA_GAP_ABORT=${outcomeCounts.DATA_GAP_ABORT}`);

    const weekOutput = {
      periodLabel: week.periodLabel,
      selectionReason: week.selectionReason,
      weekStartTimestamp: week.weekStartTimestamp,
      weekEndTimestampExclusive: week.weekEndTimestampExclusive,
      tickSize: tickResult.tickSize,
      tickSizeInference: tickResult,
      dayQualityFlags: dayFlags,
      signals: windows.map((w) => ({
        index: w.index,
        direction: w.direction,
        decisionAt: w.decisionAt,
        outcome: w.result!.outcome,
        limitPrice: w.result!.limitPrice,
        filledAtEventTime: w.result!.filledAtEventTime,
        minutesToFill: w.result!.minutesToFill,
      })),
    };

    // Written immediately per week (not accumulated across all 9 in memory) — see the design note
    // above. Also enables the resume-skip above if a later week still fails.
    await writeFile(weekOutputPath, JSON.stringify(weekOutput, null, 2), 'utf8');
    console.info(`  Wrote ${weekOutputPath}`);
  }

  console.info('\nAll weeks processed (or already present from a previous run).');
}

await main();
