import { describe, expect, it } from 'vitest';
import { detectFairValueGap } from './fairValueGap.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

describe('detectFairValueGap', () => {
  it('finds a BULLISH gap: candle[i-2].high < candle[i].low', () => {
    const candles = [c(10, 11, 11, 9), c(11, 13, 14, 11), c(14, 16, 17, 13.5)];
    // i=2: candles[0].high=11 < candles[2].low=13.5 -> gap [11, 13.5]
    const result = detectFairValueGap(candles, 'BULLISH');
    expect(result).toEqual({ type: 'BULLISH', top: 13.5, bottom: 11, candleIndex: 2 });
  });

  it('finds a BEARISH gap: candle[i-2].low > candle[i].high', () => {
    const candles = [c(11, 10, 12, 9), c(10, 8, 10, 7), c(7, 5, 6.5, 4)];
    // i=2: candles[0].low=9 > candles[2].high=6.5 -> gap [6.5, 9]
    const result = detectFairValueGap(candles, 'BEARISH');
    expect(result).toEqual({ type: 'BEARISH', top: 9, bottom: 6.5, candleIndex: 2 });
  });

  it('returns null when no 3-candle window has a gap', () => {
    const candles = [c(10, 11, 11, 9), c(11, 12, 12.5, 10.5), c(12, 13, 13.5, 10.8)]; // candles[2].low(10.8) < candles[0].high(11), ranges overlap
    expect(detectFairValueGap(candles, 'BULLISH')).toBeNull();
  });

  it('returns the most recent matching gap when multiple exist', () => {
    const candles = [
      c(10, 11, 11, 9),
      c(11, 13, 14, 11),
      c(14, 16, 17, 13.5), // FVG #1 at index 2
      c(16, 17, 17.5, 15.5),
      c(17, 19, 20, 18.5), // FVG #2 at index 4 (candles[2].high=17 < candles[4].low=18.5)
    ];
    const result = detectFairValueGap(candles, 'BULLISH');
    expect(result?.candleIndex).toBe(4);
  });
});
