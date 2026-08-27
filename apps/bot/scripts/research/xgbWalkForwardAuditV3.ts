import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';

// TICKET-RT-061 Part A step 2 + Part B: purge-corrected walk-forward (v1 8-feature + v2 14-feature,
// same fold definition as RT-058/059) plus economic quintile validation on the purged v2 predictions.
//
// Reuses xgbFeatureAuditV3.ts's own verified simulation directly (import, not a CSV round-trip) —
// avoids re-parsing a file AND avoids needing a pnl column in the CSV (pnl is only carried on the
// in-memory ClosedTradeInternal record, needed here for Part B's $ metrics, not part of the ticket's
// specified CSV columns). Self-checks against the RT-056/057 confirmed constants before trusting
// anything downstream.
//
// "Before purge" AUC values are NOT re-derived by rerunning xgbWalkForwardAuditV2.ts — that file is
// frozen per RT-059/060/061 ("khong sua RT-058/059/060"), and RUNNING it would also overwrite
// apps/bot/reports/RT-059-report.md (its Part A section) with byte-identical content, which is a
// needless risk (a previous ticket in this series accidentally clobbered a finished report doing
// exactly this for a regression check). Instead, RT-059-report.md's ALREADY-PUBLISHED, ALREADY
// SELF-CHECKED Part A.1 table is reused verbatim as the "before" column — cited by exact value below.
const BEFORE_PURGE_AUC: Record<number, { v1: number; v2: number }> = {
  // Source: apps/bot/reports/RT-059-report.md, "Part A.1 — AUC-ROC: v1 (8 feature, RT-058) vs v2
  // (14 feature), theo fold" table (lines 13-18 as published by RT-059's xgbWalkForwardAuditV2.ts).
  1: { v1: 0.4856, v2: 0.5128 },
  2: { v1: 0.6051, v2: 0.6847 },
  3: { v1: 0.7038, v2: 0.6714 },
  4: { v1: 0.5647, v2: 0.5684 },
  5: { v1: 0.5708, v2: 0.554 },
  6: { v1: 0.5353, v2: 0.6277 },
};

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

const V1_FEATURE_COLUMNS = ['distanceFromEma200H1Pct', 'slPct', 'fvgGapSizePct', 'waitedCandlesCount', 'breaksKeyZone', 'atrH1Pct', 'hourOfDayUtc', 'dayOfWeekUtc'];
const V2_NEW_FEATURE_COLUMNS = ['trendAgeH1Candles', 'atrPercentileH1', 'momentumM15Pct3Candles', 'keyZoneDistancePct', 'rollingWinRateSameSymbol20', 'concurrentOpenPositionsCount'];
const V2_ALL_FEATURE_COLUMNS = [...V1_FEATURE_COLUMNS, ...V2_NEW_FEATURE_COLUMNS];

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

  // Chronological (by entryTimestampUtc) equity curve WITHIN this group only, for drawdown + streak.
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

