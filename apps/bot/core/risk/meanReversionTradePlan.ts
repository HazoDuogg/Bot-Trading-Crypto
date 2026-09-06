import type { TradePlan } from './tradePlan.js';

// TICKET-04X-P: separate trade-plan builder for the mean-reversion strategy — deliberately NOT
// added to tradePlan.ts (that file's createTradePlan is the D1-D8 5-coin entry's own plan builder).
export const MEAN_REVERSION_RISK_PER_UNIT_ATR_MULTIPLE = 1.5;
export const MEAN_REVERSION_TP_R_MULTIPLE = 8 / 3;
// Time-stop is a distinct exit type from TP/SL, tracked separately downstream — not enforced here
// (this module only builds the plan; whatever runs the simulation owns closing at candle 40).
export const MEAN_REVERSION_TIME_STOP_M5_CANDLES = 40;
// Canonical home for the "too tight to be economically meaningful" tick count locked in
// TICKET-04X-O — slDistanceComparison.ts imports it from here (not the reverse: that file runs
// `await main()` at module scope, so importing it anywhere else would trigger its whole 3y CSV
// analysis as a side effect).
export const TOO_TIGHT_TICK_COUNT = 3;

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

// SL floor (TICKET-04X-P: option (b), corrected from an earlier wrong (a) implementation) — reuses
// TICKET-04X-O's own locked "too tight" tick count so this and slDistanceComparison.ts can never
// independently drift to two different "3"s. riskPerUnit < TOO_TIGHT_TICK_COUNT*tickSize returns
// null (a filtered-out signal, same class as positionSize<=0 below) — NOT a thrown error, since the
// inputs themselves are valid, the resulting SL is just too tight to be economically meaningful.
// ATR<=0 is still a thrown error: an invalid input that would divide by zero building positionSize,
// a different failure class from "valid ATR, SL floor not cleared".
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
  if (riskPerUnit < TOO_TIGHT_TICK_COUNT * input.tickSize) return null; // SL too tight (TICKET-04X-O floor)

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
