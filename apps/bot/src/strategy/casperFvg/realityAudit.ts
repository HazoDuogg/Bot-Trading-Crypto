import { accountCasperNetPnl, type CasperRrVariant } from './costAccounting.js';
import type {
  CasperBacktestMode,
  CasperBacktestOutcome,
  CasperBacktestTrace,
  CasperHistoricalBacktestResult,
  CasperHistoricalDataset,
} from './historicalBacktest.js';
import type { M1ExecutionReplayResult, M1VariantOutcome } from './m1ExecutionReplay.js';
import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import type { CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

export interface CasperExecutionCostScenario {
  entryFeeRate: number;
  tpExitFeeRate: number;
  slExitFeeRate: number;
  entrySlippageRate: number;
  tpExitSlippageRate: number;
  slExitSlippageRate: number;
}

export type CasperRealityScenarioName =
  | 'CURRENT_RT101'
  | 'MAKER_TP_TAKER_SL'
  | 'ZERO_COST_CONTROL';

export type CasperRealityScenarios = Record<CasperRealityScenarioName, CasperExecutionCostScenario>;

export interface CasperScenarioMetrics {
  grossR: number;
  netR: number;
  averageNetR: number | null;
  profitFactorNet: number | null;
  maxDrawdownNetR: number;
  costDragR: number;
  grossWinnersNetNonPositive: number;
  averageEntryCostR: number | null;
  averageTpExitCostR: number | null;
  averageSlExitCostR: number | null;
  averageTpCostR: number | null;
  averageSlCostR: number | null;
}

export interface AuditCasperBacktestRealityInput {
  baseline: CasperHistoricalBacktestResult;
  dataset: CasperHistoricalDataset;
  scenarios: CasperRealityScenarios;
  sampleSize: number;
}

export interface CasperRealityAuditResult {
  state: 'COMPLETED' | 'INVALID_INPUT';
  scenarioComparisons: Record<
    CasperBacktestMode,
    Record<CasperRrVariant, Record<CasperRealityScenarioName, CasperScenarioMetrics>>
  >;
  restingFillAudit: CasperRestingFillAudit;
  ambiguityAudit: Record<CasperBacktestMode, Record<CasperRrVariant, CasperAmbiguityMetrics>>;
  riskCostAudit: Record<CasperRrVariant, CasperRiskCostMetrics>;
  manualReplaySample: CasperManualReplayRecord[];
  strategyOutputFingerprint: string;
  strategyOutputsUnchanged: boolean;
  currentScenarioMatchesBaseline: boolean;
}

export interface CasperPercentiles {
  P10: number;
  P25: number;
  P50: number;
  P75: number;
  P90: number;
}

export interface CasperRiskCostMetrics {
  sampleSize: number;
  riskPctOfEntryPercentiles: CasperPercentiles;
  totalCostRPercentiles: CasperPercentiles;
  correlationRiskPctToCostR: number | null;
  costThresholdCounts: {
    OVER_0_25R: number;
    OVER_0_5R: number;
    OVER_1_0R: number;
    OVER_1_5R: number;
  };
}

export interface CasperManualReplayRecord {
  traceIndex: number;
  tradingDay: string;
  direction: 'LONG' | 'SHORT';
  openingRange: { high: number; low: number };
  sourceCandles: { c1: CasperCandle; c2: CasperCandle; c3: CasperCandle };
  fvg: { low: number; high: number };
  entry: number;
  stopLoss: number;
  targets: { '1.5R': number; '2.0R': number };
  createdAtMs: number;
  filledAtMs: number | null;
  engineState: CasperBacktestTrace['executionState'];
  outcomes: Record<CasperRrVariant, CasperBacktestOutcome>;
  costImpactR: Record<CasperRrVariant, number | null>;
  fillCategory: CasperRestingFillCategory;
  auditCategories: string[];
  riskPctOfEntry: number;
}

export interface CasperAmbiguityMetrics {
  count: number;
  percentOfFills: number | null;
  percentOfResolvedSample: number | null;
  categories: {
    FILL_PLUS_SL_SAME_M1: number;
    FILL_PLUS_TP_SAME_M1: number;
    SL_PLUS_TP_SAME_LATER_M1: number;
  };
  unclassified: number;
  hypotheticalGrossRange: { slFirstR: number; tpFirstR: number };
}

export type CasperRestingFillCategory =
  | 'EXACT_TOUCH'
  | 'RANGE_CONTAINS_ENTRY'
  | 'GAP_CROSS_BEYOND_ENTRY'
  | 'NO_TOUCH';

export interface CasperRestingFillRecord {
  traceIndex: number;
  tradingDay: string;
  direction: 'LONG' | 'SHORT';
  category: CasperRestingFillCategory;
  evidenceCandleStartMs: number | null;
  engineState: CasperBacktestTrace['executionState'];
}

export interface CasperRestingFillAudit {
  total: Record<CasperRestingFillCategory, number>;
  byDirection: Record<'LONG' | 'SHORT', Record<CasperRestingFillCategory, number>>;
  impactedGapCrossCount: number;
  records: CasperRestingFillRecord[];
}

const modes: readonly CasperBacktestMode[] = ['FIRST_VALID_PER_DAY', 'ALL_VALID_SETUPS'];
const variants: readonly CasperRrVariant[] = ['1.5R', '2.0R'];
const scenarioNames: readonly CasperRealityScenarioName[] = [
  'CURRENT_RT101',
  'MAKER_TP_TAKER_SL',
  'ZERO_COST_CONTROL',
];

function normalized(value: number): number {
  const rounded = Number(value.toFixed(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function emptyFillCounts(): Record<CasperRestingFillCategory, number> {
  return {
    EXACT_TOUCH: 0,
    RANGE_CONTAINS_ENTRY: 0,
    GAP_CROSS_BEYOND_ENTRY: 0,
    NO_TOUCH: 0,
  };
}

function lowerBound(candles: readonly CasperCandle[], startTimeMs: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].startTimeMs < startTimeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function pendingCutoffMs(trace: CasperBacktestTrace): number | null {
  const created = getNewYorkTimeParts(trace.createdAtMs);
  if (!created || created.tradingDay !== trace.tradingDay) return null;
  return trace.createdAtMs + (12 * 60 - minuteOfDay(created)) * 60_000 - created.second * 1000;
}

function classifyRestingFill(
  trace: CasperBacktestTrace,
  candles: readonly CasperCandle[],
): { category: CasperRestingFillCategory; evidenceCandleStartMs: number | null } {
  const cutoffMs = pendingCutoffMs(trace);
  if (cutoffMs === null) return { category: 'NO_TOUCH', evidenceCandleStartMs: null };
  for (let index = lowerBound(candles, trace.createdAtMs); index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.endTimeMs >= cutoffMs) break;
    if (candle.low <= trace.entry && candle.high >= trace.entry) {
      const exact = candle.low === trace.entry || candle.high === trace.entry;
      return {
        category: exact ? 'EXACT_TOUCH' : 'RANGE_CONTAINS_ENTRY',
        evidenceCandleStartMs: candle.startTimeMs,
      };
    }
    const crossed =
      trace.direction === 'LONG' ? candle.high < trace.entry : candle.low > trace.entry;
    if (crossed) {
      return { category: 'GAP_CROSS_BEYOND_ENTRY', evidenceCandleStartMs: candle.startTimeMs };
    }
  }
  return { category: 'NO_TOUCH', evidenceCandleStartMs: null };
}

function auditRestingFills(
  traces: readonly CasperBacktestTrace[],
  candles: readonly CasperCandle[],
): CasperRestingFillAudit {
  const total = emptyFillCounts();
  const byDirection = { LONG: emptyFillCounts(), SHORT: emptyFillCounts() };
  const records = traces.map((trace, traceIndex) => {
    const classification = classifyRestingFill(trace, candles);
    total[classification.category] += 1;
    byDirection[trace.direction][classification.category] += 1;
    return {
      traceIndex,
      tradingDay: trace.tradingDay,
      direction: trace.direction,
      category: classification.category,
      evidenceCandleStartMs: classification.evidenceCandleStartMs,
      engineState: trace.executionState,
    };
  });
  return {
    total,
    byDirection,
    impactedGapCrossCount: total.GAP_CROSS_BEYOND_ENTRY,
    records,
  };
}

function touchesStop(trace: CasperBacktestTrace, candle: CasperCandle): boolean {
  return trace.direction === 'LONG'
    ? candle.low <= trace.stopLoss
    : candle.high >= trace.stopLoss;
}

function touchesTarget(
  trace: CasperBacktestTrace,
  candle: CasperCandle,
  variant: CasperRrVariant,
): boolean {
  return trace.direction === 'LONG'
    ? candle.high >= trace.targets[variant]
    : candle.low <= trace.targets[variant];
}

function ambiguityMetrics(
  traces: readonly CasperBacktestTrace[],
  variant: CasperRrVariant,
  candles: readonly CasperCandle[],
): CasperAmbiguityMetrics {
  const categories = {
    FILL_PLUS_SL_SAME_M1: 0,
    FILL_PLUS_TP_SAME_M1: 0,
    SL_PLUS_TP_SAME_LATER_M1: 0,
  };
  let count = 0;
  let fills = 0;
  let wins = 0;
  let losses = 0;
  let resolvedGrossR = 0;
  let classified = 0;
  for (const trace of traces) {
    const outcome = trace.outcomes[variant];
    if (trace.executionState === 'FILLED') fills += 1;
    if (outcome === 'WIN') {
      wins += 1;
      resolvedGrossR += variant === '1.5R' ? 1.5 : 2;
    }
    if (outcome === 'LOSS') {
      losses += 1;
      resolvedGrossR -= 1;
    }
    if (outcome !== 'AMBIGUOUS' || trace.filledAtMs === null) continue;
    count += 1;
    const fillIndex = lowerBound(candles, trace.filledAtMs - 60_000);
    const fillCandle = candles[fillIndex]?.endTimeMs === trace.filledAtMs ? candles[fillIndex] : undefined;
    let matched = false;
    if (fillCandle && touchesStop(trace, fillCandle)) {
      categories.FILL_PLUS_SL_SAME_M1 += 1;
      matched = true;
    }
    if (fillCandle && touchesTarget(trace, fillCandle, variant)) {
      categories.FILL_PLUS_TP_SAME_M1 += 1;
      matched = true;
    }
    if (!matched) {
      let laterBoth = false;
      for (let index = fillIndex + 1; index < candles.length; index += 1) {
        const candle = candles[index];
        const day = getNewYorkTimeParts(candle.startTimeMs)?.tradingDay;
        if (day !== trace.tradingDay) break;
        if (touchesStop(trace, candle) && touchesTarget(trace, candle, variant)) {
          laterBoth = true;
          break;
        }
      }
      if (laterBoth) {
        categories.SL_PLUS_TP_SAME_LATER_M1 += 1;
        matched = true;
      }
    }
    if (matched) classified += 1;
  }
  const resolved = wins + losses;
  const reward = variant === '1.5R' ? 1.5 : 2;
  return {
    count,
    percentOfFills: fills > 0 ? count / fills : null,
    percentOfResolvedSample: resolved > 0 ? count / resolved : null,
    categories,
    unclassified: count - classified,
    hypotheticalGrossRange: {
      slFirstR: normalized(resolvedGrossR - count),
      tpFirstR: normalized(resolvedGrossR + reward * count),
    },
  };
}

function auditAmbiguity(
  baseline: CasperHistoricalBacktestResult,
  candles: readonly CasperCandle[],
): CasperRealityAuditResult['ambiguityAudit'] {
  return Object.fromEntries(
    modes.map((mode) => {
      const traces = baseline.selectedTraceIndexes[mode].map((index) => baseline.traces[index]);
      return [
        mode,
        Object.fromEntries(
          variants.map((variant) => [variant, ambiguityMetrics(traces, variant, candles)]),
        ),
      ];
    }),
  ) as CasperRealityAuditResult['ambiguityAudit'];
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function percentiles(values: readonly number[]): CasperPercentiles {
  return {
    P10: percentile(values, 0.1),
    P25: percentile(values, 0.25),
    P50: percentile(values, 0.5),
    P75: percentile(values, 0.75),
    P90: percentile(values, 0.9),
  };
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : null;
}

function auditRiskCost(
  traces: readonly CasperBacktestTrace[],
  variant: CasperRrVariant,
): CasperRiskCostMetrics {
  const riskPcts: number[] = [];
  const costs: number[] = [];
  for (const trace of traces) {
    const accounted = trace.variants[variant].configured;
    if (accounted.state !== 'ACCOUNTED') continue;
    riskPcts.push(Math.abs(trace.entry - trace.stopLoss) / Math.abs(trace.entry));
    costs.push(accounted.grossR - accounted.netR);
  }
  return {
    sampleSize: costs.length,
    riskPctOfEntryPercentiles: percentiles(riskPcts),
    totalCostRPercentiles: percentiles(costs),
    correlationRiskPctToCostR: correlation(riskPcts, costs),
    costThresholdCounts: {
      OVER_0_25R: costs.filter((value) => value > 0.25).length,
      OVER_0_5R: costs.filter((value) => value > 0.5).length,
      OVER_1_0R: costs.filter((value) => value > 1).length,
      OVER_1_5R: costs.filter((value) => value > 1.5).length,
    },
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fingerprint(value: unknown): string {
  return stableHash(JSON.stringify(value)).toString(16).padStart(8, '0');
}

function buildManualRecords(
  baseline: CasperHistoricalBacktestResult,
  byStart: ReadonlyMap<number, CasperCandle>,
  fillAudit: CasperRestingFillAudit,
): CasperManualReplayRecord[] {
  const riskP10 = percentile(
    baseline.traces.map((trace) => Math.abs(trace.entry - trace.stopLoss) / Math.abs(trace.entry)),
    0.1,
  );
  return baseline.traces.flatMap((trace, traceIndex) => {
    const c1 = byStart.get(trace.sourceTimestamps.c1StartMs);
    const c2 = byStart.get(trace.sourceTimestamps.c2StartMs);
    const c3 = byStart.get(trace.sourceTimestamps.c3StartMs);
    if (!c1 || !c2 || !c3) return [];
    const riskPctOfEntry = Math.abs(trace.entry - trace.stopLoss) / Math.abs(trace.entry);
    const time = getNewYorkTimeParts(trace.createdAtMs);
    const sessionCategory =
      time && minuteOfDay(time) < 10 * 60 + 30
        ? 'EARLY_SESSION'
        : time && minuteOfDay(time) >= 11 * 60 + 15
          ? 'NEAR_NOON'
          : 'MID_SESSION';
    const auditCategories = [
      trace.outcomes['1.5R'],
      trace.outcomes['2.0R'],
      trace.direction,
      sessionCategory,
    ];
    if (riskPctOfEntry <= riskP10) auditCategories.push('SMALL_RISK');
    return [{
      traceIndex,
      tradingDay: trace.tradingDay,
      direction: trace.direction,
      openingRange: trace.openingRange,
      sourceCandles: { c1, c2, c3 },
      fvg: { low: trace.fvgLow, high: trace.fvgHigh },
      entry: trace.entry,
      stopLoss: trace.stopLoss,
      targets: trace.targets,
      createdAtMs: trace.createdAtMs,
      filledAtMs: trace.filledAtMs,
      engineState: trace.executionState,
      outcomes: trace.outcomes,
      costImpactR: Object.fromEntries(
        variants.map((variant) => {
          const value = trace.variants[variant].configured;
          return [variant, value.state === 'ACCOUNTED' ? value.grossR - value.netR : null];
        }),
      ) as Record<CasperRrVariant, number | null>,
      fillCategory: fillAudit.records[traceIndex].category,
      auditCategories,
      riskPctOfEntry,
    }];
  });
}

function selectManualSample(
  records: readonly CasperManualReplayRecord[],
  sampleSize: number,
): CasperManualReplayRecord[] {
  const target = Math.max(0, Math.min(Math.floor(sampleSize), records.length));
  const ranked = [...records].sort((left, right) => {
    const leftHash = stableHash(`${left.tradingDay}:${left.createdAtMs}:${left.direction}`);
    const rightHash = stableHash(`${right.tradingDay}:${right.createdAtMs}:${right.direction}`);
    return leftHash - rightHash || left.createdAtMs - right.createdAtMs;
  });
  const selected = new Map<number, CasperManualReplayRecord>();
  const required = [
    'WIN',
    'LOSS',
    'CANCELLED',
    'AMBIGUOUS',
    'LONG',
    'SHORT',
    'EARLY_SESSION',
    'NEAR_NOON',
    'SMALL_RISK',
  ];
  for (const category of required) {
    const match = ranked.find((record) => record.auditCategories.includes(category));
    if (match && selected.size < target) selected.set(match.traceIndex, match);
  }
  for (const record of ranked) {
    if (selected.size >= target) break;
    selected.set(record.traceIndex, record);
  }
  return [...selected.values()].sort((left, right) => left.createdAtMs - right.createdAtMs);
}

function sameMetric(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function currentMatchesBaseline(
  baseline: CasperHistoricalBacktestResult,
  comparison: CasperRealityAuditResult['scenarioComparisons'],
): boolean {
  return modes.every((mode) =>
    variants.every((variant) => {
      const original = baseline.summaries[mode][variant];
      const audited = comparison[mode][variant].CURRENT_RT101;
      return (
        sameMetric(original.grossR, audited.grossR) &&
        sameMetric(original.netR, audited.netR) &&
        sameMetric(original.averageNetRPerTrade, audited.averageNetR) &&
        sameMetric(original.profitFactorNetR, audited.profitFactorNet) &&
        sameMetric(original.maxDrawdownNetR, audited.maxDrawdownNetR) &&
        original.grossWinnersNetNonPositive === audited.grossWinnersNetNonPositive
      );
    }),
  );
}

function sourceCandle(
  byStart: ReadonlyMap<number, CasperCandle>,
  startTimeMs: number,
): CasperCandle | null {
  return byStart.get(startTimeMs) ?? null;
}

function planFromTrace(
  trace: CasperBacktestTrace,
  byStart: ReadonlyMap<number, CasperCandle>,
): CasperTradePlan | null {
  const c1 = sourceCandle(byStart, trace.sourceTimestamps.c1StartMs);
  const c2 = sourceCandle(byStart, trace.sourceTimestamps.c2StartMs);
  const c3 = sourceCandle(byStart, trace.sourceTimestamps.c3StartMs);
  if (!c1 || !c2 || !c3) return null;
  return {
    state: 'VALID_TRADE_PLAN',
    direction: trace.direction,
    entryType: 'LIMIT',
    entry: trace.entry,
    stopLoss: trace.stopLoss,
    riskPerUnit: Math.abs(trace.entry - trace.stopLoss),
    targets: trace.targets,
    fvgLow: trace.fvgLow,
    fvgHigh: trace.fvgHigh,
    tradingDay: trace.tradingDay,
    sourceCandles: { c1, c2, c3 },
  };
}

function m1Outcome(outcome: CasperBacktestOutcome): M1VariantOutcome {
  return outcome === 'WIN' || outcome === 'LOSS' || outcome === 'AMBIGUOUS' ? outcome : 'OPEN';
}

function executionFromTrace(trace: CasperBacktestTrace): M1ExecutionReplayResult {
  if (trace.executionState === 'FILLED' && trace.filledAtMs !== null) {
    return {
      state: 'FILLED',
      direction: trace.direction,
      entry: trace.entry,
      stopLoss: trace.stopLoss,
      targets: trace.targets,
      createdAtMs: trace.createdAtMs,
      tradingDay: trace.tradingDay,
      filledAtMs: trace.filledAtMs,
      fillPrice: trace.entry,
      variants: {
        '1.5R': m1Outcome(trace.outcomes['1.5R']),
        '2.0R': m1Outcome(trace.outcomes['2.0R']),
      },
    };
  }
  return { state: 'INVALID', reason: 'INVALID_M1_DATA' };
}

function scenarioCosts(
  scenario: CasperExecutionCostScenario,
  outcome: 'WIN' | 'LOSS',
) {
  return {
    entryFeeRate: scenario.entryFeeRate,
    exitFeeRate: outcome === 'WIN' ? scenario.tpExitFeeRate : scenario.slExitFeeRate,
    entrySlippageRate: scenario.entrySlippageRate,
    exitSlippageRate:
      outcome === 'WIN' ? scenario.tpExitSlippageRate : scenario.slExitSlippageRate,
  };
}

function emptyMetrics(): CasperScenarioMetrics {
  return {
    grossR: 0,
    netR: 0,
    averageNetR: null,
    profitFactorNet: null,
    maxDrawdownNetR: 0,
    costDragR: 0,
    grossWinnersNetNonPositive: 0,
    averageEntryCostR: null,
    averageTpExitCostR: null,
    averageSlExitCostR: null,
    averageTpCostR: null,
    averageSlCostR: null,
  };
}

function summarizeScenario(
  traces: readonly CasperBacktestTrace[],
  variant: CasperRrVariant,
  scenario: CasperExecutionCostScenario,
  byStart: ReadonlyMap<number, CasperCandle>,
): CasperScenarioMetrics {
  const metrics = emptyMetrics();
  const netValues: number[] = [];
  let positiveNet = 0;
  let negativeNet = 0;
  let entryCostR = 0;
  let tpExitCostR = 0;
  let slExitCostR = 0;
  let tpTotalCostR = 0;
  let slTotalCostR = 0;
  let wins = 0;
  let losses = 0;
  for (const trace of traces) {
    const outcome = trace.outcomes[variant];
    if (outcome !== 'WIN' && outcome !== 'LOSS') continue;
    const plan = planFromTrace(trace, byStart);
    if (!plan) continue;
    const result = accountCasperNetPnl({
      tradePlan: plan,
      execution: executionFromTrace(trace),
      variant,
      costs: scenarioCosts(scenario, outcome),
    });
    if (result.state !== 'ACCOUNTED') continue;
    const risk = plan.riskPerUnit;
    const exitFeeRate = outcome === 'WIN' ? scenario.tpExitFeeRate : scenario.slExitFeeRate;
    const exitSlippageRate =
      outcome === 'WIN' ? scenario.tpExitSlippageRate : scenario.slExitSlippageRate;
    const entryCost = (Math.abs(result.entryPrice) * scenario.entryFeeRate + Math.abs(result.entryPrice) * scenario.entrySlippageRate) / risk;
    const exitCost = (Math.abs(result.exitPrice) * exitFeeRate + Math.abs(result.exitPrice) * exitSlippageRate) / risk;
    metrics.grossR += result.grossR;
    metrics.netR += result.netR;
    entryCostR += entryCost;
    netValues.push(result.netR);
    if (result.netR > 0) positiveNet += result.netR;
    if (result.netR < 0) negativeNet += result.netR;
    if (outcome === 'WIN') {
      wins += 1;
      tpExitCostR += exitCost;
      tpTotalCostR += result.grossR - result.netR;
      if (result.netR <= 0) metrics.grossWinnersNetNonPositive += 1;
    } else {
      losses += 1;
      slExitCostR += exitCost;
      slTotalCostR += result.grossR - result.netR;
    }
  }
  const resolved = wins + losses;
  metrics.grossR = normalized(metrics.grossR);
  metrics.netR = normalized(metrics.netR);
  metrics.averageNetR = resolved > 0 ? metrics.netR / resolved : null;
  metrics.profitFactorNet = negativeNet < 0 ? positiveNet / Math.abs(negativeNet) : null;
  let cumulative = 0;
  let peak = 0;
  for (const value of netValues) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    metrics.maxDrawdownNetR = Math.max(metrics.maxDrawdownNetR, peak - cumulative);
  }
  metrics.maxDrawdownNetR = normalized(metrics.maxDrawdownNetR);
  metrics.costDragR = normalized(metrics.grossR - metrics.netR);
  metrics.averageEntryCostR = resolved > 0 ? entryCostR / resolved : null;
  metrics.averageTpExitCostR = wins > 0 ? tpExitCostR / wins : null;
  metrics.averageSlExitCostR = losses > 0 ? slExitCostR / losses : null;
  metrics.averageTpCostR = wins > 0 ? tpTotalCostR / wins : null;
  metrics.averageSlCostR = losses > 0 ? slTotalCostR / losses : null;
  return metrics;
}

export function auditCasperBacktestReality(
  input: AuditCasperBacktestRealityInput,
): CasperRealityAuditResult {
  const strategySnapshot = {
    traces: input.baseline.traces,
    selectedTraceIndexes: input.baseline.selectedTraceIndexes,
    summaries: input.baseline.summaries,
  };
  const before = JSON.stringify(strategySnapshot);
  const byStart = new Map(input.dataset.m5.map((candle) => [candle.startTimeMs, candle]));
  const scenarioComparisons = Object.fromEntries(
    modes.map((mode) => {
      const traces = input.baseline.selectedTraceIndexes[mode].map((index) => input.baseline.traces[index]);
      return [
        mode,
        Object.fromEntries(
          variants.map((variant) => [
            variant,
            Object.fromEntries(
              scenarioNames.map((name) => [
                name,
                summarizeScenario(traces, variant, input.scenarios[name], byStart),
              ]),
            ),
          ]),
        ),
      ];
    }),
  ) as CasperRealityAuditResult['scenarioComparisons'];
  const restingFillAudit = auditRestingFills(input.baseline.traces, input.dataset.m1);
  const manualRecords = buildManualRecords(input.baseline, byStart, restingFillAudit);
  const result: CasperRealityAuditResult = {
    state: input.baseline.state === 'COMPLETED' ? 'COMPLETED' : 'INVALID_INPUT',
    scenarioComparisons,
    restingFillAudit,
    ambiguityAudit: auditAmbiguity(input.baseline, input.dataset.m1),
    riskCostAudit: Object.fromEntries(
      variants.map((variant) => [variant, auditRiskCost(input.baseline.traces, variant)]),
    ) as Record<CasperRrVariant, CasperRiskCostMetrics>,
    manualReplaySample: selectManualSample(manualRecords, input.sampleSize),
    strategyOutputFingerprint: fingerprint(strategySnapshot),
    strategyOutputsUnchanged: false,
    currentScenarioMatchesBaseline: currentMatchesBaseline(input.baseline, scenarioComparisons),
  };
  result.strategyOutputsUnchanged = before === JSON.stringify(strategySnapshot);
  return result;
}
