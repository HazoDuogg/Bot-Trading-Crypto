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

/**
 * TICKET-101 Việc 2 — a SEPARATE cap from the Risk Pool above: Risk Pool bounds the SUM of what
 * would actually be LOST if every open position's SL hit (actualRiskDollar). This bounds the SUM of
 * real MARGIN currently committed across ALL 4 symbols combined (marginRequired — capital actually
 * tied up on the exchange, not the loss-if-SL-hits figure) — a position can pass the Risk Pool check
 * (its risk$ is small, e.g. a wide-SL low-risk-multiple trade) while still committing a large chunk
 * of margin, so this cap catches concentration the Risk Pool alone can't see. `maxTotalMarginPct` is
 * a DECIMAL FRACTION (0.5 == 50%, same convention as `RiskPoolConfig.riskPoolMaxPct` — the CLI layer
 * divides a plain percentage by 100 before it ever reaches this function, this function never does).
 * `undefined` = no cap (unreachable, matches every ticket before TICKET-101 exactly) — PM has NOT
 * picked a number yet (TODO_CONFIRM, gợi ý 50-60%), so callers must not silently default to one.
 */
export function wouldExceedMaxTotalMargin(totalOpenMarginDollar: number, candidateMarginDollar: number, accountBalance: number, maxTotalMarginPct: number | undefined): boolean {
  if (maxTotalMarginPct === undefined) return false;
  if (accountBalance <= 0) {
    throw new Error(`wouldExceedMaxTotalMargin: accountBalance must be > 0, got ${accountBalance}`);
  }
  const maxTotalMarginDollar = accountBalance * maxTotalMarginPct;
  return totalOpenMarginDollar + candidateMarginDollar > maxTotalMarginDollar;
}
