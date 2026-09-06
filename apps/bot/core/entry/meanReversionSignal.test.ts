import { describe, expect, it } from 'vitest';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import {
  ZSCORE_ENTRY_THRESHOLD,
  ZSCORE_LOOKBACK,
  classifyMeanReversionSignal,
  computeMeanReversionSignals,
  computeZScore,
} from './meanReversionSignal.js';

const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;

function candle(openTime: number, price: number): Candle {
  return { openTime, open: price, high: price, low: price, close: price, volume: 1 };
}

describe('classifyMeanReversionSignal', () => {
  it('signals LONG at exactly -2 in a RANGING regime (inclusive boundary)', () => {
    expect(classifyMeanReversionSignal('RANGING', -ZSCORE_ENTRY_THRESHOLD)).toBe('LONG');
  });

  it('signals SHORT at exactly +2 in a RANGING regime (inclusive boundary)', () => {
    expect(classifyMeanReversionSignal('RANGING', ZSCORE_ENTRY_THRESHOLD)).toBe('SHORT');
  });

  it('signals NONE just inside +-2', () => {
    expect(classifyMeanReversionSignal('RANGING', ZSCORE_ENTRY_THRESHOLD - 0.0001)).toBe('NONE');
    expect(classifyMeanReversionSignal('RANGING', -(ZSCORE_ENTRY_THRESHOLD - 0.0001))).toBe('NONE');
  });

  it('never signals in a TRENDING regime, even with an extreme z-score', () => {
    expect(classifyMeanReversionSignal('TRENDING', -10)).toBe('NONE');
    expect(classifyMeanReversionSignal('TRENDING', 10)).toBe('NONE');
  });

  it('signals NONE when regime or z-score is unavailable', () => {
    expect(classifyMeanReversionSignal(null, -10)).toBe('NONE');
    expect(classifyMeanReversionSignal('RANGING', null)).toBe('NONE');
  });
});

describe('computeZScore', () => {
  it('returns null for the first ZSCORE_LOOKBACK candles (insufficient warmup)', () => {
    const closes = Array.from({ length: ZSCORE_LOOKBACK }, () => 100);
    for (let i = 0; i < ZSCORE_LOOKBACK; i += 1) {
      expect(computeZScore(closes, i)).toBeNull();
    }
  });

  it('guards a zero-variance window to null instead of Infinity/NaN', () => {
    const closes = [...Array.from({ length: ZSCORE_LOOKBACK }, () => 100), 110];
    expect(computeZScore(closes, ZSCORE_LOOKBACK)).toBeNull();
  });

  it('computes a real z-score against a varying window', () => {
    const window = [98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102];
    const closes = [...window, 110];
    const z = computeZScore(closes, ZSCORE_LOOKBACK)!;
    expect(z).toBeGreaterThan(0);
    expect(Number.isFinite(z)).toBe(true);
  });
});

describe('computeMeanReversionSignals', () => {
  it('produces NONE for the first ZSCORE_LOOKBACK 5m candles regardless of regime', () => {
    // Flat 15m series (RANGING) so any signal seen would have to come from the z-score warmup gap.
    const m15Candles = Array.from({ length: 40 }, (_, i) => candle(i * M15_MS, 100));
    const m5Candles = Array.from({ length: ZSCORE_LOOKBACK + 5 }, (_, i) => candle(i * M5_MS, 100 + (i % 3)));
    const results = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);
    for (let i = 0; i < ZSCORE_LOOKBACK; i += 1) {
      expect(results[i].signal).toBe('NONE');
      expect(results[i].zScore).toBeNull();
    }
  });

  it('never emits a signal while the mapped 15m regime is TRENDING', () => {
    const m15Candles = Array.from({ length: 40 }, (_, i) => candle(i * M15_MS, 100 + i)); // strong uptrend
    // Must span far enough (40 * 15m = 10h) for the 15m series' ADX to actually become valid
    // (needs ~28 M15 candles of warmup) before any 5m candle can pick up a non-null regime.
    const m5Candles = Array.from({ length: 130 }, (_, i) => {
      const wobble = i % 2 === 0 ? -20 : 20; // would trip the z-score threshold if regime were RANGING
      return candle(i * M5_MS, 100 + wobble);
    });
    const results = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);
    // Once enough 15m history has closed to classify a regime, it must be TRENDING here.
    const classified = results.filter((r) => r.regime !== null);
    expect(classified.length).toBeGreaterThan(0);
    for (const r of classified) {
      expect(r.regime).toBe('TRENDING');
      expect(r.signal).toBe('NONE');
    }
  });
});
