import { describe, it, expect } from 'vitest';
import { calculateSl } from './slCalculator.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

// Oscillating series with real swing points (rise-pullback-rise pattern).
function buildOscillating(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const delta = i % 8 < 5 ? 1.5 : -1;
    price += delta;
    candles.push(candle(price - 0.5, price + 1, price - 1, price));
  }
  return candles;
}

describe('calculateSl', () => {
  it('TREND_PULLBACK LONG: places SL below the most recent M5 swing low', () => {
    const m5Candles = buildOscillating(30);
    const result = calculateSl({
      strategy: 'TREND_PULLBACK',
      direction: 'LONG',
      entryPrice: m5Candles[m5Candles.length - 1].close + 1,
      m5Candles,
      swingPivotWidth: 2,
      atrM5: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.distance).toBeGreaterThan(0);
  });

  it('TREND_PULLBACK returns null when no swing point exists yet', () => {
    const m5Candles = [candle(100, 101, 99, 100), candle(100, 101, 99, 100)];
    const result = calculateSl({
      strategy: 'TREND_PULLBACK',
      direction: 'LONG',
      entryPrice: 101,
      m5Candles,
      swingPivotWidth: 2,
      atrM5: 2,
    });
    expect(result).toBeNull();
  });

  it('RANGE_TRADING LONG: SL sits below rangeLevel by the ATR buffer', () => {
    const result = calculateSl({
      strategy: 'RANGE_TRADING',
      direction: 'LONG',
      entryPrice: 101,
      m5Candles: [],
      swingPivotWidth: 2,
      rangeLevel: 100,
      atrM5: 4,
    });
    // default rangeBufferAtrMultiplier = 0.25 -> buffer = 1 -> SL = 99
    expect(result).toEqual({ slPrice: 99, distance: 2 });
  });

  it('RANGE_TRADING returns null when rangeLevel is missing', () => {
    const result = calculateSl({
      strategy: 'RANGE_TRADING',
      direction: 'LONG',
      entryPrice: 101,
      m5Candles: [],
      swingPivotWidth: 2,
      atrM5: 4,
    });
    expect(result).toBeNull();
  });

  it('BREAKOUT_WATCH SHORT: SL sits above brokenLevel by the ATR buffer', () => {
    const result = calculateSl({
      strategy: 'BREAKOUT_WATCH',
      direction: 'SHORT',
      entryPrice: 98,
      m5Candles: [],
      swingPivotWidth: 2,
      brokenLevel: 100,
      atrM5: 4,
    });
    // buffer = 1 -> SL = 101
    expect(result).toEqual({ slPrice: 101, distance: 3 });
  });
});
