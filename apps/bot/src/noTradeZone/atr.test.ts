import { describe, it, expect } from 'vitest';
import { computeAtr } from './atr.js';
import type { Candle } from './types.js';

function candle(high: number, low: number, close: number, open = close): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

describe('computeAtr', () => {
  it('returns empty array when not enough candles', () => {
    const candles = [candle(10, 9, 9.5), candle(11, 10, 10.5)];
    expect(computeAtr(candles, 14)).toEqual([]);
  });

  it('computes flat ATR for constant true range', () => {
    // Each candle: high-low = 2, matches prevClose exactly -> TR = 2 every time.
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      candles.push(candle(price + 1, price - 1, price));
      price += 0; // close stays constant so TR = high-low = 2 always
    }
    const atr = computeAtr(candles, 5);
    expect(atr.length).toBe(candles.length - 5);
    atr.forEach((v) => expect(v).toBeCloseTo(2, 5));
  });
});
