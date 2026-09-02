import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import { loadM1CandlesBetween } from './controlTest.js';
import {
  TICK_OUTLIER_EXCLUSION_MAX_COUNT,
  createTickOutlierExclusionPlan,
  inferTickSize,
  type TickSizeInferenceResult,
} from './tickSizeInference.js';
import {
  DEFAULT_COIN_BACKTEST_CONFIG,
  buildBacktestReport,
  defaultDataGate,
  loadM15CandlesBetween,
  runNukidaBacktest,
  type BacktestReport,
  type CoinBacktestInput,
  type DualCostMetrics,
  type PerformanceMetrics,
  type TradeLogEntry,
} from './runNukidaBacktest.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const M15_MS = 15 * 60 * 1000;
const M1_MS = 60 * 1000;
export const ROLLING_WINDOW_DAYS = 180;
export const LOW_SAMPLE_CLOSED_TRADES = 20;
export const TICKET_020_STRATEGY_FINGERPRINT =
  'e044760b3f5e94ced7b812409118973b337719733830c42435032ccf6a62548f';
export const ROLLING_WARNING =
  'WARNING: rolling OOS measurement only. Outcome-based threshold tuning is prohibited.';

export interface RollingWindow {
  index: number;
  startInclusive: number;
  endExclusive: number;
  partial: boolean;
}

export interface TimestampCoverage {
  firstOpenTime: number;
  lastOpenTime: number;
}

export interface CoinWindowAssignment {
  window: RollingWindow;
  status: 'READY' | 'SKIPPED_NO_DATA';
  reason: 'NO_DATA_IN_WINDOW' | 'MISSING_WINDOW_START' | 'MISSING_WINDOW_END' | null;
}

export interface MetricSnapshot {
  closedTrades: number;
  netR: number;
  profitFactor: number | null;
  expectancyPerTrade: number | null;
  winRate: number | null;
}

export interface StabilitySnapshot {
  windowsConsidered: number;
  profitablePfWindows: number;
  positiveNetRWindows: number;
  pfUnavailableWindows: number;
  profitFactor: { min: number | null; max: number | null; median: number | null };
  netR: { min: number | null; max: number | null; median: number | null };
}

export interface RollingCoinResult {
  coin: string;
  windowIndex: number;
  requested: { startInclusive: number; endExclusive: number };
  requestedIso: { startInclusive: string; endExclusive: string };
  status: 'COMPLETED' | 'SKIPPED_NO_DATA' | 'SKIPPED_ENGINE_ERROR';
  reason?: string;
  m15Candles: number;
  m1Candles: number;
  m1CandlesUsed?: number;
  actual?: { startInclusive: number; endExclusive: number };
  configuredTickSize?: number;
  tickSizeInference?: TickSizeInferenceResult;
  outliersExcluded?: number;
  excludedTickOutliers?: Array<{
    index: number;
    timestamp: number;
    timestampIso: string;
    close: number;
  }>;
  tickOutlierWarning?: string;
  engineErrorWarning?: string;
  warnings: string[];
  report?: BacktestReport;
}

export interface RollingWindowResult {
  window: RollingWindow;
  fingerprint: string;
  coinResults: RollingCoinResult[];
  report: BacktestReport;
  warnings: string[];
  engineErrorWarnings: string[];
  tickOutlierWarnings: string[];
}

export interface RollingRunOptions {
  coins?: readonly string[];
  windowIndexes?: readonly number[];
}

export interface RollingStabilityReport {
  overall: Record<'zeroCost' | 'realisticCost', StabilitySnapshot>;
  bySetupFamily: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
  byDirection: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
  byCoin: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
}

export interface TickInferenceComparisonSide {
  completedCoins: number;
  noDataSkips: number;
  engineErrorSkips: number;
  overall: Record<'zeroCost' | 'realisticCost', MetricSnapshot>;
  sol: {
    status: string;
    reason?: string;
    inferredTickSize?: number;
    metrics?: Record<'zeroCost' | 'realisticCost', MetricSnapshot>;
  };
}

export interface TickInferenceComparisonRow {
  windowIndex: number;
  before: TickInferenceComparisonSide;
  after: TickInferenceComparisonSide;
}

