import { detectBreakoutFvg } from './breakoutFvg.js';
import {
  accountCasperNetPnl,
  type CasperCostAccountingResult,
  type CasperCostConfig,
  type CasperRrVariant,
} from './costAccounting.js';
import { replayCasperM1Execution, type M1ExecutionReplayResult } from './m1ExecutionReplay.js';
import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import { CasperOpeningRangeSession } from './openingRange.js';
import { createPendingLimitOrder } from './pendingLimitLifecycle.js';
import { createCasperTradePlan, type CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

export type CasperBacktestMode = 'FIRST_VALID_PER_DAY' | 'ALL_VALID_SETUPS';
export type CasperBacktestOutcome = 'WIN' | 'LOSS' | 'OPEN' | 'AMBIGUOUS' | 'CANCELLED' | 'INVALID';

export interface CasperHistoricalDataset {
  symbol: string;
  m15: readonly CasperCandle[];
  m5: readonly CasperCandle[];
  m1: readonly CasperCandle[];
}

export interface CasperBacktestConfig {
  costs: CasperCostConfig;
}

export interface CasperIntegrityIssue {
  code:
    | 'MISSING_OR_M15'
    | 'MISSING_M5'
    | 'MISSING_M1_COVERAGE'
    | 'MALFORMED_CANDLE'
    | 'DUPLICATE_TIMESTAMP'
    | 'OUT_OF_ORDER_TIMESTAMP'
    | 'INVALID_TRADE_PLAN';
  timeframe: 'M15' | 'M5' | 'M1' | 'PIPELINE';
  tradingDay?: string;
  timestampMs?: number;
  detail: string;
}

export interface CasperVariantTrace {
  outcome: CasperBacktestOutcome;
  configured: CasperCostAccountingResult;
  zeroCost: CasperCostAccountingResult;
}

export interface CasperBacktestTrace {
  symbol: string;
  tradingDay: string;
  direction: 'LONG' | 'SHORT';
  openingRange: { high: number; low: number };
  sourceTimestamps: {
    c1StartMs: number;
    c1EndMs: number;
    c2StartMs: number;
    c2EndMs: number;
    c3StartMs: number;
    c3EndMs: number;
  };
  fvgLow: number;
  fvgHigh: number;
  entry: number;
  stopLoss: number;
  targets: { '1.5R': number; '2.0R': number };
  createdAtMs: number;
  filledAtMs: number | null;
  executionState: M1ExecutionReplayResult['state'];
  variants: Record<CasperRrVariant, CasperVariantTrace>;
  outcomes: Record<CasperRrVariant, CasperBacktestOutcome>;
  reason: string | null;
}

export interface CasperVariantSummary {
  candidates: number;
  validSetups: number;
  fills: number;
  fillRate: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  ambiguous: number;
  ambiguousRate: number | null;
  cancelled: number;
  open: number;
  invalid: number;
  grossR: number;
  netR: number;
  averageNetRPerTrade: number | null;
  profitFactorNetR: number | null;
  maxDrawdownNetR: number;
  cumulativeNetR: number;
  costDragR: number;
  costDragPercent: number | null;
  averageFeeImpactR: number | null;
  averageSlippageImpactR: number | null;
  grossWinnersNetNonPositive: number;
  grossEdgeConsumedPercent: number | null;
  zeroCostControlR: number;
}

export interface CasperHistoricalBacktestResult {
  state: 'COMPLETED' | 'INVALID_CONFIG' | 'INVALID_DATA';
  symbol: string;
  costs: CasperCostConfig;
  costPercent: CasperCostConfig;
  issues: CasperIntegrityIssue[];
  traces: CasperBacktestTrace[];
  selectedTraceIndexes: Record<CasperBacktestMode, number[]>;
  summaries: Record<CasperBacktestMode, Record<CasperRrVariant, CasperVariantSummary>>;
}

const variants: readonly CasperRrVariant[] = ['1.5R', '2.0R'];
const modes: readonly CasperBacktestMode[] = ['FIRST_VALID_PER_DAY', 'ALL_VALID_SETUPS'];
const zeroCosts: CasperCostConfig = {
  entryFeeRate: 0,
  exitFeeRate: 0,
  entrySlippageRate: 0,
  exitSlippageRate: 0,
};

function validRunnerCosts(costs: CasperCostConfig): boolean {
  return Object.values(costs).every((rate) => Number.isFinite(rate) && rate >= 0 && rate < 1);
}

function validOhlc(candle: CasperCandle): boolean {
  return (
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
    candle.high >= candle.low &&
    candle.open >= candle.low &&
    candle.open <= candle.high &&
    candle.close >= candle.low &&
    candle.close <= candle.high
  );
}

function isValidM15(candle: CasperCandle): boolean {
  const start = getNewYorkTimeParts(candle.startTimeMs);
  const end = getNewYorkTimeParts(candle.endTimeMs);
  return (
    candle.endTimeMs - candle.startTimeMs === 15 * 60_000 &&
    start !== null &&
    end !== null &&
    start.second === 0 &&
    end.second === 0 &&
    validOhlc(candle)
  );
}

function isStructurallyValid(candle: CasperCandle, timeframe: 'M15' | 'M5' | 'M1'): boolean {
  if (timeframe === 'M15') return isValidM15(candle);
  const start = getNewYorkTimeParts(candle.startTimeMs);
  const end = getNewYorkTimeParts(candle.endTimeMs);
  const duration = timeframe === 'M5' ? 5 * 60_000 : 60_000;
  const aligned = timeframe === 'M1' || (start !== null && start.minute % 5 === 0);
  return (
    candle.endTimeMs - candle.startTimeMs === duration &&
    start !== null &&
    end !== null &&
    start.second === 0 &&
    end.second === 0 &&
    aligned &&
    validOhlc(candle)
  );
}

function structuralIssues(
  candles: readonly CasperCandle[],
  timeframe: 'M15' | 'M5' | 'M1',
): CasperIntegrityIssue[] {
  const issues: CasperIntegrityIssue[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    const day = getNewYorkTimeParts(current.startTimeMs)?.tradingDay;
    const valid = isStructurallyValid(current, timeframe);
    if (!valid) {
      issues.push({
        code: 'MALFORMED_CANDLE',
        timeframe,
        tradingDay: day,
        timestampMs: current.startTimeMs,
        detail: `${timeframe} candle failed duration, alignment, trading-day, or OHLC validation`,
      });
    }
    if (index === 0) continue;
    if (current.startTimeMs === candles[index - 1].startTimeMs) {
      issues.push({
        code: 'DUPLICATE_TIMESTAMP',
        timeframe,
        tradingDay: day,
        timestampMs: current.startTimeMs,
        detail: `${timeframe} contains a duplicate start timestamp`,
      });
    } else if (current.startTimeMs < candles[index - 1].startTimeMs) {
      issues.push({
        code: 'OUT_OF_ORDER_TIMESTAMP',
        timeframe,
        tradingDay: day,
        timestampMs: current.startTimeMs,
        detail: `${timeframe} candles are not chronological ascending`,
      });
    }
  }
  return issues;
}

function tradingDay(candle: CasperCandle): string | null {
  return getNewYorkTimeParts(candle.startTimeMs)?.tradingDay ?? null;
}

function groupByDay(candles: readonly CasperCandle[]): Map<string, CasperCandle[]> {
  const grouped = new Map<string, CasperCandle[]>();
  for (const candle of candles) {
    const day = tradingDay(candle);
    if (!day) continue;
    const values = grouped.get(day) ?? [];
    values.push(candle);
    grouped.set(day, values);
  }
  return grouped;
}

function executionOutcome(
  execution: M1ExecutionReplayResult,
  variant: CasperRrVariant,
): CasperBacktestOutcome {
  if (execution.state === 'FILLED') return execution.variants[variant];
  if (execution.state === 'CANCELLED') return 'CANCELLED';
  if (execution.state === 'INVALID') return 'INVALID';
  return 'INVALID';
}

function invalidExecution(): M1ExecutionReplayResult {
  return { state: 'INVALID', reason: 'INVALID_M1_DATA' };
}

function replayWithCoverage(
  plan: CasperTradePlan,
  candles: readonly CasperCandle[],
  issues: CasperIntegrityIssue[],
): M1ExecutionReplayResult {
  const relevant = candles.filter(
    (candle) =>
      candle.endTimeMs > plan.sourceCandles.c3.endTimeMs &&
      getNewYorkTimeParts(candle.endTimeMs)?.tradingDay === plan.tradingDay,
  );
  const first = relevant[0];
  let complete = Boolean(first && first.startTimeMs === plan.sourceCandles.c3.endTimeMs);
  for (let index = 1; index < relevant.length; index += 1) {
    if (relevant[index].startTimeMs !== relevant[index - 1].endTimeMs) complete = false;
  }
  if (!complete) {
    issues.push({
      code: 'MISSING_M1_COVERAGE',
      timeframe: 'M1',
      tradingDay: plan.tradingDay,
      timestampMs: plan.sourceCandles.c3.endTimeMs,
      detail: 'M1 replay must begin at C3 close and remain contiguous',
    });
    return invalidExecution();
  }
  const pendingOrder = createPendingLimitOrder(plan);
  const replay = replayCasperM1Execution({ tradePlan: plan, pendingOrder, candles: relevant });
  if (replay.state === 'PENDING') {
    issues.push({
      code: 'MISSING_M1_COVERAGE',
      timeframe: 'M1',
      tradingDay: plan.tradingDay,
      timestampMs: relevant.at(-1)?.endTimeMs,
      detail: 'M1 replay ended before the pending order reached a terminal state',
    });
    return invalidExecution();
  }
  return replay;
}

function traceFrom(
  symbol: string,
  openingRange: { high: number; low: number },
  plan: CasperTradePlan,
  execution: M1ExecutionReplayResult,
  costs: CasperCostConfig,
): CasperBacktestTrace {
  const variantResults = Object.fromEntries(
    variants.map((variant) => [
      variant,
      {
        outcome: executionOutcome(execution, variant),
        configured: accountCasperNetPnl({ tradePlan: plan, execution, variant, costs }),
        zeroCost: accountCasperNetPnl({ tradePlan: plan, execution, variant, costs: zeroCosts }),
      },
    ]),
  ) as Record<CasperRrVariant, CasperVariantTrace>;
  const { c1, c2, c3 } = plan.sourceCandles;
  return {
    symbol,
    tradingDay: plan.tradingDay,
    direction: plan.direction,
    openingRange,
    sourceTimestamps: {
      c1StartMs: c1.startTimeMs,
      c1EndMs: c1.endTimeMs,
      c2StartMs: c2.startTimeMs,
      c2EndMs: c2.endTimeMs,
      c3StartMs: c3.startTimeMs,
      c3EndMs: c3.endTimeMs,
    },
    fvgLow: plan.fvgLow,
    fvgHigh: plan.fvgHigh,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    targets: plan.targets,
    createdAtMs: c3.endTimeMs,
    filledAtMs: execution.state === 'FILLED' ? execution.filledAtMs : null,
    executionState: execution.state,
    variants: variantResults,
    outcomes: {
      '1.5R': variantResults['1.5R'].outcome,
      '2.0R': variantResults['2.0R'].outcome,
    },
    reason:
      execution.state === 'INVALID'
        ? execution.reason
        : execution.state === 'CANCELLED'
          ? 'NO_FILL_BEFORE_12_00_NY'
          : Object.values(variantResults).some((result) => result.outcome === 'AMBIGUOUS')
            ? 'INTRABAR_ORDER_UNRESOLVED'
            : null,
  };
}

function emptySummary(candidates: number, validSetups: number): CasperVariantSummary {
  return {
    candidates,
    validSetups,
    fills: 0,
    fillRate: null,
    wins: 0,
    losses: 0,
    winRate: null,
    ambiguous: 0,
    ambiguousRate: null,
    cancelled: 0,
    open: 0,
    invalid: 0,
    grossR: 0,
    netR: 0,
    averageNetRPerTrade: null,
    profitFactorNetR: null,
    maxDrawdownNetR: 0,
    cumulativeNetR: 0,
    costDragR: 0,
    costDragPercent: null,
    averageFeeImpactR: null,
    averageSlippageImpactR: null,
    grossWinnersNetNonPositive: 0,
    grossEdgeConsumedPercent: null,
    zeroCostControlR: 0,
  };
}

function normalizedMetric(value: number): number {
  const rounded = Number(value.toFixed(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function summarize(
  traces: readonly CasperBacktestTrace[],
  variant: CasperRrVariant,
  candidates: number,
): CasperVariantSummary {
  const summary = emptySummary(candidates, traces.length);
  const netValues: number[] = [];
  let positiveNet = 0;
  let negativeNet = 0;
  let feeImpactR = 0;
  let slippageImpactR = 0;
  let grossWinnerR = 0;
  let grossWinnerCostDragR = 0;
  for (const trace of traces) {
    const item = trace.variants[variant];
    const outcome = item.outcome;
    if (trace.executionState === 'FILLED') summary.fills += 1;
    if (outcome === 'WIN') summary.wins += 1;
    else if (outcome === 'LOSS') summary.losses += 1;
    else if (outcome === 'AMBIGUOUS') summary.ambiguous += 1;
    else if (outcome === 'CANCELLED') summary.cancelled += 1;
    else if (outcome === 'OPEN') summary.open += 1;
    else summary.invalid += 1;
    if (item.configured.state !== 'ACCOUNTED' || item.zeroCost.state !== 'ACCOUNTED') continue;
    summary.grossR += item.configured.grossR;
    summary.netR += item.configured.netR;
    summary.zeroCostControlR += item.zeroCost.netR;
    netValues.push(item.configured.netR);
    if (item.configured.netR > 0) positiveNet += item.configured.netR;
    if (item.configured.netR < 0) negativeNet += item.configured.netR;
    feeImpactR += item.configured.feePerUnit / Math.abs(trace.entry - trace.stopLoss);
    slippageImpactR += item.configured.slippageImpactPerUnit / Math.abs(trace.entry - trace.stopLoss);
    if (item.configured.grossR > 0) {
      grossWinnerR += item.configured.grossR;
      grossWinnerCostDragR += item.configured.grossR - item.configured.netR;
    }
    if (item.configured.grossR > 0 && item.configured.netR <= 0) {
      summary.grossWinnersNetNonPositive += 1;
    }
  }
  const resolved = summary.wins + summary.losses;
  summary.fillRate = traces.length > 0 ? summary.fills / traces.length : null;
  summary.winRate = resolved > 0 ? summary.wins / resolved : null;
  summary.ambiguousRate = summary.fills > 0 ? summary.ambiguous / summary.fills : null;
  summary.averageNetRPerTrade = resolved > 0 ? summary.netR / resolved : null;
  summary.profitFactorNetR = negativeNet < 0 ? positiveNet / Math.abs(negativeNet) : null;
  let cumulative = 0;
  let peak = 0;
  for (const netR of netValues) {
    cumulative += netR;
    peak = Math.max(peak, cumulative);
    summary.maxDrawdownNetR = Math.max(summary.maxDrawdownNetR, peak - cumulative);
  }
  summary.grossR = normalizedMetric(summary.grossR);
  summary.netR = normalizedMetric(summary.netR);
  summary.zeroCostControlR = normalizedMetric(summary.zeroCostControlR);
  summary.maxDrawdownNetR = normalizedMetric(summary.maxDrawdownNetR);
  summary.cumulativeNetR = normalizedMetric(cumulative);
  summary.costDragR = normalizedMetric(summary.grossR - summary.netR);
  summary.costDragPercent = summary.grossR !== 0 ? (summary.costDragR / Math.abs(summary.grossR)) * 100 : null;
  const winnerCostDrag = normalizedMetric(grossWinnerCostDragR);
  summary.grossEdgeConsumedPercent = grossWinnerR > 0 ? (winnerCostDrag / grossWinnerR) * 100 : null;
  summary.averageFeeImpactR = resolved > 0 ? feeImpactR / resolved : null;
  summary.averageSlippageImpactR = resolved > 0 ? slippageImpactR / resolved : null;
  return summary;
}

function selectedIndexes(traces: readonly CasperBacktestTrace[]): Record<CasperBacktestMode, number[]> {
  const all = traces.map((_, index) => index);
  const seen = new Set<string>();
  const first = all.filter((index) => {
    const day = traces[index].tradingDay;
    if (seen.has(day)) return false;
    seen.add(day);
    return true;
  });
  return { FIRST_VALID_PER_DAY: first, ALL_VALID_SETUPS: all };
}

function blankResult(
  state: CasperHistoricalBacktestResult['state'],
  dataset: CasperHistoricalDataset,
  costs: CasperCostConfig,
  issues: CasperIntegrityIssue[],
): CasperHistoricalBacktestResult {
  const blank = { '1.5R': emptySummary(0, 0), '2.0R': emptySummary(0, 0) };
  return {
    state,
    symbol: dataset.symbol,
    costs,
    costPercent: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, value * 100])) as unknown as CasperCostConfig,
    issues,
    traces: [],
    selectedTraceIndexes: { FIRST_VALID_PER_DAY: [], ALL_VALID_SETUPS: [] },
    summaries: { FIRST_VALID_PER_DAY: blank, ALL_VALID_SETUPS: { ...blank } },
  };
}

export function runCasperHistoricalBacktest(
  dataset: CasperHistoricalDataset,
  config: CasperBacktestConfig,
): CasperHistoricalBacktestResult {
  if (!validRunnerCosts(config.costs)) return blankResult('INVALID_CONFIG', dataset, config.costs, []);
  const structural = [
    ...structuralIssues(dataset.m15, 'M15'),
    ...structuralIssues(dataset.m5, 'M5'),
    ...structuralIssues(dataset.m1, 'M1'),
  ];
  if (structural.length > 0) return blankResult('INVALID_DATA', dataset, config.costs, structural);

  const issues: CasperIntegrityIssue[] = [];
  const m15ByDay = groupByDay(dataset.m15);
  const m5ByDay = groupByDay(dataset.m5);
  const m1ByDay = groupByDay(dataset.m1);
  const days = [...new Set([...m15ByDay.keys(), ...m5ByDay.keys()])].sort();
  const traces: CasperBacktestTrace[] = [];
  const openingRangeSession = new CasperOpeningRangeSession();
  let candidates = 0;

  for (const day of days) {
    const dayM15 = m15ByDay.get(day) ?? [];
    const dayM5 = m5ByDay.get(day) ?? [];
    const evaluationMs =
      dayM5.find((item) => {
        const end = getNewYorkTimeParts(item.endTimeMs);
        return Boolean(end && minuteOfDay(end) >= 9 * 60 + 45);
      })?.endTimeMs ??
      dayM15.find((item) => {
        const end = getNewYorkTimeParts(item.endTimeMs);
        return Boolean(end && minuteOfDay(end) >= 9 * 60 + 45);
      })?.endTimeMs;
    if (evaluationMs === undefined) continue;
    const openingRange = openingRangeSession.evaluate(evaluationMs, dayM15);
    if (openingRange.state !== 'OR_LOCKED') {
      issues.push({
        code: 'MISSING_OR_M15',
        timeframe: 'M15',
        tradingDay: day,
        detail: 'No valid 09:30-09:45 New York M15 candle was available to lock the range',
      });
      continue;
    }
    const sessionM5 = dayM5.filter((item) => {
      const start = getNewYorkTimeParts(item.startTimeMs);
      const end = getNewYorkTimeParts(item.endTimeMs);
      return Boolean(
        start &&
          end &&
          start.tradingDay === day &&
          end.tradingDay === day &&
          minuteOfDay(start) >= 9 * 60 + 45 &&
          minuteOfDay(start) < 12 * 60 &&
          minuteOfDay(end) < 12 * 60,
      );
    });
    if (sessionM5.length < 3) {
      issues.push({
        code: 'MISSING_M5',
        timeframe: 'M5',
        tradingDay: day,
        detail: 'Fewer than three closed M5 candles were available in the setup window',
      });
      continue;
    }
    for (let index = 1; index < sessionM5.length; index += 1) {
      if (sessionM5[index].startTimeMs !== sessionM5[index - 1].endTimeMs) {
        issues.push({
          code: 'MISSING_M5',
          timeframe: 'M5',
          tradingDay: day,
          timestampMs: sessionM5[index - 1].endTimeMs,
          detail: 'M5 setup-window candles contain a coverage gap',
        });
      }
    }
    for (let index = 0; index <= sessionM5.length - 3; index += 1) {
      const [c1, c2, c3] = sessionM5.slice(index, index + 3);
      candidates += 1;
      const fvg = detectBreakoutFvg({ nowMs: c3.endTimeMs, c1, c2, c3, openingRange });
      if (fvg.state !== 'VALID_BULLISH_FVG' && fvg.state !== 'VALID_BEARISH_FVG') continue;
      const tradePlan = createCasperTradePlan(fvg);
      if (tradePlan.state !== 'VALID_TRADE_PLAN') {
        issues.push({
          code: 'INVALID_TRADE_PLAN',
          timeframe: 'PIPELINE',
          tradingDay: day,
          timestampMs: c3.endTimeMs,
          detail: tradePlan.reason,
        });
        continue;
      }
      const execution = replayWithCoverage(tradePlan, m1ByDay.get(day) ?? [], issues);
      traces.push(traceFrom(dataset.symbol, openingRange.range, tradePlan, execution, config.costs));
    }
  }

  traces.sort((left, right) => left.createdAtMs - right.createdAtMs);
  const selection = selectedIndexes(traces);
  const summaries = Object.fromEntries(
    modes.map((mode) => {
      const selected = selection[mode].map((index) => traces[index]);
      return [mode, Object.fromEntries(variants.map((variant) => [variant, summarize(selected, variant, candidates)]))];
    }),
  ) as Record<CasperBacktestMode, Record<CasperRrVariant, CasperVariantSummary>>;

  return {
    state: 'COMPLETED',
    symbol: dataset.symbol,
    costs: config.costs,
    costPercent: Object.fromEntries(
      Object.entries(config.costs).map(([key, value]) => [key, value * 100]),
    ) as unknown as CasperCostConfig,
    issues,
    traces,
    selectedTraceIndexes: selection,
    summaries,
  };
}
