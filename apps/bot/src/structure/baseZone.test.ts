import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { calculateOverlapRatio, candlesOverlap, detectBaseZones } from './baseZone.js';

function candle(index: number, high: number, low: number): Candle {
  return { openTime: index * 900_000, open: low + 0.5, high, low, close: high - 0.5, volume: 100 };
}

describe('base-zone overlap', () => {
  it('uses strict range intersection and calculates adjacent-pair overlap ratio', () => {
    const fixture = [candle(0, 2, 0), candle(1, 3, 1), candle(2, 5, 3)];

    expect(candlesOverlap(fixture[0], fixture[1])).toBe(true);
    expect(candlesOverlap(fixture[1], fixture[2])).toBe(false);
    expect(calculateOverlapRatio(fixture)).toBe(0.5);
  });
});

describe('detectBaseZones', () => {
  it('returns the base immediately before an impulse without including the impulse candle', () => {
    const candles = [
      candle(0, 91, 90),
      candle(1, 101, 99),
      candle(2, 101.5, 99.5),
      candle(3, 102, 100),
      candle(4, 105, 98),
    ];

    expect(detectBaseZones(candles)).toEqual([
      { start_index: 1, end_index: 3, high: 102, low: 99 },
    ]);
  });

  it('does not classify an overlapping cluster without a 1.5x impulse', () => {
    const candles = [
      candle(0, 91, 90),
      candle(1, 101, 99),
      candle(2, 101.5, 99.5),
      candle(3, 102, 100),
      candle(4, 102.5, 100.5),
    ];

    expect(detectBaseZones(candles)).toEqual([]);
  });
});
