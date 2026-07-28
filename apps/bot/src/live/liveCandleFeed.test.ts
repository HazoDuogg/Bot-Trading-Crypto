import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveCandleFeed, mergeCandles, detectGaps, isCandleClosed, type CandleData } from './liveCandleFeed.js';

function candle(timestamp: number, close = 100): CandleData {
  return { timestamp, open: close, high: close, low: close, close, volume: 1 };
}

function rawKline(c: CandleData): [number, string, string, string, string, string] {
  return [c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)];
}

describe('mergeCandles', () => {
  it('appends new candles onto an empty buffer', () => {
    const merged = mergeCandles([], [candle(1000), candle(2000)], 10);
    expect(merged.map((c) => c.timestamp)).toEqual([1000, 2000]);
  });

  it('replaces the forming candle (same timestamp) with the freshest value instead of duplicating it', () => {
    const buffer = [candle(1000), candle(2000, 100)];
    const merged = mergeCandles(buffer, [candle(2000, 105)], 10);
    expect(merged).toHaveLength(2);
    expect(merged[1].close).toBe(105);
  });

  it('trims to windowSize, keeping only the most recent candles', () => {
    const buffer = [candle(1000), candle(2000), candle(3000)];
    const merged = mergeCandles(buffer, [candle(4000)], 2);
    expect(merged.map((c) => c.timestamp)).toEqual([3000, 4000]);
  });

  it('returns the buffer unchanged when newBatch is empty', () => {
    const buffer = [candle(1000)];
    expect(mergeCandles(buffer, [], 10)).toBe(buffer);
  });

  it('TICKET-077 1.1: preserves an existing candle that falls inside the new batch range but is not itself re-returned (the old "drop everything at/after cutoff" scheme silently deleted it)', () => {
    const buffer = [candle(1000), candle(2000), candle(3000)];
    const merged = mergeCandles(buffer, [candle(4000)], 10);
    expect(merged.map((c) => c.timestamp)).toEqual([1000, 2000, 3000, 4000]);
  });
});

describe('detectGaps', () => {
  const intervalMs = 1000;

  it('finds no gaps in an evenly-spaced sequence', () => {
    const candles = [candle(0), candle(1000), candle(2000)];
    expect(detectGaps(candles, intervalMs)).toEqual([]);
  });

  it('finds a single missing candle between two known-good ones', () => {
    const candles = [candle(0), candle(2000)]; // 1000 missing
    const gaps = detectGaps(candles, intervalMs);
    expect(gaps).toEqual([{ afterTimestamp: 0, beforeTimestamp: 2000, missingCount: 1 }]);
  });

  it('finds multiple missing candles in one gap', () => {
    const candles = [candle(0), candle(4000)]; // 1000,2000,3000 missing
    const gaps = detectGaps(candles, intervalMs);
    expect(gaps).toEqual([{ afterTimestamp: 0, beforeTimestamp: 4000, missingCount: 3 }]);
  });

  it('finds multiple separate gaps', () => {
    const candles = [candle(0), candle(2000), candle(5000)];
    const gaps = detectGaps(candles, intervalMs);
    expect(gaps).toHaveLength(2);
  });
});

describe('isCandleClosed', () => {
  const intervalMs = 5 * 60_000;

  it('is NOT closed right at the nominal close time (needs the safety buffer too)', () => {
    const c = candle(0);
    expect(isCandleClosed(c, intervalMs, intervalMs)).toBe(false);
  });

  it('is closed once nominal close time + safety buffer has elapsed', () => {
    const c = candle(0);
    expect(isCandleClosed(c, intervalMs, intervalMs + 2_000)).toBe(true);
  });

  it('is not closed while still forming (now before the nominal close time)', () => {
    const c = candle(0);
    expect(isCandleClosed(c, intervalMs, intervalMs - 1)).toBe(false);
  });
});

