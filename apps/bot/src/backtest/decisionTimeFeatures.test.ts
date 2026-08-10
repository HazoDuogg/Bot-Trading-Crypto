import { describe, expect, it } from 'vitest';
import { assertNoFutureCandles, closedCandlesAt, trailingClosedWindow, type ResearchCandle } from './decisionTimeFeatures.js';

const candles: ResearchCandle[] = [0, 300_000, 600_000, 900_000].map(timestamp => ({ timestamp, open: 1, high: 2, low: 0, close: 1, volume: 1 }));

describe('decision-time feature boundaries', () => {
  it('includes only candles closed by the decision boundary', () => {
    expect(closedCandlesAt(candles, 900_000, 300_000).map(c => c.timestamp)).toEqual([0, 300_000, 600_000]);
  });

  it('takes the requested trailing window without future backfill', () => {
    expect(trailingClosedWindow(candles, 900_000, 300_000, 2).map(c => c.timestamp)).toEqual([300_000, 600_000]);
  });

  it('rejects an unclosed candle', () => {
    expect(() => assertNoFutureCandles([candles[3]], 900_000, 300_000)).toThrow(/unclosed/);
  });
});
