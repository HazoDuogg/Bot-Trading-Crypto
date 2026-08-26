import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';

// TICKET-RT-063 Part A: data-perturbation robustness of Q1 (top 20% by predicted score).
// Audit-only. Does not touch production. Does not modify RT-058..062 (imports xgbFeatureAuditV3.ts,
// RT-059/061, frozen, read-only).
//
// For each of the 6 RT-061 purge-corrected folds: compute a BASELINE run (unperturbed purged train,
// v2/14 features, random_state=42 — bit-identical to RT-061/062's own numbers, since this is the same
// deterministic pipeline) to get the baseline Q1 (top 20% of the test set by predicted score). Then
// 30 times: bootstrap-resample the SAME purged train set (with replacement, same size), retrain
// (still random_state=42 — only the DATA changes here, never the algorithm's own randomness — that's
// Part B's job), predict on the SAME unchanged test set, and measure:
//   - % of baseline-Q1 members still in the noisy run's own Q1
//   - Spearman rank correlation between baseline score and noisy score, restricted to baseline-Q1
//     members only
//
// Reproducibility: bootstrap indices for fold f, iteration r (0..29) are drawn from mulberry32(r) —
// same seeding scheme as RT-062 Part B — reset fresh for every (fold, iteration) pair, so rerunning
// this file reproduces the exact same 30 resampled training sets per fold, every time.
//
// Writes apps/bot/data/rt063PartA.json (raw per-iteration results, incl. feature importance) for
// q1FeatureCheck.ts (Part C) to read without re-running 180 XGBoost fits.

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

// mulberry32 — same deterministic PRNG as RT-062 Part B.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapResample(trades: ClosedTradeInternal[], rng: () => number): ClosedTradeInternal[] {
  const n = trades.length;
  const out: ClosedTradeInternal[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * n);
    out.push(trades[idx]);
  }
  return out;
}

function q1Indices(scores: number[], fraction = 0.2): Set<number> {
  const order = scores.map((s, idx) => ({ s, idx })).sort((a, b) => b.s - a.s);
  const nQ1 = Math.round(scores.length * fraction);
  return new Set(order.slice(0, nQ1).map((o) => o.idx));
}

// Spearman rank correlation, average-rank tie handling.
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
interface FoldResultA {
  foldIndex: number;
  testMonth: string;
  trainN: number;
  testN: number;
  baselineQ1Size: number;
  iterations: IterationResult[];
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-063-report.md');
  const jsonPath = path.resolve(process.cwd(), 'apps/bot/data/rt063PartA.json');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/xgbTrainFold.py');
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
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt063-data-'));
  const foldResults: FoldResultA[] = [];

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

      // --- Baseline (unperturbed, random_state=42 — identical to RT-061/062) ---
      const baselineTrainPath = path.join(tmpDir, `fold${testMonthIdx}_baseline_train.csv`);
      await writeFile(baselineTrainPath, tradesToCsv(purgedTrain), 'utf8');
      const baseline = trainFold(pythonExe, scriptPath, baselineTrainPath, testPath, V2_ALL_FEATURE_COLUMNS);
      const baselineScores = baseline.predictions.map((p) => p.predicted);
      const baselineQ1 = q1Indices(baselineScores);
      console.log(`  Baseline AUC=${baseline.auc !== null ? baseline.auc.toFixed(4) : 'n/a'}  Q1 size=${baselineQ1.size}`);

      // --- 30 bootstrap-resampled reruns ---
      const iterations: IterationResult[] = [];
      for (let r = 0; r < 30; r++) {
        const rng = mulberry32(r);
        const resampled = bootstrapResample(purgedTrain, rng);
        const trainPath = path.join(tmpDir, `fold${testMonthIdx}_boot${r}.csv`);
        writeFileSync(trainPath, tradesToCsv(resampled), 'utf8');
        const result = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS);
        const noisyScores = result.predictions.map((p) => p.predicted);
        const noisyQ1 = q1Indices(noisyScores);

        let overlapCount = 0;
        for (const idx of baselineQ1) if (noisyQ1.has(idx)) overlapCount++;
        const overlapPct = (overlapCount / baselineQ1.size) * 100;

        const baselineQ1Arr = Array.from(baselineQ1);
        const xs = baselineQ1Arr.map((idx) => baselineScores[idx]);
        const ys = baselineQ1Arr.map((idx) => noisyScores[idx]);
        const rho = spearman(xs, ys);

        iterations.push({ iteration: r, overlapPct, spearman: rho, featureImportance: result.featureImportance });
      }
      console.log(`  30 lan bootstrap xong. Overlap% trung binh=${(iterations.reduce((s, it) => s + it.overlapPct, 0) / iterations.length).toFixed(1)}%`);

      foldResults.push({
        foldIndex,
        testMonth,
        trainN: purgedTrain.length,
        testN: testTrades.length,
        baselineQ1Size: baselineQ1.size,
        iterations,
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ folds: foldResults }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPath}`);

  // --- Report ---
  function mean(a: number[]): number {
    return a.reduce((x, y) => x + y, 0) / a.length;
  }
  function median(a: number[]): number {
    const s = [...a].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  }

  let md = '# TICKET-RT-063 Part A — Top-Tail (Q1) Robustness: Data Perturbation\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058..062.\n\n';
  md += `Pipeline: import truc tiep xgbFeatureAuditV3.ts (RT-059/061, dong bang) — cung purge logic RT-061, cung 6 fold, feature v2. Tu-kiem-tra khop 100% RT-056/057 (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;
  md += 'Phuong phap: moi fold, 30 lan bootstrap-resample tap train sau purge (co hoan lai, cung kich thuoc goc), train lai (random_state=42 co dinh — CHI doi du lieu), du doan tren dung test set goc. So voi Q1 goc (baseline, khong nhieu).\n\n';
  md += `Seed: mulberry32(iteration), iteration=0..29, dung lai cho moi fold (tai lap 100% khi chay lai file nay).\n\n`;

  md += '## Bang tom tat: overlap% va Spearman (trung binh + phan phoi qua 30 lan), theo fold\n\n';
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
    md += '| Iteration | Overlap% | Spearman |\n';
    md += '|---|---|---|\n';
    for (const it of f.iterations) {
      md += `| ${it.iteration} | ${it.overlapPct.toFixed(1)}% | ${Number.isFinite(it.spearman) ? it.spearman.toFixed(3) : 'n/a'} |\n`;
    }
    md += '\n';
  }
  md += '_(So lieu tho, khong tu ket luan Q1 on dinh/khong on dinh voi nhieu du lieu.)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao (Part A) vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
