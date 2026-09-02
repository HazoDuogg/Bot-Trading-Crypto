import { describe, expect, it } from 'vitest';
import type {
  BacktestReport,
  DualCostMetrics,
  PerformanceMetrics,
} from './runNukidaBacktest.js';
import {
  buildComparisonReport,
  computeWalkForwardWindows,
} from './runNukidaBacktestOOS.js';

function metrics(closedTrades: number, netR: number): PerformanceMetrics {
  return {
    closedTrades,
    grossR: netR,
    feeR: 0,
    spreadR: 0,
    slippageR: 0,
    netR,
    profitFactor: 1.2,
    expectancyPerTrade: closedTrades === 0 ? null : netR / closedTrades,
    maxDrawdownR: 2,
    winRate: 0.5,
    ambiguousTrades: 0,
    openTrades: 0,
  };
}

function dual(closedTrades: number, netR: number): DualCostMetrics {
  return {
    zeroCost: metrics(closedTrades, netR),
    realisticCost: metrics(closedTrades, netR - 1),
  };
}

function report(closedTrades: number, netR: number): BacktestReport {
  return {
    note: 'fixture',
    baselineVariant: 'RETEST_LIMIT_ONLY',
    overall: dual(closedTrades, netR),
    ambiguousScenarios: {
      count: 0,
      bestCaseGrossR: 0,
      bestCaseNetR: 0,
      worstCaseGrossR: 0,
      worstCaseNetR: 0,
    },
    byCoin: {},
    bySetupFamily: {
      A_COMPRESSION_BREAKOUT: dual(closedTrades, netR),
    },
    byDirection: {
      BULL: dual(closedTrades, netR),
      BEAR: dual(closedTrades, netR),
    },
    minimumStopDistanceBlocked: { total: 0, byCoin: {} },
  };
}

describe('walk-forward window and comparison report', () => {
  it('creates the preceding OOS window with no M15 timestamp shared with in-sample', () => {
    const lastM15OpenTime = Date.UTC(2026, 7, 27, 14, 0, 0);
    const windows = computeWalkForwardWindows(lastM15OpenTime);

    expect(windows.outOfSample.endExclusive).toBe(windows.inSample.startInclusive);
    expect(windows.outOfSample.startInclusive).toBe(
      windows.inSample.startInclusive - 180 * 24 * 60 * 60 * 1000,
    );
    expect(windows.inSample.endExclusive).toBe(lastM15OpenTime + 15 * 60 * 1000);
  });

  it('compares all required slices and flags an OOS sample below 20 closed trades', () => {
    const comparison = buildComparisonReport(report(40, 8), report(12, -3));

    expect(comparison.rows).toHaveLength(8);
    expect(
      comparison.rows.find(
        (row) => row.segment === 'OVERALL' && row.costMode === 'realisticCost',
      ),
    ).toMatchObject({
      inSample: { closedTrades: 40, netR: 7 },
      outOfSample: { closedTrades: 12, netR: -4 },
      sampleWarning: 'OOS_SAMPLE_BELOW_20_TRADES',
    });
  });
});
