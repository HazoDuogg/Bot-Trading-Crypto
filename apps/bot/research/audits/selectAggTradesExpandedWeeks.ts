import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAdxSeries } from '../../core/structure/regimeFilter.js';

// TICKET-04X-Z Step 0: locks 12 UTC weeks for the expanded aggTrades order-flow sample -- H1
// regime (consistent with TICKET-04X-Q/R's own week-selection convention), 3 periods x 4 ADX
// quantiles (lowest/p33/p67/highest) per period, finer-grained than the old 3-week
// lowest/median/highest split. Locked before fetching; not to be changed after seeing results.
//
// DEVIATION FLAGGED (proceeding on the honest-selection principle, same as every other locked-
// selection ticket in this series): the ticket assumes the 12-week algorithm will naturally
// reproduce the 3 weeks already fetched in TICKET-04X-Q/X (letting only 9 need fresh fetching).
// Those 3 weeks were themselves chosen from a NARROWER 6.5-month sub-window using a coarser
// lowest/median/highest split (TICKET-04X-Q's revised Step 0, forced narrow by the bookTicker
// cutoff) -- a different selection granularity than this ticket's full-3-year/4-quantile design,
// so there is no guarantee of an exact match. This script selects the 12 weeks HONESTLY (no
// forcing/excluding candidates to manufacture overlap with the old 3) and simply marks whichever
// candidates DO exactly match an old week's UTC start for data reuse -- if fewer than 3 match, that
// is reported plainly rather than silently forcing old weeks into slots the algorithm didn't pick.
const H1_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Exact UTC week-start timestamps already fetched in TICKET-04X-Q/X -- reused, not re-fetched, IF
// this ticket's own selection happens to land on the same week.
const ALREADY_FETCHED_WEEK_STARTS = new Set<number>([
  1702252800000, // 2023-12-11 (HIGHEST_AVG_ADX)
  1702857600000, // 2023-12-18 (MEDIAN_AVG_ADX)
  1705276800000, // 2024-01-15 (LOWEST_AVG_ADX)
]);

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
  weekEnd: number;
  avgAdx: number;
}

