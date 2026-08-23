import { describe, it, expect } from 'vitest';
import { computeEma } from './ema.js';
import type { Candle } from './types.js';

function candle(close: number): Candle {
  return { openTime: 0, open: close, high: close, low: close, close, volume: 100 };
}

describe('computeEma', () => {
  it('returns empty array when not enough candles', () => {
    const candles = [candle(100), candle(101)];
    expect(computeEma(candles, 200)).toEqual([]);
  });

  it('seeds with SMA and stays constant for flat prices', () => {
    const candles = Array.from({ length: 25 }, () => candle(100));
    const ema = computeEma(candles, 20);
    expect(ema.length).toBe(6);
    ema.forEach((v) => expect(v).toBeCloseTo(100, 6));
  });

  it('trends upward when price steps up', () => {
    const candles = Array.from({ length: 25 }, (_, i) => candle(100 + i));
    const ema = computeEma(candles, 20);
    expect(ema[ema.length - 1]).toBeGreaterThan(ema[0]);
  });
});
