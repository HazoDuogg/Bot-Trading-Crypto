import type { Candle, Direction } from './types.js';

export interface FvgConfig {
  minCandle2BodyRatio: number; // TODO_CONFIRM — "than dai" of candle2, measured as body/range
}

// TODO_CONFIRM: placeholder per TICKET-RT-027 — video gives no number for "than dai", 0.6 is a
// reasonable-looking guess (body clearly dominates the range), not backtest-chosen.
export const DEFAULT_FVG_CONFIG: FvgConfig = {
  minCandle2BodyRatio: 0.6,
};

export interface FvgResult {
  isFvg: boolean;
  direction?: Direction;
  gapLow?: number;
  gapHigh?: number;
  invalidationPrice?: number;
}

// Per the video, verbatim: 3-candle pattern — candle1 has a wick, candle2 is a strong same-direction
// body candle, candle3 opens without touching candle1's wick, leaving a gap between candle1 and
// candle3. Bullish: candle3.low > candle1.high (gap up); SL sits at candle1.low (below the wick that
// must not get reclaimed). Bearish is the mirror.
export function detectFvg(candle1: Candle, candle2: Candle, candle3: Candle, config: FvgConfig): FvgResult {
  const body2 = Math.abs(candle2.close - candle2.open);
  const range2 = candle2.high - candle2.low;
  if (range2 <= 0) return { isFvg: false };
  const bodyRatio2 = body2 / range2;
  if (bodyRatio2 < config.minCandle2BodyRatio) return { isFvg: false };

  const candle2Bullish = candle2.close > candle2.open;
  const candle2Bearish = candle2.close < candle2.open;

  if (candle2Bullish && candle3.low > candle1.high) {
    return {
      isFvg: true,
      direction: 'LONG',
      gapLow: candle1.high,
      gapHigh: candle3.low,
      invalidationPrice: candle1.low,
    };
  }

  if (candle2Bearish && candle3.high < candle1.low) {
    return {
      isFvg: true,
      direction: 'SHORT',
      gapLow: candle3.high,
      gapHigh: candle1.low,
      invalidationPrice: candle1.high,
    };
  }

  return { isFvg: false };
}
