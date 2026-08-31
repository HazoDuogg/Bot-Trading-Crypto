import { isValidM1Candle } from './m1Candle.js';
import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import type { PendingLimitOrder } from './pendingLimitLifecycle.js';
import type { CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

export type M1VariantOutcome = 'OPEN' | 'WIN' | 'LOSS' | 'AMBIGUOUS';

interface M1ExecutionBase {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  targets: { '1.5R': number; '2.0R': number };
  createdAtMs: number;
  tradingDay: string;
}

export type M1ExecutionReplayResult =
  | (M1ExecutionBase & { state: 'PENDING' })
  | (M1ExecutionBase & { state: 'CANCELLED'; cancelledAtMs: number })
  | (M1ExecutionBase & {
      state: 'FILLED';
      filledAtMs: number;
      fillPrice: number;
      variants: { '1.5R': M1VariantOutcome; '2.0R': M1VariantOutcome };
    })
  | {
      state: 'INVALID';
      reason:
        | 'INVALID_PENDING_ORDER'
        | 'PLAN_ORDER_MISMATCH'
        | 'INVALID_ACTIVATION_TIME'
        | 'INVALID_M1_DATA'
        | 'NON_CHRONOLOGICAL_M1';
    };

export interface ReplayCasperM1ExecutionInput {
  tradePlan: CasperTradePlan;
  pendingOrder: PendingLimitOrder;
  candles: readonly CasperCandle[];
}

function sessionCutoffMs(createdAtMs: number, tradingDay: string): number | null {
  const created = getNewYorkTimeParts(createdAtMs);
  if (!created || created.tradingDay !== tradingDay) return null;
  const remainingMinutes = 12 * 60 - minuteOfDay(created);
  return createdAtMs + remainingMinutes * 60_000 - created.second * 1000;
}

function matchesPlan(plan: CasperTradePlan, order: PendingLimitOrder): boolean {
  if (order.state === 'INVALID') return false;
  return (
    order.direction === plan.direction &&
    order.entry === plan.entry &&
    order.stopLoss === plan.stopLoss &&
    order.targets['1.5R'] === plan.targets['1.5R'] &&
    order.targets['2.0R'] === plan.targets['2.0R'] &&
    order.createdAtMs === plan.sourceCandles.c3.endTimeMs &&
    order.tradingDay === plan.tradingDay
  );
}

function touchesStop(direction: 'LONG' | 'SHORT', candle: CasperCandle, stop: number) {
  return direction === 'LONG' ? candle.low <= stop : candle.high >= stop;
}

function touchesTarget(direction: 'LONG' | 'SHORT', candle: CasperCandle, target: number) {
  return direction === 'LONG' ? candle.high >= target : candle.low <= target;
}

function fillCandleOutcome(stopTouched: boolean, targetTouched: boolean): M1VariantOutcome {
  return stopTouched || targetTouched ? 'AMBIGUOUS' : 'OPEN';
}

function nextOutcome(
  current: M1VariantOutcome,
  stopTouched: boolean,
  targetTouched: boolean,
): M1VariantOutcome {
  if (current !== 'OPEN') return current;
  if (stopTouched && targetTouched) return 'AMBIGUOUS';
  if (stopTouched) return 'LOSS';
  if (targetTouched) return 'WIN';
  return 'OPEN';
}

export function replayCasperM1Execution(
  input: ReplayCasperM1ExecutionInput,
): M1ExecutionReplayResult {
  const { tradePlan, pendingOrder, candles } = input;
  if (pendingOrder.state === 'INVALID') {
    return { state: 'INVALID', reason: 'INVALID_PENDING_ORDER' };
  }
  if (!matchesPlan(tradePlan, pendingOrder)) {
    return { state: 'INVALID', reason: 'PLAN_ORDER_MISMATCH' };
  }

  const base: M1ExecutionBase = {
    direction: tradePlan.direction,
    entry: tradePlan.entry,
    stopLoss: tradePlan.stopLoss,
    targets: tradePlan.targets,
    createdAtMs: pendingOrder.createdAtMs,
    tradingDay: tradePlan.tradingDay,
  };
  const cutoffMs = sessionCutoffMs(base.createdAtMs, base.tradingDay);
  if (cutoffMs === null || cutoffMs <= base.createdAtMs) {
    return { state: 'INVALID', reason: 'INVALID_ACTIVATION_TIME' };
  }
  if (!candles.every((candle) => isValidM1Candle(candle, base.tradingDay))) {
    return { state: 'INVALID', reason: 'INVALID_M1_DATA' };
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].startTimeMs <= candles[index - 1].startTimeMs) {
      return { state: 'INVALID', reason: 'NON_CHRONOLOGICAL_M1' };
    }
  }

  let filledAtMs: number | null = null;
  let onePointFive: M1VariantOutcome = 'OPEN';
  let twoPointZero: M1VariantOutcome = 'OPEN';

  for (const candle of candles) {
    if (candle.startTimeMs < base.createdAtMs) continue;
    if (filledAtMs === null) {
      if (candle.endTimeMs >= cutoffMs) {
        return { ...base, state: 'CANCELLED', cancelledAtMs: cutoffMs };
      }
      if (candle.low > base.entry || candle.high < base.entry) continue;
      filledAtMs = candle.endTimeMs;
      const stopTouched = touchesStop(base.direction, candle, base.stopLoss);
      onePointFive = fillCandleOutcome(
        stopTouched,
        touchesTarget(base.direction, candle, base.targets['1.5R']),
      );
      twoPointZero = fillCandleOutcome(
        stopTouched,
        touchesTarget(base.direction, candle, base.targets['2.0R']),
      );
      continue;
    }

    const stopTouched = touchesStop(base.direction, candle, base.stopLoss);
    onePointFive = nextOutcome(
      onePointFive,
      stopTouched,
      touchesTarget(base.direction, candle, base.targets['1.5R']),
    );
    twoPointZero = nextOutcome(
      twoPointZero,
      stopTouched,
      touchesTarget(base.direction, candle, base.targets['2.0R']),
    );
  }

  if (filledAtMs === null) return { ...base, state: 'PENDING' };
  return {
    ...base,
    state: 'FILLED',
    filledAtMs,
    fillPrice: base.entry,
    variants: { '1.5R': onePointFive, '2.0R': twoPointZero },
  };
}
