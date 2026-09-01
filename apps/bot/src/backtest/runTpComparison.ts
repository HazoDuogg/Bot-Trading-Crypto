import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Candle } from '../noTradeZone/types.js';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import {
  POSITION_MANAGEMENT_V2_ATR_PERIOD,
  POSITION_MANAGEMENT_V2_MAX_M1_CANDLES,
  POSITION_MANAGEMENT_V2_TRAILING_ATR_MULTIPLE,
  simulatePositionManagementV2,
  type PositionManagementV2Input,
  type ResolvedPositionManagementV2Result,
} from '../risk/positionManagementV2.js';
import type { TradePlan } from '../risk/tradePlan.js';
import { calculateExecutionCosts } from './costModel.js';
import { loadM1CandlesBetween, readLastCandleOpenTime } from './controlTest.js';
import {
  DEFAULT_COIN_BACKTEST_CONFIG,
  runFullNukidaBacktest,
  type BacktestReport,
  type PerformanceMetrics,
  type TradeLogEntry,
} from './runNukidaBacktest.js';
import {
  computeWalkForwardWindows,
  runFullNukidaBacktestOOS,
  type TimeWindow,
} from './runNukidaBacktestOOS.js';

export const POSITION_MANAGEMENT_V2_WARNING =
  'CLASS D EXPERIMENT: partial exit, breakeven, and ATR runner are not source-backed Nukida rules.';

export type ValidationPeriod = 'IN_SAMPLE' | 'OUT_OF_SAMPLE';

export interface FixedTpRun {
  takeProfitRMultiple: number;
  period: ValidationPeriod;
  report: BacktestReport;
}

export interface FixedTpComparisonRow {
  takeProfitRMultiple: number;
  period: ValidationPeriod;
  zeroCost: PerformanceMetrics;
  realisticCost: PerformanceMetrics;
}

export function buildFixedTpComparisonRows(
  runs: readonly FixedTpRun[],
): FixedTpComparisonRow[] {
  return runs.map((run) => ({
    takeProfitRMultiple: run.takeProfitRMultiple,
    period: run.period,
    zeroCost: run.report.overall.zeroCost,
    realisticCost: run.report.overall.realisticCost,
  }));
}

export interface PositionManagementTradeSource {
  coin: string;
  period: ValidationPeriod;
  tradePlan: TradePlan;
  entryFillTimestamp: number;
  m1Candles: readonly Candle[];
}

export interface PositionManagementConfig {
  partialExitRMultiple: 1.5 | 2;
  partialExitFraction: 0.5 | 0.7;
  breakevenBufferR: 0 | 0.1;
}

export const POSITION_MANAGEMENT_V2_CONFIGS: readonly PositionManagementConfig[] = Object.freeze(
  ([1.5, 2] as const).flatMap((partialExitRMultiple) =>
    ([0.5, 0.7] as const).flatMap((partialExitFraction) =>
      ([0, 0.1] as const).map((breakevenBufferR) => ({
        partialExitRMultiple,
        partialExitFraction,
        breakevenBufferR,
      })),
    ),
  ),
);

export interface PositionManagementMetrics {
  closedTrades: number;
  grossR: number;
  feeR: number;
  spreadR: number;
  slippageR: number;
  netR: number;
  profitFactor: number | null;
  expectancyPerTrade: number | null;
  winRate: number | null;
  ambiguousTrades: number;
  openTrades: number;
  forcedCloseTrades: number;
  partialExitTrades: number;
}

export interface PositionManagementMatrixRow {
  config: PositionManagementConfig;
  inSample: PositionManagementMetrics;
  outOfSample: PositionManagementMetrics;
  combined: PositionManagementMetrics;
}

export interface PositionManagementComparisonRow extends PositionManagementMatrixRow {
  fixedTpBaseline: {
    inSampleNetR: number;
    outOfSampleNetR: number;
    combinedNetR: number;
  };
  netRDeltaVsFixedTp: { inSample: number; outOfSample: number; combined: number };
}

