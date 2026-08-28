import type { Direction } from '../entry/types.js';
import type { OrderInfo } from './exchangeOrderClient.js';

// TICKET-RT-078: classifies what a symbol's REAL exchange state means for this process's
// in-memory lifecycle state after a restart, so liveRunner.ts can restore the right phase instead
// of always blanket-blocking the symbol. Pure — no I/O, fully unit-testable. The actual
// restoration (calling SymbolOrderLifecycle.restore*/cancelOrder) happens in liveRunner.ts.

export type ReconciliationPlan =
  | { kind: 'IDLE' }
  | { kind: 'POSITION_OPEN'; direction: Direction; entryPrice: number; quantity: number; slOrderId: number; tpOrderId: number }
  | { kind: 'PLACING_PROTECTION'; direction: Direction; entryPrice: number; quantity: number; slPrice: number; tpPrice: number; slOrderId: number | null; tpOrderId: number | null }
  | { kind: 'CANCEL_PENDING_ENTRY'; orderId: number }
  | { kind: 'BLOCKED'; reason: string };

// Both SL and TP were always placed as entryPrice +/- targetRMultiple * slDistance (see
// orderLifecycle.ts's onSignalDetected) — a fixed, deterministic relationship. When exactly ONE
// leg's real trigger price is known (the other missing), that formula lets the missing leg's
// intended price be reconstructed exactly, not guessed. When BOTH are missing there is no anchor
// at all, so no reconstruction is attempted (falls through to BLOCKED).
export function classifyReconciliation(positionQty: number, entryPrice: number, openOrders: OrderInfo[], targetRMultiple: number): ReconciliationPlan {
  if (positionQty !== 0) {
    const direction: Direction = positionQty > 0 ? 'LONG' : 'SHORT';
    const quantity = Math.abs(positionQty);
    const slOrders = openOrders.filter((o) => o.type === 'STOP_MARKET');
    const tpOrders = openOrders.filter((o) => o.type === 'TAKE_PROFIT_MARKET');
    const otherOrders = openOrders.filter((o) => o.type !== 'STOP_MARKET' && o.type !== 'TAKE_PROFIT_MARKET');

    if (otherOrders.length > 0 || slOrders.length > 1 || tpOrders.length > 1) {
      return { kind: 'BLOCKED', reason: `Co vi the nhung du lieu lenh bat thuong: ${slOrders.length} SL, ${tpOrders.length} TP, ${otherOrders.length} lenh khac.` };
    }
    if (slOrders.length === 1 && tpOrders.length === 1) {
      return { kind: 'POSITION_OPEN', direction, entryPrice, quantity, slOrderId: slOrders[0].orderId, tpOrderId: tpOrders[0].orderId };
    }
    if (slOrders.length === 1) {
      const slPrice = slOrders[0].stopPrice;
      const slDistance = Math.abs(entryPrice - slPrice);
      const tpPrice = direction === 'LONG' ? entryPrice + targetRMultiple * slDistance : entryPrice - targetRMultiple * slDistance;
      return { kind: 'PLACING_PROTECTION', direction, entryPrice, quantity, slPrice, tpPrice, slOrderId: slOrders[0].orderId, tpOrderId: null };
    }
    if (tpOrders.length === 1) {
      const tpPrice = tpOrders[0].stopPrice;
      const slDistance = Math.abs(tpPrice - entryPrice) / targetRMultiple;
      const slPrice = direction === 'LONG' ? entryPrice - slDistance : entryPrice + slDistance;
      return { kind: 'PLACING_PROTECTION', direction, entryPrice, quantity, slPrice, tpPrice, slOrderId: null, tpOrderId: tpOrders[0].orderId };
    }
    return { kind: 'BLOCKED', reason: 'Co vi the nhung KHONG co ca SL lan TP — khong co gia neo nao de suy ra lai gia du kien.' };
  }

  const limitOrders = openOrders.filter((o) => o.type === 'LIMIT');
  const algoOrders = openOrders.filter((o) => o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET');

  if (algoOrders.length > 0) {
    return { kind: 'BLOCKED', reason: `Khong co vi the nhung con ${algoOrders.length} lenh SL/TP mo coi (khong gan voi vi the nao).` };
  }
  if (limitOrders.length === 1) {
    return { kind: 'CANCEL_PENDING_ENTRY', orderId: limitOrders[0].orderId };
  }
  if (limitOrders.length === 0) {
    return { kind: 'IDLE' };
  }
  return { kind: 'BLOCKED', reason: `${limitOrders.length} lenh LIMIT dang cho cung luc — khong ro cai nao la entry that.` };
}
