import { describe, it, expect } from 'vitest';
import { classifyRegime } from './regimeClassifier.js';
import type { Candle } from './types.js';

// Builds a stair-step uptrend: rises for a few candles, pulls back for a couple, then resumes — creating real swing highs/lows.
function buildUptrend(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const cyclePos = i % 8;
    const delta = cyclePos < 5 ? 1.5 : -1; // 5 candles up, 3 candles pullback, net upward per cycle
    price += delta;
    candles.push({ openTime: i, open: price - 0.5, high: price + 0.5, low: price - 1, close: price, volume: 100 });
  }
  return candles;
}

function buildFlat(n: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wiggle = Math.sin(i / 3) * 0.5;
    candles.push({ openTime: i, open: 100 + wiggle, high: 100.6 + wiggle, low: 99.4 + wiggle, close: 100 + wiggle, volume: 100 });
  }
  return candles;
}

describe('classifyRegime', () => {
  it('returns SIDEWAY with insufficient history', () => {
    const candles = buildUptrend(50);
    expect(classifyRegime(candles).state).toBe('SIDEWAY');
  });

  it('detects UPTREND from a steady rising series with HH/HL structure', () => {
    const candles = buildUptrend(230);
    const result = classifyRegime(candles);
    expect(result.state).toBe('UPTREND');
    expect(result.priceAboveEma).toBe(true);
    expect(result.emaSlopePct).toBeGreaterThan(0);
  });

  it('returns SIDEWAY for flat oscillating prices', () => {
    const candles = buildFlat(230);
    const result = classifyRegime(candles);
    expect(result.state).toBe('SIDEWAY');
  });
});