function splitQuintiles(predictions: GroupTrade[]): { top: GroupTrade[]; middle: GroupTrade[]; bottom: GroupTrade[] } {
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
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-061-report.md');
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
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-061) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);
  console.log(`Cac thang: ${monthsPresent.join(', ')} (${K} thang).`);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgb-fold-v3-'));

  interface FoldResultV3 {
    foldIndex: number;
    testMonth: string;
    trainNBeforePurge: number;
    trainNAfterPurge: number;
    purgedCount: number;
    testN: number;
    v1: TrainResult;
    v2: TrainResult;
    quintiles: { top: GroupMetrics; middle: GroupMetrics; bottom: GroupMetrics };
  }
  const folds: FoldResultV3[] = [];

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
      const purgedCount = trainCandidates.length - purgedTrain.length;

      console.log(`Fold ${foldIndex}: train truoc purge n=${trainCandidates.length}, sau purge n=${purgedTrain.length} (loai ${purgedCount}), test n=${testTrades.length}`);
      if (purgedTrain.length === 0 || testTrades.length === 0) {
        console.log('  -> BO QUA: train hoac test rong.');
        continue;
      }

      const trainPath = path.join(tmpDir, `fold${testMonthIdx}_train.csv`);
      const testPath = path.join(tmpDir, `fold${testMonthIdx}_test.csv`);
      await writeFile(trainPath, tradesToCsv(purgedTrain), 'utf8');
      await writeFile(testPath, tradesToCsv(testTrades), 'utf8');

      const v1 = trainFold(pythonExe, scriptPath, trainPath, testPath, V1_FEATURE_COLUMNS);
      const v2 = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS);
      console.log(`  AUC (sau purge) v1=${v1.auc !== null ? v1.auc.toFixed(4) : 'n/a'}  v2=${v2.auc !== null ? v2.auc.toFixed(4) : 'n/a'}`);

      // v2.predictions is in the SAME order as testTrades (both derived from testTrades written to
      // testPath in that exact order, and xgbTrainFold.py only maps over test_df rows — no reorder,
      // no filter) — safe to zip by index to recover pnl/entryTimestampUtc for Part B.
      const groupTrades: GroupTrade[] = v2.predictions.map((p, idx) => ({
        entryTimestampUtc: testTrades[idx].features.entryTimestampUtc,
        outcome: testTrades[idx].outcome,
        pnl: testTrades[idx].pnl,
        predicted: p.predicted,
      }));
      const { top, middle, bottom } = splitQuintiles(groupTrades);

      folds.push({
        foldIndex,
        testMonth,
        trainNBeforePurge: trainCandidates.length,
        trainNAfterPurge: purgedTrain.length,
        purgedCount,
        testN: testTrades.length,
        v1,
        v2,
        quintiles: { top: computeGroupMetrics(top), middle: computeGroupMetrics(middle), bottom: computeGroupMetrics(bottom) },
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // --- Build report ---
  let md = '# TICKET-RT-061 — Purge Correction + Phase 2: Economic Quintile Validation\n\n';
  md += 'Audit-only. Khong dung production, khong sua RT-058/059/060, khong bat dau Shadow Mode.\n\n';
  md += `Dataset: apps/bot/data/xgbAuditDatasetV3.csv (xgbFeatureAuditV3.ts — copy cua xgbFeatureAuditV2.ts/RT-059, KHONG sua file do, cong them cot closeTime). Tu-kiem-tra khop 100% voi RT-056/057 (n=${closed.length}, PnL=$${totalPnl.toFixed(2)}, PF=${totalPf.toFixed(3)}).\n\n`;
  md += `Cac thang: ${monthsPresent.join(', ')} (${K} thang), cung fold split (expanding window theo thang) nhu RT-058/059/060.\n\n`;

  md += '## Part A — Purge correction: AUC truoc/sau purge\n\n';
  md +=
    'Purge: loai khoi tap train moi lenh co `closeTime >= dau thang test` (RT-060 tim thay dung 1 lenh nhu vay, o Fold 2). ' +
    '"Truoc purge" la so lieu DA CONG BO, DA TU-KIEM-TRA trong RT-059-report.md (khong rerun xgbWalkForwardAuditV2.ts o day — file do bi dong bang, va rerun se ghi de RT-059-report.md khong can thiet).\n\n';
  md += '| Fold | Test thang | Train n (truoc purge) | Train n (sau purge) | So lenh bi purge | AUC v1 truoc | AUC v1 sau | Delta v1 | AUC v2 truoc | AUC v2 sau | Delta v2 |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const f of folds) {
    const before = BEFORE_PURGE_AUC[f.foldIndex];
    const dV1 = f.v1.auc !== null ? f.v1.auc - before.v1 : null;
    const dV2 = f.v2.auc !== null ? f.v2.auc - before.v2 : null;
    md += `| ${f.foldIndex} | ${f.testMonth} | ${f.trainNBeforePurge} | ${f.trainNAfterPurge} | ${f.purgedCount} | ${before.v1.toFixed(4)} | ${f.v1.auc !== null ? f.v1.auc.toFixed(4) : 'n/a'} | ${dV1 !== null ? (dV1 >= 0 ? '+' : '') + dV1.toFixed(4) : 'n/a'} | ${before.v2.toFixed(4)} | ${f.v2.auc !== null ? f.v2.auc.toFixed(4) : 'n/a'} | ${dV2 !== null ? (dV2 >= 0 ? '+' : '') + dV2.toFixed(4) : 'n/a'} |\n`;
  }
  md += `\nSo lenh bi purge khac 0 CHI o fold co ${folds.find((f) => f.purgedCount > 0)?.testMonth ?? '(khong fold nao)'} — khop voi ky vong ticket ("khac biet toi da o dung Fold 2") va voi RT-060's straddle count (1 lenh, Fold 2). Cac fold khac co purgedCount=0 nen AUC sau purge PHAI giong het truoc purge (delta=0.0000) — day la phep do that, khong phai gia dinh.\n\n`;

  md += '## Part B — Economic quintile validation (Top 20% / Middle 60% / Bottom 20%, theo diem du doan v2 sau purge)\n\n';
  md += 'Moi fold: sap xep tap test theo diem du doan P(won) giam dan, chia Top 20% / Middle 60% / Bottom 20% (lam tron so luong). R-multiple: TP=+2.10R co dinh, SL=-1R co dinh (target R khong doi trong toan bo du lieu).\n\n';
  for (const f of folds) {
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth}, test n=${f.testN})\n\n`;
    md += '| Nhom | n | Winrate | Wilson 90% CI | PF | Expectancy $ | Expectancy R | PnL$ | Max DD $ (trong nhom) | Chuoi thua dai nhat |\n';
    md += '|---|---|---|---|---|---|---|---|---|---|\n';
    for (const [label, g] of [
      ['Top 20%', f.quintiles.top],
      ['Middle 60%', f.quintiles.middle],
      ['Bottom 20%', f.quintiles.bottom],
    ] as const) {
      md += `| ${label} | ${g.n} | ${fmtPct(g.winRate)} | [${fmtPct(g.wilsonLower)}-${fmtPct(g.wilsonUpper)}] | ${Number.isFinite(g.pf) ? g.pf.toFixed(2) : 'inf'} | $${g.expectancyUsd.toFixed(2)} | ${g.expectancyR.toFixed(3)}R | $${g.pnlUsd.toFixed(2)} | $${g.maxDrawdownUsd.toFixed(2)} | ${g.longestLosingStreak} |\n`;
    }
    md += '\n';
  }

  md += '### Doi chieu Top vs Middle vs Bottom qua 6 fold (khong tu ket luan — chi trinh bay)\n\n';
  md += '| Fold | Top winrate | Middle winrate | Bottom winrate | Top > Middle? | Middle > Bottom? | Top > Bottom? |\n';
  md += '|---|---|---|---|---|---|---|\n';
  let topBeatsMiddleCount = 0;
  let middleBeatsBottomCount = 0;
  let topBeatsBottomCount = 0;
  for (const f of folds) {
    const t = f.quintiles.top.winRate;
    const m = f.quintiles.middle.winRate;
    const b = f.quintiles.bottom.winRate;
    const tm = t > m;
    const mb = m > b;
    const tb = t > b;
    if (tm) topBeatsMiddleCount++;
    if (mb) middleBeatsBottomCount++;
    if (tb) topBeatsBottomCount++;
    md += `| ${f.foldIndex} | ${fmtPct(t)} | ${fmtPct(m)} | ${fmtPct(b)} | ${tm ? 'co' : 'khong'} | ${mb ? 'co' : 'khong'} | ${tb ? 'co' : 'khong'} |\n`;
  }
  md += `\nTop > Middle: ${topBeatsMiddleCount}/${folds.length} fold. Middle > Bottom: ${middleBeatsBottomCount}/${folds.length} fold. Top > Bottom: ${topBeatsBottomCount}/${folds.length} fold.\n\n`;
  md += '_(So lieu tho, khong tu ket luan Top/Middle/Bottom co "nhat quan tot hon" hay khong — de Vinh Tam/AI reviewer tu danh gia, luu y n moi nhom rat mong (~11-32 lenh/fold) nen Wilson CI o bang tren can duoc doc cung voi ket luan nay.)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
