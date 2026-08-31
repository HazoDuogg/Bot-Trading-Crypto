import { describe, expect, it } from 'vitest';
import { detectM5Breakout } from './m5Breakout.js';
import type { OpeningRangeResult } from './openingRange.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;
const locked: OpeningRangeResult = {
  state: 'OR_LOCKED',
  tradingDay: '2026-07-15',
  range: { high: 110, low: 90 },
};

function m5(startIso: string, high: number, low: number, close: number): CasperCandle {
  const startTimeMs = Date.parse(startIso);
  return {
    startTimeMs,
    endTimeMs: startTimeMs + 5 * minute,
    open: 100,
    high,
    low,
    close,
  };
}

describe('detectM5Breakout', () => {
  it('confirms a bullish breakout only when the closed M5 close is above OR high', () => {
    const candle = m5('2026-07-15T13:45:00Z', 113, 99, 111);
    const result = detectM5Breakout({
      nowMs: candle.endTimeMs,
      candle,
      openingRange: locked,
    });

    expect(result).toEqual({
      state: 'BULLISH_BREAKOUT',
      tradingDay: '2026-07-15',
      signal: 'BULLISH',
      rejection: null,
    });
  });

  it('confirms a bearish breakout only when the closed M5 close is below OR low', () => {
    const candle = m5('2026-07-15T14:00:00Z', 101, 87, 89);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({
      state: 'BEARISH_BREAKOUT',
      signal: 'BEARISH',
      rejection: null,
    });
  });

  it('rejects a bullish wick penetration when close remains at or below OR high', () => {
    const candle = m5('2026-07-15T14:00:00Z', 113, 99, 109);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({
      state: 'OR_LOCKED',
      signal: null,
      rejection: 'BULLISH_WICK_ONLY',
    });
  });

  it('rejects a bearish wick penetration when close remains at or above OR low', () => {
    const candle = m5('2026-07-15T14:00:00Z', 101, 87, 91);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({
      state: 'OR_LOCKED',
      signal: null,
      rejection: 'BEARISH_WICK_ONLY',
    });
  });

  it('does not create a breakout from an M5 candle before OR lock', () => {
    const candle = m5('2026-07-15T13:35:00Z', 113, 99, 111);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({ state: 'OR_BUILDING', signal: null });
  });

  it('does not create a breakout from an M5 candle closing at 12:00 New York', () => {
    const candle = m5('2026-07-15T15:55:00Z', 113, 99, 111);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({ state: 'WINDOW_CLOSED', signal: null });
  });

  it('does not create a delayed setup after 12:00 from an earlier closed candle', () => {
    const candle = m5('2026-07-15T15:45:00Z', 113, 99, 111);
    const result = detectM5Breakout({
      nowMs: Date.parse('2026-07-15T16:00:00Z'),
      candle,
      openingRange: locked,
    });

    expect(result).toMatchObject({ state: 'WINDOW_CLOSED', signal: null });
  });

  it('does not inspect an M5 candle that has not closed yet', () => {
    const candle = m5('2026-07-15T14:00:00Z', 113, 99, 111);
    const result = detectM5Breakout({
      nowMs: candle.endTimeMs - 1,
      candle,
      openingRange: locked,
    });

    expect(result).toMatchObject({ state: 'INVALID_DATA', signal: null });
  });

  it('rejects an M5 candle that is not aligned to a New York five-minute boundary', () => {
    const candle = m5('2026-07-15T13:47:00Z', 113, 99, 111);
    const result = detectM5Breakout({ nowMs: candle.endTimeMs, candle, openingRange: locked });

    expect(result).toMatchObject({ state: 'INVALID_DATA', signal: null });
  });

  it('does not create a breakout before an opening range is locked', () => {
    const candle = m5('2026-07-15T14:00:00Z', 113, 99, 111);
    const result = detectM5Breakout({
      nowMs: candle.endTimeMs,
      candle,
      openingRange: { state: 'INVALID_DATA', tradingDay: '2026-07-15' },
    });

    expect(result).toMatchObject({ state: 'INVALID_DATA', signal: null });
  });
});
