/**
 * TICKET-05X-B step 2: fit the verified Baum-Welch HMM on real BTCUSDT M15
 * data and produce causal, walk-forward regime labels.
 *
 * Train on the first 6 calendar months, then for each following month:
 * apply causal forward-filtering (not smoothing/Viterbi) with the previous
 * month's fitted params, then refit on a rolling 6-month window before
 * moving to the next month. No parameter is tuned against downstream
 * verification results — see TICKET-05X-B step 3 scripts for that.
 *
 * Run: tsx scripts/hmmWalkForwardBtc.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle, RegimeState } from "../src/core/types.js";
import {
  fitGaussianHmmMultiStart,
  causalFilterStates,
  stationaryDistribution,
  type GaussianHmmParams,
} from "../src/regime/hmmRegime.js";

const DATA_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const LABELS_OUT_PATH = resolve("data/ticket05x-hmm-regime-labels.json");
const FITS_OUT_PATH = resolve("data/ticket05x-hmm-monthly-fits.json");

const TRAIN_WINDOW_MONTHS = 6;
const EM_SEED = 42;
const NUM_RESTARTS = 10;

function addMonthsUTC(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

function loadCandles(): Candle[] {
  const raw = readFileSync(DATA_PATH, "utf-8");
  return JSON.parse(raw) as Candle[];
}

/** log-return[i] corresponds to candles[i] (candles[0] has none). */
function computeLogReturns(candles: Candle[]): number[] {
  const returns = new Array(candles.length - 1);
  for (let i = 1; i < candles.length; i++) {
    returns[i - 1] = Math.log(candles[i].close / candles[i - 1].close);
  }
  return returns;
}

/**
 * Real-data labeling convention (locked, different from the synthetic
 * test's permutation-matching, which needs known ground truth): sort by
 * mean first (lowest=DOWNTREND, highest=UPTREND), then the remaining two
 * states by variance (lower=SIDEWAY, higher=DANGER_ZONE).
 */
function labelStates(params: GaussianHmmParams): RegimeState[] {
  const K = params.numStates;
  const order = Array.from({ length: K }, (_, i) => i).sort((a, b) => params.means[a] - params.means[b]);
  const downIdx = order[0];
  const upIdx = order[K - 1];
  const middle = order.slice(1, K - 1).sort((a, b) => params.stds[a] ** 2 - params.stds[b] ** 2);
  const [sidewayIdx, dangerIdx] = middle;

  const names: RegimeState[] = new Array(K);
  names[downIdx] = "DOWNTREND";
  names[upIdx] = "UPTREND";
  names[sidewayIdx] = "SIDEWAY";
  names[dangerIdx] = "DANGER_ZONE";
  return names;
}

interface MonthlyFit {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  trainCandleCount: number;
  testCandleCount: number;
  logLikelihood: number;
  emIterations: number;
  states: Record<RegimeState, { mean: number; std: number; selfLoop: number }>;
  dangerZoneHasLowestSelfLoop: boolean;
}

function main() {
  console.log(`Loading ${DATA_PATH}...`);
  const candles = loadCandles();
  console.log(`${candles.length} candles: ${new Date(candles[0].openTime).toISOString()} .. ${new Date(candles[candles.length - 1].openTime).toISOString()}`);

  const logReturns = computeLogReturns(candles);
  // logReturns[i] aligns with candles[i + 1]
  const dataStart = candles[0].openTime;
  const dataEnd = candles[candles.length - 1].openTime;

  const labels: { openTime: number; closeTime: number; state: RegimeState }[] = [];
  const monthlyFits: MonthlyFit[] = [];

  let windowStart = dataStart;
  let monthIndex = 0;

  while (true) {
    const trainEnd = addMonthsUTC(windowStart, TRAIN_WINDOW_MONTHS);
    const testStart = trainEnd;
    const testEnd = addMonthsUTC(trainEnd, 1);
    if (testStart > dataEnd) break;

    // candle index i uses logReturns[i-1]; select training candles [windowStart, trainEnd)
    const trainCandleIdx: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].openTime >= windowStart && candles[i].openTime < trainEnd) trainCandleIdx.push(i);
    }
    if (trainCandleIdx.length < 1000) {
      windowStart = addMonthsUTC(windowStart, 1);
      monthIndex++;
      continue;
    }
    const trainReturns = trainCandleIdx.map((i) => logReturns[i - 1]);

    monthIndex++;
    console.log(
      `\n[month ${monthIndex}] train [${new Date(windowStart).toISOString()}, ${new Date(trainEnd).toISOString()}) n=${trainReturns.length}`,
    );
    const fit = fitGaussianHmmMultiStart(trainReturns, 4, NUM_RESTARTS, EM_SEED);
    const names = labelStates(fit.params);
    console.log(`  LL=${fit.logLikelihood.toFixed(2)} iters=${fit.iterations}`);

    const stationary = stationaryDistribution(fit.params.transition);

    const testCandleIdx: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].openTime >= testStart && candles[i].openTime < testEnd) testCandleIdx.push(i);
    }
    if (testCandleIdx.length > 0) {
      const testReturns = testCandleIdx.map((i) => logReturns[i - 1]);
      const decoded = causalFilterStates(testReturns, fit.params, stationary);
      for (let k = 0; k < testCandleIdx.length; k++) {
        const c = candles[testCandleIdx[k]];
        labels.push({ openTime: c.openTime, closeTime: c.closeTime, state: names[decoded[k]] });
      }
    }

    const dzIdx = names.indexOf("DANGER_ZONE");
    const dzSelfLoop = fit.params.transition[dzIdx][dzIdx];
    const dangerZoneHasLowestSelfLoop = names.every((_, k) => k === dzIdx || fit.params.transition[k][k] > dzSelfLoop);

    const states = {} as MonthlyFit["states"];
    for (let k = 0; k < 4; k++) {
      states[names[k]] = { mean: fit.params.means[k], std: fit.params.stds[k], selfLoop: fit.params.transition[k][k] };
    }

    monthlyFits.push({
      trainStart: new Date(windowStart).toISOString(),
      trainEnd: new Date(trainEnd).toISOString(),
      testStart: new Date(testStart).toISOString(),
      testEnd: new Date(testEnd).toISOString(),
      trainCandleCount: trainReturns.length,
      testCandleCount: testCandleIdx.length,
      logLikelihood: fit.logLikelihood,
      emIterations: fit.iterations,
      states,
      dangerZoneHasLowestSelfLoop,
    });
    console.log(`  DANGER_ZONE self-loop=${dzSelfLoop.toFixed(3)} lowest=${dangerZoneHasLowestSelfLoop}`);

    windowStart = addMonthsUTC(windowStart, 1);
  }

  writeFileSync(LABELS_OUT_PATH, JSON.stringify(labels));
  writeFileSync(FITS_OUT_PATH, JSON.stringify(monthlyFits, null, 2));
  console.log(`\nSaved ${labels.length} labels to ${LABELS_OUT_PATH}`);
  console.log(`Saved ${monthlyFits.length} monthly fits to ${FITS_OUT_PATH}`);
}

main();
