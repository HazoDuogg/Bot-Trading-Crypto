export interface LiveR4Phase1Snapshot {
  env: string;
  baseUrl: string;
  dualSidePosition: unknown;
  walletBalance: unknown;
  availableBalance: unknown;
  btcPositionAmounts: unknown[];
  regularOpenOrderCount: unknown;
  algoOpenOrderCount: unknown;
  persistedStateClean: boolean;
  filters: {
    stepSize: unknown;
    tickSize: unknown;
    minQty: unknown;
    minNotional: unknown;
  };
  leverage: unknown;
  fixedRiskUsd: unknown;
  riskPoolMaxPct: unknown;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function evaluateLiveR4Phase1(snapshot: LiveR4Phase1Snapshot): string[] {
  const blockers: string[] = [];
  if (snapshot.env !== 'testnet' || snapshot.baseUrl !== 'https://testnet.binancefuture.com') blockers.push('ENDPOINT_NOT_PROVEN_TESTNET');
  if (snapshot.dualSidePosition !== false) blockers.push('POSITION_MODE_NOT_ONE_WAY');
  if (!positiveFinite(snapshot.walletBalance) || !positiveFinite(snapshot.availableBalance)) blockers.push('BALANCE_INVALID');
  if (snapshot.btcPositionAmounts.length === 0 || snapshot.btcPositionAmounts.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value !== 0)) {
    blockers.push('BTC_POSITION_NOT_PROVEN_FLAT');
  }
  if (!nonNegativeInteger(snapshot.regularOpenOrderCount) || snapshot.regularOpenOrderCount !== 0) blockers.push('BTC_REGULAR_OPEN_ORDERS_NOT_ZERO');
  if (!nonNegativeInteger(snapshot.algoOpenOrderCount) || snapshot.algoOpenOrderCount !== 0) blockers.push('BTC_ALGO_OPEN_ORDERS_NOT_ZERO');
  if (!snapshot.persistedStateClean) blockers.push('LOCAL_STATE_NOT_CLEAN');
  if (![snapshot.filters.stepSize, snapshot.filters.tickSize, snapshot.filters.minQty, snapshot.filters.minNotional].every(positiveFinite)) blockers.push('SYMBOL_FILTERS_INVALID');
  if (!positiveFinite(snapshot.leverage)) blockers.push('LEVERAGE_INVALID');
  if (snapshot.fixedRiskUsd !== 20) blockers.push('FIXED_RISK_NOT_20');
  if (!positiveFinite(snapshot.riskPoolMaxPct) || snapshot.riskPoolMaxPct !== 0.15) blockers.push('RISK_POOL_POLICY_INVALID');
  if (positiveFinite(snapshot.walletBalance) && positiveFinite(snapshot.riskPoolMaxPct) && snapshot.walletBalance * snapshot.riskPoolMaxPct < 20) {
    blockers.push('RISK_POOL_BELOW_FIXED_RISK');
  }
  return blockers;
}
