import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Candle } from '../noTradeZone/types.js';
import { createDefaultStrategyAdapter } from '../orchestrator/nukidaFsm.js';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import {
  DEFAULT_COIN_BACKTEST_CONFIG,
  defaultDataGate,
  loadM15CandlesBetween,
} from './runNukidaBacktest.js';
import {
  M15_MS,
  TICKET_020_STRATEGY_FINGERPRINT,
  buildRollingWindows,
  type RollingWindow,
} from './runNukidaWalkForwardRolling.js';

// AUDIT LIMITATION: These measurements are hypothesis exploration, not sufficient evidence for
// adding a filter. Any filter proposal must freeze the metric definition, preregister its threshold,
// test it on an unused holdout, and only be considered if the pattern repeats consistently.

export const LOCAL_REGIME_HORIZONS = [16, 32, 96] as const;

export interface DirectionalExcursions {
  mfe: number;
  mae: number;
}

export interface PreSignalRegimeSnapshot extends DirectionalExcursions {
  horizonCandles: number;
  windowStartIndex: number;
  windowEndIndex: number;
  directionalEfficiency: number;
  signedAlignment: number;
}

function totalRange(candles: readonly Candle[]): number {
  return candles.reduce((sum, item) => sum + Math.max(0, item.high - item.low), 0);
}

export function calculateRegimeDirectionalEfficiency(candles: readonly Candle[]): number {
  if (candles.length === 0) return 0;
  const denominator = totalRange(candles);
  if (!(denominator > 0)) return 0;
  return Math.abs(candles.at(-1)!.close - candles[0].open) / denominator;
}

export function calculateSignedAlignment(
  candles: readonly Candle[],
  direction: SetupSignal['direction'],
): number {
  if (candles.length === 0) return 0;
  const denominator = totalRange(candles);
  if (!(denominator > 0)) return 0;
  const setupDirection = direction === 'BULL' ? 1 : -1;
  return (setupDirection * (candles.at(-1)!.close - candles[0].open)) / denominator;
}

export function calculateMeanRangeOverlap(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0;
  let overlapRatioSum = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const overlapWidth = Math.max(
      0,
      Math.min(previous.high, current.high) - Math.max(previous.low, current.low),
    );
    const smallerRange = Math.min(previous.high - previous.low, current.high - current.low);
    overlapRatioSum += smallerRange > 0 ? overlapWidth / smallerRange : 0;
  }
  return overlapRatioSum / (candles.length - 1);
}

export function calculateReturnFlipDensity(candles: readonly Candle[]): number {
  if (candles.length < 3) return 0;
  const returns = candles.slice(1).map((item, index) => item.close - candles[index].close);
  let flips = 0;
  for (let index = 1; index < returns.length; index += 1) {
    if (Math.sign(returns[index - 1]) * Math.sign(returns[index]) < 0) flips += 1;
  }
  return flips / (returns.length - 1);
}

export function calculateDirectionalExcursions(
  candles: readonly Candle[],
  direction: SetupSignal['direction'],
): DirectionalExcursions {
  if (candles.length === 0) return { mfe: 0, mae: 0 };
  const anchor = candles[0].open;
  let highest = Number.NEGATIVE_INFINITY;
  let lowest = Number.POSITIVE_INFINITY;
  for (const item of candles) {
    highest = Math.max(highest, item.high);
    lowest = Math.min(lowest, item.low);
  }
  return direction === 'BULL'
    ? { mfe: Math.max(0, highest - anchor), mae: Math.max(0, anchor - lowest) }
    : { mfe: Math.max(0, anchor - lowest), mae: Math.max(0, highest - anchor) };
}

export function characterizePreSignal(input: {
  candles: readonly Candle[];
  triggerIndex: number;
  direction: SetupSignal['direction'];
  horizons?: readonly number[];
}): PreSignalRegimeSnapshot[] {
  if (
    !Number.isSafeInteger(input.triggerIndex) ||
    input.triggerIndex < 0 ||
    input.triggerIndex >= input.candles.length
  ) {
    throw new Error('triggerIndex must reference an available M15 candle');
  }
  const horizons = input.horizons ?? LOCAL_REGIME_HORIZONS;
  return horizons.flatMap((horizonCandles) => {
    if (!Number.isSafeInteger(horizonCandles) || horizonCandles <= 0) {
      throw new Error('Regime horizons must be positive candle counts');
    }
    const windowStartIndex = input.triggerIndex - horizonCandles;
    if (windowStartIndex < 0) return [];
    const windowEndIndex = input.triggerIndex - 1;
    const window = input.candles.slice(windowStartIndex, input.triggerIndex);
    return [
      {
        horizonCandles,
        windowStartIndex,
        windowEndIndex,
        directionalEfficiency: calculateRegimeDirectionalEfficiency(window),
        signedAlignment: calculateSignedAlignment(window, input.direction),
        ...calculateDirectionalExcursions(window, input.direction),
      },
    ];
  });
}

