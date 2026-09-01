import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';

export const M15_CANDLE_DURATION_MS = 15 * 60 * 1000;

export interface IntrabarExecutionInput {
  tradePlan: TradePlan;
  entryFillTimestamp: number;
  m1Candles: readonly Candle[];
}

export interface IntrabarExecutionResult {
  outcome: 'WIN' | 'LOSS' | 'AMBIGUOUS' | 'OPEN';
  exitTimestamp?: number;
  exitPrice?: number;
  bestCase?: { outcome: 'WIN'; exitPrice: number };
  worstCase?: { outcome: 'LOSS'; exitPrice: number };
  m1CandlesConsumed: number;
}

// M15 open times are UTC epoch milliseconds; a closed-candle decision becomes causal at its close.
export function mapM15ClosedCandleToExecutionStart(m15OpenTime: number): number {
  if (!Number.isSafeInteger(m15OpenTime) || m15OpenTime < 0) {
    throw new Error('m15OpenTime must be a non-negative UTC epoch millisecond timestamp');
  }
  return m15OpenTime + M15_CANDLE_DURATION_MS - 1;
}

function validatePlan(plan: TradePlan): void {
  const values = [plan.entryPrice, plan.stopLoss, plan.takeProfit, plan.positionSize];
  if (values.some((value) => !Number.isFinite(value)) || plan.positionSize <= 0) {
    throw new Error('Trade plan prices and positionSize must be finite');
  }
  if (plan.direction === 'BULL') {
    if (!(plan.stopLoss < plan.entryPrice && plan.entryPrice < plan.takeProfit)) {
      throw new Error('BULL plan must have stopLoss < entryPrice < takeProfit');
    }
  } else if (!(plan.takeProfit < plan.entryPrice && plan.entryPrice < plan.stopLoss)) {
    throw new Error('BEAR plan must have takeProfit < entryPrice < stopLoss');
  }
}

export function simulateIntrabarExecution(
  input: IntrabarExecutionInput,
): IntrabarExecutionResult {
  validatePlan(input.tradePlan);
  if (!Number.isSafeInteger(input.entryFillTimestamp) || input.entryFillTimestamp < 0) {
    throw new Error('entryFillTimestamp must be a non-negative UTC epoch millisecond timestamp');
  }

  let consumed = 0;
  for (let index = 0; index < input.m1Candles.length; index += 1) {
    const current = input.m1Candles[index];
    if (current.openTime <= input.entryFillTimestamp) continue;
    consumed += 1;

    const hitStop = current.low <= input.tradePlan.stopLoss && current.high >= input.tradePlan.stopLoss;
    const hitTarget =
      current.low <= input.tradePlan.takeProfit && current.high >= input.tradePlan.takeProfit;
    if (hitStop && hitTarget) {
      return {
        outcome: 'AMBIGUOUS',
        exitTimestamp: current.openTime,
        bestCase: { outcome: 'WIN', exitPrice: input.tradePlan.takeProfit },
        worstCase: { outcome: 'LOSS', exitPrice: input.tradePlan.stopLoss },
        m1CandlesConsumed: consumed,
      };
    }
    if (hitTarget) {
      return {
        outcome: 'WIN',
        exitTimestamp: current.openTime,
        exitPrice: input.tradePlan.takeProfit,
        m1CandlesConsumed: consumed,
      };
    }
    if (hitStop) {
      return {
        outcome: 'LOSS',
        exitTimestamp: current.openTime,
        exitPrice: input.tradePlan.stopLoss,
        m1CandlesConsumed: consumed,
      };
    }
  }

  return { outcome: 'OPEN', m1CandlesConsumed: consumed };
}
