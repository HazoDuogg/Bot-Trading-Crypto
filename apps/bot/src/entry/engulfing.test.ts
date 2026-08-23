import { describe, it, expect } from 'vitest';
import { detectEngulfing } from './engulfing.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

describe('detectEngulfing', () => {
  it('detects bullish engulfing: current candle fully engulfs prior bearish candle range', () => {
    const prev = candle(105, 106, 100, 101); // bearish, range 100-106
    const curr = candle(99, 108, 99, 107); // bullish, open<=100, close>=106
    expect(detectEngulfing(prev, curr)).toEqual({ isEngulfing: true, direction: 'LONG' });
  });

  it('detects bearish engulfing: current candle fully engulfs prior bullish candle range', () => {
    const prev = candle(101, 106, 100, 105); // bullish, range 100-106
    const curr = candle(107, 107, 98, 99); // bearish, open>=106, close<=100
    expect(detectEngulfing(prev, curr)).toEqual({ isEngulfing: true, direction: 'SHORT' });
  });

  it('rejects when the range is not fully engulfed', () => {
    const prev = candle(105, 106, 100, 101);
    const curr = candle(99, 105, 99, 104); // close=104 < prev.high=106, not fully engulfed
    expect(detectEngulfing(prev, curr).isEngulfing).toBe(false);
  });

  it('rejects when both candles move the same direction', () => {
    const prev = candle(100, 106, 99, 105); // bullish
    const curr = candle(99, 108, 98, 107); // also bullish
    expect(detectEngulfing(prev, curr).isEngulfing).toBe(false);
  });
});
