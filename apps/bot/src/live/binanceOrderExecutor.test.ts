import { describe, it, expect, vi } from 'vitest';
import { BinanceOrderExecutor, initializeLeverageForSymbols } from './binanceOrderExecutor.js';

const CREDS = { apiKey: 'test-key', apiSecret: 'test-secret', baseUrl: 'https://testnet.example' };
const TEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

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

/**
 * TICKET-099 Phần A — identity filters (tiny stepSize/tickSize, minQty/minNotional=0) for every
 * test symbol, so loadExchangeInfo()'s real rounding is a no-op against the exact quantity/price
 * values these existing tests already assert on (they test signing/retry/dryRun/rate-limit behavior,
 * not rounding correctness — dedicated rounding tests are separate, further down this file).
 */
function exchangeInfoResponse(): Response {
  return jsonResponse(200, {
    symbols: TEST_SYMBOLS.map((symbol) => ({
      symbol,
      filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00000001', minQty: '0', maxQty: '9000000' },
        { filterType: 'PRICE_FILTER', tickSize: '0.00000001', minPrice: '0', maxPrice: '9000000' },
        { filterType: 'MIN_NOTIONAL', notional: '0' },
      ],
    })),
  });
}

/** Loads identity filters for `exec` (via its own `fetchFn`, whose call history is then cleared so tests asserting on fetchFn.mock.calls are unaffected by this setup step). */
async function loadIdentityFilters(exec: BinanceOrderExecutor, fetchFn: ReturnType<typeof vi.fn>): Promise<void> {
  await exec.loadExchangeInfo(TEST_SYMBOLS);
  fetchFn.mockClear();
}

