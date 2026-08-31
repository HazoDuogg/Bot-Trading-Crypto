import type { BreakoutFvgResult } from './breakoutFvg.js';
import type { CasperCandle } from './types.js';

export interface CasperTradePlan {
  state: 'VALID_TRADE_PLAN';
  direction: 'LONG' | 'SHORT';
  entryType: 'LIMIT';
  entry: number;
  stopLoss: number;
  riskPerUnit: number;
  targets: { '1.5R': number; '2.0R': number };
  fvgLow: number;
  fvgHigh: number;
  tradingDay: string;
  sourceCandles: { c1: CasperCandle; c2: CasperCandle; c3: CasperCandle };
}

export type CasperTradePlanResult =
  | CasperTradePlan
  | { state: 'INVALID_TRADE_PLAN'; reason: 'NON_VALID_FVG' | 'INVALID_RISK' };

export function createCasperTradePlan(fvg: BreakoutFvgResult): CasperTradePlanResult {
  if (fvg.state !== 'VALID_BULLISH_FVG' && fvg.state !== 'VALID_BEARISH_FVG') {
    return { state: 'INVALID_TRADE_PLAN', reason: 'NON_VALID_FVG' };
  }

  const isLong = fvg.state === 'VALID_BULLISH_FVG';
  const entry = isLong ? fvg.fvgLow : fvg.fvgHigh;
  const stopLoss = isLong ? fvg.c1.low : fvg.c1.high;
  const riskPerUnit = Math.abs(entry - stopLoss);
  const validRisk =
    Number.isFinite(riskPerUnit) &&
    riskPerUnit > 0 &&
    (isLong ? entry > stopLoss : entry < stopLoss);
  if (!validRisk) return { state: 'INVALID_TRADE_PLAN', reason: 'INVALID_RISK' };

  return {
    state: 'VALID_TRADE_PLAN',
    direction: isLong ? 'LONG' : 'SHORT',
    entryType: 'LIMIT',
    entry,
    stopLoss,
    riskPerUnit,
    targets: {
      '1.5R': isLong ? entry + 1.5 * riskPerUnit : entry - 1.5 * riskPerUnit,
      '2.0R': isLong ? entry + 2 * riskPerUnit : entry - 2 * riskPerUnit,
    },
    fvgLow: fvg.fvgLow,
    fvgHigh: fvg.fvgHigh,
    tradingDay: fvg.tradingDay,
    sourceCandles: { c1: fvg.c1, c2: fvg.c2, c3: fvg.c3 },
  };
}