interface ResolvedManagementTrade {
  grossR: number;
  feeR: number;
  spreadR: number;
  slippageR: number;
  netR: number;
  forced: boolean;
  partial: boolean;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function candleAt(candles: readonly Candle[], timestamp: number): Candle {
  const candle = candles.find((item) => item.openTime === timestamp);
  if (candle === undefined) throw new Error(`Missing M1 cost candle at ${timestamp}`);
  return candle;
}

function priceResolvedTrade(
  source: PositionManagementTradeSource,
  result: ResolvedPositionManagementV2Result,
): ResolvedManagementTrade | null {
  if (result.outcome === 'OPEN_DATA_END') return null;
  const entryCandle = source.m1Candles.find(
    (candle) => candle.openTime > source.entryFillTimestamp,
  );
  if (entryCandle === undefined) throw new Error('Resolved position is missing its entry M1 candle');
  let feeR = 0;
  let spreadR = 0;
  let slippageR = 0;
  let grossR = 0;
  for (const leg of result.exitLegs) {
    const costs = calculateExecutionCosts({
      tradePlan: source.tradePlan,
      exitPrice: leg.exitPrice,
      exitReason: leg.reason === 'PARTIAL_EXIT' ? 'TAKE_PROFIT' : 'STOP_LOSS',
      entryM1Candle: entryCandle,
      exitM1Candle: candleAt(source.m1Candles, leg.exitTimestamp),
    });
    grossR += leg.fraction * costs.grossR;
    feeR += leg.fraction * costs.feeR;
    spreadR += leg.fraction * costs.spreadR;
    slippageR += leg.fraction * costs.slippageR;
  }
  return {
    grossR,
    feeR,
    spreadR,
    slippageR,
    netR: grossR - feeR - spreadR - slippageR,
    forced: result.outcome === 'FORCED_CLOSE_TIMEOUT',
    partial: result.partialExitTriggered,
  };
}

function summarize(
  sources: readonly PositionManagementTradeSource[],
  config: PositionManagementConfig,
): PositionManagementMetrics {
  const resolved: ResolvedManagementTrade[] = [];
  let ambiguousTrades = 0;
  let openTrades = 0;
  for (const source of sources) {
    const input: PositionManagementV2Input = {
      tradePlan: source.tradePlan,
      entryFillTimestamp: source.entryFillTimestamp,
      m1Candles: source.m1Candles,
      ...config,
    };
    const result = simulatePositionManagementV2(input);
    if (result.outcome === 'AMBIGUOUS') {
      ambiguousTrades += 1;
      continue;
    }
    const priced = priceResolvedTrade(source, result);
    if (priced === null) {
      openTrades += 1;
      continue;
    }
    resolved.push(priced);
  }
  const grossR = resolved.reduce((sum, trade) => sum + trade.grossR, 0);
  const feeR = resolved.reduce((sum, trade) => sum + trade.feeR, 0);
  const spreadR = resolved.reduce((sum, trade) => sum + trade.spreadR, 0);
  const slippageR = resolved.reduce((sum, trade) => sum + trade.slippageR, 0);
  const netValues = resolved.map((trade) => trade.netR);
  const netR = netValues.reduce((sum, value) => sum + value, 0);
  const gains = netValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = netValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  return {
    closedTrades: resolved.length,
    grossR: round(grossR),
    feeR: round(feeR),
    spreadR: round(spreadR),
    slippageR: round(slippageR),
    netR: round(netR),
    profitFactor: losses === 0 ? null : round(gains / Math.abs(losses)),
    expectancyPerTrade: resolved.length === 0 ? null : round(netR / resolved.length),
    winRate:
      resolved.length === 0
        ? null
        : round(netValues.filter((value) => value > 0).length / resolved.length),
    ambiguousTrades,
    openTrades,
    forcedCloseTrades: resolved.filter((trade) => trade.forced).length,
    partialExitTrades: resolved.filter((trade) => trade.partial).length,
  };
}

export function buildPositionManagementMatrix(
  sources: readonly PositionManagementTradeSource[],
): PositionManagementMatrixRow[] {
  return POSITION_MANAGEMENT_V2_CONFIGS.map((config) => ({
    config,
    inSample: summarize(
      sources.filter((source) => source.period === 'IN_SAMPLE'),
      config,
    ),
    outOfSample: summarize(
      sources.filter((source) => source.period === 'OUT_OF_SAMPLE'),
      config,
    ),
    combined: summarize(sources, config),
  }));
}

export function buildPositionManagementComparisonRows(
  matrix: readonly PositionManagementMatrixRow[],
  fixedRows: readonly FixedTpComparisonRow[],
): PositionManagementComparisonRow[] {
  return matrix.map((row) => {
    const matching = fixedRows.filter(
      (fixed) => fixed.takeProfitRMultiple === row.config.partialExitRMultiple,
    );
    const inSample = matching.find((fixed) => fixed.period === 'IN_SAMPLE');
    const outOfSample = matching.find((fixed) => fixed.period === 'OUT_OF_SAMPLE');
    if (inSample === undefined || outOfSample === undefined) {
      throw new Error(`Missing fixed-TP baseline for ${row.config.partialExitRMultiple}R`);
    }
    const inSampleNetR = inSample.realisticCost.netR;
    const outOfSampleNetR = outOfSample.realisticCost.netR;
    const combinedNetR = inSampleNetR + outOfSampleNetR;
    return {
      ...row,
      fixedTpBaseline: { inSampleNetR, outOfSampleNetR, combinedNetR },
      netRDeltaVsFixedTp: {
        inSample: round(row.inSample.netR - inSampleNetR),
        outOfSample: round(row.outOfSample.netR - outOfSampleNetR),
        combined: round(row.combined.netR - combinedNetR),
      },
    };
  });
}

function firstM1After(candles: readonly Candle[], timestamp: number): number {
  let left = 0;
  let right = candles.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (candles[middle].openTime <= timestamp) left = middle + 1;
    else right = middle;
  }
  return left;
}

