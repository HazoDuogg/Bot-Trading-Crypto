import { describe, it, expect } from 'vitest';
import { detectBos } from './bos.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

// Oscillating baseline: forms real swing highs/lows and gives ATR(14) enough history.
function buildBaseline(n: number): { candles: Candle[]; lastPrice: number } {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const delta = i % 6 < 3 ? 1 : -1;
    price += delta;
    candles.push(candle(price - 0.5, price + 1, price - 1, price));
  }
  return { candles, lastPrice: price };
}

const config = { swingPivotWidth: 2, confirmationCandles: 2, minBreakoutAtrMultiplier: 0.2, atrPeriod: 14, maxSwingAgeCandles: 25 };

describe('detectBos', () => {
  it('detects a bullish BOS: clean break above swing high, held for confirmation candles', () => {
    const { candles, lastPrice: p } = buildBaseline(20);
    const breakCandle = candle(p, p + 5, p - 0.5, p + 4.5);
    const confirm1 = candle(p + 4.5, p + 6, p + 3, p + 5);
    const confirm2 = candle(p + 5, p + 6.5, p + 4, p + 5.5);
    const result = detectBos([...candles, breakCandle, confirm1, confirm2], config);
    expect(result.isBos).toBe(true);
    expect(result.direction).toBe('LONG');
  });

  it('does not confirm BOS when price reclaims the broken level afterward', () => {
    const { candles, lastPrice: p } = buildBaseline(20);
    const breakCandle = candle(p, p + 5, p - 0.5, p + 4.5);
    const reclaim = candle(p + 4.5, p + 4.6, p, p + 0.5); // falls back below the broken swing high
    const confirm2 = candle(p + 0.5, p + 1, p - 1, p);
    const result = detectBos([...candles, breakCandle, reclaim, confirm2], config);
    expect(result.isBos).toBe(false);
  });

  it('does not flag BOS when the breakout is too small relative to ATR', () => {
    const { candles, lastPrice: p } = buildBaseline(20);
    const tinyBreak = candle(p, p + 0.6, p - 0.5, p + 0.5); // barely above range, well under 0.2*ATR
    const confirm1 = candle(p + 0.5, p + 0.7, p + 0.3, p + 0.5);
    const confirm2 = candle(p + 0.5, p + 0.7, p + 0.3, p + 0.5);
    const result = detectBos([...candles, tinyBreak, confirm1, confirm2], config);
    expect(result.isBos).toBe(false);
  });

  it('returns false with insufficient candle history', () => {
    const candles = [candle(100, 101, 99, 100), candle(100, 101, 99, 100)];
    expect(detectBos(candles, config).isBos).toBe(false);
  });

  it('ignores a swing point older than maxSwingAgeCandles (stale structure)', () => {
    const { candles, lastPrice: p } = buildBaseline(20);
    // Monotonic micro-drift filler: no interior swing points form (same trick as the uptrend fixture), just ages out the old ones.
    const flatFiller: Candle[] = [];
    let fp = p;
    for (let i = 0; i < 30; i++) {
      fp += 0.01;
      flatFiller.push(candle(fp - 0.05, fp + 0.1, fp - 0.1, fp));
    }
    const breakCandle = candle(fp, fp + 5, fp - 0.5, fp + 4.5);
    const confirm1 = candle(fp + 4.5, fp + 6, fp + 3, fp + 5);
    const confirm2 = candle(fp + 5, fp + 6.5, fp + 4, fp + 5.5);
    const tightConfig = { ...config, maxSwingAgeCandles: 10 }; // baseline swings are now ~30 candles old, older than this
    const result = detectBos([...candles, ...flatFiller, breakCandle, confirm1, confirm2], tightConfig);
    expect(result.isBos).toBe(false);
  });
});
