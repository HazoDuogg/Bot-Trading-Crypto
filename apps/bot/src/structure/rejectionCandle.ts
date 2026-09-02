import type { Candle } from '../noTradeZone/types.js';

// Class D — EXPERIMENTAL v1 (TICKET-028): median of each metric over the counterTestIndex
// candle of every counter-test candidate the CURRENT (unfiltered) Setup B rule emits across
// the first chronological half of all 5 configured coins' 3y history (n=226 candidates);
// the second half (n=257) is held out for evaluation only and was never used to pick these
// values — see scripts/calibrateRejectionCandle.ts for the exact derivation and the
// evaluation-set pass rate (29.6%, consistent with the 32.7% calibration self-check, i.e.
// not overfit to the calibration half). Deliberately kept out of STRATEGY_CONSTANTS
// (D1-D8) in fingerprint.ts — this is a single-test quality filter, not a structural rule.
export const REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO = 0.3960385660828152;
export const REJECTION_CANDLE_V1_MIN_CLOSE_BIAS = 0.592640943815878;

export interface RejectionCandleResult {
  passes: boolean;
  oppositeWickRatio: number;
  closeBias: number;
}

// Confirmation candle = the counter-test candle itself (the one that touches the broken
// level), not the last candle of the reclaim window: it is the only candle that actually
// interacts with the level, so it is the one whose wick/close can evidence rejection. It is
// also the candle setupBConfirmationCandleExtreme() (tradePlan.ts) measures the new SL from.
export function evaluateRejectionCandle(
  candle: Candle,
  direction: 'BULL' | 'BEAR',
): RejectionCandleResult {
  const range = candle.high - candle.low;
  if (!(range > 0)) return { passes: false, oppositeWickRatio: 0, closeBias: 0 };
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  // "Opposite" wick = the wick probing against Setup B's expected continuation direction —
  // for BULL that is the lower wick (the dip into the counter-test zone that got rejected).
  const oppositeWick = direction === 'BULL' ? bodyLow - candle.low : candle.high - bodyHigh;
  const oppositeWickRatio = oppositeWick / range;
  const closeBias =
    direction === 'BULL' ? (candle.close - candle.low) / range : (candle.high - candle.close) / range;
  return {
    passes:
      oppositeWickRatio >= REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO &&
      closeBias >= REJECTION_CANDLE_V1_MIN_CLOSE_BIAS,
    oppositeWickRatio,
    closeBias,
  };
}
