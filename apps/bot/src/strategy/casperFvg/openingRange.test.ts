import { describe, expect, it } from 'vitest';
import { CasperOpeningRangeSession } from './openingRange.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;

function m15(startIso: string, high = 110, low = 90): CasperCandle {
  const startTimeMs = Date.parse(startIso);
  return {
    startTimeMs,
    endTimeMs: startTimeMs + 15 * minute,
    open: 100,
    high,
    low,
    close: 101,
  };
}

describe('CasperOpeningRangeSession', () => {
  it('locks the exact 09:30-09:45 New York M15 candle', () => {
    const session = new CasperOpeningRangeSession();
    const result = session.evaluate(Date.parse('2026-07-15T13:45:00Z'), [
      m15('2026-07-15T13:15:00Z', 130, 80),
      m15('2026-07-15T13:30:00Z', 112, 94),
      m15('2026-07-15T13:45:00Z', 125, 85),
    ]);

    expect(result).toEqual({
      state: 'OR_LOCKED',
      tradingDay: '2026-07-15',
      range: { high: 112, low: 94 },
    });
  });

  it('uses America/New_York DST in summer and winter', () => {
    const summer = new CasperOpeningRangeSession().evaluate(
      Date.parse('2026-07-15T13:45:00Z'),
      [m15('2026-07-15T13:30:00Z', 111, 91)],
    );
    const winter = new CasperOpeningRangeSession().evaluate(
      Date.parse('2026-01-15T14:45:00Z'),
      [m15('2026-01-15T14:30:00Z', 121, 81)],
    );

    expect(summer).toMatchObject({ state: 'OR_LOCKED', range: { high: 111, low: 91 } });
    expect(winter).toMatchObject({ state: 'OR_LOCKED', range: { high: 121, low: 81 } });
  });

  it('does not lock the range before 09:45 New York', () => {
    const result = new CasperOpeningRangeSession().evaluate(
      Date.parse('2026-07-15T13:44:59Z'),
      [m15('2026-07-15T13:30:00Z')],
    );

    expect(result).toEqual({ state: 'OR_BUILDING', tradingDay: '2026-07-15' });
  });

  it('returns invalid data when the exact 09:30 M15 candle is missing', () => {
    const result = new CasperOpeningRangeSession().evaluate(
      Date.parse('2026-07-15T13:45:00Z'),
      [m15('2026-07-15T13:15:00Z'), m15('2026-07-15T13:45:00Z')],
    );

    expect(result).toEqual({ state: 'INVALID_DATA', tradingDay: '2026-07-15' });
  });

  it('returns invalid data for an incomplete 09:30 M15 candle', () => {
    const incomplete = m15('2026-07-15T13:30:00Z');
    incomplete.endTimeMs -= minute;

    const result = new CasperOpeningRangeSession().evaluate(
      Date.parse('2026-07-15T13:45:00Z'),
      [incomplete],
    );

    expect(result.state).toBe('INVALID_DATA');
  });

  it('resets the locked range when the New York trading day changes', () => {
    const session = new CasperOpeningRangeSession();
    expect(
      session.evaluate(Date.parse('2026-07-15T13:45:00Z'), [m15('2026-07-15T13:30:00Z')])
        .state,
    ).toBe('OR_LOCKED');

    const nextDay = session.evaluate(Date.parse('2026-07-16T13:45:00Z'), []);

    expect(nextDay).toEqual({ state: 'INVALID_DATA', tradingDay: '2026-07-16' });
  });
});
