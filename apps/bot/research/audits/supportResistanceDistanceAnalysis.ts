import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';

// TICKET-04X-Y: distance-to-nearest-important-support/resistance-zone, joined against the real
// TICKET-04X-S outcome for all 25,088 TAKE_PROFIT/STOP_LOSS trades -- pure description, no PnL.
// Support/resistance detection is entirely causal: at each signal's own m5CloseTime, only the 30
// days of M15 candles strictly before it are scanned, never anything at or after.
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 30 * DAY_MS;
const CLUSTER_GAP_PCT = 0.001; // 0.1%, locked before running
const MIN_TOUCHES = 3;

interface BacktestTrade {
  m5Index: number;
  direction: 'LONG' | 'SHORT';
  outcome: string;
  signalCloseC: number;
  m5CloseTime: number;
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// Lower-bound binary search: first index with openTime >= timestamp.
function firstIndexAtOrAfter(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (candles[mid].openTime < timestamp) left = mid + 1;
    else right = mid;
  }
  return left;
}

interface Zone {
  center: number;
  touches: number;
}

// Greedy chaining cluster: sort all high/low values, start a new cluster whenever the gap to the
// PREVIOUS value (not the cluster's first/mean) exceeds CLUSTER_GAP_PCT -- exactly the "gộp liên
// tiếp nếu chênh lệch với điểm gần nhất trong cụm" rule as literally described.
function clusterIntoZones(values: number[]): Zone[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const zones: Zone[] = [];
  let clusterSum = sorted[0];
  let clusterCount = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const relGap = (cur - prev) / prev;
    if (relGap < CLUSTER_GAP_PCT) {
      clusterSum += cur;
      clusterCount += 1;
    } else {
      zones.push({ center: clusterSum / clusterCount, touches: clusterCount });
      clusterSum = cur;
      clusterCount = 1;
    }
  }
  zones.push({ center: clusterSum / clusterCount, touches: clusterCount });
  return zones.filter((z) => z.touches >= MIN_TOUCHES);
}

