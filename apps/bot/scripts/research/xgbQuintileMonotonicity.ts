import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-062 Part A: 5-quintile ranking-resolution audit on the SAME purged walk-forward setup as
// RT-061 (import xgbFeatureAuditV3.ts's simulation — frozen, RT-059/061 — not modified; same purge
// rule: exclude from train any trade with closeTime >= start of test month; same 6 folds; feature set
// v2/14 features only, no v1 comparison this time). computeGroupMetrics below is a verbatim COPY of
// xgbWalkForwardAuditV3.ts's function (RT-061, frozen — not imported, not modified), per the ticket's
// explicit "copy, khong sua file goc" instruction.

const V1_FEATURE_COLUMNS = ['distanceFromEma200H1Pct', 'slPct', 'fvgGapSizePct', 'waitedCandlesCount', 'breaksKeyZone', 'atrH1Pct', 'hourOfDayUtc', 'dayOfWeekUtc'];
const V2_NEW_FEATURE_COLUMNS = ['trendAgeH1Candles', 'atrPercentileH1', 'momentumM15Pct3Candles', 'keyZoneDistancePct', 'rollingWinRateSameSymbol20', 'concurrentOpenPositionsCount'];
const V2_ALL_FEATURE_COLUMNS = [...V1_FEATURE_COLUMNS, ...V2_NEW_FEATURE_COLUMNS];

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

// Verbatim copy of xgbWalkForwardAuditV3.ts's computeGroupMetrics (RT-061, frozen) — per ticket
// instruction "tai dung dung computeGroupMetrics logic cua RT-061 — copy, khong sua file goc".
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