async function buildTradeSources(
  dataDirectory: string,
  period: ValidationPeriod,
  window: TimeWindow,
  logs: readonly TradeLogEntry[],
): Promise<PositionManagementTradeSource[]> {
  const sources: PositionManagementTradeSource[] = [];
  for (const coin of Object.keys(DEFAULT_COIN_BACKTEST_CONFIG)) {
    const coinLogs = logs.filter((log) => log.coin === coin);
    if (coinLogs.length === 0) continue;
    const candles = await loadM1CandlesBetween(
      resolve(dataDirectory, `${coin}_rt094_1m.csv`),
      window.startInclusive,
      window.endExclusive,
    );
    for (const log of coinLogs) {
      const start = firstM1After(candles, log.entryFillTimestamp);
      sources.push({
        coin,
        period,
        tradePlan: log.tradePlan,
        entryFillTimestamp: log.entryFillTimestamp,
        m1Candles: candles.slice(start, start + POSITION_MANAGEMENT_V2_MAX_M1_CANDLES),
      });
    }
  }
  return sources;
}

function compactMetric(metrics: PerformanceMetrics): string {
  return (
    `n=${metrics.closedTrades} netR=${metrics.netR.toFixed(2)} ` +
    `PF=${metrics.profitFactor?.toFixed(2) ?? 'N/A'} ` +
    `exp=${metrics.expectancyPerTrade?.toFixed(3) ?? 'N/A'} ` +
    `win=${metrics.winRate === null ? 'N/A' : `${(metrics.winRate * 100).toFixed(1)}%`}`
  );
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const anchor = await readLastCandleOpenTime(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const windows = computeWalkForwardWindows(anchor);
  const fixedRuns: FixedTpRun[] = [];
  const logsByTp = new Map<number, { inSample: TradeLogEntry[]; outOfSample: TradeLogEntry[] }>();

  console.info(POSITION_MANAGEMENT_V2_WARNING);
  for (const takeProfitRMultiple of [1.5, 2] as const) {
    const inSample = await runFullNukidaBacktest(dataDirectory, { takeProfitRMultiple });
    const outOfSample = await runFullNukidaBacktestOOS(dataDirectory, anchor, {
      takeProfitRMultiple,
    });
    fixedRuns.push(
      { takeProfitRMultiple, period: 'IN_SAMPLE', report: inSample.result.report },
      { takeProfitRMultiple, period: 'OUT_OF_SAMPLE', report: outOfSample.result.report },
    );
    logsByTp.set(takeProfitRMultiple, {
      inSample: inSample.result.tradeLogs,
      outOfSample: outOfSample.result.tradeLogs,
    });
  }

  const fixedTpComparison = buildFixedTpComparisonRows(fixedRuns);
  const baselineLogs = logsByTp.get(2);
  if (baselineLogs === undefined) throw new Error('Missing 2R trade population for v2 experiment');
  const sources = [
    ...(await buildTradeSources(
      dataDirectory,
      'IN_SAMPLE',
      windows.inSample,
      baselineLogs.inSample,
    )),
    ...(await buildTradeSources(
      dataDirectory,
      'OUT_OF_SAMPLE',
      windows.outOfSample,
      baselineLogs.outOfSample,
    )),
  ];
  const positionManagementComparison = buildPositionManagementComparisonRows(
    buildPositionManagementMatrix(sources),
    fixedTpComparison,
  );
  const reportPath = resolve(dataDirectory, 'nukida-position-management-v2-report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        warning: POSITION_MANAGEMENT_V2_WARNING,
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        windows,
        assumptions: {
          class: 'D_EXPERIMENTAL',
          fixedTpRMultiples: [1.5, 2],
          partialExitRMultiples: [1.5, 2],
          partialExitFractions: [0.5, 0.7],
          breakevenBufferRValues: [0, 0.1],
          runnerTrailingAtrMultiple: POSITION_MANAGEMENT_V2_TRAILING_ATR_MULTIPLE,
          runnerAtrPeriod: POSITION_MANAGEMENT_V2_ATR_PERIOD,
          maxM1Candles: POSITION_MANAGEMENT_V2_MAX_M1_CANDLES,
          positionPopulation:
            '2R trade logs; v2 reuses identical entry/SL and does not read TradePlan.takeProfit',
          sameCandlePolicy: 'INITIAL_STOP_AND_PARTIAL_TARGET_IS_AMBIGUOUS',
          stopUpdatePolicy: 'M1_CLOSE_EFFECTIVE_NEXT_CANDLE',
        },
        fixedTpComparison,
        positionManagementComparison,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  for (const row of fixedTpComparison) {
    console.info(
      `FIXED TP=${row.takeProfitRMultiple}R ${row.period}: ` +
        `zero[${compactMetric(row.zeroCost)}] realistic[${compactMetric(row.realisticCost)}]`,
    );
  }
  for (const row of positionManagementComparison) {
    console.info(
      `V2 partial=${row.config.partialExitRMultiple}R fraction=${row.config.partialExitFraction} ` +
        `BE=${row.config.breakevenBufferR}R: combined netR=${row.combined.netR.toFixed(2)} ` +
        `PF=${row.combined.profitFactor?.toFixed(2) ?? 'N/A'} ` +
        `exp=${row.combined.expectancyPerTrade?.toFixed(3) ?? 'N/A'} ` +
        `deltaVsFixed=${row.netRDeltaVsFixedTp.combined.toFixed(2)}`,
    );
  }
  console.info(`Report: ${reportPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
