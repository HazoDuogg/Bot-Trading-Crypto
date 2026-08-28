import { describe, it, expect, beforeEach } from 'vitest';
import type { Direction } from '../entry/types.js';
import type { ExchangeOrderClient, OrderInfo, OrderStatus, SymbolFilters } from './exchangeOrderClient.js';
import { SymbolOrderLifecycle, type RiskResolverFn } from './orderLifecycle.js';
import type { DetectedFvgSignal } from './signalEngine.js';
import { resolveRiskPct, DEFAULT_RISK_CONFIG } from '../positionSizing/riskConfig.js';

// RT-077: onSignalDetected now calls an injected risk resolver instead of resolveRiskPct
// directly — this stub reproduces the OLD (pre-Soft-Veto) behavior exactly (MIDDLE tier, no
// adjustment) so every existing sizing assertion in this file stays valid unchanged.
const stubRiskResolver: RiskResolverFn = async (symbol, breaksKeyZone) => {
  const baseRiskPct = resolveRiskPct(symbol, breaksKeyZone, DEFAULT_RISK_CONFIG);
  return { baseRiskPct, adjustedRiskPct: baseRiskPct, tier: 'MIDDLE', predictedScore: 0.5 };
};

// Mock ExchangeOrderClient: full control over order status transitions, records every call for
// assertions (order placed with what qty/price, cancel called on the right order, etc.).
class MockExchangeOrderClient implements ExchangeOrderClient {
  balanceUsdt = 10000;
  leverage = 20;
  filters: SymbolFilters = { stepSize: 0.001, tickSize: 0.01, minNotional: 5 };
  nextOrderId = 1;
  orders = new Map<number, OrderInfo>();
  realizedPnlUsd = 0;
  cancelledOrderIds: number[] = [];
  placedOrders: { type: string; symbol: string; direction: Direction; qtyOrStop: number; price?: number }[] = [];

  async getAvailableBalanceUsdt(): Promise<number> {
    return this.balanceUsdt;
  }
  async getSymbolLeverage(): Promise<number> {
    return this.leverage;
  }
  async setLeverage(_symbol: string, leverage: number): Promise<void> {
    this.leverage = leverage;
  }
  async getSymbolFilters(): Promise<SymbolFilters> {
    return this.filters;
  }

  private makeOrder(symbol: string, side: 'BUY' | 'SELL', type: string, price: number, stopPrice: number, origQty: number): OrderInfo {
    const order: OrderInfo = { orderId: this.nextOrderId++, symbol, status: 'NEW', side, type, avgPrice: 0, executedQty: 0, origQty, price, stopPrice, updateTime: Date.now() };
    this.orders.set(order.orderId, order);
    return order;
  }

  async placeLimitEntryOrder(symbol: string, direction: Direction, quantity: number, price: number): Promise<OrderInfo> {
    this.placedOrders.push({ type: 'LIMIT', symbol, direction, qtyOrStop: quantity, price });
    return this.makeOrder(symbol, direction === 'LONG' ? 'BUY' : 'SELL', 'LIMIT', price, 0, quantity);
  }
  async placeStopMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    this.placedOrders.push({ type: 'STOP_MARKET', symbol, direction, qtyOrStop: stopPrice });
    return this.makeOrder(symbol, direction === 'LONG' ? 'SELL' : 'BUY', 'STOP_MARKET', 0, stopPrice, 0);
  }
  async placeTakeProfitMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    this.placedOrders.push({ type: 'TAKE_PROFIT_MARKET', symbol, direction, qtyOrStop: stopPrice });
    return this.makeOrder(symbol, direction === 'LONG' ? 'SELL' : 'BUY', 'TAKE_PROFIT_MARKET', 0, stopPrice, 0);
  }
  async getOrder(_symbol: string, orderId: number): Promise<OrderInfo> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`unknown order ${orderId}`);
    return o;
  }
  async cancelOrder(_symbol: string, orderId: number): Promise<void> {
    this.cancelledOrderIds.push(orderId);
    const o = this.orders.get(orderId);
    if (o) o.status = 'CANCELED';
  }
  async getRealizedPnlSince(): Promise<number> {
    return this.realizedPnlUsd;
  }
  async getOpenPositionQty(): Promise<number> {
    return 0;
  }
  async getOpenOrders(): Promise<OrderInfo[]> {
    return [];
  }

  // Test helpers
  setStatus(orderId: number, status: OrderStatus, avgPrice = 0, executedQty = 0) {
    const o = this.orders.get(orderId)!;
    o.status = status;
    if (avgPrice) o.avgPrice = avgPrice;
    if (executedQty) o.executedQty = executedQty;
  }
}

