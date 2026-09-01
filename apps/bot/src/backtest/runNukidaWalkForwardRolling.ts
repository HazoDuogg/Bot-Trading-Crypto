import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import { loadM1CandlesBetween } from './controlTest.js';
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
  status: 'READY' | 'SKIPPED';
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
  status: 'COMPLETED' | 'SKIPPED';
  reason?: string;
  m15Candles: number;
  m1Candles: number;
  actual?: { startInclusive: number; endExclusive: number };
  warnings: string[];
  report?: BacktestReport;
}

export interface RollingWindowResult {
  window: RollingWindow;
  fingerprint: string;
  coinResults: RollingCoinResult[];
  report: BacktestReport;
  warnings: string[];
}

export interface RollingStabilityReport {
  overall: Record<'zeroCost' | 'realisticCost', StabilitySnapshot>;
  bySetupFamily: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
  byDirection: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
  byCoin: Record<string, Record<'zeroCost' | 'realisticCost', StabilitySnapshot>>;
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
      return { window, status: 'SKIPPED', reason: 'NO_DATA_IN_WINDOW' };
    }
    if (coverage.firstOpenTime > window.startInclusive) {
      return { window, status: 'SKIPPED', reason: 'MISSING_WINDOW_START' };
    }
    if (coverageEndExclusive < window.endExclusive) {
      return { window, status: 'SKIPPED', reason: 'MISSING_WINDOW_END' };
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
      Object.keys(DEFAULT_COIN_BACKTEST_CONFIG).map((coin) => [
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

export async function runNukidaWalkForwardRolling(dataDirectory: string): Promise<{
  windows: RollingWindowResult[];
  stability: RollingStabilityReport;
}> {
  const btcCoverage = await readM15Coverage(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const windows = buildRollingWindows(btcCoverage.firstOpenTime, btcCoverage.lastOpenTime);
  const coverages = Object.fromEntries(
    await Promise.all(
      Object.keys(DEFAULT_COIN_BACKTEST_CONFIG).map(async (coin) => [
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
    for (const [coin, config] of Object.entries(DEFAULT_COIN_BACKTEST_CONFIG)) {
      const assignment = assignments[coin][window.index];
      const requested = {
        startInclusive: window.startInclusive,
        endExclusive: window.endExclusive,
      };
      const requestedIso = {
        startInclusive: new Date(window.startInclusive).toISOString(),
        endExclusive: new Date(window.endExclusive).toISOString(),
      };
      if (assignment.status === 'SKIPPED') {
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
          status: 'SKIPPED',
          reason: assignment.reason ?? 'MISSING_DATA',
          m15Candles,
          m1Candles,
          actual,
          warnings: [],
        });
        continue;
      }
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
            status: 'SKIPPED',
            reason: `INCOMPLETE_DATA: M15=${m15CoverageReason ?? 'OK'}, M1=${m1CoverageReason ?? 'OK'}`,
            m15Candles: m15Candles.length,
            m1Candles: m1Candles.length,
            warnings: [],
          });
          continue;
        }
        completedInputs.push({
          coin,
          m15Candles,
          m1Candles,
          fsmConfig: { ...config, riskBudgetUsd: 100, dataGate: defaultDataGate },
        });
        coinResults.push({
          coin,
          windowIndex: window.index,
          requested,
          requestedIso,
          status: 'COMPLETED',
          m15Candles: m15Candles.length,
          m1Candles: m1Candles.length,
          actual: {
            startInclusive: m15Candles[0].openTime,
            endExclusive: m15Candles.at(-1)!.openTime + M15_MS,
          },
          warnings: [],
        });
      } catch (error) {
        coinResults.push({
          coin,
          windowIndex: window.index,
          requested,
          requestedIso,
          status: 'SKIPPED',
          reason: error instanceof Error ? error.message : String(error),
          m15Candles: 0,
          m1Candles: 0,
          warnings: [],
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
        coinResult.status = 'SKIPPED';
        coinResult.reason = `BACKTEST_ERROR: ${error instanceof Error ? error.message : String(error)}`;
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
    windowResults.push({ window, fingerprint, coinResults, report, warnings });
  }
  return { windows: windowResults, stability: buildStability(windowResults) };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  console.info(ROLLING_WARNING);
  const result = await runNukidaWalkForwardRolling(dataDirectory);
  for (const windowResult of result.windows) {
    const { window } = windowResult;
    console.info(
      `WINDOW ${window.index}: ${new Date(window.startInclusive).toISOString()} -> ` +
        `${new Date(window.endExclusive).toISOString()} (exclusive)${window.partial ? ' PARTIAL' : ''}`,
    );
    for (const coin of windowResult.coinResults) {
      if (coin.status === 'SKIPPED') {
        console.info(`WINDOW ${window.index} ${coin.coin}: SKIPPED reason=${coin.reason}`);
        continue;
      }
      console.info(
        `WINDOW ${window.index} ${coin.coin}: M15=${coin.m15Candles} M1=${coin.m1Candles}`,
      );
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

  const outputPath = resolve(dataDirectory, 'nukida-backtest-walkforward-rolling.json');
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        warning: ROLLING_WARNING,
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        windowDays: ROLLING_WINDOW_DAYS,
        lowSampleClosedTrades: LOW_SAMPLE_CLOSED_TRADES,
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
