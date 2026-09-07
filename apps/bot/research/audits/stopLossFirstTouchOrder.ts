import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { MEAN_REVERSION_TIME_STOP_M5_CANDLES } from '../../core/risk/meanReversionTradePlan.js';

// TICKET-04X-W: of the 22.73% of STOP_LOSS trades that touched +2.67R somewhere in their life
// (TICKET-04X-V), how many touched it BEFORE the real SL vs after? Same 7-label first-touch
// classification as favorableAdverseFirstTouch.ts (TICKET-04X-H/04X-U), same 200-min window as
// TICKET-04X-V, scoped to only the 19,701 STOP_LOSS trades from TICKET-04X-S. No new PnL/TP/SL logic.
const M5_MS = 5 * 60 * 1000;
const HORIZON_MS = MEAN_REVERSION_TIME_STOP_M5_CANDLES * M5_MS; // 200 minutes, same window as TICKET-04X-V
const FAVORABLE_R = 8 / 3; // 2.67R, the current TP level
const ADVERSE_R = 1.0; // the real SL level

type Label = 'FAVORABLE_FIRST' | 'ADVERSE_FIRST' | 'SAME_M1_AMBIGUOUS' | 'FAVORABLE_ONLY' | 'ADVERSE_ONLY' | 'NEITHER' | 'INSUFFICIENT_DATA';
const ALL_LABELS: Label[] = ['FAVORABLE_FIRST', 'ADVERSE_FIRST', 'SAME_M1_AMBIGUOUS', 'FAVORABLE_ONLY', 'ADVERSE_ONLY', 'NEITHER', 'INSUFFICIENT_DATA'];

interface BacktestTrade {
  direction: 'LONG' | 'SHORT';
  outcome: string;
  entry?: { fillTimestamp: number; fillPrice: number };
  tradePlan?: { riskPerUnit: number };
}

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

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

