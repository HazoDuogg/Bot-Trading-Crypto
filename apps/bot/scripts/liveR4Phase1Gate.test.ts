import { describe, expect, it } from 'vitest';
import { evaluateLiveR4Phase1, type LiveR4Phase1Snapshot } from './liveR4Phase1Gate.js';

function validSnapshot(): LiveR4Phase1Snapshot {
  return {
    env: 'testnet',
    baseUrl: 'https://testnet.binancefuture.com',
    dualSidePosition: false,
    walletBalance: 300,
    availableBalance: 300,
    btcPositionAmounts: [0],
    regularOpenOrderCount: 0,
    algoOpenOrderCount: 0,
    persistedStateClean: true,
    filters: { stepSize: 0.0001, tickSize: 0.1, minQty: 0.0001, minNotional: 50 },
    leverage: 30,
    fixedRiskUsd: 20,
    riskPoolMaxPct: 0.15,
  };
}

describe('evaluateLiveR4Phase1', () => {
  it('passes only a complete clean Testnet snapshot', () => {
    expect(evaluateLiveR4Phase1(validSnapshot())).toEqual([]);
  });

  it.each([
    ['hedge mode', { dualSidePosition: true }, 'POSITION_MODE_NOT_ONE_WAY'],
    ['invalid balance', { walletBalance: Number.NaN }, 'BALANCE_INVALID'],
    ['nonzero position', { btcPositionAmounts: [0.001] }, 'BTC_POSITION_NOT_PROVEN_FLAT'],
    ['regular order', { regularOpenOrderCount: 1 }, 'BTC_REGULAR_OPEN_ORDERS_NOT_ZERO'],
    ['algo order', { algoOpenOrderCount: 1 }, 'BTC_ALGO_OPEN_ORDERS_NOT_ZERO'],
    ['dirty local state', { persistedStateClean: false }, 'LOCAL_STATE_NOT_CLEAN'],
    ['invalid filter', { filters: { ...validSnapshot().filters, minNotional: Number.NaN } }, 'SYMBOL_FILTERS_INVALID'],
    ['invalid leverage', { leverage: Number.NaN }, 'LEVERAGE_INVALID'],
    ['wrong fixed risk', { fixedRiskUsd: null }, 'FIXED_RISK_NOT_20'],
    ['small risk pool', { walletBalance: 100 }, 'RISK_POOL_BELOW_FIXED_RISK'],
  ])('blocks %s', (_name, patch, expected) => {
    expect(evaluateLiveR4Phase1({ ...validSnapshot(), ...patch })).toContain(expected);
  });
});
