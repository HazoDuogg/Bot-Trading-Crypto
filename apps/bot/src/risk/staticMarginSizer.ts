import {
  validatePositionSizingInput,
  type IPositionSizer,
  type PositionSizingInput,
  type PositionSizingOutput,
} from './types.js';

export interface StaticMarginSizerConfig {
  /** Fixed margin per trade, USD. PM's value: $33 (docs Mục 1) — not TODO_CONFIRM, just configurable. */
  fixedMarginUsd: number;
}

export const DEFAULT_STATIC_MARGIN_SIZER_CONFIG: StaticMarginSizerConfig = {
  fixedMarginUsd: 33,
};

/**
 * Phương án A — Static Margin. Margin is always `config.fixedMarginUsd`, ignoring riskDollarOrPercent.
 *   marginRequired  = config.fixedMarginUsd
 *   positionSize    = marginRequired * leverage        (USD notional)
 *   actualRiskDollar = positionSize * slDistancePercent (PM's literal formula — no riskDollarOrPercent)
 *
 * PM hasn't picked A vs B as default — don't wire one in as the default elsewhere.
 */
export class StaticMarginSizer implements IPositionSizer {
  constructor(private readonly config: StaticMarginSizerConfig = DEFAULT_STATIC_MARGIN_SIZER_CONFIG) {}

  calculate(input: PositionSizingInput): PositionSizingOutput {
    validatePositionSizingInput(input);

    const marginRequired = this.config.fixedMarginUsd;
    const positionSize = marginRequired * input.leverage;
    const actualRiskDollar = positionSize * input.slDistancePercent;

    return { marginRequired, positionSize, actualRiskDollar };
  }
}