export function buildRollingWindows(
  firstM15OpenTime: number,
  lastM15OpenTime: number,
): RollingWindow[] {
  if (
    !Number.isSafeInteger(firstM15OpenTime) ||
    !Number.isSafeInteger(lastM15OpenTime) ||
    firstM15OpenTime < 0 ||
    lastM15OpenTime < firstM15OpenTime
  ) {
    throw new Error('Rolling history bounds must be ordered UTC epoch millisecond integers');
  }
  const historyEndExclusive = lastM15OpenTime + M15_MS;
  const duration = ROLLING_WINDOW_DAYS * DAY_MS;
  const windows: RollingWindow[] = [];
  for (let start = firstM15OpenTime; start < historyEndExclusive; start += duration) {
    const fullEnd = start + duration;
    windows.push({
      index: windows.length,
      startInclusive: start,
      endExclusive: Math.min(fullEnd, historyEndExclusive),
      partial: fullEnd > historyEndExclusive,
    });
  }
  return windows;
}

export function buildCoinWindowAssignments(
  windows: readonly RollingWindow[],
  coverage: TimestampCoverage,
): CoinWindowAssignment[] {
  const coverageEndExclusive = coverage.lastOpenTime + M15_MS;
  return windows.map((window) => {
    if (
      coverageEndExclusive <= window.startInclusive ||
      coverage.firstOpenTime >= window.endExclusive
    ) {
      return { window, status: 'SKIPPED_NO_DATA', reason: 'NO_DATA_IN_WINDOW' };
    }
    if (coverage.firstOpenTime > window.startInclusive) {
      return { window, status: 'SKIPPED_NO_DATA', reason: 'MISSING_WINDOW_START' };
    }
    if (coverageEndExclusive < window.endExclusive) {
      return { window, status: 'SKIPPED_NO_DATA', reason: 'MISSING_WINDOW_END' };
    }
    return { window, status: 'READY', reason: null };
  });
}

