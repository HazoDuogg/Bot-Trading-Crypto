import { readFile, writeFile, mkdtemp, rm, mkdir, appendFile, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, checkGridsAlignExactly, runInstrumentedSimulation, type ClosedTradeInternal } from './rt065FeatureAuditThreeYear.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';

// TICKET-RT-065 Part D step 3 (robustness): repeats RT-064's bootstrap-resample robustness test on
// the 3-year dataset, options A/B/C (D dropped, per ticket). Same method as RT-063 Part A / RT-064
// Part B: 30 bootstrap resamples per fold (mulberry32(iteration), reset per fold), same 30
// resampled row-selections shared across all 3 options within a fold. ~30 folds this time (vs
// RT-064's 6), so this is the long-running step — budget accordingly.

interface OptionConfig {
  label: string;
  featureColumns: string[];
}
const V1_FEATURES = ['distanceFromEma200H1Pct', 'slPct', 'fvgGapSizePct', 'waitedCandlesCount', 'breaksKeyZone', 'atrH1Pct', 'hourOfDayUtc', 'dayOfWeekUtc'];
const V2_FEATURES = [...V1_FEATURES, 'trendAgeH1Candles', 'atrPercentileH1', 'momentumM15Pct3Candles', 'keyZoneDistancePct', 'rollingWinRateSameSymbol20', 'concurrentOpenPositionsCount'];
const MINIMAL_FEATURES = ['fvgGapSizePct', 'keyZoneDistancePct', 'atrH1Pct', 'slPct'];
const OPTIONS: OptionConfig[] = [
  { label: 'A (v1, 8 feature)', featureColumns: V1_FEATURES },
  { label: 'B (v2, 14 feature)', featureColumns: V2_FEATURES },
  { label: 'C (toi gian, 4 feature)', featureColumns: MINIMAL_FEATURES },
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
  const stdout = execFileSync(pythonExe, [scriptPath, trainPath, testPath, featureColumns.join(','), '42'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  for (let i = 0; i < n; i++) out.push(trades[Math.floor(rng() * n)]);
  return out;
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
function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

interface IterationResult {
  iteration: number;
  overlapPct: number;
  spearman: number;
}
interface OptionFoldResult {
  optionLabel: string;
  foldIndex: number;
  testMonth: string;
  baselineTopSize: number;
  iterations: IterationResult[];
}

interface GroupTrade {
  entryTimestampUtc: number;
  outcome: 'TP' | 'SL';
  pnl: number;
  predicted: number;
}
interface FoldPerOptionA {
  optionLabel: string;
  foldIndex: number;
  testMonth: string;
  top: { n: number; pf: number; winRate: number };
  topTrades: GroupTrade[];
}
function computePooledPf(trades: GroupTrade[]): number {
  const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-065-report.md');
  const jsonPathA = path.resolve(process.cwd(), 'apps/bot/data/rt065PartDQuintile.json');
  const jsonPath = path.resolve(process.cwd(), 'apps/bot/data/rt065PartDRobustness.json');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/xgbTrainFold.py');
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const targetR = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

  console.log('Dang load du lieu 3 nam va chay mirrored simulation (tu-kiem-tra)...');
  const allData = await loadAllSymbolData(dataDir, '3y');
  const grid = checkGridsAlignExactly(allData);
  const { closed } = runInstrumentedSimulation(allData, grid, targetR);

  let totalPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of closed) {
    totalPnl += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += Math.abs(t.pnl);
  }
  const totalPf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  console.log(`n=${closed.length}  PnL=$${totalPnl.toFixed(2)}  PF=${totalPf.toFixed(3)}  (doi chieu RT-065 Part C: n=3468, PnL=$6638.77, PF=1.429)`);
  const matches = closed.length === 3468 && Math.abs(totalPnl - 6638.77) < 0.01 && Math.abs(totalPf - 1.429) < 0.001;
  if (!matches) {
    console.error('CORRECTION_REQUIRED: mirrored simulation KHONG khop RT-065 Part C — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  console.log(`${K} thang -> ${K - 6} fold.\n`);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt065-robust-'));
  const allResults: OptionFoldResult[] = [];

  try {
    for (let testMonthIdx = 7; testMonthIdx <= K; testMonthIdx++) {
      const foldIndex = testMonthIdx - 6;
      const trainMonthIndices = Array.from({ length: testMonthIdx - 1 }, (_, i) => i + 1);
      const trainMonths = trainMonthIndices.map((idx) => monthsPresent[idx - 1]);
      const testMonth = monthsPresent[testMonthIdx - 1];
      const testStart = monthStartMs(testMonth);

      const trainCandidates = closed.filter((t) => trainMonths.includes(monthKey(t.features.entryTimestampUtc)));
      const purgedTrain = trainCandidates.filter((t) => t.closeTime < testStart);
      const testTrades = closed.filter((t) => monthKey(t.features.entryTimestampUtc) === testMonth);

      if (purgedTrain.length === 0 || testTrades.length === 0) {
        console.log(`Fold ${foldIndex} (${testMonth}): BO QUA.`);
        continue;
      }

      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');
      const baselineTrainPath = path.join(tmpDir, `fold${testMonthIdx}_baseline_train.csv`);
      await writeFile(baselineTrainPath, tradesToCsv(purgedTrain), 'utf8');

      const baselines = OPTIONS.map((opt) => {
        const result = trainFold(pythonExe, scriptPath, baselineTrainPath, testPath, opt.featureColumns);
        const scores = result.predictions.map((p) => p.predicted);
        return { opt, scores, top: q1Indices(scores) };
      });

      const iterationsByOption: Record<string, IterationResult[]> = Object.fromEntries(OPTIONS.map((o) => [o.label, []]));
      for (let r = 0; r < 30; r++) {
        const rng = mulberry32(r);
        const resampled = bootstrapResample(purgedTrain, rng);
        const resampledCsv = tradesToCsv(resampled);

        for (const base of baselines) {
          const trainPath = path.join(tmpDir, `fold${testMonthIdx}_boot${r}_${base.opt.label.slice(0, 1)}.csv`);
          writeFileSync(trainPath, resampledCsv, 'utf8');
          const result = trainFold(pythonExe, scriptPath, trainPath, testPath, base.opt.featureColumns);
          const noisyScores = result.predictions.map((p) => p.predicted);
          const noisyTop = q1Indices(noisyScores);

          let overlapCount = 0;
          for (const idx of base.top) if (noisyTop.has(idx)) overlapCount++;
          const overlapPct = (overlapCount / base.top.size) * 100;

          const baseTopArr = Array.from(base.top);
          const xs = baseTopArr.map((idx) => base.scores[idx]);
          const ys = baseTopArr.map((idx) => noisyScores[idx]);
          const rho = spearman(xs, ys);

          iterationsByOption[base.opt.label].push({ iteration: r, overlapPct, spearman: rho });
        }
      }

      const logParts: string[] = [];
      for (const base of baselines) {
        const iters = iterationsByOption[base.opt.label];
        logParts.push(`[${base.opt.label}] Overlap=${mean(iters.map((it) => it.overlapPct)).toFixed(1)}%`);
        allResults.push({ optionLabel: base.opt.label, foldIndex, testMonth, baselineTopSize: base.top.size, iterations: iters });
      }
      console.log(`Fold ${foldIndex} (${testMonth}): ${logParts.join('  ')}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ results: allResults }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPath}`);

  // --- Report: robustness summary + final Part C summary table ---
  let md = '\n---\n\n## Part B (robustness, nhieu du lieu) — 3 phuong an, tat ca fold\n\n';
  md += 'Phuong phap: 30 lan bootstrap-resample train set sau purge moi fold (mulberry32(iteration), dung lai cho ca 3 phuong an trong 1 fold). So voi Top-20% baseline (khong nhieu) cua chinh phuong an do.\n\n';
  for (const opt of OPTIONS) {
    md += `### ${opt.label}\n\n`;
    md += '| Fold | Thang test | Top size | Overlap% (mean) | Spearman (mean) |\n';
    md += '|---|---|---|---|---|\n';
    const rows = allResults.filter((r) => r.optionLabel === opt.label);
    for (const r of rows) {
      const overlaps = r.iterations.map((it) => it.overlapPct);
      const rhos = r.iterations.map((it) => it.spearman).filter((x) => Number.isFinite(x));
      md += `| ${r.foldIndex} | ${r.testMonth} | ${r.baselineTopSize} | ${mean(overlaps).toFixed(1)}% | ${rhos.length > 0 ? mean(rhos).toFixed(3) : 'n/a'} |\n`;
    }
    md += '\n';
  }

  // --- Final summary (Part C of RT-064's naming convention) ---
  let partA: { results: FoldPerOptionA[] } | null = null;
  try {
    partA = JSON.parse(await readFile(jsonPathA, 'utf8'));
  } catch {
    console.error(`CANH BAO: khong doc duoc ${jsonPathA} — hay chay rt065PartDQuintile.ts TRUOC. Bo qua bang tong hop cuoi.`);
  }

  if (partA) {
    md += '\n---\n\n## Tong hop cuoi: 1 dong / phuong an (30 fold, 3 nam)\n\n';
    md += 'Khong tu chon "phuong an thang" — trinh bay so, de Vinh Tam/AI reviewer quyet dinh.\n\n';
    md += '| Phuong an | PF Top trung binh (pooled qua tat ca fold) | Overlap% trung binh | Spearman trung binh |\n';
    md += '|---|---|---|---|\n';
    for (const opt of OPTIONS) {
      const aRows = partA.results.filter((r) => r.optionLabel === opt.label);
      const pooledTopTrades = aRows.flatMap((r) => r.topTrades);
      const pooledPf = computePooledPf(pooledTopTrades);

      const bRows = allResults.filter((r) => r.optionLabel === opt.label);
      const perFoldOverlapMeans = bRows.map((r) => mean(r.iterations.map((it) => it.overlapPct)));
      const perFoldSpearmanMeans = bRows
        .map((r) => {
          const rhos = r.iterations.map((it) => it.spearman).filter((x) => Number.isFinite(x));
          return rhos.length > 0 ? mean(rhos) : NaN;
        })
        .filter((x) => Number.isFinite(x));

      md += `| ${opt.label} | ${Number.isFinite(pooledPf) ? pooledPf.toFixed(2) : 'inf'} | ${mean(perFoldOverlapMeans).toFixed(1)}% | ${perFoldSpearmanMeans.length > 0 ? mean(perFoldSpearmanMeans).toFixed(3) : 'n/a'} |\n`;
    }
    md += `\n_(So sanh voi RT-064 (1 nam, 6 fold): ky vong CI hep hon, phan biet A/B/C ro hon nho ${allResults.filter((r) => r.optionLabel === OPTIONS[0].label).length} fold thay vi 6.)_\n`;
  }

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  try {
    await access(reportPath);
    await appendFile(reportPath, md, 'utf8');
  } catch {
    await writeFile(reportPath, md, 'utf8');
  }
  console.log(`\nDa ghi/append bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