function makeSignal(overrides: Partial<DetectedFvgSignal> = {}): DetectedFvgSignal {
  return {
    type: 'FVG_DETECTED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    gapLow: 100,
    gapHigh: 101,
    invalidationPrice: 98,
    breaksKeyZone: false,
    detectedAtOpenTime: 0,
    atrH1Pct: 1.2,
    keyZoneDistancePct: 0.3,
    regime: { trend: 'UPTREND', trendAgeH1Candles: 5, atrPercentileH1: 50, distanceFromEma200H1Pct: 1 },
    ...overrides,
  };
}

describe('SymbolOrderLifecycle — full real-order state machine (mocked exchange)', () => {
  let client: MockExchangeOrderClient;
  let lifecycle: SymbolOrderLifecycle;

  beforeEach(() => {
    client = new MockExchangeOrderClient();
    lifecycle = new SymbolOrderLifecycle('BTCUSDT', client, stubRiskResolver);
  });

  it('starts IDLE/free', () => {
    expect(lifecycle.isFree()).toBe(true);
  });

  it('places a real LIMIT entry order on signal detection, using REAL balance/leverage (Part A)', async () => {
    client.balanceUsdt = 10000;
    const event = await lifecycle.onSignalDetected(makeSignal());
    expect(event.type).toBe('ENTRY_PLACED');
    expect(lifecycle.isFree()).toBe(false);
    expect(client.placedOrders).toHaveLength(1);
    expect(client.placedOrders[0].type).toBe('LIMIT');
    if (event.type === 'ENTRY_PLACED') {
      expect(event.balanceUsedUsdt).toBe(10000); // came from the mock's getAvailableBalanceUsdt, not hard-coded
      expect(event.direction).toBe('LONG');
      expect(event.entryPrice).toBe(100); // gapLow for LONG
      expect(event.slPrice).toBe(98);
      expect(event.tpPrice).toBeCloseTo(100 + 2.1 * 2, 6);
    }
  });

  // TICKET-RT-077: risk% actually used for sizing must be the SOFT-VETO-ADJUSTED value, not the
  // base risk% — TOP/BOTTOM/MIDDLE each verified end-to-end through the real wiring point.
  it('uses the resolver\'s ADJUSTED risk% (TOP tier, base+0.5pp) for both riskPct and riskUsd', async () => {
    client.balanceUsdt = 10000;
    const topResolver: RiskResolverFn = async () => ({ baseRiskPct: 0.015, adjustedRiskPct: 0.02, tier: 'TOP', predictedScore: 0.9 });
    const topLifecycle = new SymbolOrderLifecycle('BTCUSDT', client, topResolver);
    const event = await topLifecycle.onSignalDetected(makeSignal());
    expect(event.type).toBe('ENTRY_PLACED');
    if (event.type === 'ENTRY_PLACED') {
      expect(event.riskPct).toBe(0.02);
      expect(event.riskUsd).toBe(200);
      expect(event.softVeto).toEqual({ baseRiskPct: 0.015, adjustedRiskPct: 0.02, tier: 'TOP', predictedScore: 0.9 });
    }
  });

  it('uses the resolver\'s ADJUSTED risk% (BOTTOM tier, base-0.5pp) for both riskPct and riskUsd', async () => {
    client.balanceUsdt = 10000;
    const bottomResolver: RiskResolverFn = async () => ({ baseRiskPct: 0.015, adjustedRiskPct: 0.01, tier: 'BOTTOM', predictedScore: 0.1 });
    const bottomLifecycle = new SymbolOrderLifecycle('BTCUSDT', client, bottomResolver);
    const event = await bottomLifecycle.onSignalDetected(makeSignal());
    expect(event.type).toBe('ENTRY_PLACED');
    if (event.type === 'ENTRY_PLACED') {
      expect(event.riskPct).toBe(0.01);
      expect(event.riskUsd).toBe(100);
      expect(event.softVeto.tier).toBe('BOTTOM');
    }
  });

  it('uses the resolver\'s unchanged risk% (MIDDLE tier, no adjustment) for both riskPct and riskUsd', async () => {
    client.balanceUsdt = 10000;
    const event = await lifecycle.onSignalDetected(makeSignal()); // default beforeEach lifecycle uses stubRiskResolver (MIDDLE)
    expect(event.type).toBe('ENTRY_PLACED');
    if (event.type === 'ENTRY_PLACED') {
      expect(event.riskPct).toBe(0.015);
      expect(event.riskUsd).toBe(150);
      expect(event.softVeto.tier).toBe('MIDDLE');
    }
  });

  it('carries the SAME softVeto resolution through from ENTRY_PLACED to ENTRY_FILLED', async () => {
    client.balanceUsdt = 10000;
    const topResolver: RiskResolverFn = async () => ({ baseRiskPct: 0.015, adjustedRiskPct: 0.02, tier: 'TOP', predictedScore: 0.9 });
    const topLifecycle = new SymbolOrderLifecycle('BTCUSDT', client, topResolver);
    await topLifecycle.onSignalDetected(makeSignal());
    client.setStatus(1, 'FILLED', 100, 1);
    const event = await topLifecycle.onNewM15Candle();
    expect(event?.type).toBe('ENTRY_FILLED');
    if (event?.type === 'ENTRY_FILLED') {
      expect(event.softVeto).toEqual({ baseRiskPct: 0.015, adjustedRiskPct: 0.02, tier: 'TOP', predictedScore: 0.9 });
    }
  });

  it('skips (does not place an order) when slPct is below the production floor', async () => {
    // entry=100, invalidation=99.9 -> slPct=0.1%, well under DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor (0.5%)
    const event = await lifecycle.onSignalDetected(makeSignal({ gapLow: 100, gapHigh: 100.5, invalidationPrice: 99.9 }));
    expect(event.type).toBe('ENTRY_SKIPPED');
    expect(lifecycle.isFree()).toBe(true);
    expect(client.placedOrders).toHaveLength(0);
  });

  it('skips when the resulting notional is below the exchange minNotional', async () => {
    client.balanceUsdt = 1; // tiny balance -> tiny qty -> tiny notional
    const event = await lifecycle.onSignalDetected(makeSignal());
    expect(event.type).toBe('ENTRY_SKIPPED');
    if (event.type === 'ENTRY_SKIPPED') expect(event.reason).toContain('minNotional');
  });

  it('cancels the entry order after maxWaitCandles (20) ticks without a fill', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    let lastEvent = null;
    for (let i = 0; i < 20; i++) lastEvent = await lifecycle.onNewM15Candle(); // ticks 1..20, order stays NEW
    expect(lastEvent).not.toBeNull();
    expect(lastEvent?.type).toBe('ENTRY_TIMEOUT_CANCELLED');
    expect(lifecycle.isFree()).toBe(true);
    expect(client.cancelledOrderIds).toHaveLength(1);
  });

  it('does NOT cancel before maxWaitCandles is reached', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    for (let i = 0; i < 19; i++) {
      const e = await lifecycle.onNewM15Candle();
      expect(e).toBeNull();
    }
    expect(lifecycle.isFree()).toBe(false);
  });

  it('transitions to POSITION_OPEN and places REAL SL+TP orders when the entry order reports FILLED', async () => {
    const placeEvent = await lifecycle.onSignalDetected(makeSignal());
    const entryOrderId = placeEvent.type === 'ENTRY_PLACED' ? placeEvent.orderId : -1;
    client.setStatus(entryOrderId, 'FILLED', 100.02, client.orders.get(entryOrderId)!.origQty);

    const event = await lifecycle.onNewM15Candle();
    expect(event?.type).toBe('ENTRY_FILLED');
    if (event?.type === 'ENTRY_FILLED') {
      expect(event.entryPrice).toBe(100.02); // REAL avgPrice from the exchange, not the requested price
    }
    expect(client.placedOrders.some((o) => o.type === 'STOP_MARKET')).toBe(true);
    expect(client.placedOrders.some((o) => o.type === 'TAKE_PROFIT_MARKET')).toBe(true);
  });

  it('closes on TP fill, cancels the SL order, and reports REAL realized PnL from the API', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    const entryOrderId = 1;
    client.setStatus(entryOrderId, 'FILLED', 100, 1);
    await lifecycle.onNewM15Candle(); // -> POSITION_OPEN, places SL (id 2) and TP (id 3)

    client.realizedPnlUsd = 4.2;
    client.setStatus(3, 'FILLED', 102.1); // TP fills
    const event = await lifecycle.onNewM15Candle();

    expect(event?.type).toBe('POSITION_CLOSED');
    if (event?.type === 'POSITION_CLOSED') {
      expect(event.outcome).toBe('TP');
      expect(event.exitPrice).toBe(102.1);
      expect(event.realizedPnlUsd).toBe(4.2); // from getRealizedPnlSince — never hand-computed
      expect(event.bothOrdersReportedFilled).toBe(false);
    }
    expect(client.cancelledOrderIds).toContain(2); // the SL order was cancelled
    expect(lifecycle.isFree()).toBe(true);
  });

  it('closes on SL fill, cancels the TP order, and reports a loss', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    client.setStatus(1, 'FILLED', 100, 1);
    await lifecycle.onNewM15Candle(); // -> POSITION_OPEN, SL=id2, TP=id3

    client.realizedPnlUsd = -1.9;
    client.setStatus(2, 'FILLED', 97.5); // SL fills
    const event = await lifecycle.onNewM15Candle();

    expect(event?.type).toBe('POSITION_CLOSED');
    if (event?.type === 'POSITION_CLOSED') {
      expect(event.outcome).toBe('SL');
      expect(event.realizedPnlUsd).toBe(-1.9);
    }
    expect(client.cancelledOrderIds).toContain(3); // the TP order was cancelled
  });

  it('is free again (can detect a new signal) only after a position fully closes', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    expect(lifecycle.isFree()).toBe(false);
    client.setStatus(1, 'FILLED', 100, 1);
    await lifecycle.onNewM15Candle();
    expect(lifecycle.isFree()).toBe(false); // still open, just protected by SL/TP now
    client.setStatus(3, 'FILLED', 102);
    await lifecycle.onNewM15Candle();
    expect(lifecycle.isFree()).toBe(true);
  });

  it('reports LIFECYCLE_ERROR (does not throw) when getOrder fails, instead of crashing the caller', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    const originalGetOrder = client.getOrder.bind(client);
    client.getOrder = async () => {
      throw new Error('network blip');
    };
    const event = await lifecycle.onNewM15Candle();
    expect(event?.type).toBe('LIFECYCLE_ERROR');
    client.getOrder = originalGetOrder;
  });

  // TICKET-RT-070: reproduces the exact partial-failure bug. SL succeeds on the FIRST attempt; TP
  // fails on the first attempt then succeeds on the retry. The already-successful SL leg must NEVER
  // be re-requested, and its orderId must be the one from the FIRST call, not a new one.
  it('never re-places an already-successful SL order when TP fails and is retried (TICKET-RT-070)', async () => {
    await lifecycle.onSignalDetected(makeSignal());
    const entryOrderId = 1;
    client.setStatus(entryOrderId, 'FILLED', 100, 1);

    const originalPlaceTp = client.placeTakeProfitMarketCloseOrder.bind(client);
    let tpCallCount = 0;
    client.placeTakeProfitMarketCloseOrder = async (...args) => {
      tpCallCount++;
      if (tpCallCount === 1) throw new Error('simulated partial failure: TP placement rejected');
      return originalPlaceTp(...args);
    };

    // Tick 1: entry FILLED -> SL placed successfully (id 2), TP placement throws.
    const firstEvent = await lifecycle.onNewM15Candle();
    expect(firstEvent?.type).toBe('LIFECYCLE_ERROR');
    expect(lifecycle.isFree()).toBe(false); // stays open (PLACING_PROTECTION), not silently dropped

    const slCallsAfterFirstTick = client.placedOrders.filter((o) => o.type === 'STOP_MARKET').length;
    expect(slCallsAfterFirstTick).toBe(1); // SL was placed exactly once so far
    const slOrderIdAfterFirstTick = [...client.orders.values()].find((o) => o.type === 'STOP_MARKET')?.orderId;

    // Tick 2 (retry): only the missing TP leg should be requested; SL must NOT be called again.
    const secondEvent = await lifecycle.onNewM15Candle();
    expect(secondEvent?.type).toBe('ENTRY_FILLED');

    const slCallsTotal = client.placedOrders.filter((o) => o.type === 'STOP_MARKET').length;
    expect(slCallsTotal).toBe(1); // still exactly once across the whole retry sequence
    expect(tpCallCount).toBe(2); // TP: 1 failed attempt + 1 successful retry

    if (secondEvent?.type === 'ENTRY_FILLED') {
      expect(secondEvent.slOrderId).toBe(slOrderIdAfterFirstTick); // reused, not a fresh order
    }
    expect(lifecycle.isFree()).toBe(false); // now POSITION_OPEN
  });
});
