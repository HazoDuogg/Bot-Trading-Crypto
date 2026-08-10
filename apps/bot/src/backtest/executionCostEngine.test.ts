import { describe, expect, it } from 'vitest';
import { applyExecutionFill, attributeTradeExecution, IDEAL_EXECUTION_COST_CONFIG, type ExecutionCostConfig } from './executionCostEngine.js';

const stress: ExecutionCostConfig = { ...IDEAL_EXECUTION_COST_CONFIG, enabled: true, slippage: { enabled: true, model: 'FIXED_BPS', bpsPerSide: 2 }, spread: { enabled: true, model: 'FIXED_TOTAL_BPS', totalBps: 2 } };

describe('execution fill semantics', () => {
  it.each([
    ['LONG', true, 100.03], ['LONG', false, 99.97], ['SHORT', true, 99.97], ['SHORT', false, 100.03],
  ] as const)('%s %s is adverse', (side, isEntry, expected) => expect(applyExecutionFill(100, side, isEntry, stress).executedPrice).toBeCloseTo(expected, 12));
  it('applies half the total spread on each side and slippage once', () => {
    const fill = applyExecutionFill(100, 'LONG', true, stress);
    expect(fill.slippagePriceDelta).toBeCloseTo(0.02, 12);
    expect(fill.spreadPriceDelta).toBeCloseTo(0.01, 12);
  });
  it('disabled is exact legacy fill behavior', () => expect(applyExecutionFill(123.45, 'SHORT', false, IDEAL_EXECUTION_COST_CONFIG).executedPrice).toBe(123.45));
  it.each([['LONG', true], ['LONG', false], ['SHORT', true], ['SHORT', false]] as const)('zero-cost %s entry=%s equals legacy', (side, isEntry) => expect(applyExecutionFill(100, side, isEntry, IDEAL_EXECUTION_COST_CONFIG).executedPrice).toBe(100));
});

describe('trade accounting', () => {
  it('charges entry plus all exit-slice fees once and accounts partial TP legs', () => {
    const result = attributeTradeExecution({ symbol: 'BTCUSDT', side: 'LONG', entryTimestamp: 1, referenceEntry: 100, positionSize: 1000, exits: [{ referencePrice: 110, fraction: 0.4 }, { referencePrice: 95, fraction: 0.6 }] }, stress);
    expect(result.grossPnl).toBeCloseTo(10, 10);
    expect(result.feeCost).toBeCloseTo(0.8, 12);
    expect(result.slippageCost).toBeGreaterThan(0);
    expect(result.spreadCost).toBeGreaterThan(0);
    expect(result.netPnl).toBeCloseTo(result.grossPnl - result.totalExecutionCost, 10);
  });
  it.each([['SL', 90], ['RUNNER', 115]] as const)('accounts a %s final exit', (_reason, price) => {
    const result = attributeTradeExecution({ symbol: 'ETHUSDT', side: 'SHORT', entryTimestamp: 1, referenceEntry: 100, positionSize: 1000, exits: [{ referencePrice: price, fraction: 1 }] }, stress);
    expect(result.feeCost).toBe(0.8);
    expect(result.totalExecutionCost).toBeGreaterThan(result.feeCost);
  });
  it('lower realized balance can change later admission', () => {
    const first = attributeTradeExecution({ symbol: 'SOLUSDT', side: 'LONG', entryTimestamp: 1, referenceEntry: 100, positionSize: 1000, exits: [{ referencePrice: 100, fraction: 1 }] }, stress);
    expect(100 + first.netPnl).toBeLessThan(100);
    expect(15 / (100 + first.netPnl)).toBeGreaterThan(15 / 100);
  });
  it('deterministic zero-cost mini replay preserves the legacy balance path', () => {
    const trades = [
      { symbol: 'BTCUSDT', side: 'LONG' as const, entryTimestamp: 1, referenceEntry: 100, positionSize: 1000, exits: [{ referencePrice: 110, fraction: 1 }] },
      { symbol: 'ETHUSDT', side: 'SHORT' as const, entryTimestamp: 2, referenceEntry: 200, positionSize: 500, exits: [{ referencePrice: 180, fraction: 1 }] },
    ];
    const path = trades.reduce<number[]>((balances, trade) => [...balances, balances.at(-1)! + attributeTradeExecution(trade, IDEAL_EXECUTION_COST_CONFIG).netPnl], [100]);
    expect(path[0]).toBe(100);
    expect(path[1]).toBeCloseTo(199.2, 12);
    expect(path[2]).toBeCloseTo(248.8, 12);
  });
});
