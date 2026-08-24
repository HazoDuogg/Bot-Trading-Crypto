import type { Candle, Direction } from './types.js';

export interface FvgConfig {
  minCandle2BodyRatio: number; // "than dai" of candle2, measured as body/range
}

// TICKET-RT-032: backtest-confirmed, 0.6 -> 0.7. Robust improvement across 5/5 coin (90 days, 5 coin,
// floor=0.5%) — in particular fixes ETH, the weakest coin at 0.6 (PF 1.00, essentially breakeven) up
// to PF 1.32, without the small-sample noise seen at 0.8 (BTC n=13 at that level). See RT-031/RT-032
// reports for the full per-coin breakdown and sweep tables this was chosen from.
export const DEFAULT_FVG_CONFIG: FvgConfig = {
  minCandle2BodyRatio: 0.7,
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