describe('BinanceOrderExecutor — dryRun (default)', () => {
  it('defaults to dryRun=true and never calls fetch for mutating endpoints', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    expect(exec.isDryRun()).toBe(true);
    const result = await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(result).toMatchObject({ dryRun: true, method: 'POST', path: '/fapi/v1/order' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('dryRun blocks placeStopMarket/placeTakeProfitMarket/cancelOrder from ever hitting the network', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
      .mockResolvedValueOnce(exchangeInfoResponse())
      .mockResolvedValueOnce(jsonResponse(200, { serverTime: 1_000_500 })) // syncClock's getServerTime call
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' })); // subsequent signed call
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);

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
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain(`timestamp=${2_000_000}`);
    vi.useRealTimers();
  });
});

describe('BinanceOrderExecutor — TICKET-100: setLeverage (POST /fapi/v1/leverage)', () => {
  it('dryRun blocks setLeverage from ever hitting the network, same as every other mutating call', async () => {
    const fetchFn = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn }); // dryRun defaults true
    const result = await exec.setLeverage('BTCUSDT', 30);
    expect(result).toMatchObject({ dryRun: true, method: 'POST', path: '/fapi/v1/leverage', params: { symbol: 'BTCUSDT', leverage: 30 } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('signs the request and returns the confirmed leverage', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { symbol: 'BTCUSDT', leverage: 30, maxNotionalValue: '1000000' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const result = await exec.setLeverage('BTCUSDT', 30);
    expect(result).toMatchObject({ symbol: 'BTCUSDT', leverage: 30 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/fapi/v1/leverage');
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('leverage=30');
    expect(url).toContain('signature=');
    expect(init.method).toBe('POST');
  });

  it('does NOT require loadExchangeInfo first — leverage has no quantity/price to round', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { symbol: 'XRPUSDT', leverage: 30 }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await expect(exec.setLeverage('XRPUSDT', 30)).resolves.toMatchObject({ leverage: 30 });
  });
});

describe('BinanceOrderExecutor — TICKET-100: initializeLeverageForSymbols (startup orchestration)', () => {
  it('calls setLeverage exactly once per symbol, with leverage=30, in order', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { leverage: 30 }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const logger = { log: vi.fn(), warn: vi.fn() };

    await initializeLeverageForSymbols(exec, TEST_SYMBOLS, 30, logger);

    expect(fetchFn).toHaveBeenCalledTimes(4);
    for (let i = 0; i < TEST_SYMBOLS.length; i++) {
      const [url] = fetchFn.mock.calls[i];
      expect(url).toContain(`symbol=${TEST_SYMBOLS[i]}`);
      expect(url).toContain('leverage=30');
    }
    expect(logger.log).toHaveBeenCalledTimes(4);
    expect(logger.log).toHaveBeenCalledWith('Đã đặt đòn bẩy 30x cho BTCUSDT — OK');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('"đang có vị thế mở" rejection for one symbol -> warns, does NOT throw, continues to remaining symbols', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { leverage: 30 })) // BTCUSDT ok
      .mockResolvedValueOnce(jsonResponse(400, { code: -4161, msg: 'Leverage reduction is not supported in Isolated Margin Mode with open positions.' })) // ETHUSDT rejected
      .mockResolvedValue(jsonResponse(200, { leverage: 30 })); // SOLUSDT/XRPUSDT ok
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const logger = { log: vi.fn(), warn: vi.fn() };

    await expect(initializeLeverageForSymbols(exec, TEST_SYMBOLS, 30, logger)).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(4); // all 4 symbols attempted, not stopped
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ETHUSDT'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('open positions'));
    expect(logger.log).toHaveBeenCalledTimes(3); // BTCUSDT, SOLUSDT, XRPUSDT succeeded
  });

  it('a non-position-open error (e.g. auth) is NOT silently swallowed — throws and stops (does not attempt remaining symbols)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { leverage: 30 })) // BTCUSDT ok
      .mockResolvedValueOnce(jsonResponse(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' })); // ETHUSDT auth failure
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    const logger = { log: vi.fn(), warn: vi.fn() };

    await expect(initializeLeverageForSymbols(exec, TEST_SYMBOLS, 30, logger)).rejects.toThrow(/ETHUSDT/);

    expect(fetchFn).toHaveBeenCalledTimes(2); // BTCUSDT attempted, ETHUSDT attempted+failed, SOLUSDT/XRPUSDT never reached
    expect(logger.warn).not.toHaveBeenCalled(); // not treated as the "open position" soft-fail case
  });
});

describe('BinanceOrderExecutor — live mode (dryRun=false)', () => {
  it('openMarketPosition signs the request and returns the parsed order', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 42, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { algoId: 7, algoStatus: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { algoId: 11, algoStatus: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 8, status: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 9, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    await exec.closePositionMarket('BTCUSDT', 'LONG', 0.005);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=SELL');
    expect(url).toContain('type=MARKET');
    expect(url).toContain('reduceOnly=true');
    expect(url).toContain('quantity=0.005');
  });

  it('closePositionMarket for a SHORT position uses side=BUY + reduceOnly=true', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 10, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    await exec.closePositionMarket('ETHUSDT', 'SHORT', 0.02);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('side=BUY');
    expect(url).toContain('reduceOnly=true');
  });

  it('placeLimitOrder/closePositionMarket are gated by dryRun like every other mutating call', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn }); // dryRun defaults true
    await loadIdentityFilters(exec, fetchFn);
    await exec.placeLimitOrder('BTCUSDT', 'LONG', 50000, 0.01);
    await exec.closePositionMarket('BTCUSDT', 'LONG', 0.01);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does NOT retry a mutating call once an HTTP error response is received', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(400, { code: -2010, msg: 'insufficient balance' }));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await loadIdentityFilters(exec, fetchFn);
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/HTTP 400/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry
    expect(onOrderFailure).toHaveBeenCalledTimes(1);
  });

  it('retries a mutating call on a pre-response network error, bounded', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(exchangeInfoResponse())
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    const result = await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(result).toMatchObject({ orderId: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_MUTATING_RETRIES consecutive pre-response network errors, and calls onOrderFailure', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockRejectedValue(new TypeError('fetch failed'));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await loadIdentityFilters(exec, fetchFn);
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/lỗi mạng/);
    expect(onOrderFailure).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout (AbortError) as ambiguous status and does NOT retry', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockRejectedValue(abortErr);
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await loadIdentityFilters(exec, fetchFn);
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/TIMEOUT.*KHÔNG XÁC ĐỊNH/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry on ambiguous timeout
  });

  it('updateStopOrder cancels the old algo order (via cancelAlgoOrder/algoId) then places a new one', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(exchangeInfoResponse())
      .mockResolvedValueOnce(jsonResponse(200, { algoId: 5, code: '200', msg: 'success' })) // cancel
      .mockResolvedValueOnce(jsonResponse(200, { algoId: 99, algoStatus: 'NEW' })); // new stop
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
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
      .mockResolvedValueOnce(exchangeInfoResponse())
      .mockResolvedValueOnce(jsonResponse(200, {})) // cancel succeeds
      .mockResolvedValueOnce(jsonResponse(500, { msg: 'server error' })); // replace fails
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await loadIdentityFilters(exec, fetchFn);
    await expect(exec.updateStopOrder('BTCUSDT', 5, 'LONG', 61000, 0.01)).rejects.toThrow(/VỊ THẾ ĐANG KHÔNG CÓ SL/);
    expect(onOrderFailure).toHaveBeenCalledWith(expect.stringContaining('URGENT_NO_SL'), expect.any(Error));
  });
});

