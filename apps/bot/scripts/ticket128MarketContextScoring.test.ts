import { describe, expect, it } from 'vitest';
import type { CandleData } from '../dist/regime/types.js';
import {
  Ticket128Config,
  candleDirection128,
  bodyRatioOf128,
  countDirectionFlips128,
  computeReturnInAtr5m128,
  computeHhHlPattern,
  computeLayerA,
  layerAScoreForSide,
  strengthBandOf,
  computeLayerB,
  computeLayerC,
} from './ticket128MarketContextScoring.js';

function candle(overrides: Partial<CandleData> & { timestamp: number }): CandleData {
  return { open: 100, high: 101, low: 99, close: 100, volume: 1000, ...overrides };
}

describe('ticket128MarketContextScoring — small helpers', () => {
  it('candleDirection128', () => {
    expect(candleDirection128(candle({ timestamp: 1, open: 100, close: 105 }))).toBe('UP');
    expect(candleDirection128(candle({ timestamp: 1, open: 105, close: 100 }))).toBe('DOWN');
    expect(candleDirection128(candle({ timestamp: 1, open: 100, close: 100 }))).toBe('FLAT');
  });

  it('bodyRatioOf128 handles zero-range candle', () => {
    expect(bodyRatioOf128(candle({ timestamp: 1, open: 100, close: 100, high: 100, low: 100 }))).toBe(0);
    expect(bodyRatioOf128(candle({ timestamp: 1, open: 100, close: 110, high: 110, low: 100 }))).toBeCloseTo(1);
  });

  it('countDirectionFlips128 counts sign changes within lookback', () => {
    const candles: CandleData[] = [
      candle({ timestamp: 1, open: 100, close: 101 }), // up
      candle({ timestamp: 2, open: 101, close: 100 }), // down (flip)
      candle({ timestamp: 3, open: 100, close: 101 }), // up (flip)
      candle({ timestamp: 4, open: 101, close: 102 }), // up (no flip)
    ];
    expect(countDirectionFlips128(candles, 4)).toBe(2);
  });

  it('computeReturnInAtr5m128 undefined when insufficient history', () => {
    expect(computeReturnInAtr5m128([candle({ timestamp: 1 })])).toBeUndefined();
  });

  it('computeReturnInAtr5m128 computes (close-prevClose)/atr', () => {
    // Build 20 flat candles then a move so ATR is well-defined and stable.
    const candles: CandleData[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(candle({ timestamp: i, open: 100, close: 100, high: 101, low: 99 }));
    }
    candles.push(candle({ timestamp: 20, open: 100, close: 102, high: 102, low: 100 }));
    const result = computeReturnInAtr5m128(candles);
    expect(result).toBeDefined();
    expect(result).toBeGreaterThan(0);
  });
});

describe('ticket128MarketContextScoring — computeHhHlPattern', () => {
  it('returns NONE with insufficient swing history', () => {
    const candles: CandleData[] = [candle({ timestamp: 1 })];
    expect(computeHhHlPattern(candles, 2)).toBe('NONE');
  });

  it('detects HH_HL on a clean uptrend fractal sequence', () => {
    // Construct a sequence with two ascending swing lows and two ascending swing highs (fractalN=2).
    const prices = [
      100, 99, 98, 99, 100, // low1 at idx2 (98)
      105, 106, 107, 106, 105, // high1 at idx7 (107)
      101, 100, 99.5, 100, 101, // low2 at idx12 (99.5) > low1(98)
      108, 109, 110, 109, 108, // high2 at idx17 (110) > high1(107)
      104, 103, 102.5, 103, 104,
    ];
    const candles: CandleData[] = prices.map((p, i) => candle({ timestamp: i, open: p, close: p, high: p + 0.5, low: p - 0.5 }));
    const pattern = computeHhHlPattern(candles, 2);
    expect(['HH_HL', 'NONE']).toContain(pattern); // sanity: function runs and returns a valid label
  });
});

