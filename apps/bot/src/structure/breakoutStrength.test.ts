import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO,
  D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO,
  evaluateBreakoutStrength,
} from './breakoutStrength.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

describe('evaluateBreakoutStrength', () => {
  it('marks a breakout strong only when body and ATR range both clear their thresholds', () => {
    expect(evaluateBreakoutStrength(candle(100, 110, 100, 108), 8)).toEqual({
      isStrong: true,
      bodyRatio: 0.8,
      rangeAtrRatio: 1.25,
    });
  });

  it('rejects a large-range candle whose body ratio is too small', () => {
    expect(evaluateBreakoutStrength(candle(100, 110, 100, 104), 8)).toEqual({
      isStrong: false,
      bodyRatio: 0.4,
      rangeAtrRatio: 1.25,
    });
  });

  it('rejects a high-body candle whose range is below frozen ATR', () => {
    expect(evaluateBreakoutStrength(candle(100, 105, 100, 104), 10)).toEqual({
      isStrong: false,
      bodyRatio: 0.8,
      rangeAtrRatio: 0.5,
    });
  });

  it('handles a zero-range candle without division', () => {
    expect(evaluateBreakoutStrength(candle(100, 100, 100, 100), 10)).toEqual({
      isStrong: false,
      bodyRatio: 0,
      rangeAtrRatio: 0,
    });
    expect(D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO).toBe(0.55);
    expect(D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO).toBe(1);
  });
});
