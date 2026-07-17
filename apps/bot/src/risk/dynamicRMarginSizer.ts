import {
  validatePositionSizingInput,
  type IPositionSizer,
  type PositionSizingInput,
  type PositionSizingOutput,
} from './types.js';

/**
 * Phương án B — Dynamic-R Margin.
 *   requestedMargin  = riskDollarOrPercent / (leverage * slDistancePercent)  (riskDollarOrPercent is USD)
 *   marginRequired   = min(requestedMargin, maxMarginCap)                   (cap only if provided)
 *   positionSize     = marginRequired * leverage                            (USD notional)
 *   actualRiskDollar = positionSize * slDistancePercent
 *
 * Uncapped: actualRiskDollar == riskDollarOrPercent exactly. Capped: actualRiskDollar is lower.
 * PM hasn't picked A vs B as default — don't wire one in as the default elsewhere.
 */
export class DynamicRMarginSizer implements IPositionSizer {
  calculate(input: PositionSizingInput): PositionSizingOutput {
    validatePositionSizingInput(input);

    const requestedMargin = input.riskDollarOrPercent / (input.leverage * input.slDistancePercent);
    const marginRequired =
      input.maxMarginCap !== undefined ? Math.min(requestedMargin, input.maxMarginCap) : requestedMargin;

    const positionSize = marginRequired * input.leverage;
    const actualRiskDollar = positionSize * input.slDistancePercent;

    return { marginRequired, positionSize, actualRiskDollar };
  }
}
