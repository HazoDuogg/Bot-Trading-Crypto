import type { TradePlan } from './tradePlan.js';

// TICKET-04X-P: separate trade-plan builder for the mean-reversion strategy — deliberately NOT
// added to tradePlan.ts (that file's createTradePlan is the D1-D8 5-coin entry's own plan builder).
export const MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE = 1.5;
export const MEAN_REVERSION_TP_R_MULTIPLE = 8 / 3;
// Time-stop is a distinct exit type from TP/SL, tracked separately downstream — not enforced here
// (this module only builds the plan; whatever runs the simulation owns closing at candle 40).
export const MEAN_REVERSION_TIME_STOP_M5_CANDLES = 40;

export interface MeanReversionTradePlanInput {
  signal: 'LONG' | 'SHORT';
  entryPrice: number;
  atr14: number;
  riskBudgetUsd: number;
  leverage: number;
  tickSize: number;
  lotSize: number;
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}

function floorToLotSize(value: number, lotSize: number): number {
  const steps = Math.floor(value / lotSize + 1e-9);
  return Number((steps * lotSize).toFixed(12));
}

// No SL floor by deliberate choice (TICKET-04X-P: option (a)) — every positive ATR is accepted as
// riskPerUnit, however small. ATR<=0 is rejected outright as an invalid input (would divide by
// zero building positionSize), not a "too tight" business floor.
export function createMeanReversionTradePlan(input: MeanReversionTradePlanInput): TradePlan | null {
  requirePositiveFinite(input.entryPrice, 'entryPrice');
  requirePositiveFinite(input.riskBudgetUsd, 'riskBudgetUsd');
  requirePositiveFinite(input.leverage, 'leverage');
  requirePositiveFinite(input.tickSize, 'tickSize');
  requirePositiveFinite(input.lotSize, 'lotSize');
  if (!Number.isFinite(input.atr14) || input.atr14 <= 0) {
    throw new Error('atr14 must be positive and finite (ATR=0 would divide by zero building positionSize)');
  }

  const riskPerUnit = MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE * input.atr14;
  const sign = input.signal === 'LONG' ? 1 : -1;
  const stopLoss = input.entryPrice - sign * riskPerUnit;
  const takeProfit = input.entryPrice + sign * MEAN_REVERSION_TP_R_MULTIPLE * riskPerUnit;

  const positionSize = floorToLotSize(input.riskBudgetUsd / riskPerUnit, input.lotSize);
  if (positionSize <= 0) return null; // rounds below one lot at this ATR/riskBudget combination

  const requiredMargin = (positionSize * input.entryPrice) / input.leverage;

  return {
    direction: input.signal === 'LONG' ? 'BULL' : 'BEAR',
    entryPrice: input.entryPrice,
    stopLoss,
    takeProfit,
    riskPerUnit,
    positionSize,
    requiredMargin,
  };
}