export function assertRollingFingerprint(
  expectedHash: string,
  observedHash: string,
  windowIndex: number,
): void {
  if (observedHash !== expectedHash) {
    throw new Error(
      `Strategy fingerprint mismatch at window ${windowIndex}: expected ${expectedHash}, received ${observedHash}`,
    );
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(metrics: readonly PerformanceMetrics[]): StabilitySnapshot {
  const pfs = metrics
    .map((metric) => metric.profitFactor)
    .filter((value): value is number => value !== null);
  const netRs = metrics.map((metric) => metric.netR);
  return {
    windowsConsidered: metrics.length,
    profitablePfWindows: pfs.filter((value) => value >= 1).length,
    positiveNetRWindows: netRs.filter((value) => value > 0).length,
    pfUnavailableWindows: metrics.length - pfs.length,
    profitFactor: {
      min: pfs.length === 0 ? null : Math.min(...pfs),
      max: pfs.length === 0 ? null : Math.max(...pfs),
      median: median(pfs),
    },
    netR: {
      min: netRs.length === 0 ? null : Math.min(...netRs),
      max: netRs.length === 0 ? null : Math.max(...netRs),
      median: median(netRs),
    },
  };
}

function summarizeDual(metrics: readonly DualCostMetrics[]): Record<'zeroCost' | 'realisticCost', StabilitySnapshot> {
  return {
    zeroCost: summarize(metrics.map((metric) => metric.zeroCost)),
    realisticCost: summarize(metrics.map((metric) => metric.realisticCost)),
  };
}

function metricSnapshot(metric: PerformanceMetrics): MetricSnapshot {
  return {
    closedTrades: metric.closedTrades,
    netR: metric.netR,
    profitFactor: metric.profitFactor,
    expectancyPerTrade: metric.expectancyPerTrade,
    winRate: metric.winRate,
  };
}

function dualSnapshot(
  metrics: DualCostMetrics,
): Record<'zeroCost' | 'realisticCost', MetricSnapshot> {
  return {
    zeroCost: metricSnapshot(metrics.zeroCost),
    realisticCost: metricSnapshot(metrics.realisticCost),
  };
}

function comparisonSide(window: {
  coinResults: Array<{
    coin: string;
    status: string;
    reason?: string;
    tickSizeInference?: TickSizeInferenceResult;
    report?: BacktestReport;
  }>;
  report: BacktestReport;
}): TickInferenceComparisonSide {
  const sol = window.coinResults.find((coin) => coin.coin === 'SOLUSDT');
  const normalizedStatus =
    sol?.status === 'SKIPPED' && sol.reason?.startsWith('BACKTEST_ERROR')
      ? 'SKIPPED_ENGINE_ERROR'
      : (sol?.status ?? 'MISSING');
  return {
    completedCoins: window.coinResults.filter((coin) => coin.status === 'COMPLETED').length,
    noDataSkips: window.coinResults.filter(
      (coin) =>
        coin.status === 'SKIPPED_NO_DATA' ||
        (coin.status === 'SKIPPED' && !coin.reason?.startsWith('BACKTEST_ERROR')),
    ).length,
    engineErrorSkips: window.coinResults.filter(
      (coin) =>
        coin.status === 'SKIPPED_ENGINE_ERROR' ||
        (coin.status === 'SKIPPED' && coin.reason?.startsWith('BACKTEST_ERROR')),
    ).length,
    overall: dualSnapshot(window.report.overall),
    sol: {
      status: normalizedStatus,
      reason: sol?.reason,
      inferredTickSize: sol?.tickSizeInference?.tickSize,
      metrics: sol?.report === undefined ? undefined : dualSnapshot(sol.report.overall),
    },
  };
}

function buildTickInferenceComparison(
  previousArtifact: unknown,
  currentWindows: readonly RollingWindowResult[],
): TickInferenceComparisonRow[] {
  const previous = previousArtifact as {
    windows?: Array<RollingWindowResult>;
    tickInferenceComparison?: TickInferenceComparisonRow[];
  } | null;
  const previousRows = previous?.tickInferenceComparison;
  return [0, 1, 2].flatMap((windowIndex) => {
    const current = currentWindows.find((window) => window.window.index === windowIndex);
    const preservedBefore = previousRows?.find((row) => row.windowIndex === windowIndex)?.before;
    const previousWindow = previous?.windows?.find((window) => window.window.index === windowIndex);
    const before = preservedBefore ?? (previousWindow === undefined ? undefined : comparisonSide(previousWindow));
    return current === undefined || before === undefined
      ? []
      : [{ windowIndex, before, after: comparisonSide(current) }];
  });
}

async function readM15Coverage(csvPath: string): Promise<TimestampCoverage> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u);
  if (rows.length < 2) throw new Error('M15 CSV contains no data rows');
  const firstOpenTime = Number(rows[1].split(',')[0]);
  const lastOpenTime = Number(rows.at(-1)!.split(',')[0]);
  if (!Number.isSafeInteger(firstOpenTime) || !Number.isSafeInteger(lastOpenTime)) {
    throw new Error('M15 CSV coverage timestamps are invalid');
  }
  return { firstOpenTime, lastOpenTime };
}

function coverageReason(
  firstOpenTime: number,
  lastOpenTime: number,
  candleDuration: number,
  window: RollingWindow,
): string | null {
  if (firstOpenTime > window.startInclusive) return 'MISSING_WINDOW_START';
  if (lastOpenTime + candleDuration < window.endExclusive) return 'MISSING_WINDOW_END';
  return null;
}

function warningFor(label: string, closedTrades: number): string[] {
  return closedTrades < LOW_SAMPLE_CLOSED_TRADES
    ? [`WARNING: ${label} has ${closedTrades} closed trades (<${LOW_SAMPLE_CLOSED_TRADES})`]
    : [];
}

function emptyWindowReport(note: string): BacktestReport {
  return runNukidaBacktest({ coins: [], warning: note }).report;
}

function buildStability(windowResults: readonly RollingWindowResult[]): RollingStabilityReport {
  const completedCoinResults = windowResults.flatMap((window) =>
    window.coinResults.filter(
      (coin): coin is RollingCoinResult & { report: BacktestReport } =>
        coin.status === 'COMPLETED' && coin.report !== undefined,
    ),
  );
  const segmentStability = (
    select: (report: BacktestReport, key: string) => DualCostMetrics,
    keys: readonly string[],
  ): Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>> =>
    Object.fromEntries(
      keys.map((key) => [key, summarizeDual(windowResults.map(({ report }) => select(report, key)))]),
    );
  return {
    overall: summarizeDual(windowResults.map(({ report }) => report.overall)),
    bySetupFamily: segmentStability(
      (report, key) => report.bySetupFamily[key],
      ['A_COMPRESSION_BREAKOUT', 'B_BREAK_PULLBACK_FAILURE'],
    ),
    byDirection: segmentStability(
      (report, key) => report.byDirection[key],
      ['BULL', 'BEAR'],
    ),
    byCoin: Object.fromEntries(
      [...new Set(windowResults.flatMap((window) => window.coinResults.map((coin) => coin.coin)))].map((coin) => [
        coin,
        summarizeDual(
          completedCoinResults
            .filter((result) => result.coin === coin)
            .map((result) => result.report.overall),
        ),
      ]),
    ),
  };
}

