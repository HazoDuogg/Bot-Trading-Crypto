import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  evaluateRejectionCandle,
  REJECTION_CANDLE_V1_MIN_CLOSE_BIAS,
  REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO,
} from './rejectionCandle.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 1 };
}

describe('evaluateRejectionCandle', () => {
  it('passes a BULL counter-test candle with a long lower wick and a high close', () => {
    // range=10, lower wick=6 (bodyLow=99->low=93), closeBias=(98-93)/10=0.5... adjust to clear threshold
    const bull = candle(96, 99, 90, 98);
    // range=9, bodyLow=96, oppositeWick=96-90=6 -> ratio=0.667; closeBias=(98-90)/9=0.889
    const result = evaluateRejectionCandle(bull, 'BULL');
    expect(result.oppositeWickRatio).toBeCloseTo(6 / 9);
    expect(result.closeBias).toBeCloseTo(8 / 9);
    expect(result.oppositeWickRatio).toBeGreaterThanOrEqual(REJECTION_CANDLE_V1_MIN_OPPOSITE_WICK_RATIO);
    expect(result.closeBias).toBeGreaterThanOrEqual(REJECTION_CANDLE_V1_MIN_CLOSE_BIAS);
    expect(result.passes).toBe(true);
  });

  it('rejects a BULL counter-test candle with a small lower wick and a low close', () => {
    // range=10, bodyLow=95 (open 95, close 96), oppositeWick=95-90=5 -> ratio=0.5 (below 0 threshold ok)
    // but close near bottom of range: closeBias=(96-90)/10=0.6, below the 0.5926 threshold when combined with weak wick
    const weak = candle(95, 100, 90, 91);
    // range=10, bodyLow=91 (open95 close91 -> bodyLow=91), oppositeWick=91-90=1 -> ratio=0.1
    const result = evaluateRejectionCandle(weak, 'BULL');
    expect(result.oppositeWickRatio).toBeCloseTo(0.1);
    expect(result.passes).toBe(false);
  });

  it('mirrors the metrics for BEAR using the upper wick and a low close', () => {
    const bear = candle(94, 100, 91, 92);
    // range=9, bodyHigh=94, oppositeWick=100-94=6 -> ratio=6/9=0.667; closeBias=(100-92)/9=0.889
    const result = evaluateRejectionCandle(bear, 'BEAR');
    expect(result.oppositeWickRatio).toBeCloseTo(6 / 9);
    expect(result.closeBias).toBeCloseTo(8 / 9);
    expect(result.passes).toBe(true);
  });

  it('never passes a zero-range candle', () => {
    const flat = candle(100, 100, 100, 100);
    const result = evaluateRejectionCandle(flat, 'BULL');
    expect(result).toEqual({ passes: false, oppositeWickRatio: 0, closeBias: 0 });
  });
});
