import { describe, expect, it } from 'vitest';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { ADX_TRENDING_THRESHOLD, classifyRegime, computeAdxSeries } from './regimeFilter.js';

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

describe('classifyRegime', () => {
  it('classifies exactly the threshold as TRENDING (inclusive boundary)', () => {
    expect(classifyRegime(ADX_TRENDING_THRESHOLD)).toBe('TRENDING');
  });

  it('classifies just below the threshold as RANGING', () => {
    expect(classifyRegime(ADX_TRENDING_THRESHOLD - 0.0001)).toBe('RANGING');
  });

  it('classifies just above the threshold as TRENDING', () => {
    expect(classifyRegime(ADX_TRENDING_THRESHOLD + 0.0001)).toBe('TRENDING');
  });
});

describe('computeAdxSeries', () => {
  it('returns null before enough warmup history exists', () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i * 900_000, 100, 101, 99, 100));
    const series = computeAdxSeries(candles);
    expect(series.every((v) => v === null)).toBe(true);
  });

  it('reports a high ADX for a strongly, consistently trending series', () => {
    // Strictly rising highs/lows every candle -> maximal, one-directional +DM, near-zero -DM.
    const candles = Array.from({ length: 60 }, (_, i) =>
      candle(i * 900_000, 100 + i, 101 + i, 99 + i, 100.5 + i),
    );
    const series = computeAdxSeries(candles);
    const lastAdx = series[series.length - 1];
    expect(lastAdx).not.toBeNull();
    expect(lastAdx!).toBeGreaterThan(ADX_TRENDING_THRESHOLD);
  });

  it('reports a low ADX for a symmetric zigzag (equal up/down moves, no net trend)', () => {
    // Both high and low shift together each candle, alternating +1/-1 — genuinely balanced
    // directional movement (not the earlier flawed fixture, which left `low` constant and so
    // produced only one-sided +DM, an artificial trend rather than a real oscillation).
    let level = 100;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i += 1) {
      level += i % 2 === 0 ? 1 : -1;
      candles.push(candle(i * 900_000, level, level + 0.5, level - 0.5, level));
    }
    const series = computeAdxSeries(candles);
    const lastAdx = series[series.length - 1];
    expect(lastAdx).not.toBeNull();
    expect(lastAdx!).toBeLessThan(ADX_TRENDING_THRESHOLD);
  });
});
