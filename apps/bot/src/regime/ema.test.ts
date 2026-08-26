import { describe, it, expect } from 'vitest';
import { computeEma, createEmaTracker } from './ema.js';
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

// TICKET-RT-065 Part B: createEmaTracker() must reproduce computeEma() EXACTLY, step for step, for
// every candle count — this is the "so sanh so, khong chi doc code" verification the ticket requires
// before the incremental tracker is trusted for anything else (Part C/D's 3-year backtest).
describe('createEmaTracker matches computeEma exactly, step by step', () => {
  function pseudoRandomWalk(n: number, seed: number): Candle[] {
    // Deterministic LCG — no external randomness, reproducible across runs.
    let state = seed;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
      price += (next() - 0.5) * 4;
      candles.push({ openTime: i, open: price, high: price + 1, low: price - 1, close: price, volume: 100 });
    }
    return candles;
  }

  it('period=200 over a 400-candle synthetic walk', () => {
    const period = 200;
    const candles = pseudoRandomWalk(400, 42);
    const tracker = createEmaTracker(period);

    for (let i = 1; i <= candles.length; i++) {
      const incremental = tracker.next(candles[i - 1].close);
      const fromScratch = computeEma(candles.slice(0, i), period);
      const expected = fromScratch.length > 0 ? fromScratch[fromScratch.length - 1] : null;
      if (expected === null) {
        expect(incremental).toBeNull();
      } else {
        expect(incremental).not.toBeNull();
        expect(incremental as number).toBeCloseTo(expected, 9);
      }
    }
  });

  it('period=14 over a 100-candle synthetic walk', () => {
    const period = 14;
    const candles = pseudoRandomWalk(100, 7);
    const tracker = createEmaTracker(period);

    for (let i = 1; i <= candles.length; i++) {
      const incremental = tracker.next(candles[i - 1].close);
      const fromScratch = computeEma(candles.slice(0, i), period);
      const expected = fromScratch.length > 0 ? fromScratch[fromScratch.length - 1] : null;
      if (expected === null) {
        expect(incremental).toBeNull();
      } else {
        expect(incremental as number).toBeCloseTo(expected as number, 9);
      }
    }
  });
});
