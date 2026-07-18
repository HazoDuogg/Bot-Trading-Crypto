import { describe, expect, it } from 'vitest';
import { detectMarketStructureShift } from './marketStructureShift.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

const config = { fractalN: 2 };

describe('detectMarketStructureShift — BULLISH (higher-low, reference high BETWEEN the two lows)', () => {
  const candles: CandleData[] = [
    c(9.5, 9.5, 10, 9), // 0
    c(9.25, 9.25, 10, 8.5), // 1
    c(7.5, 7.5, 9.5, 6), // 2 — swing low #1 (6)
    c(9.25, 9.25, 10, 8.5), // 3
    c(9.5, 9.5, 10, 9), // 4
    c(10.5, 10.5, 12, 9), // 5 — swing high BETWEEN the two lows (12)
    c(9.25, 9.25, 10, 8.5), // 6
    c(9.5, 9.5, 10, 9), // 7
    c(8.75, 8.75, 9.5, 8), // 8 — swing low #2 (8) — higher-low vs index 2
    c(9.25, 9.25, 10, 8.5), // 9
    c(9.5, 9.5, 10, 9), // 10
    c(12.5, 13, 13.2, 12.3), // 11 — close 13 > 12 -> MSS confirmed here
  ];

  it('confirms MSS as soon as price breaks the high that already existed between the two lows', () => {
    expect(detectMarketStructureShift(candles, 'BULLISH', config)).toBe(11);
  });

  it('returns null if the confirming break has not happened yet in the given window', () => {
    expect(detectMarketStructureShift(candles.slice(0, 11), 'BULLISH', config)).toBeNull();
  });

  it('skips a higher-low pair with no reference high between them, and confirms on a later pair', () => {
    const withSkippedPair: CandleData[] = [
      c(9.5, 9.5, 10, 9), // 0
      c(9.25, 9.25, 10, 8.5), // 1
      c(7.5, 7.5, 9.5, 6), // 2 — low A (6)
      c(9.25, 9.25, 10, 8.5), // 3 — too close to A/B for any fractal to form between them
      c(9.5, 9.5, 10, 9), // 4
      c(8, 8, 9.5, 6.5), // 5 — low B (6.5, higher-low vs A) — no reference high exists between 2 and 5
      c(9.25, 9.25, 10, 8.5), // 6
      c(9.5, 9.5, 10, 9), // 7
      c(10.5, 10.5, 12, 9), // 8 — swing high BETWEEN B (index5) and the next low
      c(9.25, 9.25, 10, 8.5), // 9
      c(9.5, 9.5, 10, 9), // 10
      c(8.5, 8.5, 9.5, 8), // 11 — low D (8, higher-low vs B) — reference high is index 8 (12)
      c(9.25, 9.25, 10, 8.5), // 12
      c(9.5, 9.5, 10, 9), // 13
      c(12.5, 13, 13.2, 12.3), // 14 — close 13 > 12 -> MSS confirmed using the B/D pair's reference
    ];
    expect(detectMarketStructureShift(withSkippedPair, 'BULLISH', config)).toBe(14);
  });
});

describe('detectMarketStructureShift — BEARISH (lower-high, reference low BETWEEN the two highs)', () => {
  it('mirrors BULLISH: confirms as soon as price breaks the low that already existed between the two highs', () => {
    const candles: CandleData[] = [
      c(9.5, 9.5, 10, 9), // 0
      c(9.75, 9.75, 10.5, 9), // 1
      c(11.5, 11.5, 13, 10), // 2 — swing high #1 (13)
      c(9.75, 9.75, 10.5, 9), // 3
      c(9.5, 9.5, 10, 9), // 4
      c(8, 8, 10, 6), // 5 — swing low BETWEEN the two highs (6)
      c(9.75, 9.75, 10.5, 9), // 6
      c(9.5, 9.5, 10, 9), // 7
      c(10.5, 10.5, 12, 9), // 8 — swing high #2 (12) — lower-high vs index 2
      c(9.75, 9.75, 10.5, 9), // 9
      c(9.5, 9.5, 10, 9), // 10
      c(6.5, 5, 6.8, 4.8), // 11 — close 5 < 6 -> MSS confirmed here
    ];
    expect(detectMarketStructureShift(candles, 'BEARISH', config)).toBe(11);
  });
});
