import { describe, expect, it } from 'vitest';
import { accountCasperNetPnl } from './costAccounting.js';
import type { CasperCostConfig, CasperRrVariant } from './costAccounting.js';
import type { M1ExecutionReplayResult } from './m1ExecutionReplay.js';
import type { CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

const zeroCosts = {
  entryFeeRate: 0,
  exitFeeRate: 0,
  entrySlippageRate: 0,
  exitSlippageRate: 0,
};

function sourceCandle(startTimeMs: number): CasperCandle {
  return { startTimeMs, endTimeMs: startTimeMs + 300_000, open: 100, high: 101, low: 99, close: 100 };
}

function tradePlan(direction: 'LONG' | 'SHORT', riskPerUnit = 10): CasperTradePlan {
  const entry = 100;
  const stopLoss = direction === 'LONG' ? entry - riskPerUnit : entry + riskPerUnit;
  const c1 = sourceCandle(0);
  const c2 = sourceCandle(300_000);
  const c3 = sourceCandle(600_000);
  return {
    state: 'VALID_TRADE_PLAN',
    direction,
    entryType: 'LIMIT',
    entry,
    stopLoss,
    riskPerUnit,
    targets:
      direction === 'LONG'
        ? { '1.5R': entry + 1.5 * riskPerUnit, '2.0R': entry + 2 * riskPerUnit }
        : { '1.5R': entry - 1.5 * riskPerUnit, '2.0R': entry - 2 * riskPerUnit },
    fvgLow: 99,
    fvgHigh: 101,
    tradingDay: '2026-07-15',
    sourceCandles: { c1, c2, c3 },
  };
}

function execution(
  plan: CasperTradePlan,
  onePointFive: 'OPEN' | 'WIN' | 'LOSS' | 'AMBIGUOUS',
  twoPointZero: 'OPEN' | 'WIN' | 'LOSS' | 'AMBIGUOUS',
): M1ExecutionReplayResult {
  return {
    state: 'FILLED',
    direction: plan.direction,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    targets: plan.targets,
    createdAtMs: plan.sourceCandles.c3.endTimeMs,
    filledAtMs: plan.sourceCandles.c3.endTimeMs + 60_000,
    fillPrice: plan.entry,
    tradingDay: plan.tradingDay,
    variants: { '1.5R': onePointFive, '2.0R': twoPointZero },
  };
}

function account(
  direction: 'LONG' | 'SHORT',
  variant: CasperRrVariant,
  outcome: 'WIN' | 'LOSS',
  costs: CasperCostConfig = zeroCosts,
  riskPerUnit = 10,
) {
  const plan = tradePlan(direction, riskPerUnit);
  const result = accountCasperNetPnl({
    tradePlan: plan,
    execution: execution(
      plan,
      variant === '1.5R' ? outcome : 'OPEN',
      variant === '2.0R' ? outcome : 'OPEN',
    ),
    variant,
    costs,
  });
  if (result.state !== 'ACCOUNTED') throw new Error('fixture must be accounted');
  return result;
}

describe('accountCasperNetPnl', () => {
  it('preserves a zero-cost LONG 1.5R win exactly', () => {
    const plan = tradePlan('LONG');
    const result = accountCasperNetPnl({
      tradePlan: plan,
      execution: execution(plan, 'WIN', 'OPEN'),
      variant: '1.5R',
      costs: zeroCosts,
    });

    expect(result).toEqual({
      state: 'ACCOUNTED',
      variant: '1.5R',
      outcome: 'WIN',
      direction: 'LONG',
      entryPrice: 100,
      exitPrice: 115,
      effectiveEntryPrice: 100,
      effectiveExitPrice: 115,
      grossR: 1.5,
      netR: 1.5,
      entryFeePerUnit: 0,
      exitFeePerUnit: 0,
      feePerUnit: 0,
      slippageImpactPerUnit: 0,
      grossPnlPerUnit: 15,
      netPnlPerUnit: 15,
    });
  });

  it('preserves zero-cost 2.0R WIN and LOSS invariants', () => {
    expect(account('LONG', '2.0R', 'WIN').netR).toBe(2);
    expect(account('LONG', '1.5R', 'LOSS').netR).toBe(-1);
  });

  it('uses the target for WIN exit and stop loss for LOSS exit', () => {
    expect(account('LONG', '1.5R', 'WIN')).toMatchObject({
      exitPrice: 115,
      grossPnlPerUnit: 15,
    });
    expect(account('SHORT', '2.0R', 'LOSS')).toMatchObject({
      exitPrice: 110,
      grossPnlPerUnit: -10,
    });
  });

  it('calculates LONG fees from entry and exit notionals', () => {
    const result = account('LONG', '1.5R', 'WIN', {
      ...zeroCosts,
      entryFeeRate: 0.001,
      exitFeeRate: 0.002,
    });

    expect(result.entryFeePerUnit).toBeCloseTo(0.1, 12);
    expect(result.exitFeePerUnit).toBeCloseTo(0.23, 12);
    expect(result.feePerUnit).toBeCloseTo(0.33, 12);
    expect(result.netR).toBeCloseTo(1.467, 12);
  });

  it('calculates SHORT fees from entry and exit notionals', () => {
    const result = account('SHORT', '1.5R', 'WIN', {
      ...zeroCosts,
      entryFeeRate: 0.001,
      exitFeeRate: 0.002,
    });

    expect(result.entryFeePerUnit).toBeCloseTo(0.1, 12);
    expect(result.exitFeePerUnit).toBeCloseTo(0.17, 12);
    expect(result.feePerUnit).toBeCloseTo(0.27, 12);
    expect(result.netR).toBeCloseTo(1.473, 12);
  });

  it('applies adverse LONG slippage to both entry and exit', () => {
    const result = account('LONG', '1.5R', 'WIN', {
      ...zeroCosts,
      entrySlippageRate: 0.01,
      exitSlippageRate: 0.02,
    });

    expect(result.effectiveEntryPrice).toBeCloseTo(101, 12);
    expect(result.effectiveExitPrice).toBeCloseTo(112.7, 12);
    expect(result.slippageImpactPerUnit).toBeCloseTo(3.3, 12);
    expect(result.netR).toBeCloseTo(1.17, 12);
  });

  it('applies adverse SHORT slippage to both entry and exit', () => {
    const result = account('SHORT', '1.5R', 'WIN', {
      ...zeroCosts,
      entrySlippageRate: 0.01,
      exitSlippageRate: 0.02,
    });

    expect(result.effectiveEntryPrice).toBeCloseTo(99, 12);
    expect(result.effectiveExitPrice).toBeCloseTo(86.7, 12);
    expect(result.slippageImpactPerUnit).toBeCloseTo(2.7, 12);
    expect(result.netR).toBeCloseTo(1.23, 12);
  });

  it('audits combined fee and slippage separately', () => {
    const result = account('LONG', '1.5R', 'WIN', {
      entryFeeRate: 0.001,
      exitFeeRate: 0.002,
      entrySlippageRate: 0.01,
      exitSlippageRate: 0.02,
    });

    expect(result.grossR).toBe(1.5);
    expect(result.feePerUnit).toBeCloseTo(0.33, 12);
    expect(result.slippageImpactPerUnit).toBeCloseTo(3.3, 12);
    expect(result.netPnlPerUnit).toBeCloseTo(11.37, 12);
    expect(result.netR).toBeCloseTo(1.137, 12);
  });

  it('shows large cost impact when original strategy risk is tiny', () => {
    const result = account(
      'LONG',
      '1.5R',
      'WIN',
      { ...zeroCosts, entryFeeRate: 0.001, exitFeeRate: 0.001 },
      0.1,
    );

    expect(result.grossR).toBe(1.5);
    expect(result.netR).toBeCloseTo(-0.5015, 10);
  });

  it('decreases netR monotonically as fees increase', () => {
    const lower = account('LONG', '1.5R', 'WIN', {
      ...zeroCosts,
      entryFeeRate: 0.0005,
      exitFeeRate: 0.0005,
    });
    const higher = account('LONG', '1.5R', 'WIN', {
      ...zeroCosts,
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
    });

    expect(higher.netR).toBeLessThan(lower.netR);
  });

  it('decreases netR monotonically as slippage increases', () => {
    const lower = account('SHORT', '1.5R', 'WIN', {
      ...zeroCosts,
      entrySlippageRate: 0.0005,
      exitSlippageRate: 0.0005,
    });
    const higher = account('SHORT', '1.5R', 'WIN', {
      ...zeroCosts,
      entrySlippageRate: 0.001,
      exitSlippageRate: 0.001,
    });

    expect(higher.netR).toBeLessThan(lower.netR);
  });

  it('never reports netR above grossR for non-negative costs', () => {
    const costs = {
      entryFeeRate: 0.001,
      exitFeeRate: 0.002,
      entrySlippageRate: 0.001,
      exitSlippageRate: 0.002,
    };
    const results = [
      account('LONG', '1.5R', 'WIN', costs),
      account('SHORT', '2.0R', 'WIN', costs),
      account('LONG', '1.5R', 'LOSS', costs),
      account('SHORT', '2.0R', 'LOSS', costs),
    ];

    for (const result of results) expect(result.netR).toBeLessThanOrEqual(result.grossR);
  });

  it('does not create PnL for OPEN or AMBIGUOUS variants', () => {
    const plan = tradePlan('LONG');
    const open = accountCasperNetPnl({
      tradePlan: plan,
      execution: execution(plan, 'OPEN', 'OPEN'),
      variant: '1.5R',
      costs: zeroCosts,
    });
    const ambiguous = accountCasperNetPnl({
      tradePlan: plan,
      execution: execution(plan, 'AMBIGUOUS', 'OPEN'),
      variant: '1.5R',
      costs: zeroCosts,
    });

    expect(open).toEqual({ state: 'UNRESOLVED', variant: '1.5R', outcome: 'OPEN' });
    expect(ambiguous).toEqual({
      state: 'UNRESOLVED',
      variant: '1.5R',
      outcome: 'AMBIGUOUS',
    });
    expect(open).not.toHaveProperty('netR');
    expect(ambiguous).not.toHaveProperty('netR');
  });

  it('keeps PENDING, CANCELLED, and INVALID outside PnL accounting', () => {
    const plan = tradePlan('LONG');
    const base = {
      direction: plan.direction,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      targets: plan.targets,
      createdAtMs: plan.sourceCandles.c3.endTimeMs,
      tradingDay: plan.tradingDay,
    };
    const executions: M1ExecutionReplayResult[] = [
      { ...base, state: 'PENDING' },
      { ...base, state: 'CANCELLED', cancelledAtMs: 1_000_000 },
      { state: 'INVALID', reason: 'INVALID_M1_DATA' },
    ];

    expect(
      executions.map((item) =>
        accountCasperNetPnl({ tradePlan: plan, execution: item, variant: '1.5R', costs: zeroCosts }),
      ),
    ).toEqual([
      { state: 'UNRESOLVED', variant: '1.5R', outcome: 'PENDING' },
      { state: 'UNRESOLVED', variant: '1.5R', outcome: 'CANCELLED' },
      { state: 'UNRESOLVED', variant: '1.5R', outcome: 'INVALID' },
    ]);
  });

  it('rejects negative and non-finite cost rates without clamping', () => {
    const plan = tradePlan('LONG');
    const resolved = execution(plan, 'WIN', 'OPEN');
    const invalidRates = [-0.001, Number.NaN, Number.POSITIVE_INFINITY];

    for (const rate of invalidRates) {
      expect(
        accountCasperNetPnl({
          tradePlan: plan,
          execution: resolved,
          variant: '1.5R',
          costs: { ...zeroCosts, entryFeeRate: rate },
        }),
      ).toEqual({ state: 'INVALID', reason: 'INVALID_COST_CONFIG' });
    }
  });

  it('rejects invalid risk and price data', () => {
    const invalidRisk = tradePlan('LONG');
    invalidRisk.riskPerUnit = 0;
    const inconsistentRisk = tradePlan('LONG');
    inconsistentRisk.riskPerUnit = 9;
    const invalidPrice = tradePlan('LONG');
    invalidPrice.entry = Number.NaN;

    expect(
      accountCasperNetPnl({
        tradePlan: invalidRisk,
        execution: execution(invalidRisk, 'WIN', 'OPEN'),
        variant: '1.5R',
        costs: zeroCosts,
      }),
    ).toEqual({ state: 'INVALID', reason: 'INVALID_TRADE_DATA' });
    expect(
      accountCasperNetPnl({
        tradePlan: inconsistentRisk,
        execution: execution(inconsistentRisk, 'WIN', 'OPEN'),
        variant: '1.5R',
        costs: zeroCosts,
      }),
    ).toEqual({ state: 'INVALID', reason: 'INVALID_TRADE_DATA' });
    expect(
      accountCasperNetPnl({
        tradePlan: invalidPrice,
        execution: execution(invalidPrice, 'WIN', 'OPEN'),
        variant: '1.5R',
        costs: zeroCosts,
      }),
    ).toEqual({ state: 'INVALID', reason: 'INVALID_TRADE_DATA' });
  });

  it('rejects a mismatch between trade plan and execution outcome metadata', () => {
    const plan = tradePlan('LONG');
    const resolved = execution(plan, 'WIN', 'OPEN');
    if (resolved.state !== 'FILLED') throw new Error('fixture must be filled');
    const mismatched = { ...resolved, entry: 101 };

    expect(
      accountCasperNetPnl({
        tradePlan: plan,
        execution: mismatched,
        variant: '1.5R',
        costs: zeroCosts,
      }),
    ).toEqual({ state: 'INVALID', reason: 'PLAN_EXECUTION_MISMATCH' });
  });

  it('does not mutate the trade plan, execution result, or cost config', () => {
    const plan = tradePlan('SHORT');
    const resolved = execution(plan, 'OPEN', 'WIN');
    const costs = {
      entryFeeRate: 0.001,
      exitFeeRate: 0.002,
      entrySlippageRate: 0.003,
      exitSlippageRate: 0.004,
    };
    const before = structuredClone({ plan, resolved, costs });

    accountCasperNetPnl({ tradePlan: plan, execution: resolved, variant: '2.0R', costs });

    expect({ plan, resolved, costs }).toEqual(before);
  });
});
