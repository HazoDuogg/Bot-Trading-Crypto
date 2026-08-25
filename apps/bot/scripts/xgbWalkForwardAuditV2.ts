import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// TICKET-RT-059 Part A step 2: walk-forward audit on feature set v2, using the SAME expanding-window
// fold definition as RT-058's xgbWalkForwardAudit.ts (which is left completely untouched — this is a
// new, separate script). Reads apps/bot/data/xgbAuditDatasetV2.csv (produced by
// xgbFeatureAuditV2.ts, self-checked there against the RT-056/057 confirmed constants).
//
// For an apples-to-apples v1-vs-v2 comparison, each fold is trained TWICE against xgbTrainFold.py:
// once restricted to the original 8 RT-058 feature columns (V1_FEATURE_COLUMNS below), once with all
// 14 v2 columns. Both runs use the EXACT SAME 1217-row trade set and the EXACT SAME fold train/test
// split (this script's own dataset, which RT-058 and RT-059's self-checks both proved reproduces the
// confirmed baseline) — so any AUC difference reflects only the extra 6 features, not a different
// trade sample or a different month-boundary split from RT-058's own run.

interface Row {
  symbol: string;
  entryTimestampUtc: number;
  distanceFromEma200H1Pct: number;
  slPct: number;
  fvgGapSizePct: number;
  waitedCandlesCount: number;
  breaksKeyZone: boolean;
  atrH1Pct: number;
  hourOfDayUtc: number;
  dayOfWeekUtc: number;
  trendAgeH1Candles: number;
  atrPercentileH1: number;
  momentumM15Pct3Candles: number;
  keyZoneDistancePct: number | null;
  rollingWinRateSameSymbol20: number | null;
  concurrentOpenPositionsCount: number;
  won: boolean;
}

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

function parseNum(s: string): number {
  return s === '' ? NaN : Number(s);
}
function parseNullableNum(s: string): number | null {
  return s === '' ? null : Number(s);
}

function parseCsv(text: string): Row[] {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  if (header.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`Unexpected CSV header: ${header.join(',')}`);
  }
  return lines.slice(1).map((line) => {
    const c = line.split(',');
    return {
      symbol: c[0],
      entryTimestampUtc: Number(c[1]),
      distanceFromEma200H1Pct: parseNum(c[2]),
      slPct: parseNum(c[3]),
      fvgGapSizePct: parseNum(c[4]),
      waitedCandlesCount: parseNum(c[5]),
      breaksKeyZone: c[6] === 'true',
      atrH1Pct: parseNum(c[7]),
      hourOfDayUtc: parseNum(c[8]),
      dayOfWeekUtc: parseNum(c[9]),
      trendAgeH1Candles: parseNum(c[10]),
      atrPercentileH1: parseNum(c[11]),
      momentumM15Pct3Candles: parseNum(c[12]),
      keyZoneDistancePct: parseNullableNum(c[13]),
      rollingWinRateSameSymbol20: parseNullableNum(c[14]),
      concurrentOpenPositionsCount: parseNum(c[15]),
      won: c[16] === 'true',
    };
  });
}

function cell(v: unknown): string {
  if (v === null || (typeof v === 'number' && Number.isNaN(v))) return '';
  return String(v);
}

function rowsToCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => cell((r as any)[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface TrainResult {
  auc: number | null;
  featureImportance: Record<string, number>;
  predictions: { symbol: string; predicted: number; won: boolean }[];
}

interface FoldResult {
  foldIndex: number;
  trainMonths: string[];
  testMonth: string;
  trainN: number;
  testN: number;
  v1: TrainResult;
  v2: TrainResult;
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

function decileBreakdown(predictions: { predicted: number; won: boolean }[]): { decile: number; n: number; avgPredicted: number; actualWinRate: number }[] {
  const sorted = [...predictions].sort((a, b) => b.predicted - a.predicted);
  const n = sorted.length;
  const buckets: { decile: number; n: number; avgPredicted: number; actualWinRate: number }[] = [];
  for (let d = 0; d < 10; d++) {
    const start = Math.floor((d * n) / 10);
    const end = Math.floor(((d + 1) * n) / 10);
    const slice = sorted.slice(start, end);
    if (slice.length === 0) {
      buckets.push({ decile: d + 1, n: 0, avgPredicted: NaN, actualWinRate: NaN });
      continue;
    }
    const avgPredicted = slice.reduce((s, r) => s + r.predicted, 0) / slice.length;
    const wins = slice.filter((r) => r.won).length;
    buckets.push({ decile: d + 1, n: slice.length, avgPredicted, actualWinRate: wins / slice.length });
  }
  return buckets;
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

async function main() {
  const csvPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDatasetV2.csv');
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-059-report.md');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/xgbTrainFold.py');

  console.log(`Dang doc ${csvPath}...`);
  const rows = parseCsv(await readFile(csvPath, 'utf8'));
  console.log(`Da doc ${rows.length} dong.`);
  if (rows.length !== 1217) {
    console.error(`CORRECTION_REQUIRED: dataset co ${rows.length} dong, khong phai 1217 nhu RT-056/057 da chot — DUNG lai.`);
    process.exitCode = 1;
    return;
  }

  const monthsPresent = Array.from(new Set(rows.map((r) => monthKey(r.entryTimestampUtc)))).sort();
  const monthIndex = new Map<string, number>();
  monthsPresent.forEach((m, idx) => monthIndex.set(m, idx + 1));
  const K = monthsPresent.length;
  const lastTestMonth = Math.min(K, 12);
  console.log(`Cac thang co trong du lieu: ${monthsPresent.join(', ')} (${K} thang). Chay fold toi thang tuong doi ${lastTestMonth}.`);

  const rowsByMonthIdx = new Map<number, Row[]>();
  for (const r of rows) {
    const idx = monthIndex.get(monthKey(r.entryTimestampUtc))!;
    if (!rowsByMonthIdx.has(idx)) rowsByMonthIdx.set(idx, []);
    rowsByMonthIdx.get(idx)!.push(r);
  }

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgb-fold-v2-'));
  const folds: FoldResult[] = [];

  try {
    for (let testMonth = 7; testMonth <= lastTestMonth; testMonth++) {
      const trainMonthIndices = Array.from({ length: testMonth - 1 }, (_, i) => i + 1);
      const trainRows = trainMonthIndices.flatMap((m) => rowsByMonthIdx.get(m) ?? []);
      const testRows = rowsByMonthIdx.get(testMonth) ?? [];
      const trainMonthLabels = trainMonthIndices.map((idx) => monthsPresent[idx - 1]);
      const testMonthLabel = monthsPresent[testMonth - 1];

      console.log(`\nFold ${testMonth - 6}: train (n=${trainRows.length}) -> test thang ${testMonthLabel} (n=${testRows.length})`);
      if (trainRows.length === 0 || testRows.length === 0) {
        console.log('  -> BO QUA fold nay: train hoac test rong.');
        continue;
      }

      const trainPath = path.join(tmpDir, `fold${testMonth}_train.csv`);
      const testPath = path.join(tmpDir, `fold${testMonth}_test.csv`);
      await writeFile(trainPath, rowsToCsv(trainRows), 'utf8');
      await writeFile(testPath, rowsToCsv(testRows), 'utf8');

      const v1 = trainFold(pythonExe, scriptPath, trainPath, testPath, V1_FEATURE_COLUMNS);
      const v2 = trainFold(pythonExe, scriptPath, trainPath, testPath, V2_ALL_FEATURE_COLUMNS);
      console.log(`  AUC v1(8 feature)=${v1.auc !== null ? v1.auc.toFixed(4) : 'n/a'}  AUC v2(14 feature)=${v2.auc !== null ? v2.auc.toFixed(4) : 'n/a'}`);

      folds.push({
        foldIndex: testMonth - 6,
        trainMonths: trainMonthLabels,
        testMonth: testMonthLabel,
        trainN: trainRows.length,
        testN: testRows.length,
        v1,
        v2,
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // --- Build report (RT-059-report.md — monthlyRegimeAudit.ts appends Part B to this same file) ---
  let md = '# TICKET-RT-059 — XGBoost Feature Set v2 + Month-by-Month PF Regime Audit\n\n';
  md += 'Audit/proof-of-concept only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao. ';
  md += 'Khong sua/xoa xgbFeatureAudit.ts, xgbWalkForwardAudit.ts, hay xgbAuditDataset.csv cua RT-058 — giu nguyen lam baseline.\n\n';
  md += 'Dataset: apps/bot/data/xgbAuditDatasetV2.csv, tao boi xgbFeatureAuditV2.ts (khong import simulateOneYearNearLive.ts — tranh side-effect da phat hien o RT-058). ';
  md += 'Tu-kiem-tra khop 100% voi RT-056/057 Config B (n=1217, PnL=$2628.76, PF=1.551, maxDD=1.24%) da xac nhan trong log chay xgbFeatureAuditV2.ts.\n\n';
  md += `Cac thang co trong du lieu: ${monthsPresent.join(', ')} (${K} thang).\n\n`;

  md += '## Part A.1 — AUC-ROC: v1 (8 feature, RT-058) vs v2 (14 feature), theo fold\n\n';
  md += '| Fold | Test thang | Train n | Test n | AUC v1 (8 feature) | AUC v2 (14 feature) | Delta (v2-v1) |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const f of folds) {
    const delta = f.v1.auc !== null && f.v2.auc !== null ? f.v2.auc - f.v1.auc : null;
    md += `| ${f.foldIndex} | ${f.testMonth} | ${f.trainN} | ${f.testN} | ${f.v1.auc !== null ? f.v1.auc.toFixed(4) : 'n/a'} | ${f.v2.auc !== null ? f.v2.auc.toFixed(4) : 'n/a'} | ${delta !== null ? (delta >= 0 ? '+' : '') + delta.toFixed(4) : 'n/a'} |\n`;
  }
  const v1Aucs = folds.map((f) => f.v1.auc).filter((a): a is number => a !== null);
  const v2Aucs = folds.map((f) => f.v2.auc).filter((a): a is number => a !== null);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const std = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  };
  if (v1Aucs.length > 0 && v2Aucs.length > 0) {
    md += `\nv1: trung binh=${mean(v1Aucs).toFixed(4)}, std=${std(v1Aucs).toFixed(4)}, min=${Math.min(...v1Aucs).toFixed(4)}, max=${Math.max(...v1Aucs).toFixed(4)}.\n`;
    md += `v2: trung binh=${mean(v2Aucs).toFixed(4)}, std=${std(v2Aucs).toFixed(4)}, min=${Math.min(...v2Aucs).toFixed(4)}, max=${Math.max(...v2Aucs).toFixed(4)}.\n\n`;
  }
  md += '_(v1 o day duoc huan luyen lai tren CHINH xgbAuditDatasetV2.csv, chi subset 8 cot feature goc — cung 1217 dong, cung fold split voi RT-058 — nen la doi chieu tao-doi-tao voi bao cao RT-058 goc; so nho lech (neu co) chi phan anh sai so lam tron/thu tu tinh toan floating-point, khong phai du lieu khac nhau.)_\n\n';

  md += '## Part A.2 — Decile breakdown (feature set v2), theo fold\n\n';
  for (const f of folds) {
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth}, n=${f.testN})\n\n`;
    md += '| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |\n';
    md += '|---|---|---|---|\n';
    for (const d of decileBreakdown(f.v2.predictions)) {
      md += `| ${d.decile} | ${d.n} | ${Number.isFinite(d.avgPredicted) ? d.avgPredicted.toFixed(3) : 'n/a'} | ${Number.isFinite(d.actualWinRate) ? fmtPct(d.actualWinRate) : 'n/a'} |\n`;
    }
    md += '\n';
  }

  md += '## Part A.3 — Feature importance (gain), feature set v2, theo fold\n\n';
  md += `| Feature | ${folds.map((f) => `Fold ${f.foldIndex}`).join(' | ')} |\n`;
  md += `|---|${folds.map(() => '---').join('|')}|\n`;
  for (const name of V1_FEATURE_COLUMNS) {
    md += `| ${name} (v1) | ${folds.map((f) => f.v2.featureImportance[name].toFixed(2)).join(' | ')} |\n`;
  }
  for (const name of V2_NEW_FEATURE_COLUMNS) {
    md += `| **${name} (moi)** | ${folds.map((f) => f.v2.featureImportance[name].toFixed(2)).join(' | ')} |\n`;
  }
  md += '\n_(Hang in dam la 6 feature moi cua RT-059. So sanh gain cua chung voi nhom 8 feature cu — KHONG tu chon feature "quan trong nhat" de de xuat tich hop, chi bao cao so lieu tho.)_\n\n';

  md += '## Part A.4 — Breakdown theo coin (feature set v2 test set), Wilson 90% CI, chi khi n>=30\n\n';
  for (const f of folds) {
    const bySymbol = new Map<string, { symbol: string; predicted: number; won: boolean }[]>();
    for (const p of f.v2.predictions) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
      bySymbol.get(p.symbol)!.push(p);
    }
    const eligible = Array.from(bySymbol.entries()).filter(([, rs]) => rs.length >= 30);
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth})\n\n`;
    if (eligible.length === 0) {
      md += 'Khong coin nao dat n>=30 trong fold nay — khong bao cao breakdown theo coin (khong noi suy).\n\n';
      continue;
    }
    md += '| Coin | n | Winrate thuc te | Wilson 90% CI |\n';
    md += '|---|---|---|---|\n';
    for (const [symbol, rs] of eligible) {
      const wins = rs.filter((r) => r.won).length;
      const ci = wilsonInterval(wins, rs.length);
      md += `| ${symbol} | ${rs.length} | ${fmtPct(ci.p)} | [${fmtPct(ci.lower)}-${fmtPct(ci.upper)}] |\n`;
    }
    md += '\n';
  }

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi Part A vao ${reportPath} (monthlyRegimeAudit.ts se append Part B vao cuoi file nay).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
