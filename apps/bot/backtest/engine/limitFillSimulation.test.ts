import { describe, expect, it } from 'vitest';
import type { Candle } from './noTradeZone/types.js';
import { simulateLimitFill } from './limitFillSimulation.js';

function candle(openTime: number, low: number, high: number): Candle {
  return { openTime, open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 1 };
}

describe('simulateLimitFill', () => {
  it('does not fill on an exact touch that does not penetrate N ticks (BULL)', () => {
    // low touches exactly at limitPrice: penetration = 0, threshold = 2*1 = 2 -> not filled.
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BULL',
      tickSize: 1,
      n: 2,
      m1Candles: [candle(0, 100, 105)],
    });
    expect(result).toEqual({ filled: false, filledAtIndex: null, filledAtTimestamp: null, fillPrice: null });
  });

  it('fills at the candle that first penetrates, and a later retreat does not undo it (BULL)', () => {
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BULL',
      tickSize: 1,
      n: 2,
      m1Candles: [
        candle(0, 97, 105), // penetration = 100-97=3 >= 2 -> fills here
        candle(60_000, 103, 106), // retreats well above limitPrice afterward; must not un-fill
      ],
    });
    expect(result).toEqual({ filled: true, filledAtIndex: 0, filledAtTimestamp: 0, fillPrice: 100 });
  });

  it('fills clearly on the very first candle (BEAR)', () => {
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BEAR',
      tickSize: 1,
      n: 1,
      m1Candles: [candle(0, 95, 103)], // penetration = 103-100=3 >= 1 -> fills
    });
    expect(result).toEqual({ filled: true, filledAtIndex: 0, filledAtTimestamp: 0, fillPrice: 100 });
  });

  it('keeps waiting (no fill, no cancel) through repeated sub-threshold touches, then fills once a later candle crosses', () => {
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BULL',
      tickSize: 1,
      n: 2,
      m1Candles: [
        candle(0, 100, 105), // penetration=0 -> touch only, keep waiting
        candle(60_000, 99, 104), // penetration=1 < 2 -> still just a touch, keep waiting
        candle(120_000, 97, 103), // penetration=3 >= 2 -> fills here
      ],
    });
    expect(result).toEqual({ filled: true, filledAtIndex: 2, filledAtTimestamp: 120_000, fillPrice: 100 });
  });

  it('n=0 fills on any touch (penetration exactly 0 already meets the threshold)', () => {
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BULL',
      tickSize: 1,
      n: 0,
      m1Candles: [candle(0, 100, 105)],
    });
    expect(result).toEqual({ filled: true, filledAtIndex: 0, filledAtTimestamp: 0, fillPrice: 100 });
  });

  it('never fills if price never reaches the limit', () => {
    const result = simulateLimitFill({
      limitPrice: 100,
      direction: 'BULL',
      tickSize: 1,
      n: 1,
      m1Candles: [candle(0, 101, 110), candle(60_000, 102, 112)],
    });
    expect(result).toEqual({ filled: false, filledAtIndex: null, filledAtTimestamp: null, fillPrice: null });
  });
});
