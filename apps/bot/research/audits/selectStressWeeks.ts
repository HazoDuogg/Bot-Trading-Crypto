import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAdxSeries, classifyRegime } from '../../core/structure/regimeFilter.js';

// TICKET-04X-Q Step 0 (REVISED): locks the "regime stress-test set" of 3 UTC weeks BEFORE any
// bookTicker data is fetched. This file only reads the existing M15 CSV — no network access.
//
// REVISION NOTE: the original design picked 3 weeks (lowest/median/highest avg ADX) from each of
// 3 periods (2023 / 2024 / 2025-2026) = 9 weeks. Step 1 discovered that Binance stopped publishing
// public daily bookTicker archives for BTCUSDT after 2024-03-30 (data.binance.vision returns 404
// for every date from 2024-03-31 onward, through 2026 — confirmed via direct probing, matches
// Binance/binance-public-data GitHub issue #372; not a collection bug on this repo's side). 6 of
// the 9 originally-locked weeks fall after that cutoff and have zero available data.
// User decision: narrow the scope to exactly ONE regime stress-test set of 3 weeks
// (lowest/median/highest avg ADX), selected only from the confirmed-available window
// 2023-09-18T00:00:00Z .. 2024-03-31T00:00:00Z (exclusive) — not extended further back, since
// availability before 2023-09-18 was never verified. Calling this "3 periods 2023/2024/2025-2026"
// would now be misleading (everything lives inside one ~6.5-month window), hence the single
// BOOKTICKER_WINDOW_2023H2_2024Q1 label below instead of a per-year periodLabel.
const M15_MS = 15 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_LABEL = 'BOOKTICKER_WINDOW_2023H2_2024Q1';
const WINDOW_START_MS = Date.UTC(2023, 8, 18); // 2023-09-18T00:00:00Z
const WINDOW_END_EXCLUSIVE_MS = Date.UTC(2024, 2, 31); // 2024-03-31T00:00:00Z (last available day is 2024-03-30)

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

interface WeekCandidate {
  periodLabel: string;
  weekStart: number;
  weekEnd: number; // exclusive
  avgAdx: number;
  candleCount: number;
}

