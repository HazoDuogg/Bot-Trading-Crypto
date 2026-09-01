import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import { readLastCandleOpenTime } from './controlTest.js';
import {
  runFullNukidaBacktest,
  type BacktestReport,
  type DualCostMetrics,
} from './runNukidaBacktest.js';
import { runFullNukidaBacktestOOS } from './runNukidaBacktestOOS.js';

export const SETUP_B_RESCUE_WARNING =
  'Setup B rescue experiment: report all six combinations; do not promote a winner without a new holdout.';

export type SetupBRescuePeriod = 'IN_SAMPLE' | 'OUT_OF_SAMPLE';

export interface SetupBRescueConfig {
  bufferAtrMultiple: 0 | 0.3 | 0.5;
  minimumTestOccurrence: 1 | 2;
}

export const SETUP_B_RESCUE_CONFIGS: readonly SetupBRescueConfig[] = Object.freeze(
  ([0, 0.3, 0.5] as const).flatMap((bufferAtrMultiple) =>
    ([1, 2] as const).map((minimumTestOccurrence) => ({
      bufferAtrMultiple,
      minimumTestOccurrence,
    })),
  ),
);

export interface SetupBRescueRun {
  config: SetupBRescueConfig;
  period: SetupBRescuePeriod;
  report: BacktestReport;
}

export interface SetupBRescuePeriodResult {
  overall: DualCostMetrics;
  setupAControl: DualCostMetrics;
  setupB: DualCostMetrics;
  minimumStopDistanceBlocked: BacktestReport['minimumStopDistanceBlocked'];
}

export interface SetupBRescueRow {
  config: SetupBRescueConfig;
  inSample: SetupBRescuePeriodResult;
  outOfSample: SetupBRescuePeriodResult;
  setupAControlMatchesBaseline: { inSample: boolean; outOfSample: boolean };
}

export interface SetupBRescueReport {
  warning: string;
  rows: SetupBRescueRow[];
  allSetupAControlInvariant: boolean;
}

function periodResult(report: BacktestReport): SetupBRescuePeriodResult {
  return {
    overall: report.overall,
    setupAControl: report.bySetupFamily.A_COMPRESSION_BREAKOUT,
    setupB: report.bySetupFamily.B_BREAK_PULLBACK_FAILURE,
    minimumStopDistanceBlocked: report.minimumStopDistanceBlocked,
  };
}

function sameMetrics(left: DualCostMetrics, right: DualCostMetrics): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findRun(
  runs: readonly SetupBRescueRun[],
  config: SetupBRescueConfig,
  period: SetupBRescuePeriod,
): SetupBRescueRun {
  const matching = runs.filter(
    (run) =>
      run.period === period &&
      run.config.bufferAtrMultiple === config.bufferAtrMultiple &&
      run.config.minimumTestOccurrence === config.minimumTestOccurrence,
  );
  if (matching.length !== 1) {
    throw new Error(
      `Expected one ${period} run for buffer=${config.bufferAtrMultiple}, N=${config.minimumTestOccurrence}`,
    );
  }
  return matching[0];
}

export function buildSetupBRescueReport(
  runs: readonly SetupBRescueRun[],
): SetupBRescueReport {
  const baselineConfig = SETUP_B_RESCUE_CONFIGS[0];
  const baselineIs = periodResult(findRun(runs, baselineConfig, 'IN_SAMPLE').report);
  const baselineOos = periodResult(findRun(runs, baselineConfig, 'OUT_OF_SAMPLE').report);
  const rows = SETUP_B_RESCUE_CONFIGS.map((config) => {
    const inSample = periodResult(findRun(runs, config, 'IN_SAMPLE').report);
    const outOfSample = periodResult(findRun(runs, config, 'OUT_OF_SAMPLE').report);
    return {
      config,
      inSample,
      outOfSample,
      setupAControlMatchesBaseline: {
        inSample: sameMetrics(inSample.setupAControl, baselineIs.setupAControl),
        outOfSample: sameMetrics(outOfSample.setupAControl, baselineOos.setupAControl),
      },
    } satisfies SetupBRescueRow;
  });
  return {
    warning: SETUP_B_RESCUE_WARNING,
    rows,
    allSetupAControlInvariant: rows.every(
      (row) =>
        row.setupAControlMatchesBaseline.inSample &&
        row.setupAControlMatchesBaseline.outOfSample,
    ),
  };
}

function printMetric(label: string, metrics: DualCostMetrics): void {
  const realistic = metrics.realisticCost;
  console.info(
    `${label}: n=${realistic.closedTrades} netR=${realistic.netR.toFixed(2)} ` +
      `PF=${realistic.profitFactor?.toFixed(2) ?? 'N/A'} ` +
      `exp=${realistic.expectancyPerTrade?.toFixed(3) ?? 'N/A'}`,
  );
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const anchor = await readLastCandleOpenTime(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const runs: SetupBRescueRun[] = [];
  console.info(SETUP_B_RESCUE_WARNING);
  for (const config of SETUP_B_RESCUE_CONFIGS) {
    const options = {
      takeProfitRMultiple: 2,
      setupBSlBufferAtrMultiple: config.bufferAtrMultiple,
      minimumTestOccurrence: config.minimumTestOccurrence,
    };
    const inSample = await runFullNukidaBacktest(dataDirectory, options);
    const outOfSample = await runFullNukidaBacktestOOS(dataDirectory, anchor, options);
    runs.push(
      { config, period: 'IN_SAMPLE', report: inSample.result.report },
      { config, period: 'OUT_OF_SAMPLE', report: outOfSample.result.report },
    );
    printMetric(`buffer=${config.bufferAtrMultiple} N=${config.minimumTestOccurrence} IS Setup B`, inSample.result.report.bySetupFamily.B_BREAK_PULLBACK_FAILURE);
    printMetric(`buffer=${config.bufferAtrMultiple} N=${config.minimumTestOccurrence} OOS Setup B`, outOfSample.result.report.bySetupFamily.B_BREAK_PULLBACK_FAILURE);
  }

  const report = buildSetupBRescueReport(runs);
  if (!report.allSetupAControlInvariant) {
    throw new Error('Setup A control changed during the Setup B-only rescue experiment');
  }
  const reportPath = resolve(dataDirectory, 'nukida-setup-b-rescue-report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        ticket: 'TICKET-NUKIDA-019',
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        assumptions: {
          baselineTakeProfitRMultiple: 2,
          setupAControlMustRemainInvariant: true,
          secondTestCounterWindowCandles: 20,
          reclaimWindowFromSelectedTestCandles: 3,
          provenance: {
            slBuffer: 'CONVENTION',
            waitForSecondTestIdea: 'A_SOURCE_BACKED',
            testEpisodeCounting: 'CONVENTION',
          },
        },
        ...report,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.info(`Setup A control invariant: ${report.allSetupAControlInvariant}`);
  console.info(`Report: ${reportPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
