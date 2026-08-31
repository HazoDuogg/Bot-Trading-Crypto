import type { M1ExecutionReplayResult, M1VariantOutcome } from './m1ExecutionReplay.js';
import type { CasperTradePlan } from './tradePlan.js';

export interface CasperCostConfig {
  entryFeeRate: number;
  exitFeeRate: number;
  entrySlippageRate: number;
  exitSlippageRate: number;
}

export type CasperRrVariant = '1.5R' | '2.0R';

export type CasperCostAccountingResult =
  | {
      state: 'ACCOUNTED';
      variant: CasperRrVariant;
      outcome: 'WIN' | 'LOSS';
      direction: 'LONG' | 'SHORT';
      entryPrice: number;
      exitPrice: number;
      effectiveEntryPrice: number;
      effectiveExitPrice: number;
      grossR: number;
      netR: number;
      entryFeePerUnit: number;
      exitFeePerUnit: number;
      feePerUnit: number;
      slippageImpactPerUnit: number;
      grossPnlPerUnit: number;
      netPnlPerUnit: number;
    }
  | {
      state: 'UNRESOLVED';
      variant: CasperRrVariant;
      outcome: 'OPEN' | 'AMBIGUOUS' | 'PENDING' | 'CANCELLED' | 'INVALID';
    }
  | {
      state: 'INVALID';
      reason: 'INVALID_COST_CONFIG' | 'INVALID_TRADE_DATA' | 'PLAN_EXECUTION_MISMATCH';
    };

export interface AccountCasperNetPnlInput {
  tradePlan: CasperTradePlan;
  execution: M1ExecutionReplayResult;
  variant: CasperRrVariant;
  costs: CasperCostConfig;
}

function validCosts(costs: CasperCostConfig): boolean {
  const rates = [
    costs.entryFeeRate,
    costs.exitFeeRate,
    costs.entrySlippageRate,
    costs.exitSlippageRate,
  ];
  return rates.every((rate) => Number.isFinite(rate) && rate >= 0);
}

function sameNumber(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 64 * scale;
}

function validPlan(plan: CasperTradePlan): boolean {
  const prices = [
    plan.entry,
    plan.stopLoss,
    plan.riskPerUnit,
    plan.targets['1.5R'],
    plan.targets['2.0R'],
  ];
  const direction = plan.direction === 'LONG' ? 1 : -1;
  return (
    prices.every((price) => Number.isFinite(price) && price > 0) &&
    plan.riskPerUnit > 0 &&
    (plan.direction === 'LONG' ? plan.entry > plan.stopLoss : plan.entry < plan.stopLoss) &&
    sameNumber(plan.riskPerUnit, Math.abs(plan.entry - plan.stopLoss)) &&
    sameNumber(plan.targets['1.5R'], plan.entry + direction * 1.5 * plan.riskPerUnit) &&
    sameNumber(plan.targets['2.0R'], plan.entry + direction * 2 * plan.riskPerUnit)
  );
}

function matchesExecution(plan: CasperTradePlan, execution: M1ExecutionReplayResult): boolean {
  if (execution.state === 'INVALID') return true;
  return (
    execution.direction === plan.direction &&
    execution.entry === plan.entry &&
    execution.stopLoss === plan.stopLoss &&
    execution.targets['1.5R'] === plan.targets['1.5R'] &&
    execution.targets['2.0R'] === plan.targets['2.0R'] &&
    execution.tradingDay === plan.tradingDay &&
    (execution.state !== 'FILLED' || execution.fillPrice === plan.entry)
  );
}

function unresolvedOutcome(
  execution: M1ExecutionReplayResult,
  variant: CasperRrVariant,
): M1VariantOutcome | 'PENDING' | 'CANCELLED' | 'INVALID' {
  if (execution.state === 'FILLED') return execution.variants[variant];
  return execution.state;
}

export function accountCasperNetPnl(
  input: AccountCasperNetPnlInput,
): CasperCostAccountingResult {
  const { tradePlan, execution, variant, costs } = input;
  if (!validCosts(costs)) return { state: 'INVALID', reason: 'INVALID_COST_CONFIG' };
  if (!validPlan(tradePlan)) return { state: 'INVALID', reason: 'INVALID_TRADE_DATA' };
  if (!matchesExecution(tradePlan, execution)) {
    return { state: 'INVALID', reason: 'PLAN_EXECUTION_MISMATCH' };
  }

  const outcome = unresolvedOutcome(execution, variant);
  if (outcome !== 'WIN' && outcome !== 'LOSS') {
    return { state: 'UNRESOLVED', variant, outcome };
  }

  const isLong = tradePlan.direction === 'LONG';
  const entryPrice = tradePlan.entry;
  const exitPrice = outcome === 'WIN' ? tradePlan.targets[variant] : tradePlan.stopLoss;
  const grossR = outcome === 'WIN' ? (variant === '1.5R' ? 1.5 : 2) : -1;
  const effectiveEntryPrice = isLong
    ? entryPrice * (1 + costs.entrySlippageRate)
    : entryPrice * (1 - costs.entrySlippageRate);
  const effectiveExitPrice = isLong
    ? exitPrice * (1 - costs.exitSlippageRate)
    : exitPrice * (1 + costs.exitSlippageRate);
  const grossPnlPerUnit = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
  const slippedPnlPerUnit = isLong
    ? effectiveExitPrice - effectiveEntryPrice
    : effectiveEntryPrice - effectiveExitPrice;
  const slippageImpactPerUnit = grossPnlPerUnit - slippedPnlPerUnit;
  const entryFeePerUnit = Math.abs(entryPrice) * costs.entryFeeRate;
  const exitFeePerUnit = Math.abs(exitPrice) * costs.exitFeeRate;
  const feePerUnit = entryFeePerUnit + exitFeePerUnit;
  const netPnlPerUnit = slippedPnlPerUnit - feePerUnit;
  const netR = netPnlPerUnit / tradePlan.riskPerUnit;

  return {
    state: 'ACCOUNTED',
    variant,
    outcome,
    direction: tradePlan.direction,
    entryPrice,
    exitPrice,
    effectiveEntryPrice,
    effectiveExitPrice,
    grossR,
    netR,
    entryFeePerUnit,
    exitFeePerUnit,
    feePerUnit,
    slippageImpactPerUnit,
    grossPnlPerUnit,
    netPnlPerUnit,
  };
}
