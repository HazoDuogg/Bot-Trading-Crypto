import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import { loadM1CandlesBetween, readLastCandleOpenTime } from './controlTest.js';
import {
  DEFAULT_COIN_BACKTEST_CONFIG,
  defaultDataGate,
  loadM15CandlesBetween,
  runFullNukidaBacktest,
  runNukidaBacktest,
  writeBacktestArtifacts,
  type BacktestReport,
  type CoinBacktestInput,
  type NukidaBacktestResult,
  type PerformanceMetrics,
} from './runNukidaBacktest.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
export const WALK_FORWARD_PERIOD_DAYS = 180;
export const OOS_WARNING =
  'OUT-OF-SAMPLE validation period. No D1-D8 threshold changes are permitted from this run.';

export interface TimeWindow {
  startInclusive: number;
  endExclusive: number;
}

export interface WalkForwardWindows {
  inSample: TimeWindow;
  outOfSample: TimeWindow;
}

export interface ComparisonSnapshot {
  closedTrades: number;
  netR: number;
  profitFactor: number | null;
  expectancyPerTrade: number | null;
  winRate: number | null;
}

export interface ComparisonRow {
  segment: 'OVERALL' | 'A_COMPRESSION_BREAKOUT' | 'B_BREAK_PULLBACK_FAILURE' | 'BULL' | 'BEAR';
  costMode: 'zeroCost' | 'realisticCost';
  inSample: ComparisonSnapshot;
  outOfSample: ComparisonSnapshot;
  sampleWarning: 'OOS_SAMPLE_BELOW_20_TRADES' | null;
}

export interface ComparisonReport {
  warning: string;
  rows: ComparisonRow[];
  coinSampleWarnings: string[];
}

export interface OosCoinWindow {
  requested: TimeWindow;
  actual: TimeWindow;
  m15Candles: number;
  m1Candles: number;
  partialCoverage: boolean;
}

export function computeWalkForwardWindows(lastM15OpenTime: number): WalkForwardWindows {
  if (!Number.isSafeInteger(lastM15OpenTime) || lastM15OpenTime < 0) {
    throw new Error('lastM15OpenTime must be a non-negative UTC epoch millisecond timestamp');
  }
  const inSampleStart = lastM15OpenTime - WALK_FORWARD_PERIOD_DAYS * DAY_MS;
  return {
    inSample: { startInclusive: inSampleStart, endExclusive: lastM15OpenTime + M15_MS },
    outOfSample: {
      startInclusive: inSampleStart - WALK_FORWARD_PERIOD_DAYS * DAY_MS,
      endExclusive: inSampleStart,
    },
  };
}

function snapshot(metrics: PerformanceMetrics): ComparisonSnapshot {
  return {
    closedTrades: metrics.closedTrades,
    netR: metrics.netR,
    profitFactor: metrics.profitFactor,
    expectancyPerTrade: metrics.expectancyPerTrade,
    winRate: metrics.winRate,
  };
}

export function buildComparisonReport(
  inSample: BacktestReport,
  outOfSample: BacktestReport,
): ComparisonReport {
  const segments: Array<{
    name: ComparisonRow['segment'];
    inSample: BacktestReport['overall'];
    outOfSample: BacktestReport['overall'];
  }> = [
    { name: 'OVERALL', inSample: inSample.overall, outOfSample: outOfSample.overall },
    {
      name: 'A_COMPRESSION_BREAKOUT',
      inSample: inSample.bySetupFamily.A_COMPRESSION_BREAKOUT,
      outOfSample: outOfSample.bySetupFamily.A_COMPRESSION_BREAKOUT,
    },
    {
      name: 'B_BREAK_PULLBACK_FAILURE',
      inSample: inSample.bySetupFamily.B_BREAK_PULLBACK_FAILURE,
      outOfSample: outOfSample.bySetupFamily.B_BREAK_PULLBACK_FAILURE,
    },
    { name: 'BULL', inSample: inSample.byDirection.BULL, outOfSample: outOfSample.byDirection.BULL },
    { name: 'BEAR', inSample: inSample.byDirection.BEAR, outOfSample: outOfSample.byDirection.BEAR },
  ];
  const rows = segments.flatMap((segment) =>
    (['zeroCost', 'realisticCost'] as const).map((costMode) => {
      const oos = segment.outOfSample[costMode];
      return {
        segment: segment.name,
        costMode,
        inSample: snapshot(segment.inSample[costMode]),
        outOfSample: snapshot(oos),
        sampleWarning: oos.closedTrades < 20 ? 'OOS_SAMPLE_BELOW_20_TRADES' : null,
      } satisfies ComparisonRow;
    }),
  );
  const coinSampleWarnings = Object.entries(outOfSample.byCoin)
    .filter(([, metrics]) => metrics.realisticCost.closedTrades < 20)
    .map(
      ([coin, metrics]) =>
        `${coin}: OOS sample has ${metrics.realisticCost.closedTrades} closed trades (<20)`,
    );
  return { warning: OOS_WARNING, rows, coinSampleWarnings };
}

