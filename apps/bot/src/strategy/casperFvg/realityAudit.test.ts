import { describe, expect, it } from 'vitest';
import { runCasperHistoricalBacktest } from './historicalBacktest.js';
import { auditCasperBacktestReality } from './realityAudit.js';
import type { CasperHistoricalDataset } from './historicalBacktest.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;

function candle(
  start: string,
  durationMinutes: number,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  const startTimeMs = Date.parse(start);
  return { startTimeMs, endTimeMs: startTimeMs + durationMinutes * minute, open, high, low, close };
}

function twoResolvedDays(): CasperHistoricalDataset {
  return {
    symbol: 'TEST',
    m15: [
      candle('2026-07-15T13:30:00Z', 15, 100, 110, 90, 100),
      candle('2026-07-16T13:30:00Z', 15, 100, 110, 90, 100),
    ],
    m5: [
      candle('2026-07-15T13:45:00Z', 5, 100, 105, 98, 102),
      candle('2026-07-15T13:50:00Z', 5, 102, 114, 101, 109),
      candle('2026-07-15T13:55:00Z', 5, 111, 115, 106, 113),
      candle('2026-07-16T13:45:00Z', 5, 100, 102, 95, 98),
      candle('2026-07-16T13:50:00Z', 5, 98, 99, 91, 92),
      candle('2026-07-16T13:55:00Z', 5, 89, 94, 85, 87),
    ],
    m1: [
      candle('2026-07-15T14:00:00Z', 1, 106, 107, 104, 106),
      candle('2026-07-15T14:01:00Z', 1, 107, 116, 106, 115),
      candle('2026-07-16T14:00:00Z', 1, 96, 96, 94, 95),
      candle('2026-07-16T14:01:00Z', 1, 96, 103, 90, 101),
    ],
  };
}

function minuteSeries(
  start: string,
  count: number,
  values: [number, number, number, number],
): CasperCandle[] {
  const startTimeMs = Date.parse(start);
  return Array.from({ length: count }, (_, index) => ({
    startTimeMs: startTimeMs + index * minute,
    endTimeMs: startTimeMs + (index + 1) * minute,
    open: values[0],
    high: values[1],
    low: values[2],
    close: values[3],
  }));
}

function gapCrossDays(): CasperHistoricalDataset {
  const dataset = twoResolvedDays();
  return {
    ...dataset,
    m1: [
      ...minuteSeries('2026-07-15T14:00:00Z', 120, [97, 99, 96, 98]),
      ...minuteSeries('2026-07-16T14:00:00Z', 120, [97, 98, 96, 97]),
    ],
  };
}

function ambiguityDays(): CasperHistoricalDataset {
  const days = ['2026-07-15', '2026-07-16', '2026-07-17'];
  const m15 = days.map((day) => candle(`${day}T13:30:00Z`, 15, 100, 110, 90, 100));
  const m5 = days.flatMap((day) => [
    candle(`${day}T13:45:00Z`, 5, 100, 105, 98, 102),
    candle(`${day}T13:50:00Z`, 5, 102, 114, 101, 109),
    candle(`${day}T13:55:00Z`, 5, 111, 115, 106, 113),
  ]);
  return {
    symbol: 'TEST',
    m15,
    m5,
    m1: [
      candle('2026-07-15T14:00:00Z', 1, 105, 107, 98, 104),
      candle('2026-07-16T14:00:00Z', 1, 105, 116, 104, 114),
      candle('2026-07-17T14:00:00Z', 1, 105, 107, 104, 106),
      candle('2026-07-17T14:01:00Z', 1, 106, 120, 98, 110),
    ],
  };
}

const currentCosts = {
  entryFeeRate: 0.0002,
  exitFeeRate: 0.0005,
  entrySlippageRate: 0.0001,
  exitSlippageRate: 0.0002,
};

const scenarios = {
  CURRENT_RT101: {
    entryFeeRate: 0.0002,
    tpExitFeeRate: 0.0005,
    slExitFeeRate: 0.0005,
    entrySlippageRate: 0.0001,
    tpExitSlippageRate: 0.0002,
    slExitSlippageRate: 0.0002,
  },
  MAKER_TP_TAKER_SL: {
    entryFeeRate: 0.0002,
    tpExitFeeRate: 0.0002,
    slExitFeeRate: 0.0005,
    entrySlippageRate: 0,
    tpExitSlippageRate: 0,
    slExitSlippageRate: 0.0002,
  },
  ZERO_COST_CONTROL: {
    entryFeeRate: 0,
    tpExitFeeRate: 0,
    slExitFeeRate: 0,
    entrySlippageRate: 0,
    tpExitSlippageRate: 0,
    slExitSlippageRate: 0,
  },
} as const;