function periodLabelFor(weekStart: number, weekEnd: number): string | null {
  if (weekStart >= WINDOW_START_MS && weekEnd <= WINDOW_END_EXCLUSIVE_MS) return WINDOW_LABEL;
  return null;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));
  const candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  console.info(`Loaded ${candles.length} M15 candles: ${new Date(candles[0].openTime).toISOString()} .. ${new Date(candles.at(-1)!.openTime).toISOString()}`);

  const adxSeries = computeAdxSeries(candles);
  const openTimeToIndex = new Map(candles.map((c, i) => [c.openTime, i]));
  const firstOpenTime = candles[0].openTime;
  const lastOpenTime = candles.at(-1)!.openTime;

  // Monday 00:00:00 UTC week boundaries. 1970-01-01 was a Thursday, so the first Monday on/after
  // epoch 0 is at +4 days; align any timestamp down to the most recent such Monday.
  const EPOCH_TO_FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1000;
  function alignToMondayFloor(ts: number): number {
    return Math.floor((ts - EPOCH_TO_FIRST_MONDAY_MS) / WEEK_MS) * WEEK_MS + EPOCH_TO_FIRST_MONDAY_MS;
  }

  const candidates: WeekCandidate[] = [];
  let weekStart = alignToMondayFloor(firstOpenTime);
  if (weekStart < firstOpenTime) weekStart += WEEK_MS; // first FULL week only, no partial leading week
  for (; weekStart + WEEK_MS <= lastOpenTime + M15_MS; weekStart += WEEK_MS) {
    const weekEnd = weekStart + WEEK_MS;
    const periodLabel = periodLabelFor(weekStart, weekEnd);
    if (periodLabel === null) continue;

    // Require every expected M15 openTime in [weekStart, weekEnd) to exist AND have a non-null
    // ADX (a stricter, correctness-driven version of "14 candles of warmup must exist": this ADX
    // implementation actually needs ~2xperiod candles before its first valid value, so checking
    // "every candle in the week has non-null ADX" is what genuinely guarantees a meaningful
    // weekly average, rather than the literal 14-candle floor alone).
    const expectedCount = WEEK_MS / M15_MS;
    let complete = true;
    let adxSum = 0;
    let adxCount = 0;
    for (let t = weekStart; t < weekEnd; t += M15_MS) {
      const idx = openTimeToIndex.get(t);
      if (idx === undefined) {
        complete = false;
        break;
      }
      const adx = adxSeries[idx];
      if (adx === null) {
        complete = false;
        break;
      }
      adxSum += adx;
      adxCount += 1;
    }
    if (!complete || adxCount !== expectedCount) continue;

    candidates.push({ periodLabel, weekStart, weekEnd, avgAdx: adxSum / adxCount, candleCount: adxCount });
  }

  console.info(`Eligible full weeks with valid ADX warmup in ${WINDOW_LABEL}: ${candidates.length}`);

  const selected: Array<WeekCandidate & { selectionReason: 'LOWEST_AVG_ADX' | 'MEDIAN_AVG_ADX' | 'HIGHEST_AVG_ADX' }> = [];
  {
    const group = candidates.filter((c) => c.periodLabel === WINDOW_LABEL).sort((a, b) => a.avgAdx - b.avgAdx);
    if (group.length === 0) throw new Error(`CORRECTION_REQUIRED: no eligible full week found in ${WINDOW_LABEL}`);
    const lowest = group[0];
    const highest = group.at(-1)!;
    const medianIndex = Math.floor(group.length / 2);
    const median = group[medianIndex];
    selected.push({ ...lowest, selectionReason: 'LOWEST_AVG_ADX' });
    selected.push({ ...median, selectionReason: 'MEDIAN_AVG_ADX' });
    selected.push({ ...highest, selectionReason: 'HIGHEST_AVG_ADX' });
  }

  const manifest = {
    warning:
      'TICKET-04X-Q Step 0 (REVISED): "regime stress-test set" (bo stress-test theo regime) — NOT a representative/random sample. ' +
      'Locked before any bookTicker fetch; not to be changed after seeing downstream results. Narrowed from the original 9-week/3-period ' +
      'design to these 3 weeks, all inside 2023-09-18..2024-03-31 (exclusive), because Binance stopped publishing public daily bookTicker ' +
      'archives for BTCUSDT after 2024-03-30 (data.binance.vision 404 from 2024-03-31 onward, confirmed through 2026; matches ' +
      'binance/binance-public-data GitHub issue #372 — not a collection bug here). Any conclusion drawn from this data reflects ONLY ' +
      'market behavior in this ~6.5-month window; extending it to late-2024/2025/2026 is an unverified assumption and must be flagged ' +
      'every time this result is cited.',
    generatedAt: new Date().toISOString(),
    weekMs: WEEK_MS,
    weeks: selected.map((w) => ({
      periodLabel: w.periodLabel,
      selectionReason: w.selectionReason,
      weekStartUtc: new Date(w.weekStart).toISOString(),
      weekEndUtcExclusive: new Date(w.weekEnd).toISOString(),
      weekStartTimestamp: w.weekStart,
      weekEndTimestampExclusive: w.weekEnd,
      avgAdx: w.avgAdx,
    })),
  };

  console.info('\n########## 3 TUAN DA KHOA (single window) ##########');
  for (const w of manifest.weeks) {
    console.info(`${w.periodLabel} | ${w.selectionReason.padEnd(16)} | ${w.weekStartUtc} .. ${w.weekEndUtcExclusive} | avgAdx=${w.avgAdx.toFixed(3)}`);
  }

  const outputPath = resolve(auditsDirectory, 'eventDrivenStressWeeks.json');
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.info(`\nManifest: ${outputPath}`);
}

await main();
