import { describe, it, expect } from 'vitest';
import { findSwingPoints } from './swingPoints.js';
import type { Candle } from './types.js';

function candle(high: number, low: number): Candle {
  return { openTime: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

describe('findSwingPoints', () => {
  it('detects a clean swing high in the middle of a rise-then-fall', () => {
    const candles = [
      candle(101, 99),
      candle(103, 101),
      candle(106, 104), // peak
      candle(103, 101),
      candle(101, 99),
    ];
    const points = findSwingPoints(candles, 2);
    expect(points).toContainEqual({ index: 2, price: 106, type: 'high' });
  });

  it('detects a clean swing low in a fall-then-rise', () => {
    const candles = [
      candle(101, 99),
      candle(99, 97),
      candle(97, 95), // trough
      candle(99, 97),
      candle(101, 99),
    ];
    const points = findSwingPoints(candles, 2);
    expect(points).toContainEqual({ index: 2, price: 95, type: 'low' });
  });

  it('returns nothing when there are fewer candles than 2*width+1', () => {
    const candles = [candle(101, 99), candle(102, 100)];
    expect(findSwingPoints(candles, 2)).toEqual([]);
  });
});
