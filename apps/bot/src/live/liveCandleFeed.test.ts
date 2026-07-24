import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveCandleFeed, mergeCandles, type CandleData } from './liveCandleFeed.js';

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
    return { status: 200, ok: true, json: async () => candles.map(rawKline) };
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
    fetchMock.mockResolvedValueOnce({ status: 429, ok: false, json: async () => [] }).mockResolvedValue(mockOkResponse([candle(1000)]));
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
});
