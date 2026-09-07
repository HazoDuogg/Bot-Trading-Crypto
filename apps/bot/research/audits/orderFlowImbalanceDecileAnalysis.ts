import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TICKET-04X-X Step 3+4: joins the aggTrades order-flow features (Step 1+2) against the REAL
// outcome already computed by TICKET-04X-S (full cost model, no re-simulation here) and buckets by
// decile of imbalanceShift and of imbalance1min separately, LONG/SHORT split, to see whether
// TAKE_PROFIT rate trends across deciles -- a cheap screen only, not a trained/locked threshold.
// Sample is small (a few hundred signals from 3 weeks) -- exploratory, not conclusive either way.
interface FeatureRow {
  m5Index: number;
  direction: 'LONG' | 'SHORT';
  outcome: string;
  imbalance5min: number | null;
  imbalance1min: number | null;
  imbalanceShift: number | null;
}

function decileBuckets<T>(rows: readonly T[], keyOf: (row: T) => number): T[][] {
  const sorted = [...rows].sort((a, b) => keyOf(a) - keyOf(b));
  const n = sorted.length;
  const buckets: T[][] = [];
  for (let d = 0; d < 10; d += 1) {
    const startIdx = Math.floor((d * n) / 10);
    const endIdx = Math.floor(((d + 1) * n) / 10);
    buckets.push(sorted.slice(startIdx, endIdx));
  }
  return buckets;
}

function summarizeBucket(rows: readonly FeatureRow[], keyOf: (row: FeatureRow) => number | null) {
  const keys = rows.map(keyOf).filter((v): v is number => v !== null);
  const n = rows.length;
  const takeProfitCount = rows.filter((r) => r.outcome === 'TAKE_PROFIT').length;
  const stopLossCount = rows.filter((r) => r.outcome === 'STOP_LOSS').length;
  const outcomeCounts: Record<string, number> = {};
  for (const r of rows) outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
  return {
    n,
    keyMin: keys.length === 0 ? null : Math.min(...keys),
    keyMax: keys.length === 0 ? null : Math.max(...keys),
    keyMean: keys.length === 0 ? null : keys.reduce((s, v) => s + v, 0) / keys.length,
    takeProfitCount,
    stopLossCount,
    takeProfitRatePctOfAll: n === 0 ? null : (100 * takeProfitCount) / n,
    takeProfitRatePctOfTpSl: takeProfitCount + stopLossCount === 0 ? null : (100 * takeProfitCount) / (takeProfitCount + stopLossCount),
    outcomeCounts,
  };
}

function analyzeByFeature(rows: readonly FeatureRow[], keyOf: (row: FeatureRow) => number | null, featureName: string) {
  const withKey = rows.filter((r) => keyOf(r) !== null);
  const results: Record<string, unknown[]> = {};
  for (const direction of ['LONG', 'SHORT', 'ALL'] as const) {
    const subset = direction === 'ALL' ? withKey : withKey.filter((r) => r.direction === direction);
    const buckets = decileBuckets(subset, (r) => keyOf(r)!);
    results[direction] = buckets.map((bucket, idx) => ({ decile: idx + 1, ...summarizeBucket(bucket, keyOf) }));
  }
  console.info(`\n########## Decile analysis: ${featureName} ##########`);
  for (const direction of ['LONG', 'SHORT', 'ALL'] as const) {
    console.info(`\n--- ${direction} (n=${direction === 'ALL' ? withKey.length : withKey.filter((r) => r.direction === direction).length}) ---`);
    console.info('decile | n | keyRange | TP | SL | TP%(all) | TP%(TP+SL)');
    for (const row of results[direction] as Array<{ decile: number; n: number; keyMin: number | null; keyMax: number | null; takeProfitCount: number; stopLossCount: number; takeProfitRatePctOfAll: number | null; takeProfitRatePctOfTpSl: number | null }>) {
      console.info(
        `${row.decile} | ${row.n} | [${row.keyMin?.toFixed(4)}, ${row.keyMax?.toFixed(4)}] | ${row.takeProfitCount} | ${row.stopLossCount} | ` +
          `${row.takeProfitRatePctOfAll?.toFixed(2) ?? 'N/A'}% | ${row.takeProfitRatePctOfTpSl?.toFixed(2) ?? 'N/A'}%`,
      );
    }
  }
  return results;
}

async function main(): Promise<void> {
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));
  const featuresPath = resolve(auditsDirectory, 'aggTradesOrderFlowFeatures.json');
  console.info(`Loading ${featuresPath}...`);
  const data = JSON.parse(await readFile(featuresPath, 'utf8')) as { features: FeatureRow[] };
  console.info(`Total signals: ${data.features.length}`);

  const shiftResults = analyzeByFeature(data.features, (r) => r.imbalanceShift, 'imbalanceShift (imbalance_1min - imbalance_5min)');
  const imbalance1minResults = analyzeByFeature(data.features, (r) => r.imbalance1min, 'imbalance_1min');

  const output = {
    warning:
      'TICKET-04X-X Step 3+4: mau nho (mot vai tram tin hieu tu 3 tuan) -- ket qua chi la tham do so bo, KHONG du de ket luan chac chan ' +
      'du ra sao. Chua train ML, chua khoa nguong. Neu co dau hieu tot, buoc sau moi can nhac mo rong du lieu.',
    generatedAt: new Date().toISOString(),
    totalSignals: data.features.length,
    byImbalanceShift: shiftResults,
    byImbalance1min: imbalance1minResults,
  };

  const outputPath = resolve(auditsDirectory, 'orderFlowImbalanceDecileAnalysis.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
