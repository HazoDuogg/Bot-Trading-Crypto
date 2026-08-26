import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, checkGridsAlignExactly, runInstrumentedSimulation, type ClosedTradeInternal } from './rt065FeatureAuditThreeYear.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';

// TICKET-RT-065 Part D step 2 (quintile): repeats RT-064's methodology (purge, expanding
// monthly-window walk-forward, Top 20%/Middle 60%/Bottom 20% PF/Expectancy) on the 3-year dataset,
// for options A (v1/8-feature), B (v2/14-feature), C (minimal/4-feature) only — D (regularization)
// is dropped per this ticket ("da gac lai vi van de version"). Audit-only, no production file
// touched, no RT-058..064 file modified.
//
// Unlike RT-064's fixed 6 folds (12-month data), 3-year data has ~36 months -> ~30 folds (test
// month 7 through the last month present) — measured from the data, not hardcoded.

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

const Z_90 = 1.6448536269514722;
function wilsonInterval(successes: number, n: number): { p: number; lower: number; upper: number } {
  if (n === 0) return { p: NaN, lower: NaN, upper: NaN };
  const p = successes / n;
  const z2 = Z_90 * Z_90;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z_90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

interface GroupTrade {
  entryTimestampUtc: number;
  outcome: 'TP' | 'SL';
  pnl: number;
  predicted: number;
}
interface GroupMetrics {
  n: number;
  winRate: number;
  wilsonLower: number;
  wilsonUpper: number;
  pf: number;
  expectancyUsd: number;
  expectancyR: number;
  pnlUsd: number;
  maxDrawdownUsd: number;
  longestLosingStreak: number;
}
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

// Verbatim copy of xgbWalkForwardAuditV3.ts's computeGroupMetrics (RT-061, frozen), same copy used
// by RT-062/RT-064.
function computeGroupMetrics(trades: GroupTrade[]): GroupMetrics {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === 'TP').length;
  const ci = wilsonInterval(wins, n);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const pnlUsd = trades.reduce((s, t) => s + t.pnl, 0);
  const expectancyUsd = n > 0 ? pnlUsd / n : NaN;
  const rSum = trades.reduce((s, t) => s + (t.outcome === 'TP' ? TARGET_R : -1), 0);
  const expectancyR = n > 0 ? rSum / n : NaN;

  const chrono = [...trades].sort((a, b) => a.entryTimestampUtc - b.entryTimestampUtc);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  let currentLosingStreak = 0;
  let longestLosingStreak = 0;
  for (const t of chrono) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
    if (t.outcome === 'SL') {
      currentLosingStreak++;
      if (currentLosingStreak > longestLosingStreak) longestLosingStreak = currentLosingStreak;
    } else {
      currentLosingStreak = 0;
    }
  }
  return { n, winRate: ci.p, wilsonLower: ci.lower, wilsonUpper: ci.upper, pf, expectancyUsd, expectancyR, pnlUsd, maxDrawdownUsd, longestLosingStreak };
}

function splitTopMiddleBottom(predictions: GroupTrade[]): { top: GroupTrade[]; middle: GroupTrade[]; bottom: GroupTrade[] } {
  const sorted = [...predictions].sort((a, b) => b.predicted - a.predicted);
  const n = sorted.length;
  const nTop = Math.round(n * 0.2);
  const nBottom = Math.round(n * 0.2);
  const top = sorted.slice(0, nTop);
  const bottom = sorted.slice(n - nBottom);
  const middle = sorted.slice(nTop, n - nBottom);
  return { top, middle, bottom };
}

