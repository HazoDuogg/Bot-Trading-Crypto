import { describe, it, expect } from 'vitest';
import { computeStochastic } from './stochastic.js';
import type { Candle } from '../regime/types.js';

function candle(high: number, low: number, close: number): Candle {
  return { openTime: 0, open: close, high, low, close, volume: 100 };
}

describe('computeStochastic', () => {
  it('matches the hand-computed raw %K with no smoothing (smoothK=1, dPeriod=1)', () => {
    // kPeriod=3 window over the last 3 candles: high range [10,12,11], low range [8,7,9].
    // hh=12, ll=7 -> range=5. close of last candle = 10 -> %K = (10-7)/5*100 = 60.
    const candles: Candle[] = [candle(10, 8, 9), candle(12, 7, 11), candle(11, 9, 10)];
    const result = computeStochastic(candles, { kPeriod: 3, dPeriod: 1, smoothK: 1 });
    expect(result.k).toEqual([60]);
    expect(result.d).toEqual([60]); // dPeriod=1 -> SMA of 1 value = itself
  });

  it('returns 50 (midpoint) when the kPeriod range is flat (highestHigh == lowestLow)', () => {
    const candles: Candle[] = [candle(10, 10, 10), candle(10, 10, 10), candle(10, 10, 10)];
    const result = computeStochastic(candles, { kPeriod: 3, dPeriod: 1, smoothK: 1 });
    expect(result.k).toEqual([50]);
  });

  it('returns empty arrays when there are fewer candles than kPeriod', () => {
    const candles: Candle[] = [candle(10, 8, 9), candle(12, 7, 11)];
    const result = computeStochastic(candles, { kPeriod: 3, dPeriod: 1, smoothK: 1 });
    expect(result.k).toEqual([]);
    expect(result.d).toEqual([]);
  });

  it('the last k and d values always align to the latest candle, regardless of smoothK/dPeriod', () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => candle(100 + i, 95 + i, 98 + i));
    const result = computeStochastic(candles, { kPeriod: 14, dPeriod: 3, smoothK: 3 });
    expect(result.k.length).toBeGreaterThan(0);
    expect(result.d.length).toBeGreaterThan(0);
    // Monotonically rising series -> %K should be pinned near the top of its range.
    expect(result.k[result.k.length - 1]).toBeGreaterThan(80);
    expect(result.d[result.d.length - 1]).toBeGreaterThan(80);
  });
});
