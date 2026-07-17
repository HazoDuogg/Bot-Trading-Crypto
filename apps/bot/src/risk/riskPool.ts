export interface RiskPoolConfig {
  /** PM-given, not TODO_CONFIRM: 10% of balance (docs Mục 1). Decimal fraction: 0.10 == 10%. */
  riskPoolMaxPct: number;
}

export const DEFAULT_RISK_POOL_CONFIG: RiskPoolConfig = {
  riskPoolMaxPct: 0.1,
};

export interface OpenPositionRisk {
  /** Identifier for reporting only (e.g. symbol or order id) — not used in the calculation. */
  id: string;
  actualRiskDollar: number;
}

export interface RiskPoolCheckResult {
  totalRiskDollar: number;
  riskPoolMaxDollar: number;
  withinLimit: boolean;
  /** USD headroom before hitting the pool cap; negative if already over. */
  remainingCapacityDollar: number;
}

/** Sums actualRiskDollar across all open positions and compares against RISK_POOL_MAX_PCT * accountBalance. */
export function checkRiskPool(
  openPositions: OpenPositionRisk[],
  accountBalance: number,
  config: RiskPoolConfig = DEFAULT_RISK_POOL_CONFIG,
): RiskPoolCheckResult {
  if (accountBalance <= 0) {
    throw new Error(`checkRiskPool: accountBalance must be > 0, got ${accountBalance}`);
  }

  const totalRiskDollar = openPositions.reduce((sum, p) => sum + p.actualRiskDollar, 0);
  const riskPoolMaxDollar = accountBalance * config.riskPoolMaxPct;

  return {
    totalRiskDollar,
    riskPoolMaxDollar,
    withinLimit: totalRiskDollar <= riskPoolMaxDollar,
    remainingCapacityDollar: riskPoolMaxDollar - totalRiskDollar,
  };
}

/** Convenience: would adding a candidate position push the pool over its cap? */
export function wouldExceedRiskPool(
  openPositions: OpenPositionRisk[],
  candidateRiskDollar: number,
  accountBalance: number,
  config: RiskPoolConfig = DEFAULT_RISK_POOL_CONFIG,
): boolean {
  const result = checkRiskPool(
    [...openPositions, { id: '__candidate__', actualRiskDollar: candidateRiskDollar }],
    accountBalance,
    config,
  );
  return !result.withinLimit;
}