describe('BinanceOrderExecutor — ORDERS rate-limit tracking (TICKET-077 1.2 follow-up)', () => {
  it('reads X-MBX-ORDER-COUNT-* headers from a mutating response and exposes them via getters/callback', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '5', 'x-mbx-order-count-1m': '20' }));
    const onOrderCountUpdate = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderCountUpdate });
    await loadIdentityFilters(exec, fetchFn);

    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);

    expect(exec.getLastKnownOrderCount10s()).toBe(5);
    expect(exec.getLastKnownOrderCount1m()).toBe(20);
    expect(onOrderCountUpdate).toHaveBeenCalledWith(5, 300, 20, 1200);
  });

  it('isOrderRateThrottled() is false when usage is well under the safety margin', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '10', 'x-mbx-order-count-1m': '50' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(exec.isOrderRateThrottled()).toBe(false);
  });

  it('rejects the NEXT mutating call outright (no wait, no retry) once the 10s ORDERS window crosses the safety margin — critical for Bước 1.3\'s rapid place→move-SL→move-TP→partial-close sequences', async () => {
    // 200/300 = 66.7% > 60% threshold.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(exchangeInfoResponse())
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '200', 'x-mbx-order-count-1m': '200' }))
      .mockResolvedValue(jsonResponse(200, { orderId: 2, status: 'NEW' }));
    const onOrderFailure = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn, onOrderFailure });
    await loadIdentityFilters(exec, fetchFn);

    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01); // pushes count10s to 200/300
    await expect(exec.placeStopMarket('BTCUSDT', 'LONG', 60000, 0.01)).rejects.toThrow(/ORDERS rate limit gần chạm ngưỡng/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the throttled call never even reached fetch
    expect(onOrderFailure).toHaveBeenCalledWith(expect.stringContaining('placeStopMarket'), expect.any(Error));
  });

  it('rejects outright once the 1m ORDERS window (not just 10s) crosses the safety margin', async () => {
    // count10s stays low (10/300) but count1m is 800/1200 = 66.7% > 60%.
    const fetchFn = vi.fn().mockResolvedValueOnce(exchangeInfoResponse()).mockResolvedValueOnce(jsonResponse(200, { orderId: 1, status: 'FILLED' }, { 'x-mbx-order-count-10s': '10', 'x-mbx-order-count-1m': '800' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await loadIdentityFilters(exec, fetchFn);
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.01);
    expect(exec.isOrderRateThrottled()).toBe(true);
    await expect(exec.cancelOrder('BTCUSDT', 1)).rejects.toThrow(/ORDERS rate limit gần chạm ngưỡng/);
  });
});