// 5-way split, ~20% each, same rounding style as RT-061's top/bottom-20% split (Math.round on
// cumulative boundaries so all 5 groups sum exactly to n).
function splitQuintiles5(predictions: GroupTrade[]): GroupTrade[][] {
  const sorted = [...predictions].sort((a, b) => b.predicted - a.predicted);
  const n = sorted.length;
  const bounds = [0, 1, 2, 3, 4, 5].map((k) => Math.round((k * n) / 5));
  const groups: GroupTrade[][] = [];
  for (let g = 0; g < 5; g++) groups.push(sorted.slice(bounds[g], bounds[g + 1]));
  return groups;
}

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-062-report.md');
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
  console.log(`n=${closed.length}  PnL=$${totalPnl.toFixed(2)}  PF=${totalPf.toFixed(3)}`);
  console.log('Doi chieu RT-056/057 Config B (chot): n=1217, PnL=$2628.76, PF=1.551');
  const matches = closed.length === 1217 && Math.abs(totalPnl - 2628.76) < 0.01 && Math.abs(totalPf - 1.551) < 0.001;
  if (!matches) {
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-062) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgb-quintile-'));

  interface FoldQuintiles {
    foldIndex: number;
    testMonth: string;
    groups: GroupMetrics[]; // Q1..Q5
    groupTrades: GroupTrade[][]; // Q1..Q5, for pooling
  }
  const folds: FoldQuintiles[] = [];

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

      console.log(`Fold ${foldIndex}: train sau purge n=${purgedTrain.length}, test n=${testTrades.length}`);
      if (purgedTrain.length === 0 || testTrades.length === 0) {
        console.log('  -> BO QUA.');
        continue;
      }

      const trainPath = path.join(tmpDir, `fold${testMonthIdx}_train.csv`);
      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(trainPath, tradesToCsv(purgedTrain), 'utf8');
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');

      const v2 = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS);
      console.log(`  AUC v2 (sau purge) = ${v2.auc !== null ? v2.auc.toFixed(4) : 'n/a'}`);

      const groupTradesAll: GroupTrade[] = v2.predictions.map((p, idx) => ({
        entryTimestampUtc: testTrades[idx].features.entryTimestampUtc,
        outcome: testTrades[idx].outcome,
        pnl: testTrades[idx].pnl,
        predicted: p.predicted,
      }));
      const groupTrades = splitQuintiles5(groupTradesAll);
      const groups = groupTrades.map((g) => computeGroupMetrics(g));

      folds.push({ foldIndex, testMonth, groups, groupTrades });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // --- Monotonicity counts (Q1>=Q2>=Q3>=Q4>=Q5, ties allowed), PF and winrate separately ---
  function isMonotonicNonIncreasing(values: number[]): boolean {
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[i - 1]) return false;
    }
    return true;
  }
  const pfMonotonicFolds = folds.filter((f) => isMonotonicNonIncreasing(f.groups.map((g) => g.pf)));
  const winRateMonotonicFolds = folds.filter((f) => isMonotonicNonIncreasing(f.groups.map((g) => g.winRate)));

  // --- Pooled metrics per quintile position, across all 6 folds' trades (not average-of-averages) ---
  const pooled: GroupTrade[][] = [[], [], [], [], []];
  for (const f of folds) {
    for (let g = 0; g < 5; g++) pooled[g].push(...f.groupTrades[g]);
  }
  const pooledMetrics = pooled.map((g) => computeGroupMetrics(g));

  // --- Report ---
  let md = '# TICKET-RT-062 Part A — 5-Quintile Ranking Monotonicity\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058/059/060/061.\n\n';
  md += `Dataset/pipeline: import truc tiep tu xgbFeatureAuditV3.ts (RT-059/061, dong bang, KHONG sua) — cung purge logic RT-061 (loai lenh co closeTime >= dau thang test), cung 6 fold, feature set v2 (14 feature). Tu-kiem-tra khop 100% RT-056/057 (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;

  md += '## Bang PF theo quintile (Q1=diem du doan cao nhat, Q5=thap nhat)\n\n';
  md += '| Fold | Q1 (n) | Q2 (n) | Q3 (n) | Q4 (n) | Q5 (n) | Monotonic (Q1>=..>=Q5)? |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const f of folds) {
    const pfStr = f.groups.map((g) => `${Number.isFinite(g.pf) ? g.pf.toFixed(2) : 'inf'} (${g.n})`).join(' | ');
    md += `| ${f.foldIndex} | ${pfStr} | ${isMonotonicNonIncreasing(f.groups.map((g) => g.pf)) ? 'co' : 'khong'} |\n`;
  }
  md += `\nSo fold co gradient PF dung huong hoan toan (Q1>=Q2>=Q3>=Q4>=Q5, cho phep bang): **${pfMonotonicFolds.length}/${folds.length}**.\n\n`;

  md += '## Bang winrate theo quintile\n\n';
  md += '| Fold | Q1 | Q2 | Q3 | Q4 | Q5 | Monotonic (Q1>=..>=Q5)? |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const f of folds) {
    const wrStr = f.groups.map((g) => fmtPct(g.winRate)).join(' | ');
    md += `| ${f.foldIndex} | ${wrStr} | ${isMonotonicNonIncreasing(f.groups.map((g) => g.winRate)) ? 'co' : 'khong'} |\n`;
  }
  md += `\nSo fold co gradient winrate dung huong hoan toan: **${winRateMonotonicFolds.length}/${folds.length}**.\n\n`;

  md += '## Bang Expectancy R theo quintile\n\n';
  md += '| Fold | Q1 | Q2 | Q3 | Q4 | Q5 |\n';
  md += '|---|---|---|---|---|---|\n';
  for (const f of folds) {
    md += `| ${f.foldIndex} | ${f.groups.map((g) => `${g.expectancyR.toFixed(3)}R`).join(' | ')} |\n`;
  }
  md += '\n';

  md += '## Chi tiet day du moi fold (n, winrate, Wilson 90% CI, PF, Expectancy $/R, PnL$, maxDD, chuoi thua)\n\n';
  for (const f of folds) {
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth})\n\n`;
    md += '| Quintile | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ | Chuoi thua dai nhat |\n';
    md += '|---|---|---|---|---|---|---|---|---|---|\n';
    f.groups.forEach((g, idx) => {
      md += `| Q${idx + 1} | ${g.n} | ${fmtPct(g.winRate)} | [${fmtPct(g.wilsonLower)}-${fmtPct(g.wilsonUpper)}] | ${Number.isFinite(g.pf) ? g.pf.toFixed(2) : 'inf'} | $${g.expectancyUsd.toFixed(2)} | ${g.expectancyR.toFixed(3)}R | $${g.pnlUsd.toFixed(2)} | $${g.maxDrawdownUsd.toFixed(2)} | ${g.longestLosingStreak} |\n`;
    });
    md += '\n';
  }

  md += '## Pooled (gop tat ca lenh cung vi tri quintile qua ca 6 fold — khong phai trung binh cua trung binh)\n\n';
  md += '| Quintile | n (pooled) | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  pooledMetrics.forEach((g, idx) => {
    md += `| Q${idx + 1} | ${g.n} | ${fmtPct(g.winRate)} | [${fmtPct(g.wilsonLower)}-${fmtPct(g.wilsonUpper)}] | ${Number.isFinite(g.pf) ? g.pf.toFixed(2) : 'inf'} | $${g.expectancyUsd.toFixed(2)} | ${g.expectancyR.toFixed(3)}R | $${g.pnlUsd.toFixed(2)} |\n`;
  });
  md += `\nPooled monotonic PF (Q1>=..>=Q5)? ${isMonotonicNonIncreasing(pooledMetrics.map((g) => g.pf)) ? 'co' : 'khong'}. Pooled monotonic winrate? ${isMonotonicNonIncreasing(pooledMetrics.map((g) => g.winRate)) ? 'co' : 'khong'}.\n\n`;
  md += '_(So lieu tho — khong tu ket luan "5-quintile co du phan giai" hay khong, de Vinh Tam/AI reviewer tu danh gia dua tren n moi Q (~11-32/fold rieng le, lon hon nhieu khi pooled).)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
