import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// TICKET-RT-058: walk-forward expanding-window audit over apps/bot/data/xgbAuditDataset.csv
// (produced by xgbFeatureAudit.ts, itself a rerun of the RT-056/057 confirmed 1217-trade
// backtest — untouched here). This script only reads that CSV, splits it by calendar month of
// entryTimestampUtc, and shells out to xgbTrainFold.py (Python xgboost) once per fold. No
// production code (entryRouter/fvg.ts/positionSizing/*) is imported or touched.

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
  'won',
] as const;

function parseCsv(text: string): Row[] {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  if (header.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`Unexpected CSV header: ${header.join(',')}`);
  }
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      symbol: cols[0],
      entryTimestampUtc: Number(cols[1]),
      distanceFromEma200H1Pct: Number(cols[2]),
      slPct: Number(cols[3]),
      fvgGapSizePct: Number(cols[4]),
      waitedCandlesCount: Number(cols[5]),
      breaksKeyZone: cols[6] === 'true',
      atrH1Pct: Number(cols[7]),
      hourOfDayUtc: Number(cols[8]),
      dayOfWeekUtc: Number(cols[9]),
      won: cols[10] === 'true',
    };
  });
}

function rowsToCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String((r as any)[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface FoldResult {
  foldIndex: number;
  trainMonths: string[];
  testMonth: string;
  trainN: number;
  testN: number;
  auc: number | null;
  featureImportance: Record<string, number>;
  predictions: { symbol: string; predicted: number; won: boolean }[];
}

// Wilson score interval, 90% CI (Z_90 = 1.6448536269514722) — same method as RT-049/RT-051.
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

async function trainFold(pythonExe: string, scriptPath: string, tmpDir: string, foldIndex: number, trainRows: Row[], testRows: Row[]): Promise<{
  auc: number | null;
  featureImportance: Record<string, number>;
  predictions: { symbol: string; predicted: number; won: boolean }[];
}> {
  const trainPath = path.join(tmpDir, `fold${foldIndex}_train.csv`);
  const testPath = path.join(tmpDir, `fold${foldIndex}_test.csv`);
  await writeFile(trainPath, rowsToCsv(trainRows), 'utf8');
  await writeFile(testPath, rowsToCsv(testRows), 'utf8');
  const stdout = execFileSync(pythonExe, [scriptPath, trainPath, testPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const csvPath = path.resolve(process.cwd(), 'apps/bot/data/xgbAuditDataset.csv');
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-058-xgb-audit-report.md');
  const scriptPath = path.resolve(process.cwd(), 'apps/bot/scripts/research/xgbTrainFold.py');

  console.log(`Dang doc ${csvPath}...`);
  const rows = parseCsv(await readFile(csvPath, 'utf8'));
  console.log(`Da doc ${rows.length} dong.`);

  const monthsPresent = Array.from(new Set(rows.map((r) => monthKey(r.entryTimestampUtc)))).sort();
  console.log(`Cac thang (calendar year-month) co trong du lieu: ${monthsPresent.join(', ')} (${monthsPresent.length} thang)`);

  // Relative month index 1..K, in chronological order of first appearance.
  const monthIndex = new Map<string, number>();
  monthsPresent.forEach((m, idx) => monthIndex.set(m, idx + 1));
  const K = monthsPresent.length;

  const rowsByMonthIdx = new Map<number, Row[]>();
  for (const r of rows) {
    const idx = monthIndex.get(monthKey(r.entryTimestampUtc))!;
    if (!rowsByMonthIdx.has(idx)) rowsByMonthIdx.set(idx, []);
    rowsByMonthIdx.get(idx)!.push(r);
  }

  const lastTestMonth = Math.min(K, 12);
  if (K !== 12) {
    console.log(
      `LUU Y: du lieu co ${K} thang calendar (khong dung 12) — ticket mo ta fold cuoi la "test thang 12";` +
        ` chay fold cho toi thang tuong doi ${lastTestMonth} va bao cao dung so nay, khong noi suy them.`,
    );
  }

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgb-fold-'));
  const folds: FoldResult[] = [];

  try {
    for (let testMonth = 7; testMonth <= lastTestMonth; testMonth++) {
      const trainMonthIndices = Array.from({ length: testMonth - 1 }, (_, i) => i + 1);
      const trainRows = trainMonthIndices.flatMap((m) => rowsByMonthIdx.get(m) ?? []);
      const testRows = rowsByMonthIdx.get(testMonth) ?? [];
      const trainMonthLabels = trainMonthIndices.map((idx) => monthsPresent[idx - 1]);
      const testMonthLabel = monthsPresent[testMonth - 1];

      console.log(`\nFold ${testMonth - 6}: train thang ${trainMonthLabels.join(',')} (n=${trainRows.length}) -> test thang ${testMonthLabel} (n=${testRows.length})`);

      if (trainRows.length === 0 || testRows.length === 0) {
        console.log('  -> BO QUA fold nay: train hoac test rong.');
        continue;
      }

      const result = await trainFold(pythonExe, scriptPath, tmpDir, testMonth, trainRows, testRows);
      console.log(`  AUC=${result.auc !== null ? result.auc.toFixed(4) : 'n/a (test set 1 class)'}`);

      folds.push({
        foldIndex: testMonth - 6,
        trainMonths: trainMonthLabels,
        testMonth: testMonthLabel,
        trainN: trainRows.length,
        testN: testRows.length,
        auc: result.auc,
        featureImportance: result.featureImportance,
        predictions: result.predictions,
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // --- Build report ---
  const featureNames = folds.length > 0 ? Object.keys(folds[0].featureImportance) : [];

  let md = '# TICKET-RT-058 — XGBoost Proof-of-Concept: Walk-Forward Feature Audit\n\n';
  md += 'Audit/proof-of-concept only. Khong sua entryRouter/fvg.ts/positionSizing/* hay bat ky code production nao.\n';
  md += 'Dataset: apps/bot/data/xgbAuditDataset.csv, tao boi xgbFeatureAudit.ts tu chinh backtest 1 nam da chot (RT-056/057 Config B, n=1217, PF=1.551) — tu-kiem-tra khop 100% da xac nhan trong log chay xgbFeatureAudit.ts.\n\n';
  md += `Cong cu: XGBoost qua Python subprocess (khong co JS/TS xgboost binding san co trong repo) — thu vien \`xgboost\` 3.3.0 + pandas/scikit-learn da co san trong moi truong Python he thong.\n\n`;
  md += `Cac thang calendar co trong du lieu: ${monthsPresent.join(', ')} (${K} thang).`;
  if (K !== 12) md += ` LUU Y: khong dung 12 thang — cac fold chay toi thang tuong doi ${lastTestMonth}, khong noi suy them.`;
  md += '\n\n';

  md += '## 1. AUC-ROC theo fold\n\n';
  md += '| Fold | Train thang | Test thang | Train n | Test n | AUC-ROC |\n';
  md += '|---|---|---|---|---|---|\n';
  for (const f of folds) {
    md += `| ${f.foldIndex} | ${f.trainMonths.join(', ')} | ${f.testMonth} | ${f.trainN} | ${f.testN} | ${f.auc !== null ? f.auc.toFixed(4) : 'n/a'} |\n`;
  }
  const validAucs = folds.map((f) => f.auc).filter((a): a is number => a !== null);
  if (validAucs.length > 0) {
    const meanAuc = validAucs.reduce((a, b) => a + b, 0) / validAucs.length;
    const stdAuc = Math.sqrt(validAucs.reduce((s, a) => s + (a - meanAuc) ** 2, 0) / validAucs.length);
    md += `\nAUC trung binh qua ${validAucs.length} fold co gia tri: ${meanAuc.toFixed(4)} (std=${stdAuc.toFixed(4)}, min=${Math.min(...validAucs).toFixed(4)}, max=${Math.max(...validAucs).toFixed(4)}).\n\n`;
  }

  md += '## 2. Decile breakdown (P(won) du doan vs winrate thuc te), theo fold\n\n';
  for (const f of folds) {
    md += `### Fold ${f.foldIndex} (test thang ${f.testMonth}, n=${f.testN})\n\n`;
    md += '| Decile (1=cao nhat) | n | P(won) du doan TB | Winrate thuc te |\n';
    md += '|---|---|---|---|\n';
    for (const d of decileBreakdown(f.predictions)) {
      md += `| ${d.decile} | ${d.n} | ${Number.isFinite(d.avgPredicted) ? d.avgPredicted.toFixed(3) : 'n/a'} | ${Number.isFinite(d.actualWinRate) ? fmtPct(d.actualWinRate) : 'n/a'} |\n`;
    }
    md += '\n';
  }

  md += '## 3. Feature importance (gain) theo fold\n\n';
  md += `| Feature | ${folds.map((f) => `Fold ${f.foldIndex}`).join(' | ')} |\n`;
  md += `|---|${folds.map(() => '---').join('|')}|\n`;
  for (const name of featureNames) {
    md += `| ${name} | ${folds.map((f) => f.featureImportance[name].toFixed(2)).join(' | ')} |\n`;
  }
  md += '\n';

  md += '## 4. Breakdown theo coin (winrate thuc te trong tap test), Wilson 90% CI, chi khi n>=30\n\n';
  for (const f of folds) {
    const bySymbol = new Map<string, { symbol: string; predicted: number; won: boolean }[]>();
    for (const p of f.predictions) {
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

  md += '## 5. Nhan dinh\n\n';
  md += '_(Dien thu cong sau khi doc bang AUC/feature-importance o tren — KHONG tu chon threshold hay de xuat tich hop, chi bao cao so lieu tho theo yeu cau ticket.)_\n';

  const reportsDir = path.dirname(reportPath);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, md, 'utf8');
  console.log(`\nDa ghi bao cao vao ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