const SETUP_FAMILIES = ['A_COMPRESSION_BREAKOUT'] as const satisfies readonly SetupSignal['setupFamily'][];
const LOCAL_METRICS = [
  'directionalEfficiency',
  'signedAlignment',
  'mfe',
  'mae',
] as const;
const FOCUS_WINDOWS = [1, 5] as const;
const REFERENCE_WINDOWS = [0, 2, 4] as const;

type LocalMetric = (typeof LOCAL_METRICS)[number];

interface SummaryStatistics {
  sampleSize: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface Layer1RegimeRow {
  coin: string;
  windowIndex: number;
  status: 'COMPLETED' | 'SKIPPED_NO_DATA';
  reason?: string;
  candleCount: number;
  directionalEfficiency: number | null;
  meanRangeOverlap: number | null;
  returnFlipDensity: number | null;
}

export interface LocalSignalMeasurement extends PreSignalRegimeSnapshot {
  coin: string;
  windowIndex: number;
  setupFamily: SetupSignal['setupFamily'];
  direction: SetupSignal['direction'];
  triggerIndex: number;
  triggerOpenTime: number;
}

export interface LocalCombinationRow extends SummaryStatistics {
  coin: string;
  windowIndex: number;
  setupFamily: SetupSignal['setupFamily'];
  horizonCandles: number;
  horizonHours: number;
  metric: LocalMetric;
  status: 'COMPLETED' | 'SKIPPED_NO_DATA' | 'NO_SIGNALS' | 'NO_ELIGIBLE_SIGNALS';
  detectedSignals: number;
  insufficientHistorySignals: number;
}

export interface WindowGroupComparisonRow {
  coin: string;
  setupFamily: SetupSignal['setupFamily'];
  horizonCandles: number;
  horizonHours: number;
  metric: LocalMetric;
  focus: SummaryStatistics & { windows: readonly number[] };
  reference: SummaryStatistics & { windows: readonly number[] };
  meanDelta: number | null;
}

export interface RegimeCharacterizationReport {
  warning: string;
  generatedAt: string;
  strategyFingerprint: ReturnType<typeof computeStrategyFingerprint>;
  formulas: Record<string, string>;
  limitations: string[];
  windowGroups: { focus: readonly number[]; reference: readonly number[]; excluded: number[] };
  windows: RollingWindow[];
  layer1: Layer1RegimeRow[];
  localSignalMeasurements: LocalSignalMeasurement[];
  localCombinationTable: LocalCombinationRow[];
  windowGroupComparison: WindowGroupComparisonRow[];
}

function summarize(values: readonly number[]): SummaryStatistics {
  if (values.length === 0) {
    return { sampleSize: 0, mean: null, median: null, min: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    sampleSize: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median,
    min: sorted[0],
    max: sorted.at(-1)!,
  };
}

async function readM15Coverage(csvPath: string): Promise<{ first: number; last: number }> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u);
  if (rows.length < 2) throw new Error('M15 CSV contains no data rows');
  const first = Number(rows[1].split(',')[0]);
  const last = Number(rows.at(-1)!.split(',')[0]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
    throw new Error('M15 CSV coverage timestamps are invalid');
  }
  return { first, last };
}

function detectSignals(candles: readonly Candle[]): SetupSignal[] {
  const strategy = createDefaultStrategyAdapter();
  const signals: SetupSignal[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    if (!defaultDataGate(candles, index).accepted) continue;
    signals.push(...strategy.onClosedCandle(candles.slice(0, index + 1), index).setups);
  }
  return signals;
}

