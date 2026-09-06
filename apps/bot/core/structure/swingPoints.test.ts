import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { detectSwingPoints } from './swingPoints.js';

function candle(index: number, high: number, low: number): Candle {
  return { openTime: index * 900_000, open: low + 0.4, high, low, close: high - 0.4, volume: 100 };
}

describe('detectSwingPoints', () => {
  it('finds strict five-candle swing highs and lows at known indices', () => {
    const candles = [
      candle(0, 10, 7),
      candle(1, 12, 8),
      candle(2, 15, 9),
      candle(3, 13, 8),
      candle(4, 11, 6),
      candle(5, 10, 5),
      candle(6, 9, 2),
      candle(7, 11, 4),
      candle(8, 12, 5),
    ];

    expect(detectSwingPoints(candles)).toEqual([
      { index: 2, type: 'high', price: 15 },
      { index: 6, type: 'low', price: 2 },
    ]);
  });

  it('does not accept equal highs or emit an unconfirmed tail candidate', () => {
    const equalHighs = [
      candle(0, 10, 5),
      candle(1, 12, 6),
      candle(2, 12, 7),
      candle(3, 11, 6),
      candle(4, 10, 5),
    ];
    const unconfirmed = [candle(0, 10, 5), candle(1, 11, 6), candle(2, 20, 7), candle(3, 12, 6)];

    expect(detectSwingPoints(equalHighs)).toEqual([]);
    expect(detectSwingPoints(unconfirmed)).toEqual([]);
  });
});
