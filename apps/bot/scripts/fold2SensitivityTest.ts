import { writeFile, mkdtemp, rm, mkdir, appendFile, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAllSymbolData, runInstrumentedSimulation, type ClosedTradeInternal } from './xgbFeatureAuditV3.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../src/entry/fvgStrategyConfig.js';

// TICKET-RT-062 Part B: Fold 2 leave-one-out sensitivity test.
//
// Base pool (confirmed with the user over chat before implementing, since the ticket's own wording
// was ambiguous about which pool the 30 iterations draw from): Fold 2's PRE-purge train set (822
// trades — trainNBeforePurge from RT-061), NOT the already-purged 821. Each of the 30 iterations
// removes exactly 1 random trade from that same 822-trade pool, producing an 821-trade train set,
// trains, and evaluates AUC on Fold 2's unchanged 63-trade test set — directly comparable to RT-061's
// known value 0.6031, which is itself just one particular draw from that same "822 choose 1" space
// (the one that happens to remove the RT-060-identified straddle trade). Different-sized training
// sets (e.g. 820 vs 821) would not be a clean percentile comparison against a single 821-trade AUC.
//
// Reproducibility: seed for iteration r (0..29) is the literal integer r, fed into a fixed mulberry32
// PRNG (implementation below, standard/public-domain algorithm) — first draw only, scaled to
// [0, 822) and floored to pick the removed index. Re-running this exact file will reproduce the exact
// same 30 removed indices, hence the exact same 30 AUC values (XGBoost itself is already
// deterministic via xgbTrainFold.py's fixed random_state=42).

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

// mulberry32 — standard/public-domain 32-bit seeded PRNG. Deterministic: same seed -> same sequence,
// forever, on any machine (no reliance on Math.random, which is NOT seedable/reproducible).
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