function buildCombinationTable(input: {
  coins: readonly string[];
  windows: readonly RollingWindow[];
  layer1: readonly Layer1RegimeRow[];
  signalsByCoinWindow: ReadonlyMap<string, readonly SetupSignal[]>;
  measurements: readonly LocalSignalMeasurement[];
}): LocalCombinationRow[] {
  return input.coins.flatMap((coin) =>
    input.windows.flatMap((window) =>
      SETUP_FAMILIES.flatMap((setupFamily) =>
        LOCAL_REGIME_HORIZONS.flatMap((horizonCandles) => {
          const coverage = input.layer1.find(
            (row) => row.coin === coin && row.windowIndex === window.index,
          )!;
          const signals =
            input.signalsByCoinWindow
              .get(`${coin}|${window.index}`)
              ?.filter((signal) => signal.setupFamily === setupFamily) ?? [];
          const eligible = input.measurements.filter(
            (row) =>
              row.coin === coin &&
              row.windowIndex === window.index &&
              row.setupFamily === setupFamily &&
              row.horizonCandles === horizonCandles,
          );
          const status: LocalCombinationRow['status'] =
            coverage.status === 'SKIPPED_NO_DATA'
              ? 'SKIPPED_NO_DATA'
              : signals.length === 0
                ? 'NO_SIGNALS'
                : eligible.length === 0
                  ? 'NO_ELIGIBLE_SIGNALS'
                  : 'COMPLETED';
          return LOCAL_METRICS.map((metric) => ({
            coin,
            windowIndex: window.index,
            setupFamily,
            horizonCandles,
            horizonHours: horizonCandles / 4,
            metric,
            status,
            detectedSignals: signals.length,
            insufficientHistorySignals: signals.length - eligible.length,
            ...summarize(eligible.map((row) => row[metric])),
          }));
        }),
      ),
    ),
  );
}

function buildGroupComparison(
  coins: readonly string[],
  rows: readonly LocalCombinationRow[],
): WindowGroupComparisonRow[] {
  const collect = (
    coin: string,
    setupFamily: SetupSignal['setupFamily'],
    horizonCandles: number,
    metric: LocalMetric,
    windows: readonly number[],
  ): number[] =>
    rows
      .filter(
        (row) =>
          row.coin === coin &&
          row.setupFamily === setupFamily &&
          row.horizonCandles === horizonCandles &&
          row.metric === metric &&
          windows.includes(row.windowIndex),
      )
      .flatMap((row) => (row.mean === null ? [] : [row.mean]));
  return coins.flatMap((coin) =>
    SETUP_FAMILIES.flatMap((setupFamily) =>
      LOCAL_REGIME_HORIZONS.flatMap((horizonCandles) =>
        LOCAL_METRICS.map((metric) => {
          const focus = summarize(
            collect(coin, setupFamily, horizonCandles, metric, FOCUS_WINDOWS),
          );
          const reference = summarize(
            collect(coin, setupFamily, horizonCandles, metric, REFERENCE_WINDOWS),
          );
          return {
            coin,
            setupFamily,
            horizonCandles,
            horizonHours: horizonCandles / 4,
            metric,
            focus: { windows: FOCUS_WINDOWS, ...focus },
            reference: { windows: REFERENCE_WINDOWS, ...reference },
            meanDelta:
              focus.mean === null || reference.mean === null
                ? null
                : focus.mean - reference.mean,
          };
        }),
      ),
    ),
  );
}

