import { readFile, writeFile, mkdtemp, rm, mkdir, appendFile, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';

// TICKET-RT-064 Part B: data-perturbation robustness of Top-20%, 4 options side by side.
// Audit-only. Does not touch production. Does not modify RT-058..063.
//
// Same method as RT-063 Part A (bootstrap-resample the purged train set, with replacement, same
// size, random_state=42 fixed — only the DATA changes; same mulberry32(iteration) seeding, iteration
// 0..29, reset per fold). The SAME 30 resampled row-selections are reused across all 4 options within
// a given fold (only the feature-column subset written to CSV differs per option) — a fair,
// apples-to-apples perturbation, not 4 independently-randomized resamples.

interface OptionConfig {
  label: string;
  featureColumns: string[];
  subsampleColsample?: string;
}
const V1_FEATURES = ['distanceFromEma200H1Pct', 'slPct', 'fvgGapSizePct', 'waitedCandlesCount', 'breaksKeyZone', 'atrH1Pct', 'hourOfDayUtc', 'dayOfWeekUtc'];
const V2_FEATURES = [...V1_FEATURES, 'trendAgeH1Candles', 'atrPercentileH1', 'momentumM15Pct3Candles', 'keyZoneDistancePct', 'rollingWinRateSameSymbol20', 'concurrentOpenPositionsCount'];
const MINIMAL_FEATURES = ['fvgGapSizePct', 'keyZoneDistancePct', 'atrH1Pct', 'slPct'];
const OPTIONS: OptionConfig[] = [
  { label: 'A (v1, 8 feature)', featureColumns: V1_FEATURES },
  { label: 'B (v2, 14 feature)', featureColumns: V2_FEATURES },
  { label: 'C (toi gian, 4 feature)', featureColumns: MINIMAL_FEATURES },
  { label: 'D (v2 + regularization)', featureColumns: V2_FEATURES, subsampleColsample: '0.8,0.8' },
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
function trainFold(pythonExe: string, scriptPath: string, trainPath: string, testPath: string, featureColumns: string[], randomState: number | undefined, subsampleColsample: string | undefined): TrainResult {
  const args = [scriptPath, trainPath, testPath, featureColumns.join(','), String(randomState ?? 42)];
  if (subsampleColsample !== undefined) args.push(subsampleColsample);
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
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-064-report.md');
  const jsonPathA = path.resolve(process.cwd(), 'apps/bot/data/rt064PartA.json');
  const jsonPath = path.resolve(process.cwd(), 'apps/bot/data/rt064PartB.json');
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
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-064) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt064-robust-'));
  const allResults: OptionFoldResult[] = [];

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
      const baselineTrainPath = path.join(tmpDir, `fold${testMonthIdx}_baseline_train.csv`);
      await writeFile(baselineTrainPath, tradesToCsv(purgedTrain), 'utf8');

      // Baseline per option (unperturbed).
      const baselines = OPTIONS.map((opt) => {
        const result = trainFold(pythonExe, scriptPath, baselineTrainPath, testPath, opt.featureColumns, 42, opt.subsampleColsample);
        const scores = result.predictions.map((p) => p.predicted);
        return { opt, scores, top: q1Indices(scores) };
      });
      console.log(`  Baseline Top sizes: ${baselines.map((b) => `${b.opt.label}=${b.top.size}`).join(', ')}`);

      // 30 SHARED bootstrap row-selections, reused across all 4 options (fair perturbation).
      const iterationsByOption: Record<string, IterationResult[]> = Object.fromEntries(OPTIONS.map((o) => [o.label, []]));
      for (let r = 0; r < 30; r++) {
        const rng = mulberry32(r);
        const resampled = bootstrapResample(purgedTrain, rng);
        const resampledCsv = tradesToCsv(resampled);

        for (const base of baselines) {
          const trainPath = path.join(tmpDir, `fold${testMonthIdx}_boot${r}_${base.opt.label.slice(0, 1)}.csv`);
          writeFileSync(trainPath, resampledCsv, 'utf8');
          const result = trainFold(pythonExe, scriptPath, trainPath, testPath, base.opt.featureColumns, 42, base.opt.subsampleColsample);
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

      for (const base of baselines) {
        const iters = iterationsByOption[base.opt.label];
        console.log(`  [${base.opt.label}] Overlap% trung binh=${mean(iters.map((it) => it.overlapPct)).toFixed(1)}%`);
        allResults.push({ optionLabel: base.opt.label, foldIndex, testMonth, baselineTopSize: base.top.size, iterations: iters });
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ results: allResults }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPath}`);

  // --- Report ---
  let md = '\n---\n\n## Part B — Robustness (nhieu du lieu, giong RT-063 Phan A), 4 phuong an\n\n';
  md += 'Phuong phap: 30 lan bootstrap-resample train set sau purge (co hoan lai, cung kich thuoc goc, mulberry32(iteration) iteration=0..29, dung lai moi fold) — CUNG mot bo 30 lan resample duoc dung lai cho ca 4 phuong an trong 1 fold (chi khac cot feature). So voi Top-20% baseline (khong nhieu, random_state=42) cua chinh phuong an do.\n\n';
  for (const opt of OPTIONS) {
    md += `### ${opt.label}\n\n`;
    md += '| Fold | Top size (baseline) | Overlap% (mean) | Overlap% (min-max) | Spearman (mean) | Spearman (min-max) |\n';
    md += '|---|---|---|---|---|---|\n';
    const rows = allResults.filter((r) => r.optionLabel === opt.label);
    for (const r of rows) {
      const overlaps = r.iterations.map((it) => it.overlapPct);
      const rhos = r.iterations.map((it) => it.spearman).filter((x) => Number.isFinite(x));
      md += `| ${r.foldIndex} | ${r.baselineTopSize} | ${mean(overlaps).toFixed(1)}% | ${Math.min(...overlaps).toFixed(1)}%-${Math.max(...overlaps).toFixed(1)}% | ${rhos.length > 0 ? mean(rhos).toFixed(3) : 'n/a'} | ${rhos.length > 0 ? `${Math.min(...rhos).toFixed(3)}-${Math.max(...rhos).toFixed(3)}` : 'n/a'} |\n`;
    }
    md += '\n';
  }
  md += '_(So lieu tho, khong tu ket luan phuong an nao "on dinh hon".)_\n';

  // --- Part C: final summary table ---
  let partA: { results: FoldPerOptionA[] } | null = null;
  try {
    partA = JSON.parse(await readFile(jsonPathA, 'utf8'));
  } catch (err) {
    console.error(`CANH BAO: khong doc duoc ${jsonPathA} — hay chay rt064QuintileCompare.ts (Part A) TRUOC. Bo qua Part C.`);
  }

  if (partA) {
    md += '\n---\n\n## Part C — Tong hop: 1 dong / phuong an\n\n';
    md += 'Khong tu chon "phuong an thang" — trinh bay so, de Vinh Tam/AI reviewer quyet dinh dua tren danh doi (PF cao nhat chua chac on dinh nhat).\n\n';
    md += '| Phuong an | PF Top trung binh (pooled qua 6 fold) | Overlap% trung binh | Spearman trung binh |\n';
    md += '|---|---|---|---|\n';
    for (const opt of OPTIONS) {
      const aRows = partA.results.filter((r) => r.optionLabel === opt.label);
      const pooledTopTrades = aRows.flatMap((r) => r.topTrades);
      const pooledPf = computePooledPf(pooledTopTrades);

      const bRows = allResults.filter((r) => r.optionLabel === opt.label);
      const perFoldOverlapMeans = bRows.map((r) => mean(r.iterations.map((it) => it.overlapPct)));
      const perFoldSpearmanMeans = bRows.map((r) => {
        const rhos = r.iterations.map((it) => it.spearman).filter((x) => Number.isFinite(x));
        return rhos.length > 0 ? mean(rhos) : NaN;
      }).filter((x) => Number.isFinite(x));

      md += `| ${opt.label} | ${Number.isFinite(pooledPf) ? pooledPf.toFixed(2) : 'inf'} | ${mean(perFoldOverlapMeans).toFixed(1)}% | ${perFoldSpearmanMeans.length > 0 ? mean(perFoldSpearmanMeans).toFixed(3) : 'n/a'} |\n`;
    }
    md += '\n_(PF Top pooled: gop tat ca lenh Top-20% cua phuong an do qua ca 6 fold roi tinh 1 PF tong the — khong phai trung binh cua 6 PF rieng le. Overlap%/Spearman: trung binh cua 6 gia tri trung binh-theo-fold.)_\n';
  } else {
    md += '\n_(Khong co du lieu Part A de dung Part C.)_\n';
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