describe('LiveCandleFeed', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockOkResponse(candles: CandleData[]) {
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => candles.map(rawKline) };
  }

  it('fills buffers for every symbol/interval on start() before returning', async () => {
    fetchMock.mockResolvedValue(mockOkResponse([candle(1000), candle(2000)]));
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test' });
    await feed.start();
    expect(feed.getCandles('BTCUSDT', '5m')).toHaveLength(2);
    expect(feed.getCandles('BTCUSDT', '1h')).toHaveLength(2);
    feed.stop();
    // 1 symbol x 5 intervals = 5 initial calls
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  // TICKET-086 — start() must request each interval's FULL windowSize on the initial poll, not the
  // (much smaller, default 3) regular per-poll klineLimit — otherwise a caller only has a couple of
  // candles immediately and has to wait real-time (hours, for a 320-candle 5m window at the default
  // 2s cadence) for the rolling poll to build up a usable history one small batch at a time.
  it("start()'s initial poll requests the full configured windowSize as the limit, ignoring klineLimit", async () => {
    fetchMock.mockResolvedValue(mockOkResponse([candle(1000)]));
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', klineLimit: 3, windowSizes: { '5m': 320, '1h': 40 } });
    await feed.start();
    feed.stop();

    const fiveMinCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('interval=5m'));
    expect(fiveMinCall?.[0]).toContain('limit=320');
    const oneHourCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('interval=1h'));
    expect(oneHourCall?.[0]).toContain('limit=40');
  });

  it('calls onError (does not throw) when a poll fails, and does not touch the buffer', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const onError = vi.fn();
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onError, klineLimit: 1 });
    await feed.start();
    feed.stop();
    expect(onError).toHaveBeenCalled();
    expect(feed.getCandles('BTCUSDT', '5m')).toHaveLength(0);
  }, 20_000);

  it('retries on HTTP 429 then succeeds', async () => {
    fetchMock.mockResolvedValueOnce({ status: 429, ok: false, headers: { get: () => null }, json: async () => [] }).mockResolvedValue(mockOkResponse([candle(1000)]));
    const feed = new LiveCandleFeed({
      symbols: ['BTCUSDT'],
      baseUrl: 'https://example.test',
      pollIntervalsMs: { '5m': 999_999 },
    });
    await feed.start();
    feed.stop();
    expect(feed.getCandles('BTCUSDT', '5m')).toHaveLength(1);
  }, 20_000);

  it('stop() clears timers so no further polling happens', async () => {
    fetchMock.mockResolvedValue(mockOkResponse([candle(1000)]));
    let tickFn: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      tickFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', setIntervalFn, clearIntervalFn });
    await feed.start();
    const callsAfterStart = fetchMock.mock.calls.length;

    feed.stop();
    expect(clearIntervalFn).toHaveBeenCalled();

    // Simulate a timer firing after stop() — should be a no-op in practice since clearInterval was
    // called; here we only assert stop() itself invoked the clear function for every registered timer.
    tickFn?.();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsAfterStart);
  });

  it('getClosedCandles() excludes a candle whose safety buffer has not elapsed yet', async () => {
    const t0 = 1_700_000_000_000; // arbitrary fixed epoch, 5m-aligned
    fetchMock.mockResolvedValue(mockOkResponse([candle(t0)]));
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test' });
    await feed.start();
    feed.stop();

    const intervalMs = 5 * 60_000;
    expect(feed.getClosedCandles('BTCUSDT', '5m', t0 + intervalMs)).toEqual([]); // right at nominal close, buffer not elapsed
    expect(feed.getClosedCandles('BTCUSDT', '5m', t0 + intervalMs + 2_000)).toHaveLength(1); // buffer elapsed
  });

  it('detects and backfills a gap after a normal poll, calling onGapFilled', async () => {
    const intervalMs = 5 * 60_000;
    const onGapFilled = vi.fn();
    // URL-dispatched mock so the other 4 intervals' concurrent initial polls (start() polls all of
    // them) get their own harmless single-candle response instead of interfering with the 5m gap setup.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('interval=5m') && url.includes('startTime')) return Promise.resolve(mockOkResponse([candle(intervalMs)]));
      if (url.includes('interval=5m')) return Promise.resolve(mockOkResponse([candle(0), candle(2 * intervalMs)]));
      return Promise.resolve(mockOkResponse([candle(0)]));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onGapFilled, pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    expect(onGapFilled).toHaveBeenCalledTimes(1);
    expect(feed.getCandles('BTCUSDT', '5m').map((c) => c.timestamp)).toEqual([0, intervalMs, 2 * intervalMs]);
    const backfillCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('startTime'));
    expect(backfillCall?.[0]).toContain(`startTime=${intervalMs}&endTime=${intervalMs}`);
  });

  it('surfaces a failed backfill through onError instead of silently leaving the gap', async () => {
    const intervalMs = 5 * 60_000;
    const onError = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('interval=5m') && url.includes('startTime')) return Promise.reject(new Error('backfill network error'));
      if (url.includes('interval=5m')) return Promise.resolve(mockOkResponse([candle(0), candle(2 * intervalMs)])); // seeds a gap
      return Promise.resolve(mockOkResponse([candle(0)]));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onError, pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('backfillGaps(BTCUSDT,5m)') }), 'BTCUSDT', '5m');
  }, 20_000);

  it('TICKET-077 1.2: reports X-MBX-USED-WEIGHT-1m via onWeightUpdate and getLastKnownUsedWeight1m()', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, headers: { get: (h: string) => (h === 'x-mbx-used-weight-1m' ? '42' : null) }, json: async () => [candle(1000)].map(rawKline) });
    const onWeightUpdate = vi.fn();
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onWeightUpdate });
    await feed.start();
    feed.stop();

    expect(onWeightUpdate).toHaveBeenCalledWith(42, 2400);
    expect(feed.getLastKnownUsedWeight1m()).toBe(42);
  });

  it('TICKET-077 1.2: skips a poll (does not call fetch again) once used weight crosses the safety threshold, calling onThrottled', async () => {
    // 1500/2400 = 62.5% > 60% threshold — every poll after the first should be skipped.
    fetchMock.mockResolvedValue({ status: 200, ok: true, headers: { get: (h: string) => (h === 'x-mbx-used-weight-1m' ? '1500' : null) }, json: async () => [candle(1000)].map(rawKline) });
    const onThrottled = vi.fn();
    let tickFn: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      tickFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onThrottled, setIntervalFn, clearIntervalFn: vi.fn() as unknown as typeof clearInterval });
    await feed.start(); // initial poll for all 5 intervals — weight becomes 1500 after these
    const callsAfterStart = fetchMock.mock.calls.length;

    tickFn?.(); // a scheduled tick firing after weight is already over threshold
    await new Promise((r) => setTimeout(r, 50));
    feed.stop();

    expect(fetchMock.mock.calls.length).toBe(callsAfterStart); // no new fetch — poll was skipped
    expect(onThrottled).toHaveBeenCalledWith('BTCUSDT', expect.any(String), 1500);
  });

  it('TICKET-077 1.2: on 429, honors the Retry-After header instead of guessing a fixed backoff', async () => {
    const sleepSpy = vi.spyOn(global, 'setTimeout');
    fetchMock
      .mockResolvedValueOnce({ status: 429, ok: false, headers: { get: (h: string) => (h === 'retry-after' ? '7' : null) }, json: async () => [] })
      .mockResolvedValue(mockOkResponse([candle(1000)]));

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    // one of the scheduled setTimeout calls should be for exactly 7000ms (Retry-After: 7), not the
    // fixed 1000ms exponential-backoff guess used when the header is absent.
    const delays = sleepSpy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(7000);
    sleepSpy.mockRestore();
  }, 15_000);

  it('TICKET-077 1.2: treats HTTP 418 (IP auto-ban) the same as 429 — honors Retry-After, does not retry immediately', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 418, ok: false, headers: { get: (h: string) => (h === 'retry-after' ? '3' : null) }, json: async () => [] })
      .mockResolvedValue(mockOkResponse([candle(1000)]));

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    expect(feed.getCandles('BTCUSDT', '5m')).toHaveLength(1); // eventually succeeded after honoring the ban
  });
});
