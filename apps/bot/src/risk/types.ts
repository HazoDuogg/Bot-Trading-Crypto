export interface PositionSizingInput {
  accountBalance: number;
  /**
   * Meaning differs by sizer (see each class's JSDoc): unused by StaticMarginSizer's formula;
   * USD risk amount ("Risk$"), not a percent, for DynamicRMarginSizer.
   */
  riskDollarOrPercent: number;
  entryPrice: number;
  /** TODO_CONFIRM (unit not specified by PM): decimal fraction, e.g. 0.01 = 1% — not "1" = 1%. */
  slDistancePercent: number;
  leverage: number;
  /** Only used by DynamicRMarginSizer. */
  maxMarginCap?: number;
}

export interface PositionSizingOutput {
  marginRequired: number;
  /** Notional position size in USD (margin * leverage), NOT a base-asset quantity — slTpManager.ts's fee math relies on this. */
  positionSize: number;
  /** Risk$ actually taken after any margin cap — may be lower than the requested riskDollarOrPercent. */
  actualRiskDollar: number;
}

export interface IPositionSizer {
  calculate(input: PositionSizingInput): PositionSizingOutput;
}

/** Shared validation for both sizers — throws instead of returning NaN/0 on bad input. */
export function validatePositionSizingInput(input: PositionSizingInput): void {
  if (input.accountBalance <= 0) {
    throw new Error(`PositionSizingInput.accountBalance must be > 0, got ${input.accountBalance}`);
  }
  if (input.slDistancePercent <= 0) {
    throw new Error(`PositionSizingInput.slDistancePercent must be > 0, got ${input.slDistancePercent}`);
  }
  if (input.leverage <= 0) {
    throw new Error(`PositionSizingInput.leverage must be > 0, got ${input.leverage}`);
  }
  if (input.riskDollarOrPercent <= 0) {
    throw new Error(`PositionSizingInput.riskDollarOrPercent must be > 0, got ${input.riskDollarOrPercent}`);
  }
  if (input.maxMarginCap !== undefined && input.maxMarginCap <= 0) {
    throw new Error(`PositionSizingInput.maxMarginCap must be > 0 when provided, got ${input.maxMarginCap}`);
  }
  if (input.entryPrice <= 0) {
    throw new Error(`PositionSizingInput.entryPrice must be > 0, got ${input.entryPrice}`);
  }
}
