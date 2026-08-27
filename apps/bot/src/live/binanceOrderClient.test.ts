import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved relative to THIS file's own location (src/live/), not process.cwd() — vitest's cwd is
// apps/bot (not the repo root, where .env actually lives), same lesson as RT-066's softVeto.test.ts.
const REPO_ROOT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
loadEnv({ path: path.join(REPO_ROOT_DIR, '.env') });

import { describe, it, expect } from 'vitest';
import { BinanceOrderClient, TestnetSafetyError, roundDownToStep, roundToTick } from './binanceOrderClient.js';

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

// Integration tests against the REAL Binance Futures Testnet, using the REAL API key/secret from
// .env — per the ticket's own verification method. Uses XRPUSDT specifically (confirmed to have NO
// pre-existing open position on this account before RT-068 started, unlike BTCUSDT which does —
// deliberately avoided to prevent any interaction with that unrelated position). Every order
// placed here uses a price far from the real market (verified ~$1.40 at test-authoring time) so it
// can never accidentally fill, and every test cancels/cleans up what it created.
const hasCredentials = !!(process.env.BINANCE_TESTNET_URL && process.env.BINANCE_TESTNET_KEY_ENC && process.env.BINANCE_TESTNET_SECRET_ENC);

describe.skipIf(!hasCredentials)('BinanceOrderClient (integration, real Binance Futures Testnet)', () => {
  // Constructed lazily (not at describe-body top level) — describe.skipIf still EXECUTES the
  // describe callback body to register test structure even when every test inside ends up
  // skipped, so anything relying on env vars that might be absent belongs in a getter/hook, not a
  // bare top-level const (which is exactly what broke here the first time: hasCredentials=false
  // still ran `new BinanceOrderClient(undefined!, ...)` and threw during collection).
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
});
