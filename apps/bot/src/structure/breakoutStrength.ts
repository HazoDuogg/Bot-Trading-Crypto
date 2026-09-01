import type { Candle } from '../noTradeZone/types.js';

// D7 — CONVENTION v1: distribution-selected strength thresholds, not outcome/PnL optimization.
export const D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO = 0.55;
export const D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO = 1.0;

export interface BreakoutStrengthResult {
  isStrong: boolean;
  bodyRatio: number;
  rangeAtrRatio: number;
}

export function evaluateBreakoutStrength(
  candle: Candle,
  frozenAtr: number,
): BreakoutStrengthResult {
  if (!Number.isFinite(frozenAtr) || frozenAtr <= 0) {
    throw new Error('frozenAtr must be finite and greater than zero');
  }
  const range = candle.high - candle.low;
  if (range === 0) return { isStrong: false, bodyRatio: 0, rangeAtrRatio: 0 };
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const rangeAtrRatio = range / frozenAtr;
  return {
    isStrong:
      bodyRatio >= D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO &&
      rangeAtrRatio >= D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO,
    bodyRatio,
    rangeAtrRatio,
  };
}