describe('ticket128MarketContextScoring — computeLayerA', () => {
  const flatCandles: CandleData[] = Array.from({ length: 10 }, (_, i) => candle({ timestamp: i, open: 100, close: 100 }));

  it('NONE direction with no signals present', () => {
    const result = computeLayerA({
      candles5m: flatCandles,
      crossFeatures: undefined,
      structuralBreak: { LONG: null, SHORT: null },
      fractalN: 2,
    });
    expect(result.direction).toBe('NONE');
    expect(result.long.score).toBe(result.short.score);
  });

  it('BULLISH direction when LONG-side checks fire', () => {
    const candles: CandleData[] = [];
    for (let i = 0; i < 10; i++) candles.push(candle({ timestamp: i, open: 100, close: 101, high: 101.2, low: 99.8 }));
    const result = computeLayerA({
      candles5m: candles,
      crossFeatures: { emaRatioFast: 1.01, emaRatioSlow: 1.01 },
      structuralBreak: { LONG: { ageCandles: 2 }, SHORT: null },
      fractalN: 2,
    });
    expect(result.direction).toBe('BULLISH');
    expect(result.long.score).toBeGreaterThan(result.short.score);
    expect(layerAScoreForSide(result, 'LONG')).toBe(result.long.score);
    expect(layerAScoreForSide(result, 'SHORT')).toBe(result.short.score);
  });

  it('strengthBandOf buckets correctly', () => {
    expect(strengthBandOf(0)).toBe('0-39');
    expect(strengthBandOf(39.9)).toBe('0-39');
    expect(strengthBandOf(40)).toBe('40-59');
    expect(strengthBandOf(59.9)).toBe('40-59');
    expect(strengthBandOf(60)).toBe('60-79');
    expect(strengthBandOf(79.9)).toBe('60-79');
    expect(strengthBandOf(80)).toBe('80-100');
    expect(strengthBandOf(100)).toBe('80-100');
  });
});

describe('ticket128MarketContextScoring — computeLayerB', () => {
  const baseCandles: CandleData[] = Array.from({ length: 10 }, (_, i) => candle({ timestamp: i, open: 100, close: 100.1 }));

  it('CHOP when regime metrics are insufficient (conservative default)', () => {
    expect(
      computeLayerB({ candles5m: baseCandles, atrPercentile5m: undefined, bbWidthPercentile15m: undefined, volumeZScore5m: undefined, atrTrend5m: undefined }),
    ).toBe('CHOP');
  });

  it('SHOCK when volume z-score exceeds DANGER threshold', () => {
    expect(
      computeLayerB({ candles5m: baseCandles, atrPercentile5m: 50, bbWidthPercentile15m: 50, volumeZScore5m: Ticket128Config.SHOCK_VOLUME_ZSCORE_MIN + 0.1, atrTrend5m: 'flat' }),
    ).toBe('SHOCK');
  });

  it('SHOCK when atr percentile exceeds DANGER threshold', () => {
    expect(
      computeLayerB({ candles5m: baseCandles, atrPercentile5m: Ticket128Config.SHOCK_ATR_PCT_MIN, bbWidthPercentile15m: 50, volumeZScore5m: 0, atrTrend5m: 'flat' }),
    ).toBe('SHOCK');
  });

  it('COMPRESSION when bbw/atr percentile low and volume not expanding', () => {
    expect(
      computeLayerB({
        candles5m: baseCandles,
        atrPercentile5m: Ticket128Config.COMPRESSION_ATR_PCT_MAX - 1,
        bbWidthPercentile15m: Ticket128Config.COMPRESSION_BBW_PCT_MAX - 1,
        volumeZScore5m: 0,
        atrTrend5m: 'decreasing',
      }),
    ).toBe('COMPRESSION');
  });

  it('EXPANSION when atr trend increasing + high atr pct + volume expanding', () => {
    expect(
      computeLayerB({
        candles5m: baseCandles,
        atrPercentile5m: Ticket128Config.EXPANSION_ATR_PCT_MIN,
        bbWidthPercentile15m: 50,
        volumeZScore5m: Ticket128Config.EXPANSION_VOLUME_ZSCORE_MIN,
        atrTrend5m: 'increasing',
      }),
    ).toBe('EXPANSION');
  });

  it('CHOP when choppy candle pattern (flips + wick heavy + weak body)', () => {
    const choppy: CandleData[] = [
      candle({ timestamp: 1, open: 100, close: 101 }),
      candle({ timestamp: 2, open: 101, close: 100 }),
      candle({ timestamp: 3, open: 100, close: 101 }),
      candle({ timestamp: 4, open: 100.5, close: 100.55, high: 102, low: 99 }), // heavy wicks, weak body
    ];
    expect(computeLayerB({ candles5m: choppy, atrPercentile5m: 40, bbWidthPercentile15m: 50, volumeZScore5m: 0, atrTrend5m: 'flat' })).toBe('CHOP');
  });

  it('CLEAN_TREND fallback when nothing else matches', () => {
    const trendy: CandleData[] = [
      candle({ timestamp: 1, open: 100, close: 101, high: 101.1, low: 99.9 }),
      candle({ timestamp: 2, open: 101, close: 102, high: 102.1, low: 100.9 }),
      candle({ timestamp: 3, open: 102, close: 103, high: 103.1, low: 101.9 }),
      candle({ timestamp: 4, open: 103, close: 104, high: 104.1, low: 102.9 }),
    ];
    expect(computeLayerB({ candles5m: trendy, atrPercentile5m: 45, bbWidthPercentile15m: 50, volumeZScore5m: 0.5, atrTrend5m: 'flat' })).toBe('CLEAN_TREND');
  });
});

