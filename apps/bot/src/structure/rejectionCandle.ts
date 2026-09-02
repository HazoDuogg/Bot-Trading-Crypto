import type { Candle } from '../noTradeZone/types.js';

// v1 thresholds: median of each metric over a held-out calibration sample of real
// counter-test candles, not tuned against any backtest outcome. Unused since Setup B's
// removal (TICKET-035); kept as a generic candle-rejection utility, not deleted per ticket.
export const REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO = 0.3960385660828152;
export const REJECTION_CANDLE_V1_MIN_CLOSE_BIAS = 0.592640943815878;

export interface RejectionCandleResult {
  passes: boolean;
  oppositeWickRatio: number;
  closeBias: number;
}

// Measures whether a candle shows rejection of a probe against `direction`: a long wick
// opposite that direction plus a close biased back toward it.
export function evaluateRejectionCandle(
  candle: Candle,
  direction: 'BULL' | 'BEAR',
): RejectionCandleResult {
  const range = candle.high - candle.low;
  if (!(range > 0)) return { passes: false, oppositeWickRatio: 0, closeBias: 0 };
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  // "Opposite" wick = the wick probing against the expected continuation direction — for
  // BULL that is the lower wick (a dip that got rejected).
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
