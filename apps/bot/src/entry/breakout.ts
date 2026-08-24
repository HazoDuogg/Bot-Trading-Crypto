import type { Candle, Direction } from './types.js';
import { findSwingPoints } from '../regime/swingPoints.js';

export interface BreakoutInput {
  direction: Direction;
  m15Candles: Candle[];
  swingPivotWidth: number;
  volumeSpikeMultiplier: number;
  volumeLookback: number;
}

export interface BreakoutResult {
  isBreakout: boolean;
  brokenLevel: number | null;
  rangeHeight: number | null;
  volumeRatio: number | null;
}

export interface BreakoutConfig {
  volumeSpikeMultiplier: number;
  volumeLookback: number;
}

// TODO_CONFIRM: placeholders per TICKET-RT-021 — not backtest-calibrated, a follow-up sweep is
// planned only if this base M15+volume version shows a positive signal first.
export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  volumeSpikeMultiplier: 1.5,
  volumeLookback: 20,
};

// Per spec (Phan IV muc 3.2): M15 range breakout, confirmed by an M15 close beyond the range edge
// plus a volume spike — NOT M5 (see DEFAULT_BOS_CONFIG's own comment: its "~5/day" calibration only
// works out mathematically on M15 candle counts, not M5). Uses the same swing-high/swing-low pair
// classifyRegime() bases its SIDEWAY call on (most recent M15 swing high/low), so the range being
// tested here is the same one Regime Matrix already identified — findSwingPoints() naturally can't
// classify the last `swingPivotWidth` candles as pivots (needs padding on both sides), so the
// breakout candle itself can never contaminate its own range definition; no extra slicing needed.
export function detectBreakout(input: BreakoutInput): BreakoutResult {
  const swings = findSwingPoints(input.m15Candles, input.swingPivotWidth);
  const highs = swings.filter((p) => p.type === 'high');
  const lows = swings.filter((p) => p.type === 'low');
  if (highs.length === 0 || lows.length === 0) {
    return { isBreakout: false, brokenLevel: null, rangeHeight: null, volumeRatio: null };
  }

  const resistance = highs[highs.length - 1].price;
  const support = lows[lows.length - 1].price;
  const rangeHeight = Math.abs(resistance - support);

  const latest = input.m15Candles[input.m15Candles.length - 1];
  const brokenLevel = input.direction === 'LONG' ? resistance : support;
  const priceBreaksOut = input.direction === 'LONG' ? latest.close > resistance : latest.close < support;

  const lookbackCandles = input.m15Candles.slice(-1 - input.volumeLookback, -1);
  const volumeRatio =
    lookbackCandles.length === input.volumeLookback
      ? latest.volume / (lookbackCandles.reduce((sum, c) => sum + c.volume, 0) / lookbackCandles.length)
      : null;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= input.volumeSpikeMultiplier;

  return {
    isBreakout: priceBreaksOut && volumeConfirmed,
    brokenLevel,
    rangeHeight,
    volumeRatio,
  };
}
