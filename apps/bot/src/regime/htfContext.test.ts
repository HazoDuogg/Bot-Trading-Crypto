import { describe, expect, it } from 'vitest';
import { classifyHtfContextCandidate } from './htfContext.js';
import { HTFContext } from './htfSafetyTypes.js';
import type { ComputedMetrics } from './types.js';
import { RegimeConfig } from './config.js';

function metrics(overrides: Partial<ComputedMetrics>): ComputedMetrics {
  return {
    adx1h: 15,
    adxDirection1h: 'FLAT',
    bbWidthPercentile15m: 50,
    atrPercentile5m: 50,
    volumeZScore5m: 0,
    ...overrides,
  };
}

describe('classifyHtfContextCandidate', () => {
  it('returns NEUTRAL when required HTF metrics are undefined', () => {
    expect(classifyHtfContextCandidate(metrics({ adx1h: undefined }))).toBe(HTFContext.NEUTRAL);
    expect(classifyHtfContextCandidate(metrics({ adxDirection1h: undefined }))).toBe(HTFContext.NEUTRAL);
    expect(classifyHtfContextCandidate(metrics({ bbWidthPercentile15m: undefined }))).toBe(HTFContext.NEUTRAL);
  });

  it('returns TREND_UP when adx1h clears TREND_ENTER_ADX.enter and direction is UP', () => {
    const m = metrics({ adx1h: RegimeConfig.TREND_ENTER_ADX.enter, adxDirection1h: 'UP', bbWidthPercentile15m: 50 });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.TREND_UP);
  });

  it('returns TREND_DOWN when adx1h clears TREND_ENTER_ADX.enter and direction is DOWN', () => {
    const m = metrics({ adx1h: RegimeConfig.TREND_ENTER_ADX.enter, adxDirection1h: 'DOWN', bbWidthPercentile15m: 50 });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.TREND_DOWN);
  });

  it('returns RANGE when adx1h is at or below SIDEWAY_ADX_THRESHOLD.enter', () => {
    const m = metrics({ adx1h: RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter, adxDirection1h: 'UP', bbWidthPercentile15m: 50 });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.RANGE);
  });

  it('returns RANGE when bbWidthPercentile15m is at or below COMPRESSION_BBW_PCT_THRESHOLD.enter, even with high adx1h', () => {
    const m = metrics({
      adx1h: RegimeConfig.TREND_ENTER_ADX.enter,
      adxDirection1h: 'UP',
      bbWidthPercentile15m: RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter,
    });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.RANGE);
  });

  it('returns NEUTRAL in the grey zone between RANGE and TREND thresholds', () => {
    const m = metrics({
      adx1h: (RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter + RegimeConfig.TREND_ENTER_ADX.enter) / 2,
      adxDirection1h: 'UP',
      bbWidthPercentile15m: 50,
    });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.NEUTRAL);
  });

  it('returns NEUTRAL when adx1h is trending but direction is FLAT', () => {
    const m = metrics({ adx1h: RegimeConfig.TREND_ENTER_ADX.enter, adxDirection1h: 'FLAT', bbWidthPercentile15m: 50 });
    expect(classifyHtfContextCandidate(m)).toBe(HTFContext.NEUTRAL);
  });

  it('does NOT change because 5m ATR percentile / wick / volume z-score fluctuate — same HTF inputs, wildly different 5m inputs, same output', () => {
    const base = metrics({ adx1h: RegimeConfig.TREND_ENTER_ADX.enter, adxDirection1h: 'UP', bbWidthPercentile15m: 50 });
    const calm = classifyHtfContextCandidate({ ...base, atrPercentile5m: 5, volumeZScore5m: -1, upperSweepCount5m: 0, lowerSweepCount5m: 0 });
    const shocked = classifyHtfContextCandidate({ ...base, atrPercentile5m: 99, volumeZScore5m: 5, upperSweepCount5m: 10, lowerSweepCount5m: 10 });
    expect(calm).toBe(HTFContext.TREND_UP);
    expect(shocked).toBe(HTFContext.TREND_UP);
    expect(calm).toBe(shocked);
  });
});
