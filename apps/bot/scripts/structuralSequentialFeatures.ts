import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';
import { createAtrTracker } from '../src/noTradeZone/atr.js';

// TICKET-04X-C: structural/sequential features for TICKET-043's reverse-entry mining population.
// All six new features are pure functions of (coin, m15 index i) and the OHLC history strictly
// before index i (candles[0..i-1]) — never index i itself, unlike the six old at-a-candle metrics
// (atr15, compressionBandwidthAtrRatio, breakoutBodyRatio, atrH1, emaValueH1, aboveEmaH1), which the
// ticket explicitly grandfathers and which this script reuses as-is (e.g. atr15 as the R unit).
// Since none of the six new features depend on direction, each is computed exactly once per
// (coin, index) and then joined onto both the BULL and BEAR rows that may reference that index —
// far cheaper than recomputing per mining row.
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
// N chosen for both the swing-high/low / compression-median window and the breakout's own
// "exceeds the high/low of N candles before it" reference, per the ticket's "đề xuất 20 nến" — one
// N, reused everywhere, no extra filter condition invented.
const N = 20;
const ATR_SLOPE_LOOKBACK = 5;
const BODY_RATIO_LOOKBACK = 5;

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS: readonly Group[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'];
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
const NEW_FEATURE_NAMES = [
  'compressionCandleCount',
  'atrSlope5',
  'distanceToSwingHigh20R',
  'distanceToSwingLow20R',
  'consecutiveDirectionalCloses',
  'retestDepthR',
  'bodyRatioTrend5',
] as const;
type FeatureName = (typeof NEW_FEATURE_NAMES)[number];
type FeatureRow = Record<FeatureName, number | null>;

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (range === 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Computes all 7 features for every index of one coin's full M15 series, using only
// candles[0..i-1] for each index i (plus the already-established atr15AtIndex[i]/candles[i].close,
// which is the grandfathered exception — atr15 and entryPrice are the same "at candle i" values the
// old columns already used).
function computeFeaturesForCoin(candles: readonly Candle[]): { features: FeatureRow[]; atr15AtIndex: Array<number | null> } {
  const n = candles.length;
  const ranges = candles.map((c) => c.high - c.low);
  const atrTracker = createAtrTracker(14);
  const atr15AtIndex: Array<number | null> = candles.map((c) => atrTracker.next(c));

  // rollingHigh20[k]/rollingLow20[k] = max(high)/min(low) over candles[k-N..k-1] (excludes k itself).
  const rollingHigh20: Array<number | null> = new Array(n).fill(null);
  const rollingLow20: Array<number | null> = new Array(n).fill(null);
  for (let k = N; k < n; k += 1) {
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let w = k - N; w < k; w += 1) {
      hi = Math.max(hi, candles[w].high);
      lo = Math.min(lo, candles[w].low);
    }
    rollingHigh20[k] = hi;
    rollingLow20[k] = lo;
  }

  const out: FeatureRow[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const windowStart = Math.max(0, i - N);
    const windowLen = i - windowStart;

    let compressionCandleCount: number | null = null;
    if (windowLen >= N) {
      const windowRanges: number[] = [];
      for (let w = windowStart; w < i; w += 1) windowRanges.push(ranges[w]);
      const med = median(windowRanges);
      let count = 0;
      for (let w = i - 1; w >= windowStart; w -= 1) {
        if (ranges[w] < med) count += 1;
        else break;
      }
      compressionCandleCount = count;
    }

    let atrSlope5: number | null = null;
    if (i - ATR_SLOPE_LOOKBACK >= 0) {
      const prevAtr = atr15AtIndex[i - ATR_SLOPE_LOOKBACK];
      const curAtr = atr15AtIndex[i];
      if (prevAtr !== null && curAtr !== null && prevAtr > 0) {
        atrSlope5 = (curAtr - prevAtr) / prevAtr;
      }
    }

    let distanceToSwingHigh20R: number | null = null;
    let distanceToSwingLow20R: number | null = null;
    const atrAtI = atr15AtIndex[i];
    if (windowLen >= N && atrAtI !== null && atrAtI > 0) {
      let swingHigh = Number.NEGATIVE_INFINITY;
      let swingLow = Number.POSITIVE_INFINITY;
      for (let w = windowStart; w < i; w += 1) {
        swingHigh = Math.max(swingHigh, candles[w].high);
        swingLow = Math.min(swingLow, candles[w].low);
      }
      const entryPrice = candles[i].close;
      distanceToSwingHigh20R = (swingHigh - entryPrice) / atrAtI;
      distanceToSwingLow20R = (entryPrice - swingLow) / atrAtI;
    }

    // Signed streak: positive = consecutive higher-highs ending at i-1, negative = consecutive
    // lower-lows ending at i-1, magnitude = whichever streak is longer (ties favor the up-streak,
    // sign is 0 only when both streaks are 0, i.e. no directional structure immediately before entry).
    let consecutiveDirectionalCloses: number | null = null;
    if (i >= 2) {
      let upStreak = 0;
      for (let w = i - 1; w >= 1; w -= 1) {
        if (candles[w].high > candles[w - 1].high) upStreak += 1;
        else break;
      }
      let downStreak = 0;
      for (let w = i - 1; w >= 1; w -= 1) {
        if (candles[w].low < candles[w - 1].low) downStreak += 1;
        else break;
      }
      consecutiveDirectionalCloses = upStreak >= downStreak ? upStreak : -downStreak;
    } else {
      consecutiveDirectionalCloses = 0;
    }

    // Most recent breakout in the N candles before entry: candle j's close exceeds the high/low of
    // the N candles before j (rollingHigh20[j]/rollingLow20[j]). Depth = distance from the extreme
    // reached between the breakout and entry, back to entryPrice, in ATR units. null if no breakout
    // candle is found in that window (never inferred/defaulted).
    let retestDepthR: number | null = null;
    if (atrAtI !== null && atrAtI > 0) {
      const entryPrice = candles[i].close;
      const scanFloor = Math.max(N, i - N);
      for (let j = i - 1; j >= scanFloor; j -= 1) {
        const hi = rollingHigh20[j];
        const lo = rollingLow20[j];
        if (hi === null || lo === null) continue;
        if (candles[j].close > hi) {
          let extreme = Number.NEGATIVE_INFINITY;
          for (let w = j; w <= i - 1; w += 1) extreme = Math.max(extreme, candles[w].high);
          retestDepthR = (extreme - entryPrice) / atrAtI;
          break;
        }
        if (candles[j].close < lo) {
          let extreme = Number.POSITIVE_INFINITY;
          for (let w = j; w <= i - 1; w += 1) extreme = Math.min(extreme, candles[w].low);
          retestDepthR = (entryPrice - extreme) / atrAtI;
          break;
        }
      }
    }

    let bodyRatioTrend5: number | null = null;
    if (i - BODY_RATIO_LOOKBACK >= 0) {
      let sum = 0;
      for (let w = i - BODY_RATIO_LOOKBACK; w < i; w += 1) sum += bodyRatio(candles[w]);
      bodyRatioTrend5 = sum / BODY_RATIO_LOOKBACK;
    }

    out[i] = {
      compressionCandleCount,
      atrSlope5,
      distanceToSwingHigh20R,
      distanceToSwingLow20R,
      consecutiveDirectionalCloses,
      retestDepthR,
      bodyRatioTrend5,
    };
  }
  return { features: out, atr15AtIndex };
}

interface OldRow {
  values: unknown[]; // 1-indexed ExcelJS row.values slice [1..11], i.e. OLD_HEADER order
  coin: string;
  entryTimestamp: number;
}

async function readOldRows(path: string, sheetName: Group): Promise<OldRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: OldRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    out.push({ values: OLD_HEADER.map((_, idx) => v[idx + 1]), coin: String(v[1]), entryTimestamp: Number(v[2]) });
  });
  return out;
}

