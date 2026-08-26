import { describe, it, expect } from 'vitest';
import { computeAtr, createAtrTracker } from './atr.js';
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

// TICKET-RT-065 Part B: createAtrTracker() must reproduce computeAtr() EXACTLY, step for step, for
// every candle count — same "so sanh so, khong chi doc code" verification as ema.test.ts, before the
// incremental tracker is trusted for Part C/D's 3-year backtest.
describe('createAtrTracker matches computeAtr exactly, step by step', () => {
  function pseudoRandomWalkCandles(n: number, seed: number): Candle[] {
    let state = seed;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
      price += (next() - 0.5) * 4;
      const high = price + next() * 2;
      const low = price - next() * 2;
      candles.push({ openTime: i, open: price, high, low, close: price, volume: 100 });
    }
    return candles;
  }

  it('period=14 over a 300-candle synthetic walk', () => {
    const period = 14;
    const candles = pseudoRandomWalkCandles(300, 42);
    const tracker = createAtrTracker(period);

    for (let i = 1; i <= candles.length; i++) {
      const incremental = tracker.next(candles[i - 1]);
      const fromScratch = computeAtr(candles.slice(0, i), period);
      const expected = fromScratch.length > 0 ? fromScratch[fromScratch.length - 1] : null;
      if (expected === null) {
        expect(incremental).toBeNull();
      } else {
        expect(incremental).not.toBeNull();
        expect(incremental as number).toBeCloseTo(expected, 9);
      }
    }
  });

  it('period=200 over a 250-candle synthetic walk', () => {
    const period = 200;
    const candles = pseudoRandomWalkCandles(250, 7);
    const tracker = createAtrTracker(period);

    for (let i = 1; i <= candles.length; i++) {
      const incremental = tracker.next(candles[i - 1]);
      const fromScratch = computeAtr(candles.slice(0, i), period);
      const expected = fromScratch.length > 0 ? fromScratch[fromScratch.length - 1] : null;
      if (expected === null) {
        expect(incremental).toBeNull();
      } else {
        expect(incremental as number).toBeCloseTo(expected as number, 9);
      }
    }
  });
});