describe('auditCasperBacktestReality', () => {
  it('separates current, maker-TP/taker-SL, and zero-cost accounting by outcome', () => {
    const dataset = twoResolvedDays();
    const baseline = runCasperHistoricalBacktest(dataset, { costs: currentCosts });
    const audit = auditCasperBacktestReality({ baseline, dataset, scenarios, sampleSize: 40 });
    const comparison = audit.scenarioComparisons.ALL_VALID_SETUPS['1.5R'];

    expect(comparison.CURRENT_RT101.netR).toBeCloseTo(0.469678571429, 10);
    expect(comparison.MAKER_TP_TAKER_SL.netR).toBeCloseTo(0.480785714286, 10);
    expect(comparison.ZERO_COST_CONTROL.netR).toBe(0.5);
    expect(comparison.MAKER_TP_TAKER_SL.averageTpCostR).toBeCloseTo(0.0063, 10);
    expect(comparison.MAKER_TP_TAKER_SL.averageSlCostR).toBeCloseTo(0.012914285714, 10);
    expect(comparison.MAKER_TP_TAKER_SL.averageEntryCostR).toBeCloseTo(0.002857142857, 10);
    expect(comparison.MAKER_TP_TAKER_SL.averageTpExitCostR).toBeCloseTo(0.0033, 10);
    expect(comparison.CURRENT_RT101.averageEntryCostR).toBeGreaterThan(
      comparison.MAKER_TP_TAKER_SL.averageEntryCostR!,
    );
  });

  it('classifies resting-limit gap/cross evidence for LONG and SHORT without changing fills', () => {
    const dataset = gapCrossDays();
    const baseline = runCasperHistoricalBacktest(dataset, { costs: currentCosts });
    const before = structuredClone(baseline);
    const audit = auditCasperBacktestReality({ baseline, dataset, scenarios, sampleSize: 40 });

    expect(audit.restingFillAudit.byDirection.LONG.GAP_CROSS_BEYOND_ENTRY).toBe(1);
    expect(audit.restingFillAudit.byDirection.SHORT.GAP_CROSS_BEYOND_ENTRY).toBe(1);
    expect(audit.restingFillAudit.impactedGapCrossCount).toBe(2);
    expect(baseline.traces.every((trace) => trace.executionState === 'CANCELLED')).toBe(true);
    expect(baseline).toEqual(before);
  });

  it('does not classify the 11:59-12:00 New York cancellation candle as a fill touch', () => {
    const dataset = twoResolvedDays();
    const longOnly = {
      ...dataset,
      m15: dataset.m15.slice(0, 1),
      m5: dataset.m5.slice(0, 3),
      m1: minuteSeries('2026-07-15T14:00:00Z', 120, [120, 121, 119, 120]),
    };
    longOnly.m1[119] = candle('2026-07-15T15:59:00Z', 1, 106, 107, 104, 105);
    const baseline = runCasperHistoricalBacktest(longOnly, { costs: currentCosts });
    const audit = auditCasperBacktestReality({ baseline, dataset: longOnly, scenarios, sampleSize: 40 });

    expect(baseline.traces[0].executionState).toBe('CANCELLED');
    expect(audit.restingFillAudit.total.NO_TOUCH).toBe(1);
    expect(audit.restingFillAudit.total.RANGE_CONTAINS_ENTRY).toBe(0);
  });

  it('counts fill-candle and later-candle ambiguity categories independently by RR', () => {
    const dataset = ambiguityDays();
    const baseline = runCasperHistoricalBacktest(dataset, { costs: currentCosts });
    const audit = auditCasperBacktestReality({ baseline, dataset, scenarios, sampleSize: 40 });
    const one = audit.ambiguityAudit.ALL_VALID_SETUPS['1.5R'];
    const two = audit.ambiguityAudit.ALL_VALID_SETUPS['2.0R'];

    expect(one.categories).toEqual({
      FILL_PLUS_SL_SAME_M1: 1,
      FILL_PLUS_TP_SAME_M1: 1,
      SL_PLUS_TP_SAME_LATER_M1: 1,
    });
    expect(two.categories).toEqual({
      FILL_PLUS_SL_SAME_M1: 1,
      FILL_PLUS_TP_SAME_M1: 0,
      SL_PLUS_TP_SAME_LATER_M1: 1,
    });
    expect(one.count).toBe(3);
    expect(one.hypotheticalGrossRange).toEqual({ slFirstR: -3, tpFirstR: 4.5 });
  });

  it('reports risk/cost statistics and selects the manual sample deterministically', () => {
    const dataset = twoResolvedDays();
    const baseline = runCasperHistoricalBacktest(dataset, { costs: currentCosts });
    const before = structuredClone(baseline);
    const first = auditCasperBacktestReality({ baseline, dataset, scenarios, sampleSize: 40 });
    const second = auditCasperBacktestReality({ baseline, dataset, scenarios, sampleSize: 40 });
    const stats = first.riskCostAudit['1.5R'];

    expect(stats.sampleSize).toBe(2);
    expect(stats.riskPctOfEntryPercentiles.P50).toBeCloseTo(0.070175438596, 10);
    expect(stats.totalCostRPercentiles.P50).toBeCloseTo(0.015160714286, 10);
    expect(stats.correlationRiskPctToCostR).toBeCloseTo(-1, 10);
    expect(stats.costThresholdCounts).toEqual({
      OVER_0_25R: 0,
      OVER_0_5R: 0,
      OVER_1_0R: 0,
      OVER_1_5R: 0,
    });
    expect(first.manualReplaySample).toEqual(second.manualReplaySample);
    expect(first.manualReplaySample).toHaveLength(2);
    expect(first.strategyOutputFingerprint).toBe(second.strategyOutputFingerprint);
    expect(first.strategyOutputsUnchanged).toBe(true);
    expect(first.currentScenarioMatchesBaseline).toBe(true);
    expect(baseline).toEqual(before);
  });
});
