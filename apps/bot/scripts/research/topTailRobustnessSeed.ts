import { readFile, writeFile, mkdtemp, rm, mkdir, appendFile, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-063 Part B: algorithmic-randomness robustness of Q1 — mirrors Part A
// (topTailRobustnessData.ts) exactly EXCEPT the perturbation source: here the training DATA never
// changes (same purged train set as the baseline, no resampling); only XGBClassifier's own
// random_state varies, 0..29, via xgbTrainFold.py's new optional 5th CLI arg (RT-063 addition,
// backward compatible — every RT-058..062 call site is unaffected and keeps defaulting to 42).
// Same 2 metrics as Part A (Q1 overlap%, Spearman on baseline-Q1 members), same baseline
// (random_state=42, unperturbed — recomputed here independently for standalone reproducibility, but
// bit-identical to Part A's baseline and to RT-061/062's own numbers, since it's the same
// deterministic pipeline).
//
// After computing its own 30 iterations, this script reads apps/bot/data/rt063PartA.json (written by
// topTailRobustnessData.ts, which must be run first) to build the direct Part A vs Part B comparison
// table, then appends both this section and its own results to RT-063-report.md.
//
// Writes apps/bot/data/rt063PartB.json in the same shape as Part A's, for q1FeatureCheck.ts.

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
function trainFold(pythonExe: string, scriptPath: string, trainPath: string, testPath: string, featureColumns: string[], randomState?: number): TrainResult {
  const args = [scriptPath, trainPath, testPath, featureColumns.join(',')];
  if (randomState !== undefined) args.push(String(randomState));
  const stdout = execFileSync(pythonExe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const rank = (values: number[]): number[] => {
    const idxSorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idxSorted[j + 1].v === idxSorted[i].v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idxSorted[k].i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const meanRx = rx.reduce((a, b) => a + b, 0) / n;
  const meanRy = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanRx;
    const dy = ry[i] - meanRy;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return NaN;
  return cov / Math.sqrt(varX * varY);
}

interface IterationResult {
  iteration: number;
  overlapPct: number;
  spearman: number;
  featureImportance: Record<string, number>;
}
interface FoldResultB {
  foldIndex: number;
  testMonth: string;
  trainN: number;
  testN: number;
  baselineQ1Size: number;
  iterations: IterationResult[];
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-063-report.md');
  const jsonPathA = path.resolve(process.cwd(), 'apps/bot/data/rt063PartA.json');
  const jsonPathB = path.resolve(process.cwd(), 'apps/bot/data/rt063PartB.json');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/research/xgbTrainFold.py');
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

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
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt063-seed-'));
  const foldResults: FoldResultB[] = [];

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

      console.log(`Fold ${foldIndex}: train (sau purge) n=${purgedTrain.length}, test n=${testTrades.length}`);
      if (purgedTrain.length === 0 || testTrades.length === 0) {
        console.log('  -> BO QUA.');
        continue;
      }

      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');
      const trainPath = path.join(tmpDir, `fold${testMonthIdx}_train.csv`);
      await writeFile(trainPath, tradesToCsv(purgedTrain), 'utf8');

      // --- Baseline (random_state=42, unperturbed data) — same as Part A's ---
      const baseline = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS, 42);
      const baselineScores = baseline.predictions.map((p) => p.predicted);
      const baselineQ1 = q1Indices(baselineScores);
      console.log(`  Baseline AUC=${baseline.auc !== null ? baseline.auc.toFixed(4) : 'n/a'}  Q1 size=${baselineQ1.size}`);

      // --- 30 reruns, SAME data, only random_state = 0..29 varies ---
      const iterations: IterationResult[] = [];
      for (let seed = 0; seed < 30; seed++) {
        const result = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS, seed);
        const noisyScores = result.predictions.map((p) => p.predicted);
        const noisyQ1 = q1Indices(noisyScores);

        let overlapCount = 0;
        for (const idx of baselineQ1) if (noisyQ1.has(idx)) overlapCount++;
        const overlapPct = (overlapCount / baselineQ1.size) * 100;

        const baselineQ1Arr = Array.from(baselineQ1);
        const xs = baselineQ1Arr.map((idx) => baselineScores[idx]);
        const ys = baselineQ1Arr.map((idx) => noisyScores[idx]);
        const rho = spearman(xs, ys);

        iterations.push({ iteration: seed, overlapPct, spearman: rho, featureImportance: result.featureImportance });
      }
      console.log(`  30 lan seed xong. Overlap% trung binh=${(iterations.reduce((s, it) => s + it.overlapPct, 0) / iterations.length).toFixed(1)}%`);

      foldResults.push({ foldIndex, testMonth, trainN: purgedTrain.length, testN: testTrades.length, baselineQ1Size: baselineQ1.size, iterations });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPathB), { recursive: true });
  await writeFile(jsonPathB, JSON.stringify({ folds: foldResults }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPathB}`);

  // --- Load Part A's results for the direct comparison table ---
  let partA: { folds: FoldResultB[] } | null = null;
  try {
    partA = JSON.parse(await readFile(jsonPathA, 'utf8'));
  } catch {
    console.error(`CANH BAO: khong doc duoc ${jsonPathA} — hay chay topTailRobustnessData.ts (Part A) TRUOC. Bo qua bang so sanh A vs B.`);
  }

  let md = '\n---\n\n# TICKET-RT-063 Part B — Top-Tail (Q1) Robustness: Algorithmic Randomness\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058..062. Khong doi random_state MAC DINH cua xgbTrainFold.py cho cac loi goi khong truyen tham so moi (RT-058..062 khong bi anh huong).\n\n';
  md += 'Phuong phap: du lieu train KHONG doi (tap sau purge, khong resample) — CHI doi random_state cua XGBClassifier, 0..29, qua tham so CLI thu 5 moi (backward compatible). So voi baseline (random_state=42) cung 2 chi so nhu Part A.\n\n';

  md += '## Bang tom tat: overlap% va Spearman, theo fold\n\n';
  md += '| Fold | Train n | Test n | Q1 size (baseline) | Overlap% (mean) | Overlap% (median) | Overlap% (min-max) | Spearman (mean) | Spearman (median) | Spearman (min-max) |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|\n';
  for (const f of foldResults) {
    const overlaps = f.iterations.map((it) => it.overlapPct);
    const rhos = f.iterations.map((it) => it.spearman).filter((r) => Number.isFinite(r));
    md += `| ${f.foldIndex} | ${f.trainN} | ${f.testN} | ${f.baselineQ1Size} | ${mean(overlaps).toFixed(1)}% | ${median(overlaps).toFixed(1)}% | ${Math.min(...overlaps).toFixed(1)}%-${Math.max(...overlaps).toFixed(1)}% | ${rhos.length > 0 ? mean(rhos).toFixed(3) : 'n/a'} | ${rhos.length > 0 ? median(rhos).toFixed(3) : 'n/a'} | ${rhos.length > 0 ? `${Math.min(...rhos).toFixed(3)}-${Math.max(...rhos).toFixed(3)}` : 'n/a'} |\n`;
  }
  md += '\n';

  md += '## Chi tiet 30 lan/fold\n\n';
  for (const f of foldResults) {
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth})\n\n`;
    md += '| Seed | Overlap% | Spearman |\n';
    md += '|---|---|---|\n';
    for (const it of f.iterations) {
      md += `| ${it.iteration} | ${it.overlapPct.toFixed(1)}% | ${Number.isFinite(it.spearman) ? it.spearman.toFixed(3) : 'n/a'} |\n`;
    }
    md += '\n';
  }

  md += '## So sanh truc tiep Phan A (nhieu du lieu) vs Phan B (nhieu thuat toan), theo fold\n\n';
  if (partA) {
    md += '| Fold | Overlap% mean (A: data) | Overlap% mean (B: seed) | Chenh lech (B-A) | Spearman mean (A) | Spearman mean (B) | Chenh lech (B-A) |\n';
    md += '|---|---|---|---|---|---|---|\n';
    for (const fb of foldResults) {
      const fa = partA.folds.find((f) => f.foldIndex === fb.foldIndex);
      if (!fa) continue;
      const overlapsA = fa.iterations.map((it) => it.overlapPct);
      const overlapsB = fb.iterations.map((it) => it.overlapPct);
      const rhosA = fa.iterations.map((it) => it.spearman).filter((r) => Number.isFinite(r));
      const rhosB = fb.iterations.map((it) => it.spearman).filter((r) => Number.isFinite(r));
      const meanOA = mean(overlapsA);
      const meanOB = mean(overlapsB);
      const meanRA = rhosA.length > 0 ? mean(rhosA) : NaN;
      const meanRB = rhosB.length > 0 ? mean(rhosB) : NaN;
      md += `| ${fb.foldIndex} | ${meanOA.toFixed(1)}% | ${meanOB.toFixed(1)}% | ${(meanOB - meanOA >= 0 ? '+' : '') + (meanOB - meanOA).toFixed(1)}pp | ${Number.isFinite(meanRA) ? meanRA.toFixed(3) : 'n/a'} | ${Number.isFinite(meanRB) ? meanRB.toFixed(3) : 'n/a'} | ${Number.isFinite(meanRA) && Number.isFinite(meanRB) ? ((meanRB - meanRA >= 0 ? '+' : '') + (meanRB - meanRA).toFixed(3)) : 'n/a'} |\n`;
    }
    md += '\n_(Neu Phan B (chi doi seed) da bat on ngang Phan A (doi ca du lieu) — tuc chenh lech nho — thi van de nghieng ve thuat toan/tham so (vd max_depth=3, n_estimators=100 khong phu hop voi n nho). Neu Phan A bat on ro ret hon Phan B, thi van de nghieng ve ban chat du lieu/co mau. Khong tu ket luan — de Vinh Tam/AI reviewer tu doc.)_\n';
  } else {
    md += '_(Khong co du lieu Part A de so sanh — chay topTailRobustnessData.ts truoc.)_\n';
  }

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  try {
    await access(reportPath);
    await appendFile(reportPath, md, 'utf8');
  } catch {
    await writeFile(reportPath, md, 'utf8');
  }
  console.log(`\nDa ghi/append bao cao (Part B) vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
