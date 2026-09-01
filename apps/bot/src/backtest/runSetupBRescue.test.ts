import { describe, expect, it } from 'vitest';
import type { BacktestReport, DualCostMetrics, PerformanceMetrics } from './runNukidaBacktest.js';
import {
  SETUP_B_RESCUE_CONFIGS,
  buildSetupBRescueReport,
  type SetupBRescueRun,
} from './runSetupBRescue.js';

function metrics(netR: number): PerformanceMetrics {
  return {
    closedTrades: 10,
    grossR: netR + 1,
    feeR: 1,
    spreadR: 0,
    slippageR: 0,
    netR,
    profitFactor: 1.1,
    expectancyPerTrade: netR / 10,
    maxDrawdownR: 2,
    winRate: 0.4,
    ambiguousTrades: 0,
    openTrades: 0,
  };
}

function dual(netR: number): DualCostMetrics {
  return { zeroCost: metrics(netR + 1), realisticCost: metrics(netR) };
}

function report(setupBNetR: number): BacktestReport {
  return {
    note: 'fixture',
    baselineVariant: 'RETEST_LIMIT_ONLY',
    overall: dual(setupBNetR),
    ambiguousScenarios: {
      count: 0,
      bestCaseGrossR: 0,
      bestCaseNetR: 0,
      worstCaseGrossR: 0,
      worstCaseNetR: 0,
    },
    byCoin: {},
    bySetupFamily: {
      A_COMPRESSION_BREAKOUT: dual(5),
      B_BREAK_PULLBACK_FAILURE: dual(setupBNetR),
    },
    byDirection: {},
    minimumStopDistanceBlocked: { total: 0, byCoin: {} },
  };
}

describe('Setup B rescue report', () => {
  it('keeps all six combinations and verifies Setup A remains an invariant control', () => {
    const runs: SetupBRescueRun[] = SETUP_B_RESCUE_CONFIGS.flatMap((config, index) => [
      { config, period: 'IN_SAMPLE' as const, report: report(index) },
      { config, period: 'OUT_OF_SAMPLE' as const, report: report(-index) },
    ]);
    const result = buildSetupBRescueReport(runs);

    expect(result.rows).toHaveLength(6);
    expect(result.rows[0]).toMatchObject({
      config: { bufferAtrMultiple: 0, minimumTestOccurrence: 1 },
      inSample: { setupB: { realisticCost: { netR: 0 } } },
      setupAControlMatchesBaseline: { inSample: true, outOfSample: true },
    });
    expect(result.rows[0].outOfSample.setupB.realisticCost.netR).toBeCloseTo(0);
    expect(result.allSetupAControlInvariant).toBe(true);
  });
});