// Same year-bucket convention as the ORIGINAL (pre-revision) TICKET-04X-Q Step 0 -- explicitly the
// "consistent with Q/R" period split the ticket asks for.
function periodLabelFor(weekStart: number): string | null {
  const year = new Date(weekStart).getUTCFullYear();
  if (year === 2023) return '2023';
  if (year === 2024) return '2024';
  if (year === 2025 || year === 2026) return '2025-2026';
  return null;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));
  const h1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_1h_3y.csv'));
  console.info(`Loaded ${h1Candles.length} H1 candles: ${new Date(h1Candles[0].openTime).toISOString()} .. ${new Date(h1Candles.at(-1)!.openTime).toISOString()}`);

  const adxSeries = computeAdxSeries(h1Candles);
  const openTimeToIndex = new Map(h1Candles.map((c, i) => [c.openTime, i]));
  const firstOpenTime = h1Candles[0].openTime;
  const lastOpenTime = h1Candles.at(-1)!.openTime;

  const EPOCH_TO_FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1000;
  function alignToMondayFloor(ts: number): number {
    return Math.floor((ts - EPOCH_TO_FIRST_MONDAY_MS) / WEEK_MS) * WEEK_MS + EPOCH_TO_FIRST_MONDAY_MS;
  }

  const candidates: WeekCandidate[] = [];
  let weekStart = alignToMondayFloor(firstOpenTime);
  if (weekStart < firstOpenTime) weekStart += WEEK_MS;
  for (; weekStart + WEEK_MS <= lastOpenTime + H1_MS; weekStart += WEEK_MS) {
    const weekEnd = weekStart + WEEK_MS;
    const periodLabel = periodLabelFor(weekStart);
    if (periodLabel === null) continue;

    const expectedCount = WEEK_MS / H1_MS;
    let complete = true;
    let adxSum = 0;
    let adxCount = 0;
    for (let t = weekStart; t < weekEnd; t += H1_MS) {
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
    candidates.push({ periodLabel, weekStart, weekEnd, avgAdx: adxSum / adxCount });
  }

  console.info(`Eligible full weeks with valid ADX warmup: ${candidates.length}`);
  for (const label of ['2023', '2024', '2025-2026']) {
    console.info(`  ${label}: ${candidates.filter((c) => c.periodLabel === label).length}`);
  }

  const selected: Array<WeekCandidate & { selectionReason: string }> = [];
  for (const label of ['2023', '2024', '2025-2026']) {
    const group = candidates.filter((c) => c.periodLabel === label).sort((a, b) => a.avgAdx - b.avgAdx);
    if (group.length === 0) throw new Error(`CORRECTION_REQUIRED: no eligible full week found for period ${label}`);
    const n = group.length;
    // Discrete quantile indices, locked before running: floor(q * (n-1)) for q in {0, 0.33, 0.67, 1}.
    const indices = [0, Math.floor(0.33 * (n - 1)), Math.floor(0.67 * (n - 1)), n - 1];
    const reasons = ['LOWEST_AVG_ADX', 'P33_AVG_ADX', 'P67_AVG_ADX', 'HIGHEST_AVG_ADX'];
    const seenIndices = new Set<number>();
    for (let k = 0; k < indices.length; k += 1) {
      const idx = indices[k];
      if (seenIndices.has(idx)) continue; // small groups can collapse quantile slots; keep unique weeks only
      seenIndices.add(idx);
      selected.push({ ...group[idx], selectionReason: reasons[k] });
    }
  }

  const alreadyFetchedMatches = selected.filter((w) => ALREADY_FETCHED_WEEK_STARTS.has(w.weekStart));
  const needsFetch = selected.filter((w) => !ALREADY_FETCHED_WEEK_STARTS.has(w.weekStart));

  console.info(`\n########## ${selected.length} TUAN DA KHOA ##########`);
  for (const w of selected) {
    const reused = ALREADY_FETCHED_WEEK_STARTS.has(w.weekStart) ? ' [REUSE existing TICKET-04X-Q/X data]' : '';
    console.info(`${w.periodLabel} | ${w.selectionReason.padEnd(16)} | ${new Date(w.weekStart).toISOString()} | avgAdx=${w.avgAdx.toFixed(3)}${reused}`);
  }
  console.info(`\nNatural overlap with the 3 already-fetched weeks: ${alreadyFetchedMatches.length}/3`);
  console.info(`Weeks needing a fresh fetch: ${needsFetch.length} (ticket assumed 9; actual may differ, reported transparently)`);

  const manifest = {
    warning:
      'TICKET-04X-Z Step 0: 12-week expanded set for aggTrades order-flow, H1 regime, 3 periods x 4 ADX quantiles (lowest/p33/p67/highest). ' +
      'Locked before fetching; not changed after seeing results. Selection is honest (no forcing to match the 3 already-fetched TICKET-04X-Q/X ' +
      'weeks) -- see naturalOverlapWithPriorWeeks for how many actually coincided.',
    generatedAt: new Date().toISOString(),
    weekMs: WEEK_MS,
    naturalOverlapWithPriorWeeks: alreadyFetchedMatches.length,
    weeksNeedingFreshFetch: needsFetch.length,
    weeks: selected.map((w) => ({
      periodLabel: w.periodLabel,
      selectionReason: w.selectionReason,
      weekStartUtc: new Date(w.weekStart).toISOString(),
      weekEndUtcExclusive: new Date(w.weekEnd).toISOString(),
      weekStartTimestamp: w.weekStart,
      weekEndTimestampExclusive: w.weekEnd,
      avgAdx: w.avgAdx,
      alreadyFetched: ALREADY_FETCHED_WEEK_STARTS.has(w.weekStart),
    })),
  };

  const outputPath = resolve(auditsDirectory, 'aggTradesExpandedWeeks.json');
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.info(`\nManifest: ${outputPath}`);
}

await main();
