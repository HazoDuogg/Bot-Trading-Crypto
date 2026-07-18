import type { CandleData } from '../../regime/types.js';
import type { Direction, FairValueGap } from '../types.js';

/**
 * B.2 — 3-candle pattern, returns the most recent matching gap.
 * BULLISH: candle[i-2].high < candle[i].low (gap = [candle[i-2].high, candle[i].low]).
 * BEARISH: candle[i-2].low > candle[i].high (gap = [candle[i].high, candle[i-2].low]).
 */
export function detectFairValueGap(candles: CandleData[], direction: Direction): FairValueGap | null {
  for (let i = candles.length - 1; i >= 2; i--) {
    const first = candles[i - 2];
    const third = candles[i];

    if (direction === 'BULLISH' && first.high < third.low) {
      return { type: 'BULLISH', top: third.low, bottom: first.high, candleIndex: i };
    }
    if (direction === 'BEARISH' && first.low > third.high) {
      return { type: 'BEARISH', top: first.low, bottom: third.high, candleIndex: i };
    }
  }
  return null;
}
