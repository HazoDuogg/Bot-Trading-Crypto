import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved relative to THIS file's own location (src/live/), not process.cwd() — vitest's cwd is
// apps/bot (not the repo root, where .env actually lives), same lesson as RT-066's softVeto.test.ts.
const REPO_ROOT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
loadEnv({ path: path.join(REPO_ROOT_DIR, '.env') });

import { describe, it, expect } from 'vitest';
import { BinanceOrderClient, TestnetSafetyError, roundDownToStep, roundToTick } from './binanceOrderClient.js';
import { BinanceHttpError } from './binanceRestPollingFeed.js';
import type { OrderInfo } from './exchangeOrderClient.js';

async function getOrderWithRetry(client: BinanceOrderClient, symbol: string, orderId: number, maxAttempts = 5): Promise<OrderInfo> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await client.getOrder(symbol, orderId);
    } catch (err) {
      if (err instanceof BinanceHttpError && err.message.includes('-2013') && i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

async function pollUntilNotOpen(client: BinanceOrderClient, symbol: string, orderId: number, maxAttempts = 5): Promise<OrderInfo[]> {
  let last: OrderInfo[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    last = await client.getOpenOrders(symbol);
    if (!last.some((o) => o.orderId === orderId)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

describe('roundDownToStep / roundToTick (pure)', () => {
  it('rounds quantity DOWN to the LOT_SIZE step (never up — never risk over-sizing)', () => {
    expect(roundDownToStep(0.12349, 0.001)).toBeCloseTo(0.123, 10);
    expect(roundDownToStep(0.1, 0.001)).toBeCloseTo(0.1, 10);
    expect(roundDownToStep(0.0009, 0.001)).toBe(0);
  });

  it('rounds price to the nearest PRICE_FILTER tick', () => {
    expect(roundToTick(101.234, 0.01)).toBeCloseTo(101.23, 10);
    expect(roundToTick(101.236, 0.01)).toBeCloseTo(101.24, 10);
  });

  it('is a no-op when step/tick is 0', () => {
    expect(roundDownToStep(1.23456, 0)).toBe(1.23456);
    expect(roundToTick(1.23456, 0)).toBe(1.23456);
  });
});

describe('BinanceOrderClient — testnet safety guard', () => {
  it('refuses to construct against a non-testnet baseUrl by default', () => {
    expect(() => new BinanceOrderClient('https://fapi.binance.com', 'key', 'secret')).toThrow(TestnetSafetyError);
  });

  it('constructs fine against a testnet baseUrl', () => {
    expect(() => new BinanceOrderClient('https://testnet.binancefuture.com', 'key', 'secret')).not.toThrow();
  });

  it('allows a non-testnet baseUrl ONLY with the explicit opt-out', () => {
    expect(() => new BinanceOrderClient('https://fapi.binance.com', 'key', 'secret', { allowNonTestnet: true })).not.toThrow();
  });
});

const hasCredentials = !!(process.env.BINANCE_TESTNET_URL && process.env.BINANCE_TESTNET_KEY_ENC && process.env.BINANCE_TESTNET_SECRET_ENC);

describe.skipIf(!hasCredentials)('BinanceOrderClient (integration, real Binance Futures Testnet)', () => {
  function makeClient(): BinanceOrderClient {
    return new BinanceOrderClient(process.env.BINANCE_TESTNET_URL!, process.env.BINANCE_TESTNET_KEY_ENC!, process.env.BINANCE_TESTNET_SECRET_ENC!);
  }
  const client = hasCredentials ? makeClient() : (null as unknown as BinanceOrderClient);
  const FAR_BELOW_MARKET_PRICE = 0.5; // real XRPUSDT price ~1.40 at authoring time — never fills

  it('getAvailableBalanceUsdt returns a real, positive USDT balance', async () => {
    const balance = await client.getAvailableBalanceUsdt();
    expect(balance).toBeGreaterThan(0);
  }, 15000);

  it('getSymbolLeverage returns the account\'s real current leverage for XRPUSDT', async () => {
    const leverage = await client.getSymbolLeverage('XRPUSDT');
    expect(leverage).toBeGreaterThan(0);
  }, 15000);

  it('getSymbolFilters returns real LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL for XRPUSDT', async () => {
    const filters = await client.getSymbolFilters('XRPUSDT');
    expect(filters.stepSize).toBeGreaterThan(0);
    expect(filters.tickSize).toBeGreaterThan(0);
    expect(filters.minNotional).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('places a real LIMIT order far below market, queries it as NEW, cancels it, and confirms CANCELED', async () => {
    const filters = await client.getSymbolFilters('XRPUSDT');
    const price = roundToTick(FAR_BELOW_MARKET_PRICE, filters.tickSize);
    const minQtyForNotional = filters.minNotional > 0 ? filters.minNotional / price : filters.stepSize;
    const quantity = roundDownToStep(Math.max(minQtyForNotional * 1.1, filters.stepSize), filters.stepSize);

    const placed = await client.placeLimitEntryOrder('XRPUSDT', 'LONG', quantity, price);
    expect(placed.status).toBe('NEW');
    expect(placed.symbol).toBe('XRPUSDT');

    const queried = await client.getOrder('XRPUSDT', placed.orderId);
    expect(queried.status).toBe('NEW');
    expect(queried.orderId).toBe(placed.orderId);

    await client.cancelOrder('XRPUSDT', placed.orderId);
    const afterCancel = await client.getOrder('XRPUSDT', placed.orderId);
    expect(afterCancel.status).toBe('CANCELED');
  }, 30000);

  it('cancelOrder on an already-canceled order does not throw (idempotent, -2011 tolerated)', async () => {
    const filters = await client.getSymbolFilters('XRPUSDT');
    const price = roundToTick(FAR_BELOW_MARKET_PRICE, filters.tickSize);
    const quantity = roundDownToStep(Math.max((filters.minNotional / price) * 1.1, filters.stepSize), filters.stepSize);
    const placed = await client.placeLimitEntryOrder('XRPUSDT', 'LONG', quantity, price);
    await client.cancelOrder('XRPUSDT', placed.orderId);
    await expect(client.cancelOrder('XRPUSDT', placed.orderId)).resolves.not.toThrow();
  }, 30000);

  it('opens a real tiny position, places REAL STOP_MARKET+TAKE_PROFIT_MARKET close orders via the Algo Order API, verifies+cancels them, and flattens the position again', async () => {
    const filters = await client.getSymbolFilters('XRPUSDT');
    const priceRes = await fetch(`${process.env.BINANCE_TESTNET_URL}/fapi/v1/ticker/price?symbol=XRPUSDT`);
    const markPrice = Number(((await priceRes.json()) as { price: string }).price);
    expect(markPrice).toBeGreaterThan(0);

    const minQtyForNotional = filters.minNotional > 0 ? filters.minNotional / markPrice : filters.stepSize;
    const quantity = roundDownToStep(Math.max(minQtyForNotional * 1.1, filters.stepSize), filters.stepSize);

    // Cross the book (2% above mark) so this LIMIT order fills immediately as a taker order —
    // opens a REAL tiny LONG position, same as a real ENTRY_FILLED in production.
    const entryPrice = roundToTick(markPrice * 1.02, filters.tickSize);
    const entry = await client.placeLimitEntryOrder('XRPUSDT', 'LONG', quantity, entryPrice);
    const filledEntry = await client.getOrder('XRPUSDT', entry.orderId);
    expect(filledEntry.status).toBe('FILLED');

    try {
      const slPrice = roundToTick(markPrice * 0.5, filters.tickSize); // far below — never triggers
      const tpPrice = roundToTick(markPrice * 2, filters.tickSize); // far above — never triggers

      const slPlaced = await client.placeStopMarketCloseOrder('XRPUSDT', 'LONG', slPrice);
      expect(slPlaced.status).toBe('NEW');
      expect(slPlaced.symbol).toBe('XRPUSDT');
      expect(slPlaced.orderId).toBeGreaterThan(0);

      const tpPlaced = await client.placeTakeProfitMarketCloseOrder('XRPUSDT', 'LONG', tpPrice);
      expect(tpPlaced.status).toBe('NEW');
      expect(tpPlaced.orderId).toBeGreaterThan(0);
      expect(tpPlaced.orderId).not.toBe(slPlaced.orderId);

      // getOrder() routes both through the new algoId-based query path — proves the response is
      // getOrder()-compatible (algoStatus mapped back to the same OrderStatus vocabulary).
      const slQueried = await getOrderWithRetry(client, 'XRPUSDT', slPlaced.orderId);
      expect(slQueried.status).toBe('NEW');
      expect(slQueried.orderId).toBe(slPlaced.orderId);
      const tpQueried = await getOrderWithRetry(client, 'XRPUSDT', tpPlaced.orderId);
      expect(tpQueried.status).toBe('NEW');

      // getOpenOrders() must see both (merged from /fapi/v1/openAlgoOrders, since they no longer
      // show up in /fapi/v1/openOrders post-migration).
      const open = await client.getOpenOrders('XRPUSDT');
      expect(open.some((o) => o.orderId === slPlaced.orderId)).toBe(true);
      expect(open.some((o) => o.orderId === tpPlaced.orderId)).toBe(true);

      await client.cancelOrder('XRPUSDT', slPlaced.orderId);
      const openAfterSlCancel = await pollUntilNotOpen(client, 'XRPUSDT', slPlaced.orderId);
      expect(openAfterSlCancel.some((o) => o.orderId === slPlaced.orderId)).toBe(false);

      await client.cancelOrder('XRPUSDT', tpPlaced.orderId);
      const openAfterTpCancel = await pollUntilNotOpen(client, 'XRPUSDT', tpPlaced.orderId);
      expect(openAfterTpCancel.some((o) => o.orderId === tpPlaced.orderId)).toBe(false);

      // Idempotent cancel on an already-canceled ALGO order must not throw.
      await expect(client.cancelOrder('XRPUSDT', slPlaced.orderId)).resolves.not.toThrow();
    } finally {
      // Always flatten the real position this test opened, even if an assertion above failed.
      const closePrice = roundToTick(markPrice * 0.98, filters.tickSize); // crosses below -> fills as taker
      await client.placeLimitEntryOrder('XRPUSDT', 'SHORT', quantity, closePrice);
    }
  }, 30000);
});
