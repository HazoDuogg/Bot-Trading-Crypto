import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-064 Part A: quintile PF/expectancy quality, 4 options side by side.
// Audit-only. Does not touch production. Does not modify RT-058..063 (imports xgbFeatureAuditV3.ts,
// frozen, read-only; xgbTrainFold.py gets a new OPTIONAL 6th CLI arg, backward compatible — every
// RT-058..063 call site is unaffected).
//
// Same purge logic as RT-061 (exclude from train any trade with closeTime >= start of test month),
// same 6 folds, same Top 20%/Middle 60%/Bottom 20% split as RT-061 (Math.round on cumulative
// boundaries). computeGroupMetrics below is a verbatim copy of xgbWalkForwardAuditV3.ts's function
// (RT-061, frozen), same as RT-062's copy.

interface OptionConfig {
  label: string;
  featureColumns: string[];
  subsampleColsample?: string; // "0.8,0.8" or undefined -> xgbTrainFold.py defaults to "1.0,1.0"
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

// Verbatim copy of xgbWalkForwardAuditV3.ts's computeGroupMetrics (RT-061, frozen).
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

// Top 20%/Middle 60%/Bottom 20%, same rounding style as RT-061.
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

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-064-report.md');
  const jsonPath = path.resolve(process.cwd(), 'apps/bot/data/rt064PartA.json');
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
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-064) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'rt064-quintile-'));

  interface FoldPerOption {
    optionLabel: string;
    foldIndex: number;
    testMonth: string;
    top: GroupMetrics;
    middle: GroupMetrics;
    bottom: GroupMetrics;
    topTrades: GroupTrade[];
  }
  const results: FoldPerOption[] = [];

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

      for (const opt of OPTIONS) {
        const result = trainFold(pythonExe, scriptPath, trainPath, testPath, opt.featureColumns, 42, opt.subsampleColsample);
        const groupTradesAll: GroupTrade[] = result.predictions.map((p, idx) => ({
          entryTimestampUtc: testTrades[idx].features.entryTimestampUtc,
          outcome: testTrades[idx].outcome,
          pnl: testTrades[idx].pnl,
          predicted: p.predicted,
        }));
        const { top, middle, bottom } = splitTopMiddleBottom(groupTradesAll);
        console.log(`  [${opt.label}] AUC=${result.auc !== null ? result.auc.toFixed(4) : 'n/a'}  Top PF=${Number.isFinite(computeGroupMetrics(top).pf) ? computeGroupMetrics(top).pf.toFixed(2) : 'inf'}`);
        results.push({
          optionLabel: opt.label,
          foldIndex,
          testMonth,
          top: computeGroupMetrics(top),
          middle: computeGroupMetrics(middle),
          bottom: computeGroupMetrics(bottom),
          topTrades: top,
        });
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ results }, null, 2), 'utf8');
  console.log(`\nDa ghi ket qua tho vao ${jsonPath}`);

  // --- Report ---
  function mean(a: number[]): number {
    return a.reduce((x, y) => x + y, 0) / a.length;
  }

  let md = '# TICKET-RT-064 — So sanh 4 phuong an Feature/Hyperparameter: Quintile Quality + Robustness\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058..063.\n\n';
  md += `Pipeline: import truc tiep xgbFeatureAuditV3.ts (frozen) — cung purge logic RT-061, cung 6 fold. Tu-kiem-tra khop 100% RT-056/057 (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;
  md += '## 4 phuong an\n\n';
  md += '| Ky hieu | Mo ta |\n|---|---|\n';
  md += '| A (v1) | 8 feature goc RT-058 |\n';
  md += '| B (v2) | 14 feature RT-059 (baseline hien tai) |\n';
  md += '| C (toi gian) | 4 feature: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct |\n';
  md += '| D (v2 + reg) | 14 feature, subsample=0.8, colsample_bytree=0.8 |\n\n';

  md += '## Part A — PF theo Top/Middle/Bottom, 4 phuong an x 6 fold\n\n';
  for (const opt of OPTIONS) {
    md += `### ${opt.label}\n\n`;
    md += '| Fold | Top n | Top PF | Top Winrate | Middle n | Middle PF | Middle Winrate | Bottom n | Bottom PF | Bottom Winrate |\n';
    md += '|---|---|---|---|---|---|---|---|---|---|\n';
    const rowsForOpt = results.filter((r) => r.optionLabel === opt.label);
    for (const r of rowsForOpt) {
      md += `| ${r.foldIndex} | ${r.top.n} | ${Number.isFinite(r.top.pf) ? r.top.pf.toFixed(2) : 'inf'} | ${fmtPct(r.top.winRate)} | ${r.middle.n} | ${Number.isFinite(r.middle.pf) ? r.middle.pf.toFixed(2) : 'inf'} | ${fmtPct(r.middle.winRate)} | ${r.bottom.n} | ${Number.isFinite(r.bottom.pf) ? r.bottom.pf.toFixed(2) : 'inf'} | ${fmtPct(r.bottom.winRate)} |\n`;
    }
    md += '\n';
  }

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao (Part A) vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