async function main() {
  const reportPath = path.resolve(process.cwd(), 'apps/bot/reports/RT-062-report.md');
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
    console.error('CORRECTION_REQUIRED: mirrored simulation (RT-062) KHONG khop RT-056/057 da chot — DUNG lai.');
    process.exitCode = 1;
    return;
  }
  console.log('-> KHOP 100%.\n');

  const monthsPresent = Array.from(new Set(closed.map((t) => monthKey(t.features.entryTimestampUtc)))).sort();

  // Fold 2 = testMonthIdx 8 (foldIndex 2, i.e. testMonthIdx - 6 = 2 -> testMonthIdx = 8), matching
  // RT-061's fold numbering exactly (foldIndex 1..6 for testMonthIdx 7..12).
  const testMonthIdx = 8;
  const trainMonthIndices = Array.from({ length: testMonthIdx - 1 }, (_, i) => i + 1);
  const trainMonths = trainMonthIndices.map((idx) => monthsPresent[idx - 1]);
  const testMonth = monthsPresent[testMonthIdx - 1];
  const testStart = monthStartMs(testMonth);

  const trainCandidates822 = closed.filter((t) => trainMonths.includes(monthKey(t.features.entryTimestampUtc)));
  const testTrades = closed.filter((t) => monthKey(t.features.entryTimestampUtc) === testMonth);
  console.log(`Fold 2 (test thang ${testMonth}): train truoc-purge n=${trainCandidates822.length}, test n=${testTrades.length}`);

  const straddleIndex = trainCandidates822.findIndex((t) => t.closeTime >= testStart);
  if (straddleIndex < 0 || trainCandidates822.filter((t) => t.closeTime >= testStart).length !== 1) {
    console.error(`CORRECTION_REQUIRED: ky vong dung 1 lenh straddle trong 822 (theo RT-060/061), tim thay ${trainCandidates822.filter((t) => t.closeTime >= testStart).length} — DUNG lai.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Da xac dinh lenh straddle o index ${straddleIndex}/822 (symbol=${trainCandidates822[straddleIndex].symbol}, closeTime=${new Date(trainCandidates822[straddleIndex].closeTime).toISOString()}).`);

  const pythonExe = findPython();
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'fold2-sensitivity-'));

  function trainDroppingIndex(dropIndex: number, testCsvPath: string, tag: string): number | null {
    const trainSubset = trainCandidates822.filter((_, idx) => idx !== dropIndex);
    const trainPath = path.join(tmpDir, `train_${tag}.csv`);
    // Sync write (trainFold is itself synchronous via execFileSync) keeps this loop straightforward.
    writeFileSync(trainPath, tradesToCsv(trainSubset), 'utf8');
    const result = trainFold(pythonExe, scriptPath, trainPath, testCsvPath, V2_ALL_FEATURE_COLUMNS);
    return result.auc;
  }

  try {
    const testPath = path.join(tmpDir, 'test_fold2.csv');
    await writeFile(testPath, tradesToCsv(testTrades), 'utf8');

    console.log('\nDoi chieu: bo dung mau straddle da biet (self-check voi RT-061 0.6031)...');
    const straddleRemovedAuc = trainDroppingIndex(straddleIndex, testPath, 'straddle');
    console.log(`  AUC (bo mau straddle) = ${straddleRemovedAuc !== null ? straddleRemovedAuc.toFixed(4) : 'n/a'} (RT-061 da bao cao: 0.6031)`);
    const straddleSelfCheckMatches = straddleRemovedAuc !== null && Math.abs(straddleRemovedAuc - 0.6031) < 0.0001;
    if (!straddleSelfCheckMatches) {
      console.error(`CORRECTION_REQUIRED: tai-tao AUC bo-mau-straddle = ${straddleRemovedAuc} KHONG khop RT-061's 0.6031 (dung sai 0.0001) — DUNG lai, kiem tra lai truoc khi chay 30 lan random.`);
      process.exitCode = 1;
      return;
    }
    console.log('  -> KHOP 100% voi RT-061.\n');

    console.log('Dang chay 30 lan bo-ngau-nhien-1-mau (seed = 0..29, mulberry32, tai lap duoc)...');
    const randomAucs: { seed: number; droppedIndex: number; auc: number | null }[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const rng = mulberry32(seed);
      const droppedIndex = Math.floor(rng() * trainCandidates822.length);
      const auc = trainDroppingIndex(droppedIndex, testPath, `rand${seed}`);
      randomAucs.push({ seed, droppedIndex, auc });
      console.log(`  seed=${seed}  dropIndex=${droppedIndex}  AUC=${auc !== null ? auc.toFixed(4) : 'n/a'}`);
    }

    const validAucs = randomAucs.map((r) => r.auc).filter((a): a is number => a !== null);
    const sorted = [...validAucs].sort((a, b) => a - b);
    const percentile = (p: number) => {
      const idx = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    };
    const median = percentile(50);
    const p10 = percentile(10);
    const p90 = percentile(90);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const rankBelow = sorted.filter((a) => a < straddleRemovedAuc!).length;
    const straddlePercentileRank = (rankBelow / sorted.length) * 100;

    let md = '# TICKET-RT-062 Part B — Fold 2 Leave-One-Out Sensitivity Test\n\n';
    md += 'Audit-only. Khong dung production, khong sua RT-058/059/060/061. Khong tu ket luan "model on dinh hay khong" — chi bao cao phan phoi + vi tri percentile.\n\n';
    md +=
      `Base pool: tap train Fold 2 TRUOC purge (${trainCandidates822.length} mau — khac voi cach doc dau tien cua ticket, da xac nhan lai voi nguoi dung qua chat truoc khi code: moi lan lap bo 1 mau ngau nhien tu chinh 822 mau nay, tao tap 821-mau, de so sanh truc tiep, cung co-mau, voi AUC=0.6031 da biet cua RT-061 (ban than 0.6031 cung la mot lan chon-bo-1-mau cu the tu 822 — chinh la mau straddle).\n\n`;
    md += `Tu-kiem-tra: tai-tao AUC khi bo dung mau straddle (index ${straddleIndex}/822, ${trainCandidates822[straddleIndex].symbol}, closeTime=${new Date(trainCandidates822[straddleIndex].closeTime).toISOString()}) = **${straddleRemovedAuc!.toFixed(4)}**, khop RT-061's 0.6031 trong dung sai 0.0001.\n\n`;
    md += `Seed: mulberry32(seed), seed = 0..29 (chinh la so thu tu lan lap), lay gia tri random dau tien, nhan voi ${trainCandidates822.length} roi lam tron xuong de chon index bi bo. Tai lap 100% khi chay lai file nay.\n\n`;

    md += '## 30 lan bo-ngau-nhien-1-mau\n\n';
    md += '| Seed | Dropped index (/822) | AUC |\n';
    md += '|---|---|---|\n';
    for (const r of randomAucs) {
      md += `| ${r.seed} | ${r.droppedIndex} | ${r.auc !== null ? r.auc.toFixed(4) : 'n/a'} |\n`;
    }
    md += '\n';

    md += '## Phan phoi 30 gia tri AUC\n\n';
    md += `| Median | P10 | P90 | Min | Max |\n`;
    md += `|---|---|---|---|---|\n`;
    md += `| ${median.toFixed(4)} | ${p10.toFixed(4)} | ${p90.toFixed(4)} | ${min.toFixed(4)} | ${max.toFixed(4)} |\n\n`;

    md += '## Vi tri cua AUC=0.6031 (bo mau straddle) trong phan phoi 30 lan random\n\n';
    md += `AUC bo-mau-straddle = ${straddleRemovedAuc!.toFixed(4)}. Trong 30 gia tri random: ${rankBelow}/${sorted.length} gia tri THAP HON no (percentile rank = ${straddlePercentileRank.toFixed(1)}%). `;
    md += `Median cua 30 lan random = ${median.toFixed(4)} (chenh lech = ${(straddleRemovedAuc! - median).toFixed(4)}). Khoang [P10, P90] cua 30 lan random = [${p10.toFixed(4)}, ${p90.toFixed(4)}] — gia tri straddle ${straddleRemovedAuc! < p10 || straddleRemovedAuc! > p90 ? 'NAM NGOAI' : 'nam trong'} khoang nay.\n\n`;
    md +=
      '_(Khong tu ket luan thay: percentile rank cang gan 0 hoac 100 (cang gan min/max cua phan phoi random) cang ung ho gia thuyet "mau straddle dac biet influential"; percentile rank cang gan 50 (gan median) cang ung ho gia thuyet "model noi chung bat on voi nhieu 1 mau, straddle khong dac biet hon cac mau khac". Vinh Tam/AI reviewer tu doc so lieu tren de danh gia.)_\n';

    const reportsDir = path.dirname(reportPath);
    await mkdir(reportsDir, { recursive: true });
    // Append after Part A (xgbQuintileMonotonicity.ts writes Part A to the SAME report path first).
    try {
      await access(reportPath);
      await appendFile(reportPath, '\n---\n\n' + md, 'utf8');
    } catch {
      await writeFile(reportPath, md, 'utf8');
    }
    console.log(`\nDa ghi/append Part B vao ${reportPath}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
