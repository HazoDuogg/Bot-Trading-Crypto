import { describe, expect, it } from 'vitest';
import { detectSwingPoints, latestSwingPointBefore } from './swingPoints.js';
import type { CandleData } from '../../regime/types.js';

function candle(high: number, low: number): CandleData {
  return { timestamp: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

describe('detectSwingPoints', () => {
  it('finds a swing high at the center of a 5-candle fractal (N=2)', () => {
    const candles = [candle(10, 9), candle(11, 10), candle(15, 12), candle(11, 10), candle(10, 9)];
    const points = detectSwingPoints(candles, 2);
    expect(points).toContainEqual({ index: 2, price: 15, type: 'HIGH' });
  });

  it('finds a swing low at the center of a 5-candle fractal (N=2)', () => {
    const candles = [candle(20, 15), candle(19, 14), candle(18, 5), candle(19, 14), candle(20, 15)];
    const points = detectSwingPoints(candles, 2);
    expect(points).toContainEqual({ index: 2, price: 5, type: 'LOW' });
  });

  it('does not confirm a fractal in the trailing N candles (not enough data after it yet)', () => {
    const candles = [candle(10, 9), candle(11, 10), candle(15, 12)]; // spike at index 2, but no candles after it
    const points = detectSwingPoints(candles, 2);
    expect(points).toHaveLength(0);
  });
});

describe('latestSwingPointBefore', () => {
  it('returns the most recent point of the given type strictly before the index', () => {
    const points = [
      { index: 2, price: 15, type: 'HIGH' as const },
      { index: 6, price: 20, type: 'HIGH' as const },
      { index: 4, price: 5, type: 'LOW' as const },
    ];
    expect(latestSwingPointBefore(points, 'HIGH', 10)).toEqual({ index: 6, price: 20, type: 'HIGH' });
    expect(latestSwingPointBefore(points, 'HIGH', 5)).toEqual({ index: 2, price: 15, type: 'HIGH' });
    expect(latestSwingPointBefore(points, 'HIGH', 2)).toBeNull(); // nothing strictly before index 2
  });
});