function nearestZoneDistance(zones: readonly Zone[], entryPrice: number, direction: 'LONG' | 'SHORT'): number | null {
  if (direction === 'LONG') {
    const below = zones.filter((z) => z.center < entryPrice);
    if (below.length === 0) return null;
    const nearest = below.reduce((best, z) => (z.center > best.center ? z : best));
    return (entryPrice - nearest.center) / entryPrice;
  }
  const above = zones.filter((z) => z.center > entryPrice);
  if (above.length === 0) return null;
  const nearest = above.reduce((best, z) => (z.center < best.center ? z : best));
  return (nearest.center - entryPrice) / entryPrice;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function decileBuckets<T>(rows: readonly T[], keyOf: (row: T) => number): T[][] {
  const sorted = [...rows].sort((a, b) => keyOf(a) - keyOf(b));
  const n = sorted.length;
  const buckets: T[][] = [];
  for (let d = 0; d < 10; d += 1) {
    buckets.push(sorted.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10)));
  }
  return buckets;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../../reports/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info('Loading M15 CSV and TICKET-04X-S backtest output...');
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const backtest = JSON.parse(await readFile(resolve(reportsDirectory, 'nukida-04x-s-mean-reversion-backtest.json'), 'utf8')) as {
    trades: BacktestTrade[];
  };
  const trades = backtest.trades.filter((t) => t.outcome === 'TAKE_PROFIT' || t.outcome === 'STOP_LOSS');
  console.info(`M15=${m15Candles.length} TP/SL trades=${trades.length}`);

  interface Row {
    direction: 'LONG' | 'SHORT';
    outcome: string;
    distancePct: number | null;
  }
  const rows: Row[] = [];
  let processed = 0;
  const startedAt = Date.now();

  for (const trade of trades) {
    const windowEndIdx = firstIndexAtOrAfter(m15Candles, trade.m5CloseTime); // exclusive, excludes current candle
    const windowStartIdx = firstIndexAtOrAfter(m15Candles, trade.m5CloseTime - LOOKBACK_MS);
    const window = m15Candles.slice(windowStartIdx, windowEndIdx);

    const values: number[] = [];
    for (const c of window) {
      values.push(c.high, c.low);
    }
    const zones = clusterIntoZones(values);
    const distancePct = nearestZoneDistance(zones, trade.signalCloseC, trade.direction);

    rows.push({ direction: trade.direction, outcome: trade.outcome, distancePct });
    processed += 1;
    if (processed % 5000 === 0) console.info(`  processed ${processed}/${trades.length} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }

  const nullCount = rows.filter((r) => r.distancePct === null).length;
  console.info(`\nDone. ${processed} trades processed, ${nullCount} with distancePct=null (${((100 * nullCount) / processed).toFixed(2)}%), elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  function analyzeDirection(direction: 'LONG' | 'SHORT' | 'ALL') {
    const subset = direction === 'ALL' ? rows : rows.filter((r) => r.direction === direction);
    const withValue = subset.filter((r): r is Row & { distancePct: number } => r.distancePct !== null);
    const nullSubset = subset.length - withValue.length;
    const buckets = decileBuckets(withValue, (r) => r.distancePct);
    const deciles = buckets.map((bucket, idx) => {
      const tp = bucket.filter((r) => r.outcome === 'TAKE_PROFIT').length;
      const sl = bucket.filter((r) => r.outcome === 'STOP_LOSS').length;
      const distances = bucket.map((r) => r.distancePct);
      return {
        decile: idx + 1,
        n: bucket.length,
        distancePctMin: distances.length === 0 ? null : Math.min(...distances),
        distancePctMax: distances.length === 0 ? null : Math.max(...distances),
        takeProfitCount: tp,
        stopLossCount: sl,
        takeProfitRatePctOfTpSl: tp + sl === 0 ? null : (100 * tp) / (tp + sl),
      };
    });
    return {
      totalInDirection: subset.length,
      usableWithDistance: withValue.length,
      nullCount: nullSubset,
      nullPct: subset.length === 0 ? null : (100 * nullSubset) / subset.length,
      distancePctMedian: percentile(withValue.map((r) => r.distancePct), 50),
      distancePctP75: percentile(withValue.map((r) => r.distancePct), 75),
      distancePctP90: percentile(withValue.map((r) => r.distancePct), 90),
      deciles,
    };
  }

  const summary = {
    LONG: analyzeDirection('LONG'),
    SHORT: analyzeDirection('SHORT'),
    ALL: analyzeDirection('ALL'),
  };

  console.info('\n########## Decile analysis: distancePct to nearest support/resistance zone ##########');
  for (const direction of ['LONG', 'SHORT', 'ALL'] as const) {
    const s = summary[direction];
    console.info(`\n--- ${direction} (total=${s.totalInDirection}, usable=${s.usableWithDistance}, null=${s.nullCount} [${s.nullPct?.toFixed(2)}%]) ---`);
    console.info('decile | n | distancePct range | TP | SL | TP%(TP+SL)');
    for (const d of s.deciles) {
      console.info(`${d.decile} | ${d.n} | [${d.distancePctMin?.toFixed(5)}, ${d.distancePctMax?.toFixed(5)}] | ${d.takeProfitCount} | ${d.stopLossCount} | ${d.takeProfitRatePctOfTpSl?.toFixed(2) ?? 'N/A'}%`);
    }
  }

  const output = {
    warning:
      'TICKET-04X-Y: khoang cach toi vung ho tro/khang cu THUAN MO TA, khong PnL/toi uu gi. Nguong 0.1% cluster gap va 3-lan-cham/30-ngay ' +
      'da khoa TRUOC khi chay, khong chinh sau khi thay ket qua.',
    generatedAt: new Date().toISOString(),
    clusterGapPct: CLUSTER_GAP_PCT,
    minTouches: MIN_TOUCHES,
    lookbackDays: 30,
    totalTpSlTrades: trades.length,
    summary,
  };

  const outputPath = resolve(auditsDirectory, 'supportResistanceDistanceAnalysis.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
