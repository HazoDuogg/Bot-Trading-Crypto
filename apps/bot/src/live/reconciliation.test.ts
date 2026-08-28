import { describe, it, expect } from 'vitest';
import { classifyReconciliation } from './reconciliation.js';
import type { OrderInfo } from './exchangeOrderClient.js';

const TARGET_R = 2.1;

function order(overrides: Partial<OrderInfo>): OrderInfo {
  return { orderId: 1, symbol: 'BTCUSDT', status: 'NEW', side: 'SELL', type: 'STOP_MARKET', avgPrice: 0, executedQty: 0, origQty: 0, price: 0, stopPrice: 0, updateTime: 0, ...overrides };
}

describe('classifyReconciliation', () => {
  it('case 4: no position, no orders -> IDLE', () => {
    expect(classifyReconciliation(0, 0, [], TARGET_R)).toEqual({ kind: 'IDLE' });
  });

  it('case 1: position open + exactly 1 SL + 1 TP -> POSITION_OPEN with real orderIds', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET', stopPrice: 98 }), order({ orderId: 11, type: 'TAKE_PROFIT_MARKET', stopPrice: 104.2 })];
    const plan = classifyReconciliation(1.5, 100, openOrders, TARGET_R);
    expect(plan).toEqual({ kind: 'POSITION_OPEN', direction: 'LONG', entryPrice: 100, quantity: 1.5, slOrderId: 10, tpOrderId: 11 });
  });

  it('case 1: SHORT position (negative qty) -> direction SHORT, quantity is the absolute value', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET', stopPrice: 102 }), order({ orderId: 11, type: 'TAKE_PROFIT_MARKET', stopPrice: 95.8 })];
    const plan = classifyReconciliation(-1.5, 100, openOrders, TARGET_R);
    expect(plan).toEqual({ kind: 'POSITION_OPEN', direction: 'SHORT', entryPrice: 100, quantity: 1.5, slOrderId: 10, tpOrderId: 11 });
  });

  it('case 2: position open, SL exists but TP missing -> PLACING_PROTECTION, tpPrice reconstructed via targetR formula', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET', stopPrice: 98 })];
    const plan = classifyReconciliation(1, 100, openOrders, TARGET_R);
    expect(plan.kind).toBe('PLACING_PROTECTION');
    if (plan.kind === 'PLACING_PROTECTION') {
      expect(plan.slOrderId).toBe(10);
      expect(plan.tpOrderId).toBeNull();
      expect(plan.slPrice).toBe(98);
      expect(plan.tpPrice).toBeCloseTo(100 + TARGET_R * 2, 6); // entry + targetR * slDistance
    }
  });

  it('case 2: position open, TP exists but SL missing -> PLACING_PROTECTION, slPrice reconstructed via targetR formula', () => {
    const openOrders = [order({ orderId: 11, type: 'TAKE_PROFIT_MARKET', stopPrice: 104.2 })];
    const plan = classifyReconciliation(1, 100, openOrders, TARGET_R);
    expect(plan.kind).toBe('PLACING_PROTECTION');
    if (plan.kind === 'PLACING_PROTECTION') {
      expect(plan.tpOrderId).toBe(11);
      expect(plan.slOrderId).toBeNull();
      expect(plan.tpPrice).toBe(104.2);
      expect(plan.slPrice).toBeCloseTo(100 - 4.2 / TARGET_R, 6);
    }
  });

  it('case 2: SHORT position, SL exists but TP missing -> tpPrice reconstructed below entry', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET', stopPrice: 102 })];
    const plan = classifyReconciliation(-1, 100, openOrders, TARGET_R);
    expect(plan.kind).toBe('PLACING_PROTECTION');
    if (plan.kind === 'PLACING_PROTECTION') {
      expect(plan.direction).toBe('SHORT');
      expect(plan.tpPrice).toBeCloseTo(100 - TARGET_R * 2, 6);
    }
  });

  it('case 3: no position, exactly 1 pending LIMIT order -> CANCEL_PENDING_ENTRY', () => {
    const openOrders = [order({ orderId: 20, type: 'LIMIT', price: 99.5 })];
    expect(classifyReconciliation(0, 0, openOrders, TARGET_R)).toEqual({ kind: 'CANCEL_PENDING_ENTRY', orderId: 20 });
  });

  it('case 5: position open, NEITHER SL nor TP exists -> BLOCKED (no anchor to reconstruct either price)', () => {
    const plan = classifyReconciliation(1, 100, [], TARGET_R);
    expect(plan.kind).toBe('BLOCKED');
  });

  it('case 5: position open, more than 1 SL order -> BLOCKED (anomalous)', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET' }), order({ orderId: 12, type: 'STOP_MARKET' }), order({ orderId: 11, type: 'TAKE_PROFIT_MARKET' })];
    expect(classifyReconciliation(1, 100, openOrders, TARGET_R).kind).toBe('BLOCKED');
  });

  it('case 5: position open, an unexpected order type present -> BLOCKED (anomalous)', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET' }), order({ orderId: 11, type: 'TAKE_PROFIT_MARKET' }), order({ orderId: 30, type: 'LIMIT' })];
    expect(classifyReconciliation(1, 100, openOrders, TARGET_R).kind).toBe('BLOCKED');
  });

  it('case 5: no position, an orphaned SL/TP algo order exists -> BLOCKED (anomalous)', () => {
    const openOrders = [order({ orderId: 10, type: 'STOP_MARKET' })];
    expect(classifyReconciliation(0, 0, openOrders, TARGET_R).kind).toBe('BLOCKED');
  });

  it('case 5: no position, more than 1 pending LIMIT order -> BLOCKED (ambiguous which is the real entry)', () => {
    const openOrders = [order({ orderId: 20, type: 'LIMIT' }), order({ orderId: 21, type: 'LIMIT' })];
    expect(classifyReconciliation(0, 0, openOrders, TARGET_R).kind).toBe('BLOCKED');
  });
});
