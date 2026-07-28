import { describe, it, expect, vi } from 'vitest';
import { BinanceOrderExecutor } from './binanceOrderExecutor.js';

const CREDS = { apiKey: 'test-key', apiSecret: 'test-secret', baseUrl: 'https://testnet.example' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

  // TICKET-086 — found via a real dry-run soak test: getServerTime() (called first, by syncClock())
  // used to have no retry at all, so a single transient network error killed the whole process at
  // startup. Now retries on network error / 429, same policy as every other GET in this class.
  it('getServerTime retries on a transient network error, then succeeds', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(jsonResponse(200, { serverTime: 5000 }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    const time = await exec.getServerTime();
    expect(time).toBe(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('getServerTime retries on 429, honoring the same backoff policy as signedGet', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(429, {})).mockResolvedValueOnce(jsonResponse(200, { serverTime: 6000 }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    const time = await exec.getServerTime();
    expect(time).toBe(6000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

  it('placeStopMarket for a SHORT position uses side=BUY + reduceOnly=true, via /fapi/v1/algoOrder (TICKET-077 1.3 — bắt buộc từ 09/12/2025)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { algoId: 7, algoStatus: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.placeStopMarket('ETHUSDT', 'SHORT', 2000, 0.5);
    expect(result).toMatchObject({ algoId: 7, algoStatus: 'NEW' });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('/fapi/v1/algoOrder');
    expect(url).toContain('side=BUY');
    expect(url).toContain('algoType=CONDITIONAL');
    expect(url).toContain('type=STOP_MARKET');
    expect(url).toContain('triggerPrice=2000');
    expect(url).toContain('reduceOnly=true');
  });

  it('placeTakeProfitMarket uses /fapi/v1/algoOrder with algoType=CONDITIONAL and triggerPrice (not stopPrice)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { algoId: 11, algoStatus: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.placeTakeProfitMarket('BTCUSDT', 'LONG', 70000, 0.01);
    expect(result).toMatchObject({ algoId: 11, algoStatus: 'NEW' });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('/fapi/v1/algoOrder');
    expect(url).toContain('type=TAKE_PROFIT_MARKET');
    expect(url).toContain('triggerPrice=70000');
    expect(url).not.toContain('stopPrice=');
  });

  it('cancelAlgoOrder DELETEs /fapi/v1/algoOrder with algoId (a separate ID space from cancelOrder\'s orderId)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { algoId: 7, clientAlgoId: 'x', code: '200', msg: 'success' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.cancelAlgoOrder('ETHUSDT', 7);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/fapi/v1/algoOrder');
    expect(url).toContain('algoId=7');
    expect(init.method).toBe('DELETE');
  });

  it('placeLimitOrder for a LONG opens with side=BUY, type=LIMIT, timeInForce=GTC (not reduceOnly)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 8, status: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.placeLimitOrder('BTCUSDT', 'LONG', 50000, 0.01);
    expect(result).toMatchObject({ orderId: 8, status: 'NEW' });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=BUY');
    expect(url).toContain('type=LIMIT');
    expect(url).toContain('timeInForce=GTC');
    expect(url).toContain('price=50000');
    expect(url).not.toContain('reduceOnly');
  });

  it('closePositionMarket for a LONG position uses side=SELL + reduceOnly=true (partial or full quantity)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 9, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.closePositionMarket('BTCUSDT', 'LONG', 0.005);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=SELL');
    expect(url).toContain('type=MARKET');
    expect(url).toContain('reduceOnly=true');
    expect(url).toContain('quantity=0.005');
  });

  it('closePositionMarket for a SHORT position uses side=BUY + reduceOnly=true', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 10, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.closePositionMarket('ETHUSDT', 'SHORT', 0.02);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=BUY');
    expect(url).toContain('reduceOnly=true');
  });

  it('placeLimitOrder/closePositionMarket are gated by dryRun like every other mutating call', async () => {
    const fetchFn = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn }); // dryRun defaults true
    await exec.placeLimitOrder('BTCUSDT', 'LONG', 50000, 0.01);
    await exec.closePositionMarket('BTCUSDT', 'LONG', 0.01);
    expect(fetchFn).not.toHaveBeenCalled();
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

  it('updateStopOrder cancels the old algo order (via cancelAlgoOrder/algoId) then places a new one', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { algoId: 5, code: '200', msg: 'success' })) // cancel
      .mockResolvedValueOnce(jsonResponse(200, { algoId: 99, algoStatus: 'NEW' })); // new stop
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.updateStopOrder('BTCUSDT', 5, 'LONG', 61000, 0.01);
    expect(result).toMatchObject({ algoId: 99 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toContain('/fapi/v1/algoOrder');
    expect(fetchFn.mock.calls[0][0]).toContain('algoId=5');
    expect(fetchFn.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchFn.mock.calls[1][0]).toContain('/fapi/v1/algoOrder');
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

describe('BinanceOrderExecutor — ORDERS rate-limit tracking (TICKET-077 1.2 follow-up)', () => {
  it('reads X-MBX-ORDER-COUNT-* headers from a mutating response and exposes them via getters/callback', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '5', 'x-mbx-order-count-1m': '20' }));
    const onOrderCountUpdate = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderCountUpdate });

    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);

    expect(exec.getLastKnownOrderCount10s()).toBe(5);
    expect(exec.getLastKnownOrderCount1m()).toBe(20);
    expect(onOrderCountUpdate).toHaveBeenCalledWith(5, 300, 20, 1200);
  });

  it('isOrderRateThrottled() is false when usage is well under the safety margin', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '10', 'x-mbx-order-count-1m': '50' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(exec.isOrderRateThrottled()).toBe(false);
  });

  it('rejects the NEXT mutating call outright (no wait, no retry) once the 10s ORDERS window crosses the safety margin — critical for Bước 1.3\'s rapid place→move-SL→move-TP→partial-close sequences', async () => {
    // 200/300 = 66.7% > 60% threshold.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '200', 'x-mbx-order-count-1m': '200' }))
      .mockResolvedValue(jsonResponse(200, { orderId: 2, status: 'NEW' }));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });

    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01); // pushes count10s to 200/300
    await expect(exec.placeStopMarket('BTCUSDT', 'LONG', 60000, 0.01)).rejects.toThrow(/ORDERS rate limit gần chạm ngưỡng/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the throttled call never even reached fetch
    expect(onOrderFailure).toHaveBeenCalledWith(expect.stringContaining('placeStopMarket'), expect.any(Error));
  });

  it('rejects outright once the 1m ORDERS window (not just 10s) crosses the safety margin', async () => {
    // count10s stays low (10/300) but count1m is 800/1200 = 66.7% > 60%.
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '10', 'x-mbx-order-count-1m': '800' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(exec.isOrderRateThrottled()).toBe(true);
    await expect(exec.cancelOrder('BTCUSDT', 1)).rejects.toThrow(/ORDERS rate limit gần chạm ngưỡng/);
  });
});
