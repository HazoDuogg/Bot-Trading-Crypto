import { describe, it, expect } from 'vitest';
import { isShockEvent } from './shockEventCheck.js';
import type { Candle } from './types.js';

function candle(open: number, close: number): Candle {
  return { openTime: 0, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 };
}

describe('isShockEvent', () => {
  it('flags a single H1 candle moving beyond threshold%', () => {
    const candles = [candle(100, 90)]; // -10%
    expect(isShockEvent(candles, 7.5)).toBe(true);
  });

  it('does not flag a normal candle', () => {
    const candles = [candle(100, 99)]; // -1%
    expect(isShockEvent(candles, 7.5)).toBe(false);
  });

  it('returns false with no candles', () => {
    expect(isShockEvent([], 7.5)).toBe(false);
  });
});