export async function buildRegimeCharacterizationReport(
  dataDirectory: string,
): Promise<RegimeCharacterizationReport> {
  const btcCoverage = await readM15Coverage(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const windows = buildRollingWindows(btcCoverage.first, btcCoverage.last);
  const coins = Object.keys(DEFAULT_COIN_BACKTEST_CONFIG);
  const layer1: Layer1RegimeRow[] = [];
  const localSignalMeasurements: LocalSignalMeasurement[] = [];
  const signalsByCoinWindow = new Map<string, SetupSignal[]>();

  for (const window of windows) {
    for (const coin of coins) {
      const csvPath = resolve(dataDirectory, `${coin}_15m_3y.csv`);
      try {
        const coverage = await readM15Coverage(csvPath);
        if (coverage.first > window.startInclusive || coverage.last + M15_MS < window.endExclusive) {
          layer1.push({
            coin,
            windowIndex: window.index,
            status: 'SKIPPED_NO_DATA',
            reason:
              coverage.first > window.startInclusive
                ? 'MISSING_WINDOW_START'
                : 'MISSING_WINDOW_END',
            candleCount: 0,
            directionalEfficiency: null,
            meanRangeOverlap: null,
            returnFlipDensity: null,
          });
          continue;
        }
        const candles = await loadM15CandlesBetween(
          csvPath,
          window.startInclusive,
          window.endExclusive,
        );
        const signals = detectSignals(candles);
        signalsByCoinWindow.set(`${coin}|${window.index}`, signals);
        layer1.push({
          coin,
          windowIndex: window.index,
          status: 'COMPLETED',
          candleCount: candles.length,
          directionalEfficiency: calculateRegimeDirectionalEfficiency(candles),
          meanRangeOverlap: calculateMeanRangeOverlap(candles),
          returnFlipDensity: calculateReturnFlipDensity(candles),
        });
        for (const signal of signals) {
          for (const snapshot of characterizePreSignal({
            candles,
            triggerIndex: signal.triggerIndex,
            direction: signal.direction,
          })) {
            localSignalMeasurements.push({
              coin,
              windowIndex: window.index,
              setupFamily: signal.setupFamily,
              direction: signal.direction,
              triggerIndex: signal.triggerIndex,
              triggerOpenTime: candles[signal.triggerIndex].openTime,
              ...snapshot,
            });
          }
        }
      } catch (error) {
        layer1.push({
          coin,
          windowIndex: window.index,
          status: 'SKIPPED_NO_DATA',
          reason: error instanceof Error ? error.message : String(error),
          candleCount: 0,
          directionalEfficiency: null,
          meanRangeOverlap: null,
          returnFlipDensity: null,
        });
      }
    }
  }

  const localCombinationTable = buildCombinationTable({
    coins,
    windows,
    layer1,
    signalsByCoinWindow,
    measurements: localSignalMeasurements,
  });
  return {
    warning: 'AUDIT ONLY: regime characterization does not activate or justify a strategy filter.',
    generatedAt: new Date().toISOString(),
    strategyFingerprint: computeStrategyFingerprint(),
    formulas: {
      directionalEfficiency: 'abs(last.close - first.open) / sum(high - low)',
      signedAlignment:
        'setupDirection(BULL=+1, BEAR=-1) * (last.close - first.open) / sum(high - low)',
      meanRangeOverlap:
        'mean(max(0, min(high[t-1], high[t]) - max(low[t-1], low[t])) / min(range[t-1], range[t]))',
      returnFlipDensity:
        'count(sign(closeReturn[t-1]) * sign(closeReturn[t]) < 0) / adjacentReturnPairs; zero return is not a flip',
      rawDirectionalMfeMae:
        'price-unit excursion from first.open in setup direction over pre-trigger candles; no SL/TP used',
      preSignalBoundary: 'slice(triggerIndex - horizonCandles, triggerIndex); trigger excluded',
      windowGroupComparison:
        'unweighted summary of per-window means within each coin/setup/horizon/metric; each completed window has weight 1',
    },
    limitations: [
      'Hypothesis exploration only; these results are not sufficient evidence to add a filter.',
      'Before any filter use, freeze the measurement definition and preregister the threshold.',
      'Test the preregistered rule on an unused holdout.',
      'Only consider a filter if the pattern repeats consistently.',
      'Raw MFE/MAE are price-unit metrics and are compared within coin, never pooled across coins.',
      'Windows 3 and 6 remain in the raw tables but are excluded from the requested 1-and-5 versus 0-2-4 group comparison.',
    ],
    windowGroups: {
      focus: FOCUS_WINDOWS,
      reference: REFERENCE_WINDOWS,
      excluded: windows.map((window) => window.index).filter(
        (index) => !FOCUS_WINDOWS.includes(index as 1 | 5) && !REFERENCE_WINDOWS.includes(index as 0 | 2 | 4),
      ),
    },
    windows,
    layer1,
    localSignalMeasurements,
    localCombinationTable,
    windowGroupComparison: buildGroupComparison(coins, localCombinationTable),
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const report = await buildRegimeCharacterizationReport(dataDirectory);
  if (report.strategyFingerprint.hash !== TICKET_020_STRATEGY_FINGERPRINT) {
    throw new Error(
      `Strategy fingerprint mismatch: expected ${TICKET_020_STRATEGY_FINGERPRINT}, received ${report.strategyFingerprint.hash}`,
    );
  }
  const outputPath = resolve(dataDirectory, 'nukida-regime-characterization.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(report.warning);
  console.info(
    `Layer 1 rows=${report.layer1.length}; local measurements=${report.localSignalMeasurements.length}; ` +
      `combination rows=${report.localCombinationTable.length}; group rows=${report.windowGroupComparison.length}`,
  );
  console.info(`Regime report: ${outputPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
