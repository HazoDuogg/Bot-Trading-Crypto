import { describe, it, expect, vi } from 'vitest';
import { BinanceOrderExecutor } from './binanceOrderExecutor.js';

const CREDS = { apiKey: 'test-key', apiSecret: 'test-secret', baseUrl: 'https://testnet.example' };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: 'x', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('BinanceOrderExecutor — dryRun (default)', () => {
  it('defaults to dryRun=true and never calls fetch for mutating endpoints', async () => {
    const fetchFn = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    expect(exec.isDryRun()).toBe(true);
    const result = await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(result).toMatchObject({ dryRun: true, method: 'POST', path: '/fapi/v1/order' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('dryRun blocks placeStopMarket/placeTakeProfitMarket/cancelOrder from ever hitting the network', async () => {
    const fetchFn = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.placeStopMarket('BTCUSDT', 'LONG', 60000, 0.01);
    await exec.placeTakeProfitMarket('BTCUSDT', 'LONG', 70000, 0.01);
    await exec.cancelOrder('BTCUSDT', 123);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('read-only endpoints (getServerTime/getAccountInfo/getPositionRisk) are NOT gated by dryRun', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { serverTime: 1000 }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    const time = await exec.getServerTime();
    expect(time).toBe(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('BinanceOrderExecutor — syncClock', () => {
  it('computes the offset from server time and applies it to subsequent signed timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { serverTime: 1_000_500 })) // syncClock's getServerTime call
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' })); // subsequent signed call
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });

    const offset = await exec.syncClock();
    expect(offset).toBe(500); // server is 500ms ahead of local clock

    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    const [url] = fetchFn.mock.calls[1];
    expect(url).toContain(`timestamp=${1_000_000 + 500}`);
    vi.useRealTimers();
  });

  it('without syncClock(), signed timestamp falls back to the raw local clock (offset=0)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain(`timestamp=${2_000_000}`);
    vi.useRealTimers();
  });
});

describe('BinanceOrderExecutor — live mode (dryRun=false)', () => {
  it('openMarketPosition signs the request and returns the parsed order', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 42, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(result).toMatchObject({ orderId: 42, symbol: 'BTCUSDT', status: 'FILLED' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/fapi/v1/order');
    expect(url).toContain('side=BUY');
    expect(url).toContain('type=MARKET');
    expect(url).toContain('signature=');
    expect((init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe('test-key');
  });

  it('placeStopMarket for a SHORT position uses side=BUY + reduceOnly=true', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 7, status: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.placeStopMarket('ETHUSDT', 'SHORT', 2000, 0.5);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=BUY');
    expect(url).toContain('type=STOP_MARKET');
    expect(url).toContain('reduceOnly=true');
  });

  it('does NOT retry a mutating call once an HTTP error response is received', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(400, { code: -2010, msg: 'insufficient balance' }));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/HTTP 400/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry
    expect(onOrderFailure).toHaveBeenCalledTimes(1);
  });

  it('retries a mutating call on a pre-response network error, bounded', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(result).toMatchObject({ orderId: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_MUTATING_RETRIES consecutive pre-response network errors, and calls onOrderFailure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/lỗi mạng/);
    expect(onOrderFailure).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout (AbortError) as ambiguous status and does NOT retry', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fetchFn = vi.fn().mockRejectedValue(abortErr);
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/TIMEOUT.*KHÔNG XÁC ĐỊNH/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry on ambiguous timeout
  });

  it('updateStopOrder cancels the old order then places a new one', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {})) // cancel
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 99, status: 'NEW' })); // new stop
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.updateStopOrder('BTCUSDT', 5, 'LONG', 61000, 0.01);
    expect(result).toMatchObject({ orderId: 99 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchFn.mock.calls[1][1].method).toBe('POST');
  });

  it('updateStopOrder surfaces an URGENT no-SL error if cancel succeeds but the replace fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {})) // cancel succeeds
      .mockResolvedValueOnce(jsonResponse(500, { msg: 'server error' })); // replace fails
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await expect(exec.updateStopOrder('BTCUSDT', 5, 'LONG', 61000, 0.01)).rejects.toThrow(/VỊ THẾ ĐANG KHÔNG CÓ SL/);
    expect(onOrderFailure).toHaveBeenCalledWith(expect.stringContaining('URGENT_NO_SL'), expect.any(Error));
  });
});