function printDual(label: string, metrics: DualCostMetrics): void {
  for (const mode of ['zeroCost', 'realisticCost'] as const) {
    const snapshot = metricSnapshot(metrics[mode]);
    console.info(
      `${label} ${mode}: n=${snapshot.closedTrades} netR=${snapshot.netR.toFixed(2)} ` +
        `PF=${snapshot.profitFactor?.toFixed(2) ?? 'N/A'} ` +
        `exp=${snapshot.expectancyPerTrade?.toFixed(3) ?? 'N/A'} ` +
        `win=${snapshot.winRate === null ? 'N/A' : `${(snapshot.winRate * 100).toFixed(1)}%`}`,
    );
  }
}

export async function runNukidaWalkForwardRolling(
  dataDirectory: string,
  options: RollingRunOptions = {},
): Promise<{
  windows: RollingWindowResult[];
  stability: RollingStabilityReport;
  engineErrorWarnings: string[];
  tickOutlierWarnings: string[];
}> {
  const btcCoverage = await readM15Coverage(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const allWindows = buildRollingWindows(btcCoverage.firstOpenTime, btcCoverage.lastOpenTime);
  const windows =
    options.windowIndexes === undefined
      ? allWindows
      : allWindows.filter((window) => options.windowIndexes!.includes(window.index));
  const configuredCoins = Object.keys(DEFAULT_COIN_BACKTEST_CONFIG);
  const selectedCoins = options.coins ?? configuredCoins;
  const unknownCoins = selectedCoins.filter((coin) => !configuredCoins.includes(coin));
  if (unknownCoins.length > 0) throw new Error(`Unknown rolling coin(s): ${unknownCoins.join(', ')}`);
  const coverages = Object.fromEntries(
    await Promise.all(
      selectedCoins.map(async (coin) => [
        coin,
        await readM15Coverage(resolve(dataDirectory, `${coin}_15m_3y.csv`)),
      ]),
    ),
  ) as Record<string, TimestampCoverage>;
  const assignments = Object.fromEntries(
    Object.entries(coverages).map(([coin, coverage]) => [
      coin,
      buildCoinWindowAssignments(windows, coverage),
    ]),
  );
  const windowResults: RollingWindowResult[] = [];

  for (const window of windows) {
    const fingerprint = computeStrategyFingerprint().hash;
    assertRollingFingerprint(TICKET_020_STRATEGY_FINGERPRINT, fingerprint, window.index);
    const completedInputs: CoinBacktestInput[] = [];
    const coinResults: RollingCoinResult[] = [];
    for (const coin of selectedCoins) {
      const config = DEFAULT_COIN_BACKTEST_CONFIG[coin as keyof typeof DEFAULT_COIN_BACKTEST_CONFIG];
      const assignment = assignments[coin].find((candidate) => candidate.window.index === window.index)!;
      const requested = {
        startInclusive: window.startInclusive,
        endExclusive: window.endExclusive,
      };
      const requestedIso = {
        startInclusive: new Date(window.startInclusive).toISOString(),
        endExclusive: new Date(window.endExclusive).toISOString(),
      };
      if (assignment.status === 'SKIPPED_NO_DATA') {
        let m15Candles = 0;
        let m1Candles = 0;
        let actual: RollingCoinResult['actual'];
        if (assignment.reason !== 'NO_DATA_IN_WINDOW') {
          try {
            const partialM15 = await loadM15CandlesBetween(
              resolve(dataDirectory, `${coin}_15m_3y.csv`),
              window.startInclusive,
              window.endExclusive,
            );
            m15Candles = partialM15.length;
            actual = {
              startInclusive: partialM15[0].openTime,
              endExclusive: partialM15.at(-1)!.openTime + M15_MS,
            };
          } catch {
            // The explicit SKIPPED reason remains the source of truth when no M15 rows exist.
          }
          try {
            m1Candles = (
              await loadM1CandlesBetween(
                resolve(dataDirectory, `${coin}_rt094_1m.csv`),
                window.startInclusive,
                window.endExclusive,
              )
            ).length;
          } catch {
            // Missing M1 rows are represented by the zero count in the coverage report.
          }
        }
        coinResults.push({
          coin,
          windowIndex: window.index,
          requested,
          requestedIso,
          status: 'SKIPPED_NO_DATA',
          reason: assignment.reason ?? 'MISSING_DATA',
          m15Candles,
          m1Candles,
          actual,
          warnings: [],
        });
        continue;
      }
      let attemptedTickInference: TickSizeInferenceResult | undefined;
      let attemptedM15Candles = 0;
      let attemptedM1Candles = 0;
      let attemptedActual: RollingCoinResult['actual'];
      try {
        const m15Candles = await loadM15CandlesBetween(
          resolve(dataDirectory, `${coin}_15m_3y.csv`),
          window.startInclusive,
          window.endExclusive,
        );
        const m1Candles = await loadM1CandlesBetween(
          resolve(dataDirectory, `${coin}_rt094_1m.csv`),
          window.startInclusive,
          window.endExclusive,
        );
        attemptedM15Candles = m15Candles.length;
        attemptedM1Candles = m1Candles.length;
        attemptedActual = {
          startInclusive: m15Candles[0].openTime,
          endExclusive: m15Candles.at(-1)!.openTime + M15_MS,
        };
        const m15CoverageReason = coverageReason(
          m15Candles[0].openTime,
          m15Candles.at(-1)!.openTime,
          M15_MS,
          window,
        );
        const m1CoverageReason = coverageReason(
          m1Candles[0].openTime,
          m1Candles.at(-1)!.openTime,
          M1_MS,
          window,
        );
        if (m15CoverageReason !== null || m1CoverageReason !== null) {
          coinResults.push({
            coin,
            windowIndex: window.index,
            requested,
            requestedIso,
            status: 'SKIPPED_NO_DATA',
            reason: `INCOMPLETE_DATA: M15=${m15CoverageReason ?? 'OK'}, M1=${m1CoverageReason ?? 'OK'}`,
            m15Candles: m15Candles.length,
            m1Candles: m1Candles.length,
            warnings: [],
          });
          continue;
        }
        const prices = m1Candles.map((candle) => candle.close);
        const tickSizeInference = inferTickSize(prices);
        attemptedTickInference = tickSizeInference;
        const exclusionPlan = createTickOutlierExclusionPlan(
          prices,
          tickSizeInference.tickSize,
        );
        const excludedIndices = new Set(exclusionPlan.outliers.map((outlier) => outlier.index));
        const usableM1Candles = m1Candles.filter((_, index) => !excludedIndices.has(index));
        const excludedTickOutliers = exclusionPlan.outliers.map(({ index, price }) => ({
          index,
          timestamp: m1Candles[index].openTime,
          timestampIso: new Date(m1Candles[index].openTime).toISOString(),
          close: price,
        }));
        const tickOutlierWarning =
          exclusionPlan.outliersExcluded === 0
            ? undefined
            : `DATA_OUTLIERS_EXCLUDED: window=${window.index} coin=${coin} ` +
              `count=${exclusionPlan.outliersExcluded} threshold=${TICK_OUTLIER_EXCLUSION_MAX_COUNT} ` +
              `points=${excludedTickOutliers
                .map((outlier) => `${outlier.timestampIso}@${outlier.close}`)
                .join(',')}`;
        completedInputs.push({
          coin,
          m15Candles,
          m1Candles: usableM1Candles,
          fsmConfig: {
            ...config,
            tickSize: tickSizeInference.tickSize,
            riskBudgetUsd: 100,
            dataGate: defaultDataGate,
          },
        });
        coinResults.push({
          coin,
          windowIndex: window.index,
          requested,
          requestedIso,
          status: 'COMPLETED',
          m15Candles: m15Candles.length,
          m1Candles: m1Candles.length,
          m1CandlesUsed: usableM1Candles.length,
          actual: {
            startInclusive: m15Candles[0].openTime,
            endExclusive: m15Candles.at(-1)!.openTime + M15_MS,
          },
          configuredTickSize: config.tickSize,
          tickSizeInference,
          outliersExcluded: exclusionPlan.outliersExcluded,
          excludedTickOutliers,
          tickOutlierWarning,
          warnings: [],
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const engineErrorWarning =
          `ENGINE_ERROR: window=${window.index} coin=${coin} during data/tick preparation: ${reason}`;
        coinResults.push({
          coin,
          windowIndex: window.index,
          requested,
          requestedIso,
          status: 'SKIPPED_ENGINE_ERROR',
          reason,
          m15Candles: attemptedM15Candles,
          m1Candles: attemptedM1Candles,
          actual: attemptedActual,
          configuredTickSize: config.tickSize,
          tickSizeInference: attemptedTickInference,
          warnings: [],
          engineErrorWarning,
        });
      }
    }

    const note = `${ROLLING_WARNING} Window ${window.index}.`;
    const tradeLogs: TradeLogEntry[] = [];
    const minimumStopBlockedByCoin: Record<string, number> = {};
    for (const input of completedInputs) {
      const coinResult = coinResults.find((result) => result.coin === input.coin)!;
      try {
        const coinBacktest = runNukidaBacktest({ coins: [input], warning: note });
        coinResult.report = coinBacktest.report;
        coinResult.warnings = warningFor(
          `${coinResult.coin} window ${window.index}`,
          coinBacktest.report.overall.realisticCost.closedTrades,
        );
        tradeLogs.push(...coinBacktest.tradeLogs);
        minimumStopBlockedByCoin[input.coin] =
          coinBacktest.report.minimumStopDistanceBlocked.byCoin[input.coin] ?? 0;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        coinResult.status = 'SKIPPED_ENGINE_ERROR';
        coinResult.reason = reason;
        coinResult.engineErrorWarning =
          `ENGINE_ERROR: window=${window.index} coin=${input.coin} during backtest: ${reason}`;
        coinResult.warnings = [];
      }
    }
    tradeLogs.sort((left, right) => left.entryFillTimestamp - right.entryFillTimestamp);
    const completedCoins = coinResults
      .filter((coin) => coin.status === 'COMPLETED')
      .map((coin) => coin.coin);
    const report =
      completedCoins.length === 0
        ? emptyWindowReport(note)
        : buildBacktestReport(tradeLogs, completedCoins, minimumStopBlockedByCoin, note);
    const warnings = [
      ...warningFor(
        `overall window ${window.index}`,
        report.overall.realisticCost.closedTrades,
      ),
      ...coinResults.flatMap((coin) => coin.warnings),
    ];
    const engineErrorWarnings = coinResults.flatMap((coin) =>
      coin.engineErrorWarning === undefined ? [] : [coin.engineErrorWarning],
    );
    const tickOutlierWarnings = coinResults.flatMap((coin) =>
      coin.tickOutlierWarning === undefined ? [] : [coin.tickOutlierWarning],
    );
    windowResults.push({
      window,
      fingerprint,
      coinResults,
      report,
      warnings,
      engineErrorWarnings,
      tickOutlierWarnings,
    });
  }
  return {
    windows: windowResults,
    stability: buildStability(windowResults),
    engineErrorWarnings: windowResults.flatMap((window) => window.engineErrorWarnings),
    tickOutlierWarnings: windowResults.flatMap((window) => window.tickOutlierWarnings),
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const outputPath = resolve(dataDirectory, 'nukida-backtest-walkforward-rolling.json');
  const tickOutlierDiagnostic = JSON.parse(
    await readFile(resolve(dataDirectory, 'nukida-tick-outlier-diagnostic.json'), 'utf8'),
  ) as unknown;
  let previousArtifact: unknown = null;
  try {
    previousArtifact = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  console.info(ROLLING_WARNING);
  console.info(
    `TICK OUTLIER POLICY: diagnostic distribution=0:30,1:2; ` +
      `p95/max=${TICK_OUTLIER_EXCLUSION_MAX_COUNT}`,
  );
  const result = await runNukidaWalkForwardRolling(dataDirectory);
  const tickInferenceComparison = buildTickInferenceComparison(
    previousArtifact,
    result.windows,
  );
  for (const windowResult of result.windows) {
    const { window } = windowResult;
    console.info(
      `WINDOW ${window.index}: ${new Date(window.startInclusive).toISOString()} -> ` +
        `${new Date(window.endExclusive).toISOString()} (exclusive)${window.partial ? ' PARTIAL' : ''}`,
    );
    const completed = windowResult.coinResults.filter((coin) => coin.status === 'COMPLETED').length;
    const noData = windowResult.coinResults.filter(
      (coin) => coin.status === 'SKIPPED_NO_DATA',
    ).length;
    const engineErrors = windowResult.coinResults.filter(
      (coin) => coin.status === 'SKIPPED_ENGINE_ERROR',
    ).length;
    console.info(
      `WINDOW ${window.index} COVERAGE: completed=${completed}, noData=${noData}, engineErrors=${engineErrors}`,
    );
    for (const coin of windowResult.coinResults) {
      if (coin.status === 'SKIPPED_NO_DATA') {
        console.info(`WINDOW ${window.index} ${coin.coin}: SKIPPED_NO_DATA reason=${coin.reason}`);
        continue;
      }
      if (coin.status === 'SKIPPED_ENGINE_ERROR') {
        console.error(coin.engineErrorWarning);
        continue;
      }
      console.info(
        `WINDOW ${window.index} ${coin.coin}: M15=${coin.m15Candles} M1=${coin.m1Candles} ` +
          `M1_USED=${coin.m1CandlesUsed} tickSize=${coin.tickSizeInference?.tickSize} ` +
          `source=${coin.tickSizeInference?.source} outliersExcluded=${coin.outliersExcluded}`,
      );
      if (coin.tickOutlierWarning !== undefined) console.warn(coin.tickOutlierWarning);
      printDual(`WINDOW ${window.index} ${coin.coin}`, coin.report!.overall);
      for (const warning of coin.warnings) console.info(warning);
    }
    printDual(`WINDOW ${window.index} OVERALL`, windowResult.report.overall);
    for (const [family, metrics] of Object.entries(windowResult.report.bySetupFamily)) {
      printDual(`WINDOW ${window.index} ${family}`, metrics);
    }
    for (const [direction, metrics] of Object.entries(windowResult.report.byDirection)) {
      printDual(`WINDOW ${window.index} ${direction}`, metrics);
    }
    for (const warning of windowResult.warnings) console.info(warning);
  }

  for (const row of tickInferenceComparison) {
    const before = row.before.overall.realisticCost;
    const after = row.after.overall.realisticCost;
    console.info(
      `TICKET-022 WINDOW ${row.windowIndex} BEFORE/AFTER: ` +
        `overall netR ${before.netR.toFixed(2)} -> ${after.netR.toFixed(2)}, ` +
        `PF ${before.profitFactor?.toFixed(2) ?? 'N/A'} -> ${after.profitFactor?.toFixed(2) ?? 'N/A'}, ` +
        `SOL ${row.before.sol.status} -> ${row.after.sol.status}, ` +
        `SOL tick=${row.after.sol.inferredTickSize ?? 'N/A'}, ` +
        `SOL netR=${row.after.sol.metrics?.realisticCost.netR.toFixed(2) ?? 'N/A'}`,
    );
  }

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        warning: ROLLING_WARNING,
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        windowDays: ROLLING_WINDOW_DAYS,
        lowSampleClosedTrades: LOW_SAMPLE_CLOSED_TRADES,
        engineErrorWarnings: result.engineErrorWarnings,
        tickOutlierWarnings: result.tickOutlierWarnings,
        tickOutlierPolicy: {
          maximumExcludedPerCoinWindow: TICK_OUTLIER_EXCLUSION_MAX_COUNT,
          selectionBasis: 'nearest-rank p95 and observed maximum across 32 scanned coin-windows',
          originalDistribution: { 0: 30, 1: 2 },
          diagnosticArtifact: 'nukida-tick-outlier-diagnostic.json',
        },
        tickOutlierDiagnostic,
        tickInferenceComparison,
        windows: result.windows,
        stability: result.stability,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.info(`Rolling report: ${outputPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