describe('BinanceOrderExecutor — TICKET-099 Phần A: real LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL rounding', () => {
  /** Realistic (ground-truthed shape) per-symbol filters — deliberately DIFFERENT precision per symbol, so a bug that hardcodes one symbol's decimals for all 4 would fail these tests. */
  function realExchangeInfoResponse(): Response {
    return jsonResponse(200, {
      symbols: [
        { symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' }, { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '0', maxPrice: '1000000' }, { filterType: 'MIN_NOTIONAL', notional: '100' }] },
        { symbol: 'ETHUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' }, { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0', maxPrice: '100000' }, { filterType: 'MIN_NOTIONAL', notional: '20' }] },
        { symbol: 'SOLUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '100000' }, { filterType: 'PRICE_FILTER', tickSize: '0.010', minPrice: '0', maxPrice: '10000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
        { symbol: 'XRPUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '10000000' }, { filterType: 'PRICE_FILTER', tickSize: '0.0001', minPrice: '0', maxPrice: '1000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
      ],
    });
  }

  it('loadExchangeInfo parses stepSize/tickSize/minQty/minNotional for all 4 symbols via getSymbolFilters', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    expect(exec.getSymbolFilters('BTCUSDT')).toMatchObject({ stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: 100 });
    expect(exec.getSymbolFilters('SOLUSDT')).toMatchObject({ stepSize: 1, tickSize: 0.01, minQty: 1, minNotional: 5 });
    expect(exec.getSymbolFilters('XRPUSDT')).toMatchObject({ stepSize: 1, tickSize: 0.0001, minQty: 1, minNotional: 5 });
  });

  it('every mutating method throws a clear error (never sends) if called before loadExchangeInfo', async () => {
    const fetchFn = vi.fn();
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.01)).rejects.toThrow(/chưa load/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('openMarketPosition rounds quantity DOWN to the real stepSize (BTCUSDT 0.001) — never rounds up past the caller-intended size', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    await exec.openMarketPosition('BTCUSDT', 'LONG', 0.012649); // would be rejected by real Binance at 3+ decimals
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('quantity=0.012'); // rounded DOWN, not to 0.013
  });

  it('openMarketPosition rounds quantity to a WHOLE number for a symbol with stepSize=1 (SOLUSDT) — no decimals ever sent', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    await exec.openMarketPosition('SOLUSDT', 'LONG', 12.87);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('quantity=12');
    expect(url).not.toContain('quantity=12.');
  });

  it('placeLimitOrder rounds price to the nearest tickSize per symbol (XRPUSDT 0.0001 — needs 4 decimals, not a fixed 2)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'NEW' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    await exec.placeLimitOrder('XRPUSDT', 'LONG', 1.05537, 10);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('price=1.0554'); // nearest 0.0001 tick, not truncated to 2 decimals like the old fixed rounding would
  });

  it('rejects (never sends) a quantity that rounds below the real minQty', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    await expect(exec.openMarketPosition('BTCUSDT', 'LONG', 0.0004)).rejects.toThrow(/< minQty/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects (never sends) an order value below the real minNotional', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse());
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    // ETHUSDT minNotional=$20; price=1000 * qty=0.001 = $1 notional, well under it.
    await expect(exec.placeLimitOrder('ETHUSDT', 'LONG', 1000, 0.001)).rejects.toThrow(/minNotional/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('closePositionMarket rounds quantity but does NOT reject a small dust remainder below minQty (reduceOnly close)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(realExchangeInfoResponse()).mockResolvedValue(jsonResponse(200, { orderId: 1, status: 'FILLED' }));
    const exec = new BinanceOrderExecutor({ credentials: CREDS, dryRun: false, fetchFn });
    await exec.loadExchangeInfo(TEST_SYMBOLS);
    fetchFn.mockClear();
    await expect(exec.closePositionMarket('BTCUSDT', 'LONG', 0.0004)).resolves.toMatchObject({ orderId: 1 });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('quantity=0'); // rounds down to 0 (below stepSize granularity) but does not throw
  });
});
