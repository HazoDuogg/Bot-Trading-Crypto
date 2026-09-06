// FAVORABLE_FIRST chi la dieu kien CAN cho gia thuyet "SL rong hon co the cuu lenh",
// KHONG phai bang chung 1.5R/2.0R co loi nhuan — can backtest lifecycle rieng truoc khi ket luan.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { M15_CANDLE_DURATION_MS } from '../../backtest/engine/intrabarExecution.js';
import { simulatePositionManagementV2 } from '../../core/risk/positionManagementV2.js';
import type { TradePlan } from '../../core/risk/tradePlan.js';

const RISK_BUDGET_USD = 6;
const OLD_HEADER = [
  'coin',
  'entryTimestamp',
  'direction',
  'totalGrossR',
  'totalNetR',
  'atr15',
  'compressionBandwidthAtrRatio',
  'breakoutBodyRatio',
  'atrH1',
  'emaValueH1',
  'aboveEmaH1',
];
const HORIZONS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000, '24h': 86_400_000 };
const HORIZON_KEYS = ['1h', '4h', '12h', '24h'];
const ADVERSE_THRESHOLDS: Record<string, number> = { '1.5R': 1.5, '2.0R': 2.0 };
const THRESHOLD_KEYS = ['1.5R', '2.0R'];
const FAVORABLE_R = 0.75;

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// Same binary-search convention as exitReasonAnalysis.ts / mfeMaeFixedHorizon.ts.
function firstM1After(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (candles[middle].openTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left;
}

// Copied from exitReasonAnalysis.ts resolveRow() — labeling only, not used for first-touch below.
function resolveExitReason(
  entryPrice: number,
  atr15: number,
  direction: 'BULL' | 'BEAR',
  entryFillTimestamp: number,
  m1Candles: readonly Candle[],
): { finalExitReason: string; minutesToResolve: number | null } {
  const sign = direction === 'BULL' ? 1 : -1;
  const tradePlan: TradePlan = {
    direction,
    entryPrice,
    stopLoss: entryPrice - sign * atr15,
    takeProfit: entryPrice + sign * atr15,
    riskPerUnit: atr15,
    positionSize: RISK_BUDGET_USD / atr15,
    requiredMargin: 0,
  };
  const postFillM1 = m1Candles.slice(firstM1After(m1Candles, entryFillTimestamp));
  const execution = simulatePositionManagementV2({ tradePlan, entryFillTimestamp, m1Candles: postFillM1 });
  const lastLeg = execution.exitLegs[execution.exitLegs.length - 1];
  if (lastLeg === undefined) return { finalExitReason: execution.outcome, minutesToResolve: null };
  const finalExitReason = lastLeg.reasonCode === 'AMBIGUOUS_FORCED_LOSS' ? 'AMBIGUOUS_FORCED_LOSS' : execution.outcome;
  return { finalExitReason, minutesToResolve: (lastLeg.exitTimestamp - entryFillTimestamp) / 60_000 };
}

type Label =
  | 'FAVORABLE_FIRST'
  | 'ADVERSE_FIRST'
  | 'SAME_M1_AMBIGUOUS'
  | 'FAVORABLE_ONLY'
  | 'ADVERSE_ONLY'
  | 'NEITHER'
  | 'INSUFFICIENT_DATA';

interface ComboResult {
  label: Label;
  favTouchMin: number | null;
  advTouchMin: number | null;
}

// One scan per horizon window computes favIdx and both adverse-threshold indices together —
// same per-candle math as TICKET-04X-G's MFE/MAE, just tracking first-touch indices instead of running max.
function computeHorizon(
  m1Candles: readonly Candle[],
  entryFillTimestamp: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'BULL' | 'BEAR',
  horizonMs: number,
): Record<string, ComboResult> {
  const startIdx = firstM1After(m1Candles, entryFillTimestamp);
  const cutoffTimestamp = entryFillTimestamp + horizonMs;
  const endIdx = firstM1After(m1Candles, cutoffTimestamp);
  const expectedCandleCount = horizonMs / 60_000;
  const actualCandleCount = endIdx - startIdx;

  if (actualCandleCount !== expectedCandleCount) {
    const insufficient: ComboResult = { label: 'INSUFFICIENT_DATA', favTouchMin: null, advTouchMin: null };
    return Object.fromEntries(THRESHOLD_KEYS.map((t) => [t, insufficient]));
  }

  let favIdx: number | null = null;
  const advIdxByThreshold: Record<string, number | null> = { '1.5R': null, '2.0R': null };
  for (let k = startIdx; k < endIdx; k += 1) {
    const candle = m1Candles[k];
    const favorable = direction === 'BULL' ? (candle.high - entryPrice) / riskPerUnit : (entryPrice - candle.low) / riskPerUnit;
    const adverse = direction === 'BULL' ? (entryPrice - candle.low) / riskPerUnit : (candle.high - entryPrice) / riskPerUnit;
    if (favIdx === null && favorable >= FAVORABLE_R) favIdx = k;
    for (const t of THRESHOLD_KEYS) {
      if (advIdxByThreshold[t] === null && adverse >= ADVERSE_THRESHOLDS[t]) advIdxByThreshold[t] = k;
    }
  }

  const toMinutes = (idx: number | null) => (idx === null ? null : (m1Candles[idx].openTime - entryFillTimestamp) / 60_000);
  const out: Record<string, ComboResult> = {};
  for (const t of THRESHOLD_KEYS) {
    const advIdx = advIdxByThreshold[t];
    let label: Label;
    if (favIdx !== null && advIdx !== null) {
      label = favIdx === advIdx ? 'SAME_M1_AMBIGUOUS' : favIdx < advIdx ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST';
    } else if (favIdx !== null) {
      label = 'FAVORABLE_ONLY';
    } else if (advIdx !== null) {
      label = 'ADVERSE_ONLY';
    } else {
      label = 'NEITHER';
    }
    out[t] = { label, favTouchMin: toMinutes(favIdx), advTouchMin: toMinutes(advIdx) };
  }
  return out;
}

function exitReasonBucket(finalExitReason: string): 'INITIAL_STOP' | 'AMBIGUOUS_FORCED_LOSS' | 'OTHER' {
  if (finalExitReason === 'INITIAL_STOP' || finalExitReason === 'AMBIGUOUS_FORCED_LOSS') return finalExitReason;
  return 'OTHER';
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const sourcePath = resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining -loss.xlsx');
  const outputPath = resolve(reportsDirectory, 'nukida-ticket04x-h-favorable-vs-adverse-first-touch.xlsx');
  const startedAt = Date.now();

  console.info(`Reading ${sourcePath} [LOSS]...`);
  const source = new ExcelJS.Workbook();
  await source.xlsx.readFile(sourcePath);
  const sourceSheet = source.getWorksheet('LOSS');
  if (sourceSheet === undefined) throw new Error('Missing LOSS sheet');

  const rows: Array<{ values: unknown[]; coin: string; entryTimestamp: number; direction: 'BULL' | 'BEAR'; atr15: number }> = [];
  sourceSheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    rows.push({
      values: OLD_HEADER.map((_, i) => v[i + 1]),
      coin: String(v[1]),
      entryTimestamp: Number(v[2]),
      direction: v[3] as 'BULL' | 'BEAR',
      atr15: Number(v[6]),
    });
  });
  console.info(`  ${rows.length} rows`);
  rows.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });
  const detailSheet = workbook.addWorksheet('LOSS_DETAIL');
  const detailHeader = [
    ...OLD_HEADER,
    'finalExitReason',
    'minutesToResolve',
    ...HORIZON_KEYS.flatMap((h) => THRESHOLD_KEYS.flatMap((t) => [`firstTouch_${h}_${t}`, `favTouchMin_${h}_${t}`, `advTouchMin_${h}_${t}`])),
  ];
  detailSheet.addRow(detailHeader).commit();

  // summaryCounts[bucket][horizon][threshold][label] = count
  const summaryCounts: Record<string, Record<string, Record<string, Record<string, number>>>> = {};
  const bucketTotals: Record<string, number> = { INITIAL_STOP: 0, AMBIGUOUS_FORCED_LOSS: 0, OTHER: 0 };

  let currentCoin: string | null = null;
  let m1Candles: Candle[] = [];
  let m15CloseByOpenTime = new Map<number, number>();
  let written = 0;

  for (const row of rows) {
    if (row.coin !== currentCoin) {
      currentCoin = row.coin;
      const m15Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_15m_3y.csv`));
      m1Candles = await loadCsv(resolve(dataDirectory, `${row.coin}_rt094_1m.csv`));
      m15CloseByOpenTime = new Map(m15Candles.map((c) => [c.openTime, c.close]));
    }
    const entryPrice = m15CloseByOpenTime.get(row.entryTimestamp);
    if (entryPrice === undefined) throw new Error(`entryTimestamp ${row.entryTimestamp} not found in ${row.coin} M15 CSV`);
    const entryFillTimestamp = row.entryTimestamp + M15_CANDLE_DURATION_MS - 1;

    const { finalExitReason, minutesToResolve } = resolveExitReason(entryPrice, row.atr15, row.direction, entryFillTimestamp, m1Candles);
    const bucket = exitReasonBucket(finalExitReason);
    bucketTotals[bucket] += 1;

    const outValues: unknown[] = [...row.values, finalExitReason, minutesToResolve];
    for (const h of HORIZON_KEYS) {
      const combos = computeHorizon(m1Candles, entryFillTimestamp, entryPrice, row.atr15, row.direction, HORIZONS[h]);
      summaryCounts[bucket] ??= {};
      summaryCounts[bucket][h] ??= {};
      for (const t of THRESHOLD_KEYS) {
        const c = combos[t];
        outValues.push(c.label, c.favTouchMin, c.advTouchMin);
        summaryCounts[bucket][h][t] ??= {};
        summaryCounts[bucket][h][t][c.label] = (summaryCounts[bucket][h][t][c.label] ?? 0) + 1;
      }
    }

    written += 1;
    const excelRow = detailSheet.addRow(outValues);
    if (written % 500 === 0) excelRow.commit();
    if (written % 40_000 === 0) console.info(`${written}/${rows.length} elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
  }
  detailSheet.commit();

  const ALL_LABELS: Label[] = ['FAVORABLE_FIRST', 'ADVERSE_FIRST', 'SAME_M1_AMBIGUOUS', 'FAVORABLE_ONLY', 'ADVERSE_ONLY', 'NEITHER', 'INSUFFICIENT_DATA'];
  const summarySheet = workbook.addWorksheet('SUMMARY');
  summarySheet.addRow(['finalExitReasonBucket', 'horizon', 'adverseThreshold', 'label', 'count', 'percent']).commit();
  const summaryRowsForConsole: string[] = [];
  for (const bucket of ['INITIAL_STOP', 'AMBIGUOUS_FORCED_LOSS', 'OTHER']) {
    const total = bucketTotals[bucket];
    for (const h of HORIZON_KEYS) {
      for (const t of THRESHOLD_KEYS) {
        const counts = summaryCounts[bucket]?.[h]?.[t] ?? {};
        for (const label of ALL_LABELS) {
          const count = counts[label] ?? 0;
          const percent = total === 0 ? 0 : (100 * count) / total;
          summarySheet.addRow([bucket, h, t, label, count, percent]).commit();
          summaryRowsForConsole.push(`${bucket} | ${h} | ${t} | ${label}: ${count} (${percent.toFixed(2)}%)`);
        }
        const advFirst = counts.ADVERSE_FIRST ?? 0;
        const sameM1 = counts.SAME_M1_AMBIGUOUS ?? 0;
        const conservativePercent = total === 0 ? 0 : (100 * (advFirst + sameM1)) / total;
        summarySheet.addRow([bucket, h, t, 'adverse-first-conservative', advFirst + sameM1, conservativePercent]).commit();
        summaryRowsForConsole.push(`${bucket} | ${h} | ${t} | adverse-first-conservative: ${advFirst + sameM1} (${conservativePercent.toFixed(2)}%)`);
      }
    }
  }
  summarySheet.commit();

  await workbook.commit();

  console.info('\n########## SUMMARY ##########');
  for (const line of summaryRowsForConsole) console.info(line);
  console.info(`\nOutput: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
