import { describe, it, expect } from 'vitest';
import { nextCandleCloseMs, msUntilNextPoll, retryWithBackoff, BinanceHttpError, BinanceRestPollingFeed } from './binanceRestPollingFeed.js';

describe('nextCandleCloseMs', () => {
  it('returns the next 15m boundary strictly after nowServerMs', () => {
    const t = Date.UTC(2026, 0, 1, 10, 7, 30); // 10:07:30 -> next M15 close is 10:15:00
    expect(nextCandleCloseMs('15m', t)).toBe(Date.UTC(2026, 0, 1, 10, 15, 0));
  });

  it('returns the SAME-instant boundary + interval when nowServerMs sits exactly on a boundary (never returns "now")', () => {
    const t = Date.UTC(2026, 0, 1, 10, 15, 0);
    expect(nextCandleCloseMs('15m', t)).toBe(Date.UTC(2026, 0, 1, 10, 30, 0));
  });

  it('returns the next 1h boundary strictly after nowServerMs', () => {
    const t = Date.UTC(2026, 0, 1, 10, 42, 0);
    expect(nextCandleCloseMs('1h', t)).toBe(Date.UTC(2026, 0, 1, 11, 0, 0));
  });
});

describe('msUntilNextPoll', () => {
  it('adds the poll delay on top of the next boundary', () => {
    const t = Date.UTC(2026, 0, 1, 10, 0, 0); // next M15 boundary = 10:15:00
    const expectedBoundary = Date.UTC(2026, 0, 1, 10, 15, 0);
    expect(msUntilNextPoll('15m', t, 3000)).toBe(expectedBoundary + 3000 - t);
  });

  it('is always positive (a future point in time), even right at a boundary', () => {
    const t = Date.UTC(2026, 0, 1, 10, 15, 0);
    expect(msUntilNextPoll('15m', t)).toBeGreaterThan(0);
  });
});

describe('retryWithBackoff', () => {
  it('returns the result immediately on first success, no retries', async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws (does not swallow) once retries are exhausted', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error('always fails');
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it('honors BinanceHttpError.retryAfterSec as a minimum delay', async () => {
    let calls = 0;
    const onRetryDelays: number[] = [];
    await retryWithBackoff(
      async () => {
        calls++;
        if (calls === 1) throw new BinanceHttpError('rate limited', 429, 2); // 2s minimum
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 100000, onRetry: (_a, _e, delayMs) => onRetryDelays.push(delayMs) },
    );
    expect(onRetryDelays[0]).toBeGreaterThanOrEqual(2000);
  });
});

// Integration tests against the REAL Binance Futures Testnet public endpoints (no API key needed
// for market data) — per the ticket's own verification method ("Claude Code tu test bang
// testnet... doc du lieu cong khai"). Not mocked, matching this repo's established convention of
// testing against real external tooling rather than mocking it (see softVeto.test.ts's real
// Python/XGBoost calls, RT-066).
describe('BinanceRestPollingFeed (integration, real Binance Futures Testnet)', () => {
  const feed = new BinanceRestPollingFeed('https://testnet.binancefuture.com');

  it('getServerTimeMs returns a plausible current timestamp', async () => {
    const serverMs = await feed.getServerTimeMs();
    const localMs = Date.now();
    expect(Math.abs(serverMs - localMs)).toBeLessThan(60_000); // testnet clock should be within ~1 min of real time
  }, 15000);

  it('getClosedCandlesSince(null) returns a recent, closed-only, gap-free batch for catch-up', async () => {
    const candles = await feed.getClosedCandlesSince('BTCUSDT', '15m', null, 20);
    expect(candles.length).toBeGreaterThan(0);
    expect(candles.length).toBeLessThanOrEqual(20);

    const serverMs = await feed.getServerTimeMs();
    for (const c of candles) {
      expect(c.openTime + 15 * 60 * 1000).toBeLessThanOrEqual(serverMs); // closeTime < server time, per RT-054
    }
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].openTime - candles[i - 1].openTime).toBe(15 * 60 * 1000); // no gaps
    }
  }, 15000);

  it('getClosedCandlesSince(cursor) only returns candles strictly after the cursor (dedupe)', async () => {
    const batch = await feed.getClosedCandlesSince('BTCUSDT', '15m', null, 10);
    const cursor = batch[batch.length - 2].openTime; // second-to-last candle's openTime
    const since = await feed.getClosedCandlesSince('BTCUSDT', '15m', cursor);
    for (const c of since) expect(c.openTime).toBeGreaterThan(cursor);
    // The last candle of the original batch must reappear (it's after the cursor) — confirms no
    // candle is silently skipped at the cursor boundary.
    expect(since.some((c) => c.openTime === batch[batch.length - 1].openTime)).toBe(true);
  }, 15000);

  it('getClosedCandlesSince returns [] (not an error) when nothing new exists yet', async () => {
    const serverMs = await feed.getServerTimeMs();
    const since = await feed.getClosedCandlesSince('BTCUSDT', '15m', serverMs); // cursor in the future -> nothing new
    expect(since).toEqual([]);
  }, 15000);
});