export interface FoldPerOptionA {
  optionLabel: string;
  foldIndex: number;
  testMonth: string;
  top: { n: number; pf: number; winRate: number };
  middle: { n: number; pf: number; winRate: number };
  bottom: { n: number; pf: number; winRate: number };
  topTrades: GroupTrade[];
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-065-report.md');
  const jsonPath = path.resolve(process.cwd(), 'apps/bot/data/rt065PartDQuintile.json');
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
  console.log(`Cac thang: ${monthsPresent.length} thang (${monthsPresent[0]} .. ${monthsPresent[K - 1]}). Fold: test thang 7..${K} -> ${K - 6} fold.`);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt065-quintile-'));
  const results: FoldPerOptionA[] = [];

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
        console.log(`Fold ${foldIndex} (${testMonth}): BO QUA (train/test rong).`);
        continue;
      }

      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');
      const trainPath = path.join(tmpDir, `fold${testMonthIdx}_train.csv`);
      await writeFile(trainPath, tradesToCsv(purgedTrain), 'utf8');

      const logParts: string[] = [];
      for (const opt of OPTIONS) {
        const result = trainFold(pythonExe, scriptPath, trainPath, testPath, opt.featureColumns);
        const groupTradesAll: GroupTrade[] = result.predictions.map((p, idx) => ({
          entryTimestampUtc: testTrades[idx].features.entryTimestampUtc,
          outcome: testTrades[idx].outcome,
          pnl: testTrades[idx].pnl,
          predicted: p.predicted,
        }));
        const { top, middle, bottom } = splitTopMiddleBottom(groupTradesAll);
        const topM = computeGroupMetrics(top);
        logParts.push(`[${opt.label}] AUC=${result.auc !== null ? result.auc.toFixed(4) : 'n/a'} TopPF=${Number.isFinite(topM.pf) ? topM.pf.toFixed(2) : 'inf'}`);
        results.push({
          optionLabel: opt.label,
          foldIndex,
          testMonth,
          top: { n: topM.n, pf: topM.pf, winRate: topM.winRate },
          middle: (() => {
            const m = computeGroupMetrics(middle);
            return { n: m.n, pf: m.pf, winRate: m.winRate };
          })(),
          bottom: (() => {
            const b = computeGroupMetrics(bottom);
            return { n: b.n, pf: b.pf, winRate: b.winRate };
          })(),
          topTrades: top,
        });
      }
      console.log(`Fold ${foldIndex} (train n=${purgedTrain.length}, test n=${testTrades.length}, ${testMonth}): ${logParts.join('  ')}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ results }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPath}`);

  // --- Report ---
  let md = '\n---\n\n# TICKET-RT-065 Part D — So sanh A/B/C tren du lieu 3 nam\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058..064.\n\n';
  md += `Pipeline: apps/bot/data/xgbAuditDatasetThreeYear.csv, cung purge logic RT-061, mo rong theo thang tren 3 nam. Tu-kiem-tra khop 100% RT-065 Part C (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;
  md += `Cac thang: ${K} thang (${monthsPresent[0]} .. ${monthsPresent[K - 1]}) -> ${K - 6} fold (test thang 7..${K}), so voi 6 fold cua RT-064 tren du lieu 1 nam.\n\n`;
  md += '## 3 phuong an (D bo qua theo yeu cau ticket)\n\n| Ky hieu | Mo ta |\n|---|---|\n';
  md += '| A (v1) | 8 feature goc RT-058 |\n| B (v2) | 14 feature RT-059 |\n| C (toi gian) | 4 feature: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct |\n\n';

  md += '## Part A — PF theo Top/Middle/Bottom, 3 phuong an, tat ca fold\n\n';
  for (const opt of OPTIONS) {
    md += `### ${opt.label}\n\n`;
    md += '| Fold | Thang test | Top n | Top PF | Top Winrate | Middle n | Middle PF | Bottom n | Bottom PF |\n';
    md += '|---|---|---|---|---|---|---|---|---|\n';
    const rows = results.filter((r) => r.optionLabel === opt.label);
    for (const r of rows) {
      md += `| ${r.foldIndex} | ${r.testMonth} | ${r.top.n} | ${Number.isFinite(r.top.pf) ? r.top.pf.toFixed(2) : 'inf'} | ${fmtPct(r.top.winRate)} | ${r.middle.n} | ${Number.isFinite(r.middle.pf) ? r.middle.pf.toFixed(2) : 'inf'} | ${r.bottom.n} | ${Number.isFinite(r.bottom.pf) ? r.bottom.pf.toFixed(2) : 'inf'} |\n`;
    }
    md += '\n';
  }

  function computePooledPf(trades: GroupTrade[]): number {
    const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
    return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  }
  function mean(a: number[]): number {
    return a.reduce((x, y) => x + y, 0) / a.length;
  }
  md += '## Pooled Top-20% PF va winrate qua toan bo fold, 3 phuong an\n\n';
  md += '| Phuong an | n (pooled Top) | Pooled Top PF | Trung binh Top winrate/fold |\n|---|---|---|---|\n';
  for (const opt of OPTIONS) {
    const rows = results.filter((r) => r.optionLabel === opt.label);
    const pooledTop = rows.flatMap((r) => r.topTrades);
    const pooledPf = computePooledPf(pooledTop);
    const meanWr = mean(rows.map((r) => r.top.winRate));
    md += `| ${opt.label} | ${pooledTop.length} | ${Number.isFinite(pooledPf) ? pooledPf.toFixed(2) : 'inf'} | ${fmtPct(meanWr)} |\n`;
  }
  md += '\n_(So lieu tho — khong tu chon phuong an "thang".)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao (Part D quintile) vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
