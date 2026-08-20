import { describe, expect, it } from 'vitest';
import { CandleData, INTERVAL_MS, Interval, isCandleClosed } from './liveCandleFeed.js';
import { assessCandleFreshness, assessCandleFreshnessForSymbol, hasAnyStaleRequiredTimeframe } from './candleFreshnessGate.js';

const CANDLE_TEMPLATE: CandleData = { timestamp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 };

function findCloseBoundary(candleTimestamp: number, intervalMs: number): number {
  let lo = candleTimestamp + intervalMs;
  let hi = candleTimestamp + intervalMs + 60_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (isCandleClosed({ ...CANDLE_TEMPLATE, timestamp: candleTimestamp }, intervalMs, mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '1d'];

describe('assessCandleFreshness (TICKET-LIVE-R2A item 1)', () => {
  for (const interval of INTERVALS) {
    const intervalMs = INTERVAL_MS[interval];
    const candleTimestamp = 10 * intervalMs;

    it(`${interval}: exactly-fresh-enough — nowMs at the safety-buffer boundary is FRESH`, () => {
      const nowMs = findCloseBoundary(candleTimestamp, intervalMs);
      const verdict = assessCandleFreshness(interval, candleTimestamp, nowMs);
      expect(verdict.fresh).toBe(true);
    });

    it(`${interval}: one-interval-stale — a newer candle should already exist, verdict is STALE_BEHIND`, () => {
      const nowMs = findCloseBoundary(candleTimestamp + intervalMs, intervalMs);
      const verdict = assessCandleFreshness(interval, candleTimestamp, nowMs);
      expect(verdict.fresh).toBe(false);
      expect(verdict.fresh === false && verdict.reason).toBe('STALE_BEHIND');
    });

    it(`${interval}: future-candle — candle timestamp after now also fails, not just old data`, () => {
      const nowMs = candleTimestamp;
      const futureTimestamp = candleTimestamp + intervalMs;
      const verdict = assessCandleFreshness(interval, futureTimestamp, nowMs);
      expect(verdict.fresh).toBe(false);
      expect(verdict.fresh === false && verdict.reason).toBe('FUTURE');
    });

    it(`${interval}: missing data fails as MISSING`, () => {
      const verdict = assessCandleFreshness(interval, null, candleTimestamp + intervalMs * 5);
      expect(verdict.fresh).toBe(false);
      expect(verdict.fresh === false && verdict.reason).toBe('MISSING');
    });

    it(`${interval}: not-yet-closed — candle timestamp <= now but its own safety buffer hasn't elapsed yet`, () => {
      const nowMs = candleTimestamp + intervalMs;
      const verdict = assessCandleFreshness(interval, candleTimestamp, nowMs);
      expect(verdict.fresh).toBe(false);
      expect(verdict.fresh === false && verdict.reason).toBe('NOT_YET_CLOSED');
    });
  }
});

describe('assessCandleFreshnessForSymbol / hasAnyStaleRequiredTimeframe', () => {
  it('flags stale when ANY required timeframe is stale, even if others are fresh', () => {
    const nowMs = findCloseBoundary(1_000_000, INTERVAL_MS['5m']);
    const verdicts = assessCandleFreshnessForSymbol(
      {
        '5m': [{ ...CANDLE_TEMPLATE, timestamp: 1_000_000 }],
        '15m': [],
      },
      ['5m', '15m'],
      nowMs,
    );
    expect(hasAnyStaleRequiredTimeframe(verdicts)).toBe(true);
  });

  it('is not stale when every required timeframe individually reports fresh', () => {
    expect(hasAnyStaleRequiredTimeframe([{ interval: '5m', fresh: true }, { interval: '15m', fresh: true }])).toBe(false);
  });

  it('produces one verdict per requested interval, defaulting an absent key to MISSING', () => {
    const nowMs = 1_000_000;
    const verdicts = assessCandleFreshnessForSymbol({ '5m': [] }, ['5m', '15m'], nowMs);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ interval: '5m', fresh: false, reason: 'MISSING' });
    expect(verdicts[1]).toMatchObject({ interval: '15m', fresh: false, reason: 'MISSING' });
  });

  for (const interval of INTERVALS) {
    it(`${interval}: rejects an internal candle gap even when the latest candle is fresh`, () => {
      const intervalMs = INTERVAL_MS[interval];
      const latestTimestamp = 10 * intervalMs;
      const nowMs = findCloseBoundary(latestTimestamp, intervalMs);
      const verdicts = assessCandleFreshnessForSymbol(
        {
          [interval]: [
            { ...CANDLE_TEMPLATE, timestamp: latestTimestamp - 3 * intervalMs },
            { ...CANDLE_TEMPLATE, timestamp: latestTimestamp - intervalMs },
            { ...CANDLE_TEMPLATE, timestamp: latestTimestamp },
          ],
        },
        [interval],
        nowMs,
      );
      expect(verdicts).toEqual([{ interval, fresh: false, reason: 'GAP' }]);
    });
  }
});
