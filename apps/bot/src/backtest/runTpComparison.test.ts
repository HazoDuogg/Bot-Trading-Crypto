import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';
import type { BacktestReport, PerformanceMetrics } from './runNukidaBacktest.js';
import {
  buildFixedTpComparisonRows,
  buildPositionManagementComparisonRows,
  buildPositionManagementMatrix,
} from './runTpComparison.js';

function metrics(netR: number): PerformanceMetrics {
  return {
    closedTrades: 10,
    grossR: netR + 1,
    feeR: 0.2,
    spreadR: 0.5,
    slippageR: 0.3,
    netR,
    profitFactor: 1.25,
    expectancyPerTrade: netR / 10,
    maxDrawdownR: 2,
    winRate: 0.5,
    ambiguousTrades: 0,
    openTrades: 0,
  };
}

function report(netR: number): BacktestReport {
  const pair = { zeroCost: metrics(netR + 1), realisticCost: metrics(netR) };
  return {
    note: 'fixture',
    baselineVariant: 'RETEST_LIMIT_ONLY',
    overall: pair,
    ambiguousScenarios: {
      count: 0,
      bestCaseGrossR: 0,
      bestCaseNetR: 0,
      worstCaseGrossR: 0,
      worstCaseNetR: 0,
    },
    byCoin: {},
    bySetupFamily: {},
    byDirection: {},
    minimumStopDistanceBlocked: { total: 0, byCoin: {} },
  };
}

function plan(): TradePlan {
  return {
    direction: 'BULL',
    entryPrice: 100,
    stopLoss: 90,
    takeProfit: 120,
    riskPerUnit: 10,
    positionSize: 10,
    requiredMargin: 100,
  };
}

function m1(openTime: number, low: number, high: number, close: number): Candle {
  return { openTime, open: 100, low, high, close, volume: 10 };
}

describe('TP and position-management comparison report', () => {
  it('keeps all four fixed-TP IS/OOS combinations visible', () => {
    const rows = buildFixedTpComparisonRows([
      { takeProfitRMultiple: 1.5, period: 'IN_SAMPLE', report: report(1) },
      { takeProfitRMultiple: 1.5, period: 'OUT_OF_SAMPLE', report: report(2) },
      { takeProfitRMultiple: 2, period: 'IN_SAMPLE', report: report(3) },
      { takeProfitRMultiple: 2, period: 'OUT_OF_SAMPLE', report: report(4) },
    ]);

    expect(rows.map((row) => [row.takeProfitRMultiple, row.period, row.realisticCost.netR])).toEqual([
      [1.5, 'IN_SAMPLE', 1],
      [1.5, 'OUT_OF_SAMPLE', 2],
      [2, 'IN_SAMPLE', 3],
      [2, 'OUT_OF_SAMPLE', 4],
    ]);
  });

  it('reports every experimental combination and applies weighted per-leg execution costs', () => {
    const matrix = buildPositionManagementMatrix([
      {
        coin: 'TESTUSDT',
        period: 'OUT_OF_SAMPLE',
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: [m1(60_000, 89, 100, 90)],
      },
    ]);

    const rows = buildPositionManagementComparisonRows(
      matrix,
      buildFixedTpComparisonRows([
        { takeProfitRMultiple: 1.5, period: 'IN_SAMPLE', report: report(1) },
        { takeProfitRMultiple: 1.5, period: 'OUT_OF_SAMPLE', report: report(2) },
        { takeProfitRMultiple: 2, period: 'IN_SAMPLE', report: report(3) },
        { takeProfitRMultiple: 2, period: 'OUT_OF_SAMPLE', report: report(4) },
      ]),
    );

    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({
      config: { partialExitRMultiple: 1.5, partialExitFraction: 0.5, breakevenBufferR: 0 },
      combined: {
        closedTrades: 1,
        grossR: -1,
        netR: -1.2283,
        expectancyPerTrade: -1.2283,
        ambiguousTrades: 0,
      },
      fixedTpBaseline: { inSampleNetR: 1, outOfSampleNetR: 2, combinedNetR: 3 },
      netRDeltaVsFixedTp: { inSample: -1, outOfSample: -3.2283, combined: -4.2283 },
    });
  });

  it('prices a partial limit as maker and its breakeven stop as taker', () => {
    const rows = buildPositionManagementMatrix([
      {
        coin: 'TESTUSDT',
        period: 'OUT_OF_SAMPLE',
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: [m1(60_000, 101, 116, 114), m1(120_000, 99, 102, 100)],
      },
    ]);

    expect(rows[0].combined).toMatchObject({ closedTrades: 1, grossR: 0.75, feeR: 0.00565 });
  });
});