function classify(
  m1Candles: readonly Candle[],
  entryFillTimestamp: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'BULL' | 'BEAR',
): Label {
  const startIdx = firstM1After(m1Candles, entryFillTimestamp);
  const cutoffTimestamp = entryFillTimestamp + HORIZON_MS;
  const endIdx = firstM1After(m1Candles, cutoffTimestamp);
  const expectedCandleCount = HORIZON_MS / 60_000;
  if (endIdx - startIdx !== expectedCandleCount) return 'INSUFFICIENT_DATA';

  let favIdx: number | null = null;
  let advIdx: number | null = null;
  for (let k = startIdx; k < endIdx; k += 1) {
    const candle = m1Candles[k];
    const favorable = direction === 'BULL' ? (candle.high - entryPrice) / riskPerUnit : (entryPrice - candle.low) / riskPerUnit;
    const adverse = direction === 'BULL' ? (entryPrice - candle.low) / riskPerUnit : (candle.high - entryPrice) / riskPerUnit;
    if (favIdx === null && favorable >= FAVORABLE_R) favIdx = k;
    if (advIdx === null && adverse >= ADVERSE_R) advIdx = k;
  }

  if (favIdx !== null && advIdx !== null) {
    if (favIdx === advIdx) return 'SAME_M1_AMBIGUOUS';
    return favIdx < advIdx ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST';
  }
  if (favIdx !== null) return 'FAVORABLE_ONLY';
  if (advIdx !== null) return 'ADVERSE_ONLY';
  return 'NEITHER';
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../../reports/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info('Loading M1 CSV and TICKET-04X-S backtest output...');
  const m1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_rt094_1m.csv'));
  const backtest = JSON.parse(await readFile(resolve(reportsDirectory, 'nukida-04x-s-mean-reversion-backtest.json'), 'utf8')) as {
    trades: BacktestTrade[];
  };

  const stopLossTrades = backtest.trades.filter((t) => t.outcome === 'STOP_LOSS');
  console.info(`STOP_LOSS trades: ${stopLossTrades.length}`);

  const counts: Record<Label, number> = Object.fromEntries(ALL_LABELS.map((l) => [l, 0])) as Record<Label, number>;
  let processed = 0;

  for (const trade of stopLossTrades) {
    if (trade.entry === undefined || trade.tradePlan === undefined) continue; // defensive only, should not occur for STOP_LOSS
    const label = classify(
      m1Candles,
      trade.entry.fillTimestamp,
      trade.entry.fillPrice,
      trade.tradePlan.riskPerUnit,
      trade.direction === 'LONG' ? 'BULL' : 'BEAR',
    );
    counts[label] += 1;
    processed += 1;
  }

  const total = processed;
  const touchedFavorable = counts.FAVORABLE_FIRST + counts.ADVERSE_FIRST + counts.SAME_M1_AMBIGUOUS + counts.FAVORABLE_ONLY;
  // ^ any label where favIdx !== null: FAVORABLE_FIRST/ADVERSE_FIRST/SAME_M1_AMBIGUOUS require both;
  // FAVORABLE_ONLY means favorable touched but adverse (real SL) somehow didn't register within the
  // window (should be ~0 for a group already labeled STOP_LOSS, kept for completeness/transparency).
  const favorableFirstPctOfTouched = touchedFavorable === 0 ? null : (100 * counts.FAVORABLE_FIRST) / touchedFavorable;
  const favorableFirstPctOfAll = total === 0 ? null : (100 * counts.FAVORABLE_FIRST) / total;

  console.info('\n########## Label breakdown (STOP_LOSS trades, +2.67R vs -1.0R) ##########');
  for (const label of ALL_LABELS) {
    console.info(`${label}: ${counts[label]} (${total === 0 ? 'N/A' : ((100 * counts[label]) / total).toFixed(2) + '%'})`);
  }
  console.info(`\nTouched +2.67R at some point (favIdx!==null, any label): ${touchedFavorable} (${((100 * touchedFavorable) / total).toFixed(2)}% of STOP_LOSS -- should match TICKET-04X-V's 22.73%)`);
  console.info(`\n########## ANSWER ##########`);
  console.info(`Of the ${touchedFavorable} STOP_LOSS trades that touched +2.67R, ${counts.FAVORABLE_FIRST} (${favorableFirstPctOfTouched?.toFixed(2)}%) touched it BEFORE the real SL (FAVORABLE_FIRST -- a genuinely missed opportunity).`);
  console.info(`As a share of ALL ${total} STOP_LOSS trades: ${favorableFirstPctOfAll?.toFixed(2)}%.`);

  const output = {
    warning:
      'TICKET-04X-W: thu tu thoi gian cham nguong thuan tuy, khong TP/SL/PnL moi. FAVORABLE_FIRST la co hoi bi bo lo THAT (cham 2.67R ' +
      'truoc SL that); ADVERSE_FIRST nghia la SL that xay ra truoc, viec sau do gia con cham 2.67R chi la he qua cua viec khong dong lenh ' +
      'dung luc, khong phai co hoi.',
    generatedAt: new Date().toISOString(),
    horizonMinutes: HORIZON_MS / 60_000,
    favorableThresholdR: FAVORABLE_R,
    adverseThresholdR: ADVERSE_R,
    totalStopLossTrades: total,
    labelCounts: counts,
    touchedFavorableAtSomePoint: touchedFavorable,
    touchedFavorablePctOfStopLoss: total === 0 ? null : (100 * touchedFavorable) / total,
    answer: {
      favorableFirstCount: counts.FAVORABLE_FIRST,
      pctOfTouchedThatWereFavorableFirst: favorableFirstPctOfTouched,
      pctOfAllStopLossThatWereFavorableFirst: favorableFirstPctOfAll,
    },
  };

  const outputPath = resolve(auditsDirectory, 'stopLossFirstTouchOrder.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
