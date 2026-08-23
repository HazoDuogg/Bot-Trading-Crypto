export type Direction = 'LONG' | 'SHORT';

export interface PositionSizingInput {
  balance: number;
  riskUsd: number; // maximum desired risk, per spec — not a guaranteed floor
  entryPrice: number;
  slPrice: number;
  leverage: number;
  maxMarginPct: number; // per-trade margin cap as a fraction of balance, e.g. 0.3 = 30%
}

export interface PositionSizingResult {
  qty: number; // unrounded — LOT_SIZE/MIN_NOTIONAL normalization happens in a later step (5c), not here
  notional: number;
  requiredMargin: number;
  actualRiskUsd: number; // <= riskUsd always; equals riskUsd only when the margin cap doesn't bind
  clampedByMargin: boolean; // true when the per-trade margin cap reduced qty below the risk-based ideal
}

// TODO_CONFIRM: experimental baseline only, not a production recommendation — needs backtest/simulation per Bước 5b discussion.
export const DEFAULT_MAX_MARGIN_PCT = 0.3;
