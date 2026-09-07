import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { MEAN_REVERSION_TIME_STOP_M5_CANDLES } from '../../core/risk/meanReversionTradePlan.js';

// TICKET-04X-V: real MFE (in R) for every filled TICKET-04X-S trade, scanning the FULL time-stop
// window (200 min) regardless of when the actual TP/SL/time-stop exit happened -- reuses the exact
// MFE formula verified in TICKET-04X-G (mfeMaeFixedHorizon.ts computeHorizon's favorable term),
// just fed real entry.fillPrice/entry.fillTimestamp/tradePlan.riskPerUnit from the existing
// TICKET-04X-S output instead of re-running mining. No new PnL/TP/SL logic anywhere in this file.
const M5_MS = 5 * 60 * 1000;
const HORIZON_MS = MEAN_REVERSION_TIME_STOP_M5_CANDLES * M5_MS; // 200 minutes
const OUTCOME_GROUPS = ['TAKE_PROFIT', 'STOP_LOSS', 'AMBIGUOUS_FORCED_LOSS', 'TIME_STOP'] as const;
type OutcomeGroup = (typeof OUTCOME_GROUPS)[number];
const MFE_MILESTONES_R = [2.67, 4, 6];

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

// Same binary-search convention as mfeMaeFixedHorizon.ts / favorableAdverseFirstTouch.ts:
// first index with openTime > timestamp.
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

// Verbatim MFE math from mfeMaeFixedHorizon.ts's computeHorizon (favorable term only -- this
// ticket doesn't ask for MAE), generalized from $ to R by dividing by the trade's own riskPerUnit.
function computeMfeR(
  m1Candles: readonly Candle[],
  entryFillTimestamp: number,
  entryPrice: number,
  riskPerUnit: number,
  direction: 'BULL' | 'BEAR',
): { mfeR: number; dataStatus: 'OK' | 'INSUFFICIENT_DATA' } {
  const startIdx = firstM1After(m1Candles, entryFillTimestamp);
  const cutoffTimestamp = entryFillTimestamp + HORIZON_MS;
  const endIdx = firstM1After(m1Candles, cutoffTimestamp);
  const expectedCandleCount = HORIZON_MS / 60_000;
  const actualCandleCount = endIdx - startIdx;
  if (actualCandleCount !== expectedCandleCount) return { mfeR: 0, dataStatus: 'INSUFFICIENT_DATA' };

  let runningMfeR = 0;
  for (let k = startIdx; k < endIdx; k += 1) {
    const candle = m1Candles[k];
    const favorable = direction === 'BULL' ? (candle.high - entryPrice) / riskPerUnit : (entryPrice - candle.low) / riskPerUnit;
    runningMfeR = Math.max(runningMfeR, favorable);
  }
  return { mfeR: runningMfeR, dataStatus: 'OK' };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function median(values: readonly number[]): number | null {
  return percentile(values, 50);
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
  console.info(`  M1=${m1Candles.length} trades=${backtest.trades.length}`);

  const mfeByGroup: Record<OutcomeGroup, number[]> = { TAKE_PROFIT: [], STOP_LOSS: [], AMBIGUOUS_FORCED_LOSS: [], TIME_STOP: [] };
  let insufficientDataCount = 0;
  let processed = 0;

  for (const trade of backtest.trades) {
    if (!OUTCOME_GROUPS.includes(trade.outcome as OutcomeGroup)) continue; // skips EXPIRED and anything else without a filled entry+plan
    if (trade.entry === undefined || trade.tradePlan === undefined) continue; // should not occur for these 4 outcomes, defensive only
    const group = trade.outcome as OutcomeGroup;

    const { mfeR, dataStatus } = computeMfeR(
      m1Candles,
      trade.entry.fillTimestamp,
      trade.entry.fillPrice,
      trade.tradePlan.riskPerUnit,
      trade.direction === 'LONG' ? 'BULL' : 'BEAR',
    );
    if (dataStatus === 'INSUFFICIENT_DATA') {
      insufficientDataCount += 1;
      continue;
    }
    mfeByGroup[group].push(mfeR);
    processed += 1;
    if (processed % 5000 === 0) console.info(`  processed ${processed}...`);
  }

  console.info(`\nDone. Processed ${processed} trades, INSUFFICIENT_DATA=${insufficientDataCount}`);

  const summary = Object.fromEntries(
    OUTCOME_GROUPS.map((group) => {
      const values = mfeByGroup[group];
      const n = values.length;
      const atOrAbove = (threshold: number) => (n === 0 ? null : (100 * values.filter((v) => v >= threshold).length) / n);
      return [
        group,
        {
          n,
          meanMfeR: mean(values),
          medianMfeR: median(values),
          p75MfeR: percentile(values, 75),
          p90MfeR: percentile(values, 90),
          pctAtOrAbove: Object.fromEntries(MFE_MILESTONES_R.map((m) => [`${m}R`, atOrAbove(m)])),
        },
      ];
    }),
  );

  console.info('\n########## MFE_R distribution by original outcome ##########');
  for (const group of OUTCOME_GROUPS) {
    const s = summary[group];
    console.info(
      `${group}: n=${s.n} mean=${s.meanMfeR?.toFixed(3) ?? 'N/A'} median=${s.medianMfeR?.toFixed(3) ?? 'N/A'} ` +
        `p75=${s.p75MfeR?.toFixed(3) ?? 'N/A'} p90=${s.p90MfeR?.toFixed(3) ?? 'N/A'} | ` +
        MFE_MILESTONES_R.map((m) => `>=${m}R: ${s.pctAtOrAbove[`${m}R`]?.toFixed(2) ?? 'N/A'}%`).join(' '),
    );
  }

  const output = {
    warning:
      'TICKET-04X-V: MFE_R thuan tuy mo ta tiem nang gia trong ca cua so time-stop (200 phut), khong dai dien PnL/TP/SL that -- ' +
      'khong tinh lai va khong toi uu gi tu file nay.',
    generatedAt: new Date().toISOString(),
    horizonMinutes: HORIZON_MS / 60_000,
    mfeMilestonesR: MFE_MILESTONES_R,
    processedTrades: processed,
    insufficientDataCount,
    byOutcome: summary,
  };

  const outputPath = resolve(auditsDirectory, 'mfeRealizedFromBacktest.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