export async function runFullNukidaBacktestOOS(
  dataDirectory: string,
  lastM15OpenTime?: number,
  options: { takeProfitRMultiple?: number } = {},
): Promise<{
  result: NukidaBacktestResult;
  windows: WalkForwardWindows;
  coinWindows: Record<string, OosCoinWindow>;
  coinRuns: Record<string, { status: 'COMPLETED' | 'SKIPPED'; error?: string }>;
}> {
  const anchor =
    lastM15OpenTime ??
    (await readLastCandleOpenTime(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv')));
  const windows = computeWalkForwardWindows(anchor);
  const coinWindows: Record<string, OosCoinWindow> = {};
  const coinRuns: Record<string, { status: 'COMPLETED' | 'SKIPPED'; error?: string }> = {};
  const completed: CoinBacktestInput[] = [];
  for (const [coin, config] of Object.entries(DEFAULT_COIN_BACKTEST_CONFIG)) {
    try {
      const m15Candles = await loadM15CandlesBetween(
        resolve(dataDirectory, `${coin}_15m_3y.csv`),
        windows.outOfSample.startInclusive,
        windows.outOfSample.endExclusive,
      );
      const actualStart = m15Candles[0].openTime;
      const actualEnd = m15Candles.at(-1)!.openTime + M15_MS;
      const m1Candles = await loadM1CandlesBetween(
        resolve(dataDirectory, `${coin}_rt094_1m.csv`),
        actualStart,
        windows.outOfSample.endExclusive,
      );
      completed.push({
        coin,
        m15Candles,
        m1Candles,
        fsmConfig: {
          ...config,
          riskBudgetUsd: 100,
          takeProfitRMultiple: options.takeProfitRMultiple,
          dataGate: defaultDataGate,
        },
      });
      coinWindows[coin] = {
        requested: windows.outOfSample,
        actual: { startInclusive: actualStart, endExclusive: actualEnd },
        m15Candles: m15Candles.length,
        m1Candles: m1Candles.length,
        partialCoverage:
          actualStart > windows.outOfSample.startInclusive ||
          actualEnd < windows.outOfSample.endExclusive,
      };
      coinRuns[coin] = { status: 'COMPLETED' };
    } catch (error) {
      coinRuns[coin] = {
        status: 'SKIPPED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    result: runNukidaBacktest({ coins: completed, warning: OOS_WARNING }),
    windows,
    coinWindows,
    coinRuns,
  };
}

function formatMetric(value: number | null, digits = 2): string {
  return value === null ? 'N/A' : value.toFixed(digits);
}

function printComparison(report: ComparisonReport): void {
  for (const row of report.rows) {
    console.info(
      `${row.segment} ${row.costMode}: ` +
        `IS n=${row.inSample.closedTrades} netR=${formatMetric(row.inSample.netR)} ` +
        `PF=${formatMetric(row.inSample.profitFactor)} exp=${formatMetric(row.inSample.expectancyPerTrade, 3)} ` +
        `win=${row.inSample.winRate === null ? 'N/A' : `${(row.inSample.winRate * 100).toFixed(1)}%`} | ` +
        `OOS n=${row.outOfSample.closedTrades} netR=${formatMetric(row.outOfSample.netR)} ` +
        `PF=${formatMetric(row.outOfSample.profitFactor)} exp=${formatMetric(row.outOfSample.expectancyPerTrade, 3)} ` +
        `win=${row.outOfSample.winRate === null ? 'N/A' : `${(row.outOfSample.winRate * 100).toFixed(1)}%`}` +
        `${row.sampleWarning === null ? '' : ` WARNING=${row.sampleWarning}`}`,
    );
  }
  for (const warning of report.coinSampleWarnings) console.info(`WARNING: ${warning}`);
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const lastM15OpenTime = await readLastCandleOpenTime(
    resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'),
  );
  const windows = computeWalkForwardWindows(lastM15OpenTime);
  console.info(OOS_WARNING);
  console.info(
    `IS=${new Date(windows.inSample.startInclusive).toISOString()} -> ` +
      `${new Date(windows.inSample.endExclusive).toISOString()} (exclusive)`,
  );
  console.info(
    `OOS=${new Date(windows.outOfSample.startInclusive).toISOString()} -> ` +
      `${new Date(windows.outOfSample.endExclusive).toISOString()} (exclusive)`,
  );

  const inSample = await runFullNukidaBacktest(dataDirectory);
  const outOfSample = await runFullNukidaBacktestOOS(dataDirectory, lastM15OpenTime);
  const comparison = buildComparisonReport(inSample.result.report, outOfSample.result.report);
  const inSamplePaths = await writeBacktestArtifacts(
    dataDirectory,
    inSample.result,
    inSample.coinRuns,
    'nukida-backtest-insample-v2',
  );
  const oosPaths = await writeBacktestArtifacts(
    dataDirectory,
    outOfSample.result,
    outOfSample.coinRuns,
    'nukida-backtest-oos',
  );
  const comparisonPath = resolve(dataDirectory, 'nukida-backtest-comparison-is-vs-oos.json');
  await writeFile(
    comparisonPath,
    `${JSON.stringify(
      {
        warning: OOS_WARNING,
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        windows,
        oosCoinWindows: outOfSample.coinWindows,
        inSampleCoinRuns: inSample.coinRuns,
        outOfSampleCoinRuns: outOfSample.coinRuns,
        comparison,
        inSampleReport: inSample.result.report,
        outOfSampleReport: outOfSample.result.report,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.info(
    `OOS coin runs: ${Object.entries(outOfSample.coinRuns)
      .map(([coin, run]) => `${coin}=${run.status}`)
      .join(', ')}`,
  );
  for (const [coin, window] of Object.entries(outOfSample.coinWindows)) {
    console.info(
      `${coin} OOS coverage: M15=${window.m15Candles}, M1=${window.m1Candles}, ` +
        `partial=${window.partialCoverage}`,
    );
  }
  printComparison(comparison);
  console.info(`IS-v2 trades: ${inSamplePaths.tradesPath}`);
  console.info(`IS-v2 report: ${inSamplePaths.reportPath}`);
  console.info(`OOS trades: ${oosPaths.tradesPath}`);
  console.info(`OOS report: ${oosPaths.reportPath}`);
  console.info(`Comparison: ${comparisonPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
