import path from 'node:path';
import { DEFAULT_COIN_BACKTEST_CONFIG, loadM15CandlesBetween } from '../src/backtest/runNukidaBacktest.js';
import { createDefaultStrategyAdapter } from '../src/orchestrator/nukidaFsm.js';
import { evaluateRejectionCandle } from '../src/structure/rejectionCandle.js';
import type { Candle } from '../src/noTradeZone/types.js';

// TICKET-028 calibration: derive REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO and
// REJECTION_CANDLE_V1_MIN_CLOSE_BIAS from a held-out split of real counter-test
// candidates — the counterTestIndex candle of every signal the CURRENT (unfiltered)
// Setup B rule already emits, across all 5 configured coins' full 3y history.
//
// Split: first half of each coin's candle series (chronological, no look-ahead) is the
// calibration set the thresholds are computed from; the second half is held out and only
// used here to report how the (already-fixed) thresholds would classify unseen data — it
// is never used to pick or adjust the threshold values themselves.
//
// Threshold rule: median of each metric over the calibration set. A median cut is a
// single-test quality filter (roughly half of historical candidates would have passed),
// not a strict multi-touch requirement — chosen a priori, before looking at any
// backtest PF/netR outcome, per TICKET-028's explicit prohibition on outcome-tuned
// thresholds.

interface Candidate {
  coin: string;
  oppositeWickRatio: number;
  closeBias: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function collectCandidates(coin: string, candles: readonly Candle[]): Candidate[] {
  const adapter = createDefaultStrategyAdapter({});
  const candidates: Candidate[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const visible = candles.slice(0, index + 1);
    const stage = adapter.onClosedCandle(visible, index);
    for (const setup of stage.setups) {
      if (setup.setupFamily !== 'B_BREAK_PULLBACK_FAILURE') continue;
      const counterTestIndex = setup.reasonTrace.dominance.counterTestIndex;
      if (counterTestIndex === null || counterTestIndex === undefined) continue;
      const candle = candles[counterTestIndex];
      const metrics = evaluateRejectionCandle(candle, setup.direction);
      candidates.push({
        coin,
        oppositeWickRatio: metrics.oppositeWickRatio,
        closeBias: metrics.closeBias,
      });
    }
  }
  return candidates;
}

async function main(): Promise<void> {
  const dataDirectory = path.resolve(process.cwd(), 'apps/bot/data');
  const calibration: Candidate[] = [];
  const evaluation: Candidate[] = [];

  for (const coin of Object.keys(DEFAULT_COIN_BACKTEST_CONFIG)) {
    const all = await loadM15CandlesBetween(
      path.resolve(dataDirectory, `${coin}_15m_3y.csv`),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const midpoint = Math.floor(all.length / 2);
    const calibrationCandles = all.slice(0, midpoint);
    const evaluationCandles = all.slice(midpoint);
    const coinCalibration = collectCandidates(coin, calibrationCandles);
    const coinEvaluation = collectCandidates(coin, evaluationCandles);
    calibration.push(...coinCalibration);
    evaluation.push(...coinEvaluation);
    console.info(
      `${coin}: total=${all.length} calibrationCandidates=${coinCalibration.length} ` +
        `evaluationCandidates=${coinEvaluation.length}`,
    );
  }

  const minOppositeWickRatio = median(calibration.map((c) => c.oppositeWickRatio));
  const minCloseBias = median(calibration.map((c) => c.closeBias));

  console.info(`\nCalibration set: n=${calibration.length}`);
  console.info(`  median oppositeWickRatio = ${minOppositeWickRatio}`);
  console.info(`  median closeBias = ${minCloseBias}`);

  const evalPassBoth = evaluation.filter(
    (c) => c.oppositeWickRatio >= minOppositeWickRatio && c.closeBias >= minCloseBias,
  ).length;
  console.info(`\nEvaluation set (held out, NOT used to pick thresholds): n=${evaluation.length}`);
  console.info(
    `  would pass both thresholds: ${evalPassBoth} (${((evalPassBoth / evaluation.length) * 100).toFixed(1)}%)`,
  );

  const calibPassBoth = calibration.filter(
    (c) => c.oppositeWickRatio >= minOppositeWickRatio && c.closeBias >= minCloseBias,
  ).length;
  console.info(`\nCalibration set self-check: would pass both: ${calibPassBoth} (${calibration.length} total)`);
}

await main();