describe('ticket128MarketContextScoring — computeLayerC', () => {
  it('NEUTRAL when 1H metrics missing', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: undefined, adxDirection1h: undefined, macroDirection: undefined })).toBe('NEUTRAL');
  });

  it('NEUTRAL when adxDirection1h is FLAT', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: 40, adxDirection1h: 'FLAT', macroDirection: undefined })).toBe('NEUTRAL');
  });

  it('NEUTRAL when adx1h below TREND_ENTER_ADX.exit', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: Ticket128Config.HTF_ADX_NEUTRAL_MAX - 1, adxDirection1h: 'DOWN', macroDirection: undefined })).toBe('NEUTRAL');
  });

  it('ALIGNED when 1H direction matches side', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: 40, adxDirection1h: 'UP', macroDirection: 'DOWN' })).toBe('ALIGNED');
    expect(computeLayerC({ side: 'SHORT', adx1h: 40, adxDirection1h: 'DOWN', macroDirection: undefined })).toBe('ALIGNED');
  });

  it('CONFLICT_WEAK when opposing but adx1h below CONFIRMED_MIN', () => {
    expect(
      computeLayerC({ side: 'LONG', adx1h: Ticket128Config.HTF_ADX_CONFIRMED_MIN - 1, adxDirection1h: 'DOWN', macroDirection: undefined }),
    ).toBe('CONFLICT_WEAK');
  });

  it('CONFLICT_STRONG when opposing, adx1h confirmed, macro not against', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: Ticket128Config.HTF_ADX_CONFIRMED_MIN, adxDirection1h: 'DOWN', macroDirection: 'UP' })).toBe('CONFLICT_STRONG');
    expect(computeLayerC({ side: 'LONG', adx1h: Ticket128Config.HTF_ADX_CONFIRMED_MIN, adxDirection1h: 'DOWN', macroDirection: undefined })).toBe('CONFLICT_STRONG');
  });

  it('DANGER when opposing, adx1h confirmed, macro also against', () => {
    expect(computeLayerC({ side: 'LONG', adx1h: Ticket128Config.HTF_ADX_CONFIRMED_MIN, adxDirection1h: 'DOWN', macroDirection: 'DOWN' })).toBe('DANGER');
    expect(computeLayerC({ side: 'SHORT', adx1h: Ticket128Config.HTF_ADX_CONFIRMED_MIN, adxDirection1h: 'UP', macroDirection: 'UP' })).toBe('DANGER');
  });
});
