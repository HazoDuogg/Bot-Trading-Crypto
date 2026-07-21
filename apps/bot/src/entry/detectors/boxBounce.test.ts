import { describe, expect, it } from 'vitest';
import { detectBoxBounce } from './boxBounce.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

// Same box15m fixture as boxBreakout.test.ts — box = [90, 110], boxRange = 20.
const box15m: CandleData[] = [c(100, 101, 105, 95), c(101, 103, 108, 92), c(103, 100, 110, 90), c(100, 102, 107, 93), c(102, 101, 106, 91)];

const boxLookbackM = 5;
const edgeZonePercent = 0.15; // lowerEdgeThreshold = 90 + 3 = 93, upperEdgeThreshold = 110 - 3 = 107
const wickRatioThreshold = 0.3;

describe('detectBoxBounce', () => {
  it('confirms LONG when the candle wicks into the bottom edge zone and rejects hard enough', () => {
    const candles5m = [c(95, 96, 97, 92)]; // low=92 <= 93; lowerWickRatio=(95-92)/5=0.6 > 0.3
    const result = detectBoxBounce(box15m, candles5m, boxLookbackM, edgeZonePercent, wickRatioThreshold);
    expect(result).toEqual({ side: 'LONG', boxMidpoint: 100, candleIndex: 0 });
  });

  it('confirms SHORT mirror when the candle wicks into the top edge zone and rejects hard enough', () => {
    const candles5m = [c(105, 104, 108, 103)]; // high=108 >= 107; upperWickRatio=(108-105)/5=0.6 > 0.3
    const result = detectBoxBounce(box15m, candles5m, boxLookbackM, edgeZonePercent, wickRatioThreshold);
    expect(result).toEqual({ side: 'SHORT', boxMidpoint: 100, candleIndex: 0 });
  });

  it('returns null when the candle sits in the middle of the box (not near either edge)', () => {
    const candles5m = [c(99, 100, 101, 99)]; // low=99 > 93, high=101 < 107 — neither edge zone
    expect(detectBoxBounce(box15m, candles5m, boxLookbackM, edgeZonePercent, wickRatioThreshold)).toBeNull();
  });

  it('returns null when near the edge but the wick ratio does not clear the threshold', () => {
    const candles5m = [c(92.2, 92.5, 93, 92)]; // low=92 <= 93 (in edge zone), but lowerWickRatio=(92.2-92)/1=0.2 <= 0.3
    expect(detectBoxBounce(box15m, candles5m, boxLookbackM, edgeZonePercent, wickRatioThreshold)).toBeNull();
  });

  it('returns null if there is not enough 15m history for the box lookback', () => {
    const candles5m = [c(95, 96, 97, 92)];
    expect(detectBoxBounce(box15m.slice(0, 3), candles5m, boxLookbackM, edgeZonePercent, wickRatioThreshold)).toBeNull();
  });
});
