import { describe, it, expect } from 'vitest';
import { classifyTrendH1 } from './trendH1.js';
import type { Candle } from '../regime/types.js';

function candle(close: number): Candle {
  return { openTime: 0, open: close, high: close, low: close, close, volume: 100 };
}

function buildFlatSeries(n: number, price: number): Candle[] {
  return Array.from({ length: n }, () => candle(price));
}

describe('classifyTrendH1', () => {
  it('UPTREND when close is above EMA200', () => {
    const candles = buildFlatSeries(200, 100);
    candles.push(candle(150)); // sharp rise -> close well above the flat EMA
    expect(classifyTrendH1(candles, 200)).toBe('UPTREND');
  });

  it('DOWNTREND when close is below EMA200', () => {
    const candles = buildFlatSeries(200, 100);
    candles.push(candle(50));
    expect(classifyTrendH1(candles, 200)).toBe('DOWNTREND');
  });

  it('UPTREND when close exactly equals EMA (boundary counts as up)', () => {
    // period=1 makes k=2/(1+1)=1 exactly, so EMA == latest close with no floating-point drift —
    // a deterministic tie, unlike trying to force an exact tie through period=200's arithmetic.
    const candles = [candle(100), candle(100)];
    expect(classifyTrendH1(candles, 1)).toBe('UPTREND');
  });

  it('returns null when there is not enough H1 history for EMA200', () => {
    const candles = buildFlatSeries(50, 100);
    expect(classifyTrendH1(candles, 200)).toBeNull();
  });
});