// Prints the exact candles feeding each feature for one (coin, index) pair, all with openTime
// strictly less than the entry candle's openTime — the manual no-lookahead check the ticket
// requires. Also prints the intermediate computed values (median, swing high/low, atr, breakout
// candle found) so the printed numbers can be checked against featureRow's final output.
function printVerification(
  coin: string,
  candles: readonly Candle[],
  atr15AtIndex: readonly (number | null)[],
  i: number,
  featureRow: FeatureRow,
): void {
  const fmt = (c: Candle) => `openTime=${c.openTime} (${new Date(c.openTime).toISOString()}) O=${c.open} H=${c.high} L=${c.low} C=${c.close}`;
  const entry = candles[i];
  console.log(`\n=== VERIFY coin=${coin} index=${i} entry ${fmt(entry)} atr15@i=${atr15AtIndex[i]} ===`);
  console.log(`featureRow = ${JSON.stringify(featureRow)}`);
  const windowStart = Math.max(0, i - N);

  console.log(`-- compressionCandleCount / distanceToSwingHigh20R / distanceToSwingLow20R: window [${windowStart}, ${i - 1}] (${i - windowStart} candles, all openTime < entry.openTime=${entry.openTime})`);
  const windowRanges: number[] = [];
  let swingHigh = Number.NEGATIVE_INFINITY;
  let swingLow = Number.POSITIVE_INFINITY;
  for (let w = windowStart; w < i; w += 1) {
    const range = candles[w].high - candles[w].low;
    windowRanges.push(range);
    swingHigh = Math.max(swingHigh, candles[w].high);
    swingLow = Math.min(swingLow, candles[w].low);
    console.log(`   [${w}] ${fmt(candles[w])} range=${range.toFixed(6)}`);
  }
  if (windowRanges.length === N) {
    console.log(`   median(range)=${median(windowRanges).toFixed(6)}, swingHigh=${swingHigh}, swingLow=${swingLow}`);
  }

  console.log(`-- atrSlope5: atr15[i=${i}]=${atr15AtIndex[i]} vs atr15[i-5=${i - 5}]=${i - 5 >= 0 ? atr15AtIndex[i - 5] : 'n/a'}`);
  if (i - 5 >= 0) console.log(`   candle at i-5: ${fmt(candles[i - 5])} (openTime < entry.openTime: ${candles[i - 5].openTime < entry.openTime})`);

  console.log(`-- consecutiveDirectionalCloses: walking backward from i-1=${i - 1} (all openTime < entry.openTime)`);
  for (let w = Math.max(1, i - 10); w < i; w += 1) {
    console.log(`   [${w}] ${fmt(candles[w])} vs [${w - 1}] high=${candles[w - 1].high} low=${candles[w - 1].low}`);
  }

  console.log(`-- bodyRatioTrend5: candles [${Math.max(0, i - 5)}, ${i - 1}]`);
  for (let w = Math.max(0, i - 5); w < i; w += 1) console.log(`   [${w}] ${fmt(candles[w])} bodyRatio=${bodyRatio(candles[w]).toFixed(4)}`);

  console.log(`-- retestDepthR: scanning j from ${i - 1} down to ${Math.max(N, i - N)} for a breakout candle (all < entry.openTime)`);
  const scanFloor = Math.max(N, i - N);
  let foundJ: number | null = null;
  for (let j = i - 1; j >= scanFloor; j -= 1) {
    const hi = candles.slice(j - N, j).reduce((m, c) => Math.max(m, c.high), Number.NEGATIVE_INFINITY);
    const lo = candles.slice(j - N, j).reduce((m, c) => Math.min(m, c.low), Number.POSITIVE_INFINITY);
    const isBull = candles[j].close > hi;
    const isBear = candles[j].close < lo;
    if (isBull || isBear) {
      console.log(`   breakout found at j=${j} ${fmt(candles[j])} vs prior-${N} hi=${hi} lo=${lo} (${isBull ? 'BULLISH' : 'BEARISH'})`);
      foundJ = j;
      break;
    }
  }
  if (foundJ === null) console.log(`   no breakout found in [${scanFloor}, ${i - 1}] -> retestDepthR should be null`);
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const startedAt = Date.now();

  console.info('Computing structural features per coin (O(n) pass, direction-independent)...');
  const featuresByCoin = new Map<string, FeatureRow[]>();
  const atrByCoin = new Map<string, Array<number | null>>();
  const candlesByCoin = new Map<string, Candle[]>();
  const openTimeToIndexByCoin = new Map<string, Map<number, number>>();
  for (const coin of COINS) {
    const candles = await loadCsv(resolve(dataDirectory, `${coin}_15m_3y.csv`));
    candlesByCoin.set(coin, candles);
    const { features, atr15AtIndex } = computeFeaturesForCoin(candles);
    featuresByCoin.set(coin, features);
    atrByCoin.set(coin, atr15AtIndex);
    openTimeToIndexByCoin.set(coin, new Map(candles.map((c, idx) => [c.openTime, idx])));
    console.info(`  ${coin}: ${candles.length} candles`);
  }

  // Manual no-lookahead spot check: 5 random (coin, index) pairs with a full window available.
  console.info('\n########## MANUAL NO-LOOKAHEAD VERIFICATION (5 random rows) ##########');
  for (let k = 0; k < 5; k += 1) {
    const coin = COINS[Math.floor(Math.random() * COINS.length)];
    const candles = candlesByCoin.get(coin)!;
    const index = N + 10 + Math.floor(Math.random() * (candles.length - N - 20));
    printVerification(coin, candles, atrByCoin.get(coin)!, index, featuresByCoin.get(coin)![index]);
  }

  const outputPath = resolve(dataDirectory, 'nukida-ticket04x-c-structural-features.xlsx');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });
  const nullCounts: Record<FeatureName, number> = Object.fromEntries(NEW_FEATURE_NAMES.map((f) => [f, 0])) as Record<FeatureName, number>;
  let totalRows = 0;

  for (const { file, sheet: sheetName } of REPORTS_FILES) {
    console.info(`\nReading ${file} [${sheetName}]...`);
    const oldRows = await readOldRows(resolve(reportsDirectory, file), sheetName);
    console.info(`  ${oldRows.length} rows`);

    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow([...OLD_HEADER, ...NEW_FEATURE_NAMES]).commit();

    let written = 0;
    for (const row of oldRows) {
      const idx = openTimeToIndexByCoin.get(row.coin)?.get(row.entryTimestamp);
      if (idx === undefined) throw new Error(`entryTimestamp ${row.entryTimestamp} not found in ${row.coin} CSV — key join failed`);
      const features = featuresByCoin.get(row.coin)![idx];
      const excelRow = sheet.addRow([...row.values, ...NEW_FEATURE_NAMES.map((f) => features[f])]);
      for (const f of NEW_FEATURE_NAMES) if (features[f] === null) nullCounts[f] += 1;
      totalRows += 1;
      written += 1;
      if (written % 500 === 0) excelRow.commit();
    }
    sheet.commit();
    console.info(`  wrote ${written} rows with features, elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
  }

  await workbook.commit();

  console.info('\n########## NULL RATE PER FEATURE ##########');
  for (const f of NEW_FEATURE_NAMES) {
    const pct = (100 * nullCounts[f]) / totalRows;
    console.info(`${f}: ${nullCounts[f]}/${totalRows} null (${pct.toFixed(4)}%)`);
  }
  console.info(`\nOutput: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
