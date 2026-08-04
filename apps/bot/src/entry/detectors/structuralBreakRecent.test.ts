import { describe, expect, it } from 'vitest';
import { detectRecentStructuralBreak } from './structuralBreakRecent.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number, timestamp = 0): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

const config = { fractalN: 2 };

// Same fixture shape as marketStructureShift.test.ts's BULLISH case: confirmation lands at index 11
// (last candle of a 12-candle window) — recent by construction.
const bullishConfirmedAtEnd: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.25, 9.25, 10, 8.5),
  c(7.5, 7.5, 9.5, 6), // swing low #1 (6)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // swing high between the two lows (12) — reference level
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(8.75, 8.75, 9.5, 8), // swing low #2 (8), higher-low
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(12.5, 13, 13.2, 12.3), // index 11 — close 13 > 12 -> MSS confirmed here
];

describe('detectRecentStructuralBreak', () => {
  it('returns the sided, level-anchored break when the confirmation is at the end of the window (age=0)', () => {
    const result = detectRecentStructuralBreak(bullishConfirmedAtEnd, 'BULLISH', config);
    expect(result).not.toBeNull();
    expect(result?.side).toBe('LONG');
    expect(result?.index).toBe(11);
    expect(result?.ageCandles).toBe(0);
    expect(result?.levelPrice).toBe(12);
  });

  it('returns BEARISH -> SHORT side', () => {
    const bearish: CandleData[] = [
      c(9.5, 9.5, 10, 9),
      c(9.75, 9.75, 10.5, 9),
      c(11.5, 11.5, 13, 10), // swing high #1 (13)
      c(9.75, 9.75, 10.5, 9),
      c(9.5, 9.5, 10, 9),
      c(8, 8, 10, 6), // swing low between the two highs (6) — reference level
      c(9.75, 9.75, 10.5, 9),
      c(9.5, 9.5, 10, 9),
      c(10.5, 10.5, 12, 9), // lower-high vs index 2
      c(9.75, 9.75, 10.5, 9),
      c(9.5, 9.5, 10, 9),
      c(6.5, 5, 6.8, 4.8), // index 11 — close 5 < 6 -> MSS confirmed here
    ];
    const result = detectRecentStructuralBreak(bearish, 'BEARISH', config);
    expect(result?.side).toBe('SHORT');
    expect(result?.levelPrice).toBe(6);
  });

  it('returns null (stale) when the confirmation is older than the tolerance, even though detectMarketStructureShift would still find it', () => {
    // Pad extra quiet candles after the confirmation so its age exceeds a small tolerance.
    const padded = [...bullishConfirmedAtEnd, c(13, 13, 13.1, 12.9), c(13, 13, 13.1, 12.9), c(13, 13, 13.1, 12.9)];
    // Confirmation is still at index 11; window is now 15 long -> age = 15-1-11 = 3.
    const resultToleranceTooSmall = detectRecentStructuralBreak(padded, 'BULLISH', config, 2);
    expect(resultToleranceTooSmall).toBeNull();
    const resultToleranceEnough = detectRecentStructuralBreak(padded, 'BULLISH', config, 5);
    expect(resultToleranceEnough).not.toBeNull();
    expect(resultToleranceEnough?.ageCandles).toBe(3);
  });

  it('returns null when there is no confirmation at all in the window', () => {
    const noConfirmation = bullishConfirmedAtEnd.slice(0, 10);
    expect(detectRecentStructuralBreak(noConfirmation, 'BULLISH', config)).toBeNull();
  });

  it('default tolerance (RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES=20) accepts a break within 20 candles of the end', () => {
    const result = detectRecentStructuralBreak(bullishConfirmedAtEnd, 'BULLISH', config);
    expect(result).not.toBeNull();
  });
});
