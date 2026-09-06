import { describe, it, expect } from 'vitest';
import { isVolatilityExtreme } from './volatilityCheck.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

describe('isVolatilityExtreme', () => {
  it('flags via H1 range% when latest candle range is extreme, even with short history', () => {
    const candles: Candle[] = [candle(100, 108, 100, 107)]; // range% = 8
    expect(isVolatilityExtreme(candles, 1.75, 4)).toBe(true);
  });

  it('does not flag calm, uniform candles', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) candles.push(candle(100, 101, 99, 100));
    expect(isVolatilityExtreme(candles, 1.75, 4)).toBe(false);
  });

  it('flags via ATR ratio when current ATR spikes vs prior 20-average', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) candles.push(candle(100, 101, 99, 100)); // calm baseline
    candles.push(candle(100, 110, 95, 102)); // sudden wide-range candle, but range% here = 15 (also trips range check)
    expect(isVolatilityExtreme(candles, 1.75, 4)).toBe(true);
  });
});
