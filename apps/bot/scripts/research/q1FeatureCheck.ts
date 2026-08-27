import { readFile, writeFile, mkdtemp, rm, mkdir, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-063 Part C: is Q1 just fvgGapSizePct in disguise?
// Audit-only. Does not touch production. Does not modify RT-058..062.
//
// Reads apps/bot/data/rt063PartA.json and rt063PartB.json (written by topTailRobustnessData.ts /
// topTailRobustnessSeed.ts, which must both be run first — no XGBoost retraining happens here for
// those 60 perturbation runs, just reading their already-recorded feature importances). Among the
// runs with Q1 overlap >= 80% ("stable" per the ticket's own threshold), checks whether
// fvgGapSizePct's gain share of the total is consistently dominant (>50%).
//
// Independently (cheap — 6 XGBoost fits, one baseline per fold, recomputed here for standalone
// reproducibility, bit-identical to RT-061/062/063 Part A/B's own baseline): for each fold, builds a
// univariate "Q1" by simply thresholding fvgGapSizePct itself (top ~20% of the test set by that one
// raw feature value, no model) and measures its overlap with the REAL baseline XGBoost Q1.

const V2_ALL_FEATURE_COLUMNS = [
  'distanceFromEma200H1Pct',
  'slPct',
  'fvgGapSizePct',
  'waitedCandlesCount',
  'breaksKeyZone',
  'atrH1Pct',
  'hourOfDayUtc',
  'dayOfWeekUtc',
  'trendAgeH1Candles',
  'atrPercentileH1',
  'momentumM15Pct3Candles',
  'keyZoneDistancePct',
  'rollingWinRateSameSymbol20',
  'concurrentOpenPositionsCount',
];

const CSV_COLUMNS = [
  'symbol',
  'entryTimestampUtc',
  'distanceFromEma200H1Pct',
  'slPct',
  'fvgGapSizePct',
  'waitedCandlesCount',
  'breaksKeyZone',
  'atrH1Pct',
  'hourOfDayUtc',
  'dayOfWeekUtc',
  'trendAgeH1Candles',
  'atrPercentileH1',
  'momentumM15Pct3Candles',
  'keyZoneDistancePct',
  'rollingWinRateSameSymbol20',
  'concurrentOpenPositionsCount',
  'won',
] as const;

function cell(v: unknown): string {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
  return String(v);
}
function tradesToCsv(trades: ClosedTradeInternal[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = trades.map((t) => {
    const f = t.features as any;
    const row: Record<string, unknown> = { ...f, won: t.outcome === 'TP' };
    return CSV_COLUMNS.map((c) => cell(row[c])).join(',');
  });
  return [header, ...lines].join('\n') + '\n';
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthStartMs(monthLabel: string): number {
  const [y, m] = monthLabel.split('-').map(Number);
  return Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
}

interface TrainResult {
  auc: number | null;
  featureImportance: Record<string, number>;
  predictions: { symbol: string; predicted: number; won: boolean }[];
}
function trainFold(pythonExe: string, scriptPath: string, trainPath: string, testPath: string, featureColumns: string[]): TrainResult {
  const stdout = execFileSync(pythonExe, [scriptPath, trainPath, testPath, featureColumns.join(',')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}
function findPython(): string {
  const candidates = ['python', 'python3'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['-c', 'import xgboost, pandas, sklearn'], { stdio: 'ignore' });
      return c;
    } catch {
      // try next
    }
  }
  throw new Error('CORRECTION_REQUIRED: no Python interpreter with xgboost/pandas/scikit-learn found on PATH.');
}

function q1Indices(scores: number[], fraction = 0.2): Set<number> {
  const order = scores.map((s, idx) => ({ s, idx })).sort((a, b) => b.s - a.s);
  const nQ1 = Math.round(scores.length * fraction);
  return new Set(order.slice(0, nQ1).map((o) => o.idx));
}

interface IterationResult {
  iteration: number;
  overlapPct: number;
  spearman: number;
  featureImportance: Record<string, number>;
}
interface FoldResultRaw {
  foldIndex: number;
  testMonth: string;
  trainN: number;
  testN: number;
  baselineQ1Size: number;
  iterations: IterationResult[];
}

function fvgGapShare(fi: Record<string, number>): number {
  const total = Object.values(fi).reduce((a, b) => a + b, 0);
  return total > 0 ? (fi.fvgGapSizePct ?? 0) / total : NaN;
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-063-report.md');
  const jsonPathA = path.resolve(process.cwd(), 'apps/bot/data/rt063PartA.json');
  const jsonPathB = path.resolve(process.cwd(), 'apps/bot/data/rt063PartB.json');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/research/xgbTrainFold.py');
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  let partA: { folds: FoldResultRaw[] };
  let partB: { folds: FoldResultRaw[] };
  try {
    partA = JSON.parse(await readFile(jsonPathA, 'utf8'));
    partB = JSON.parse(await readFile(jsonPathB, 'utf8'));
  } catch (err) {
    console.error(`CORRECTION_REQUIRED: khong doc duoc ${jsonPathA} va/hoac ${jsonPathB} — hay chay topTailRobustnessData.ts VA topTailRobustnessSeed.ts TRUOC. Loi: ${err}`);
    process.exitCode = 1;
    return;
  }

  console.log('Dang load du lieu va chay mirrored simulation (xgbFeatureAuditV3, tu-kiem-tra)...');
  const allData = await loadAllSymbolData(dataDir);
  const { closed } = runInstrumentedSimulation(allData, targetR);

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of closed) {
    totalPnl += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const totalPf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const matches = closed.length === 1217 && Math.abs(totalPnl - 2628.76) < 0.01 && Math.abs(totalPf - 1.551) < 0.001;
  console.log(`n=${closed.length}  PnL=$${totalPnl.toFixed(2)}  PF=${totalPf.toFixed(3)}  (doi chieu RT-056/057: n=1217, PnL=$2628.76, PF=1.551)`);
  if (!matches) {
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-063) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt063-featcheck-'));

  interface FoldC {
    foldIndex: number;
    testMonth: string;
    baselineFvgShare: number;
    baselineFeatureImportance: Record<string, number>;
    stableCount: number;
    totalPerturbedCount: number;
    stableFvgShares: number[];
    univariateQ1Size: number;
    univariateOverlapPct: number;
    univariateThreshold: number;
  }
  const foldResults: FoldC[] = [];

  try {
    for (let testMonthIdx = 7; testMonthIdx <= lastTestMonth; testMonthIdx++) {
      const foldIndex = testMonthIdx - 6;
      const trainMonthIndices = Array.from({ length: testMonthIdx - 1 }, (_, i) => i + 1);
      const trainMonths = trainMonthIndices.map((idx) => monthsPresent[idx - 1]);
      const testMonth = monthsPresent[testMonthIdx - 1];
      const testStart = monthStartMs(testMonth);

      const trainCandidates = closed.filter((t) => trainMonths.includes(monthKey(t.features.entryTimestampUtc)));
      const purgedTrain = trainCandidates.filter((t) => t.closeTime < testStart);
      const testTrades = closed.filter((t) => monthKey(t.features.entryTimestampUtc) === testMonth);
      if (purgedTrain.length === 0 || testTrades.length === 0) continue;

      console.log(`Fold ${foldIndex}: baseline train n=${purgedTrain.length}, test n=${testTrades.length}`);
      const trainPath = path.join(tmpDir, `fold${testMonthIdx}_train.csv`);
      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(trainPath, tradesToCsv(purgedTrain), 'utf8');
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');

      const baseline = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS);
      const baselineScores = baseline.predictions.map((p) => p.predicted);
      const baselineQ1 = q1Indices(baselineScores);
      const baselineFvgShare = fvgGapShare(baseline.featureImportance);
      console.log(`  Baseline AUC=${baseline.auc !== null ? baseline.auc.toFixed(4) : 'n/a'}  fvgGapSizePct share=${(baselineFvgShare * 100).toFixed(1)}%`);

      // --- Stable runs from Part A + Part B (overlap>=80%) ---
      const faA = partA.folds.find((f) => f.foldIndex === foldIndex);
      const faB = partB.folds.find((f) => f.foldIndex === foldIndex);
      const allIterations = [...(faA?.iterations ?? []), ...(faB?.iterations ?? [])];
      const stable = allIterations.filter((it) => it.overlapPct >= 80);
      const stableFvgShares = stable.map((it) => fvgGapShare(it.featureImportance)).filter((s) => Number.isFinite(s));

      // --- Univariate threshold check on fvgGapSizePct alone ---
      const fvgValues = testTrades.map((t) => t.features.fvgGapSizePct);
      const sortedDesc = [...fvgValues].map((v, idx) => ({ v, idx })).sort((a, b) => b.v - a.v);
      const nQ1 = Math.round(testTrades.length * 0.2);
      const univariateQ1 = new Set(sortedDesc.slice(0, nQ1).map((o) => o.idx));
      const univariateThreshold = sortedDesc[nQ1 - 1]?.v ?? NaN;
      let overlapCount = 0;
      for (const idx of baselineQ1) if (univariateQ1.has(idx)) overlapCount++;
      const univariateOverlapPct = (overlapCount / baselineQ1.size) * 100;
      console.log(`  Univariate (fvgGapSizePct>=${univariateThreshold.toFixed(3)}) Q1 overlap voi XGBoost Q1 = ${univariateOverlapPct.toFixed(1)}%`);

      foldResults.push({
        foldIndex,
        testMonth,
        baselineFvgShare,
        baselineFeatureImportance: baseline.featureImportance,
        stableCount: stable.length,
        totalPerturbedCount: allIterations.length,
        stableFvgShares,
        univariateQ1Size: univariateQ1.size,
        univariateOverlapPct,
        univariateThreshold,
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // --- Report ---
  let md = '\n---\n\n# TICKET-RT-063 Part C — Q1: chi la fvgGapSizePct nguy trang?\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058..062. Khong tu ket luan.\n\n';
  md += `Tu-kiem-tra: mirrored simulation khop 100% RT-056/057 (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}). Doc ket qua tho tu ${path.basename(jsonPathA)} va ${path.basename(jsonPathB)} (khong train lai 60 lan nhieu) — chi train lai 6 lan baseline (1/fold) cho phan doi chieu univariate.\n\n`;

  md += '## fvgGapSizePct gain-share trong cac lan chay "on dinh" (Q1 overlap >= 80%, gop ca Phan A + Phan B)\n\n';
  md += '| Fold | Baseline fvgGapSizePct share | So lan on dinh (/60) | fvgGapSizePct share (mean, stable runs) | (min-max, stable runs) |\n';
  md += '|---|---|---|---|---|\n';
  for (const f of foldResults) {
    const shareStr = f.stableFvgShares.length > 0 ? `${(mean(f.stableFvgShares) * 100).toFixed(1)}%` : 'n/a (0 lan on dinh)';
    const minMaxStr = f.stableFvgShares.length > 0 ? `${(Math.min(...f.stableFvgShares) * 100).toFixed(1)}%-${(Math.max(...f.stableFvgShares) * 100).toFixed(1)}%` : 'n/a';
    md += `| ${f.foldIndex} | ${(f.baselineFvgShare * 100).toFixed(1)}% | ${f.stableCount}/${f.totalPerturbedCount} | ${shareStr} | ${minMaxStr} |\n`;
  }
  const allStableShares = foldResults.flatMap((f) => f.stableFvgShares);
  const dominantCount = allStableShares.filter((s) => s > 0.5).length;
  md += `\nQua tat ca fold: ${allStableShares.length} lan chay "on dinh" (overlap>=80%). Trong so do, ${dominantCount}/${allStableShares.length} lan (${allStableShares.length > 0 ? ((dominantCount / allStableShares.length) * 100).toFixed(1) : 'n/a'}%) co fvgGapSizePct chiem >50% tong gain.\n\n`;

  md += '## Baseline feature importance day du (gain), theo fold\n\n';
  const featureNames = foldResults.length > 0 ? Object.keys(foldResults[0].baselineFeatureImportance) : [];
  md += `| Feature | ${foldResults.map((f) => `Fold ${f.foldIndex}`).join(' | ')} |\n`;
  md += `|---|${foldResults.map(() => '---').join('|')}|\n`;
  for (const name of featureNames) {
    md += `| ${name} | ${foldResults.map((f) => f.baselineFeatureImportance[name].toFixed(2)).join(' | ')} |\n`;
  }
  md += '\n';

  md += '## Phep do phu: Q1 don bien tren fvgGapSizePct (khong dung model) vs Q1 that cua XGBoost\n\n';
  md += '| Fold | Nguong fvgGapSizePct (top ~20%) | n (univariate Q1) | Overlap% voi Q1 XGBoost |\n';
  md += '|---|---|---|---|\n';
  for (const f of foldResults) {
    md += `| ${f.foldIndex} | ${f.univariateThreshold.toFixed(3)}% | ${f.univariateQ1Size} | ${f.univariateOverlapPct.toFixed(1)}% |\n`;
  }
  md += `\nOverlap% trung binh qua ${foldResults.length} fold: ${mean(foldResults.map((f) => f.univariateOverlapPct)).toFixed(1)}%.\n\n`;
  md += '_(So lieu tho — khong tu ket luan Q1 co "chi la" fvgGapSizePct hay khong. Vinh Tam/AI reviewer tu doi chieu gain-share va overlap% don bien o tren.)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  try {
    await access(reportPath);
    await appendFile(reportPath, md, 'utf8');
  } catch {
    await writeFile(reportPath, md, 'utf8');
  }
  console.log(`\nDa ghi/append bao cao (Part C) vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
