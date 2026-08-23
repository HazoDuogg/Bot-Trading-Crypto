import { describe, it, expect } from 'vitest';
import { detectPinBar } from './pinBar.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

describe('detectPinBar', () => {
  it('detects a bullish pin bar (long lower wick, close near top)', () => {
    // range 100->110 (10), body |109-108|=1, lowerWick=108-100=8 (>=2*1), close=109 -> closeFromLow=0.9 (>=2/3)
    const c = candle(108, 110, 100, 109);
    expect(detectPinBar(c)).toEqual({ isPinBar: true, direction: 'LONG' });
  });

  it('detects a bearish pin bar (long upper wick, close near bottom)', () => {
    const c = candle(102, 110, 100, 101);
    expect(detectPinBar(c)).toEqual({ isPinBar: true, direction: 'SHORT' });
  });

  it('rejects a candle with too large a body', () => {
    const c = candle(100, 110, 99, 109); // body=9, range=11, body/range=0.82 > 0.3
    expect(detectPinBar(c).isPinBar).toBe(false);
  });

  it('rejects a normal candle with balanced wicks', () => {
    const c = candle(100, 101, 99.3, 100.5); // body=0.5, upperWick=0.5, lowerWick=0.7 — under 2x body ratio
    expect(detectPinBar(c).isPinBar).toBe(false);
  });

  it('rejects a zero-range candle', () => {
    const c = candle(100, 100, 100, 100);
    expect(detectPinBar(c).isPinBar).toBe(false);
  });
});
