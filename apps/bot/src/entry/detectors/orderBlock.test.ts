import { describe, expect, it } from 'vitest';
import { detectOrderBlock } from './orderBlock.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

const config = { fractalN: 2, lookforwardK: 10 };

describe('detectOrderBlock — BULLISH', () => {
  it('confirms the last down-close candle before an up-push that closes above the prior swing high', () => {
    const candles = [
      c(9, 9, 10, 8), // 0
      c(10.5, 10.5, 12, 9), // 1
      c(13, 13, 15, 11), // 2 — swing high (15)
      c(11, 11, 12, 10), // 3
      c(9, 9, 10, 8), // 4
      c(11, 9, 11, 9), // 5 — OB candidate (down)
      c(9, 12, 12.5, 9), // 6 — up
      c(12, 16, 16, 11.5), // 7 — up, close 16 > 15 -> BOS confirmed here
    ];
    const result = detectOrderBlock(candles, 'BULLISH', config);
    expect(result).toEqual({ type: 'BULLISH', high: 11, low: 9, candleIndex: 5, confirmedAtIndex: 7 });
  });

  it('invalidates a candidate whose low gets broken before BOS, and finds no OB if nothing else qualifies', () => {
    const candles = [
      c(9, 9, 10, 8), // 0
      c(10.5, 10.5, 12, 9), // 1
      c(13, 13, 15, 11), // 2 — swing high (15)
      c(11, 11, 12, 10), // 3
      c(9, 9, 10, 8), // 4
      c(11, 9, 11, 9), // 5 — OB candidate (down)
      c(9, 8.5, 9, 7), // 6 — breaks below candle 5's low (9) before any BOS -> invalidated
    ];
    const result = detectOrderBlock(candles, 'BULLISH', config);
    expect(result).toBeNull();
  });

  it('returns null when no reference swing high exists before the candidate', () => {
    const candles = [c(11, 9, 11, 9), c(9, 12, 12.5, 9)];
    expect(detectOrderBlock(candles, 'BULLISH', config)).toBeNull();
  });
});

describe('detectOrderBlock — BEARISH', () => {
  it('mirrors BULLISH: last up-close candle before a down-push that closes below the prior swing low', () => {
    const candles = [
      c(9, 9, 10, 8), // 0
      c(10.5, 10.5, 12, 9), // 1
      c(9, 9, 10, 5), // 2 — swing low (5)
      c(10.5, 10.5, 12, 9), // 3
      c(9, 9, 10, 8), // 4
      c(9, 11, 11, 9), // 5 — OB candidate (up)
      c(11, 8, 11, 7.5), // 6 — down
      c(8, 4, 8.5, 4), // 7 — down, close 4 < 5 -> BOS confirmed here
    ];
    const result = detectOrderBlock(candles, 'BEARISH', config);
    expect(result).toEqual({ type: 'BEARISH', high: 11, low: 9, candleIndex: 5, confirmedAtIndex: 7 });
  });
});
