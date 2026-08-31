import { isValidClosedM5Candle } from './m5Candle.js';
import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import type { CasperTradePlanResult } from './tradePlan.js';
import type { CasperCandle } from './types.js';

interface PendingLimitData {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  targets: { '1.5R': number; '2.0R': number };
  createdAtMs: number;
  tradingDay: string;
}

export type PendingLimitOrder =
  | (PendingLimitData & { state: 'PENDING' })
  | (PendingLimitData & { state: 'FILLED'; filledAtMs: number; fillPrice: number })
  | (PendingLimitData & { state: 'CANCELLED'; cancelledAtMs: number })
  | {
      state: 'INVALID';
      reason:
        | 'INVALID_TRADE_PLAN'
        | 'INVALID_ACTIVATION_TIME'
        | 'PRE_ACTIVATION_CANDLE'
        | 'INVALID_CANDLE';
    };

export function createPendingLimitOrder(plan: CasperTradePlanResult): PendingLimitOrder {
  if (plan.state !== 'VALID_TRADE_PLAN') {
    return { state: 'INVALID', reason: 'INVALID_TRADE_PLAN' };
  }
  return {
    state: 'PENDING',
    direction: plan.direction,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    targets: plan.targets,
    createdAtMs: plan.sourceCandles.c3.endTimeMs,
    tradingDay: plan.tradingDay,
  };
}

function sessionCutoffMs(order: PendingLimitData): number | null {
  const created = getNewYorkTimeParts(order.createdAtMs);
  if (!created || created.tradingDay !== order.tradingDay) return null;
  const remainingMinutes = 12 * 60 - minuteOfDay(created);
  return order.createdAtMs + remainingMinutes * 60_000 - created.second * 1000;
}

export function evaluatePendingLimitOrder(
  order: PendingLimitOrder,
  candle: CasperCandle,
  nowMs: number,
): PendingLimitOrder {
  if (order.state !== 'PENDING') return order;

  const cutoffMs = sessionCutoffMs(order);
  const now = getNewYorkTimeParts(nowMs);
  if (cutoffMs === null || cutoffMs <= order.createdAtMs) {
    return { state: 'INVALID', reason: 'INVALID_ACTIVATION_TIME' };
  }
  if (
    !now ||
    now.tradingDay !== order.tradingDay ||
    !isValidClosedM5Candle(candle, nowMs, order.tradingDay)
  ) {
    return { state: 'INVALID', reason: 'INVALID_CANDLE' };
  }
  if (candle.startTimeMs < order.createdAtMs) {
    return { state: 'INVALID', reason: 'PRE_ACTIVATION_CANDLE' };
  }
  if (nowMs >= cutoffMs || candle.endTimeMs >= cutoffMs) {
    return { ...order, state: 'CANCELLED', cancelledAtMs: cutoffMs };
  }

  const touched = candle.low <= order.entry && candle.high >= order.entry;
  if (!touched) return order;
  return {
    ...order,
    state: 'FILLED',
    filledAtMs: candle.endTimeMs,
    fillPrice: order.entry,
  };
}
