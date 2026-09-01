import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Candle } from '../noTradeZone/types.js';
import {
  createNukidaFsm,
  type FsmConfig,
} from '../orchestrator/nukidaFsm.js';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import {
  MIN_STOP_DISTANCE_ATR_MULTIPLE,
  type TradePlan,
} from '../risk/tradePlan.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import { loadRecentM1Candles } from './controlTest.js';
import {
  BINANCE_USDM_REGULAR_USER_TAKER_FEE_RATE,
  calculateExecutionCosts,
  DEFAULT_ADVERSE_SLIPPAGE_RATE,
  SPREAD_PROXY_M1_RANGE_FRACTION,
  type ExecutionCostResult,
} from './costModel.js';
import {
  mapM15ClosedCandleToExecutionStart,
  simulateIntrabarExecution,
  type IntrabarExecutionResult,
} from './intrabarExecution.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const IN_SAMPLE_WARNING =
  'WARNING: IN-SAMPLE calibration period. Pipeline diagnostic only; do not infer profitability.';

export interface CoinBacktestInput {
  coin: string;
  m15Candles: readonly Candle[];
  m1Candles: readonly Candle[];
  fsmConfig: FsmConfig;
}

export interface TradeLogEntry {
  coin: string;
  setupFamily: SetupSignal['setupFamily'];
  entryFillTimestamp: number;
  tradePlan: TradePlan;
  reasonTrace: SetupSignal['reasonTrace'];
  execution: IntrabarExecutionResult;
  costs:
    | ExecutionCostResult
    | { bestCase: ExecutionCostResult; worstCase: ExecutionCostResult }
    | null;
}

export interface PerformanceMetrics {
  closedTrades: number;
  grossR: number;
  feeR: number;
  spreadR: number;
  slippageR: number;
  netR: number;
  profitFactor: number | null;
  expectancyPerTrade: number | null;
  maxDrawdownR: number;
  winRate: number | null;
  ambiguousTrades: number;
  openTrades: number;
}

export interface DualCostMetrics {
  zeroCost: PerformanceMetrics;
  realisticCost: PerformanceMetrics;
}

export interface BacktestReport {
  note: string;
  baselineVariant: 'RETEST_LIMIT_ONLY';
  overall: DualCostMetrics;
  ambiguousScenarios: {
    count: number;
    bestCaseGrossR: number;
    bestCaseNetR: number;
    worstCaseGrossR: number;
    worstCaseNetR: number;
  };
  byCoin: Record<string, DualCostMetrics>;
  bySetupFamily: Record<string, DualCostMetrics>;
  byDirection: Record<string, DualCostMetrics>;
  minimumStopDistanceBlocked: { total: number; byCoin: Record<string, number> };
}

export interface NukidaBacktestResult {
  warning: string;
  tradeLogs: TradeLogEntry[];
  report: BacktestReport;
}

interface ResolvedTrade {
  timestamp: number;
  grossR: number;
  realisticR: number;
  feeR: number;
  spreadR: number;
  slippageR: number;
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

function executionCosts(
  tradePlan: TradePlan,
  execution: IntrabarExecutionResult,
  entryCandle: Candle | undefined,
  exitCandle: Candle | undefined,
): TradeLogEntry['costs'] {
  if (execution.outcome === 'OPEN') return null;
  if (entryCandle === undefined || exitCandle === undefined) {
    throw new Error('Closed execution is missing its M1 entry/exit cost proxy candle');
  }
  if (execution.outcome === 'AMBIGUOUS') {
    return {
      bestCase: calculateExecutionCosts({
        tradePlan,
        exitPrice: execution.bestCase!.exitPrice,
        entryM1Candle: entryCandle,
        exitM1Candle: exitCandle,
      }),
      worstCase: calculateExecutionCosts({
        tradePlan,
        exitPrice: execution.worstCase!.exitPrice,
        entryM1Candle: entryCandle,
        exitM1Candle: exitCandle,
      }),
    };
  }
  return calculateExecutionCosts({
    tradePlan,
    exitPrice: execution.exitPrice!,
    entryM1Candle: entryCandle,
    exitM1Candle: exitCandle,
  });
}

function runCoin(input: CoinBacktestInput): { logs: TradeLogEntry[]; minimumStopBlocked: number } {
  const fsm = createNukidaFsm(input.fsmConfig);
  const logs: TradeLogEntry[] = [];
  let minimumStopBlocked = 0;
  for (let index = 0; index < input.m15Candles.length; index += 1) {
    const events = fsm.onClosedCandle(input.m15Candles, index);
    for (const event of events) {
      if (
        event.state === 'TRADE_PLAN_REJECTED' &&
        event.reasonCode === 'MIN_STOP_DISTANCE'
      ) {
        minimumStopBlocked += 1;
        continue;
      }
      if (event.state !== 'TRADE_PLAN_READY') continue;
      if (event.tradePlan === undefined || event.setupSignal === undefined) {
        throw new Error('TRADE_PLAN_READY must include tradePlan and setupSignal');
      }
      const entryFillTimestamp = mapM15ClosedCandleToExecutionStart(
        input.m15Candles[event.index].openTime,
      );
      const m1Start = firstM1After(input.m1Candles, entryFillTimestamp);
      const postFillM1 = input.m1Candles.slice(m1Start);
      const execution = simulateIntrabarExecution({
        tradePlan: event.tradePlan,
        entryFillTimestamp,
        m1Candles: postFillM1,
      });
      const exitM1 =
        execution.exitTimestamp === undefined
          ? undefined
          : input.m1Candles[firstM1After(input.m1Candles, execution.exitTimestamp - 1)];
      logs.push({
        coin: input.coin,
        setupFamily: event.setupSignal.setupFamily,
        entryFillTimestamp,
        tradePlan: event.tradePlan,
        reasonTrace: event.setupSignal.reasonTrace,
        execution,
        costs: executionCosts(event.tradePlan, execution, postFillM1[0], exitM1),
      });
    }
  }
  return { logs, minimumStopBlocked };
}

function isResolvedCosts(costs: TradeLogEntry['costs']): costs is ExecutionCostResult {
  return costs !== null && 'grossR' in costs;
}

function metricSet(logs: readonly TradeLogEntry[], realistic: boolean): PerformanceMetrics {
  const resolved: ResolvedTrade[] = logs
    .filter((log) => isResolvedCosts(log.costs))
    .map((log) => ({
      timestamp: log.execution.exitTimestamp!,
      grossR: (log.costs as ExecutionCostResult).grossR,
      realisticR: (log.costs as ExecutionCostResult).netR,
      feeR: (log.costs as ExecutionCostResult).feeR,
      spreadR: (log.costs as ExecutionCostResult).spreadR,
      slippageR: (log.costs as ExecutionCostResult).slippageR,
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
  const values = resolved.map((trade) => (realistic ? trade.realisticR : trade.grossR));
  const grossR = resolved.reduce((sum, trade) => sum + trade.grossR, 0);
  const feeR = realistic ? resolved.reduce((sum, trade) => sum + trade.feeR, 0) : 0;
  const spreadR = realistic ? resolved.reduce((sum, trade) => sum + trade.spreadR, 0) : 0;
  const slippageR = realistic ? resolved.reduce((sum, trade) => sum + trade.slippageR, 0) : 0;
  const netR = values.reduce((sum, value) => sum + value, 0);
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    closedTrades: resolved.length,
    grossR,
    feeR,
    spreadR,
    slippageR,
    netR,
    profitFactor: losses === 0 ? null : gains / Math.abs(losses),
    expectancyPerTrade: resolved.length === 0 ? null : netR / resolved.length,
    maxDrawdownR,
    winRate:
      resolved.length === 0 ? null : values.filter((value) => value > 0).length / resolved.length,
    ambiguousTrades: logs.filter((log) => log.execution.outcome === 'AMBIGUOUS').length,
    openTrades: logs.filter((log) => log.execution.outcome === 'OPEN').length,
  };
}

function dualMetrics(logs: readonly TradeLogEntry[]): DualCostMetrics {
  return { zeroCost: metricSet(logs, false), realisticCost: metricSet(logs, true) };
}

function groupMetrics(
  logs: readonly TradeLogEntry[],
  keys: readonly string[],
  select: (log: TradeLogEntry) => string,
): Record<string, DualCostMetrics> {
  return Object.fromEntries(
    keys.map((key) => [key, dualMetrics(logs.filter((log) => select(log) === key))]),
  );
}

export function buildBacktestReport(
  logs: readonly TradeLogEntry[],
  coins: readonly string[],
  minimumStopBlockedByCoin: Readonly<Record<string, number>> = {},
  note = IN_SAMPLE_WARNING,
): BacktestReport {
  const ambiguous = logs.filter(
    (log): log is TradeLogEntry & {
      costs: { bestCase: ExecutionCostResult; worstCase: ExecutionCostResult };
    } => log.execution.outcome === 'AMBIGUOUS' && log.costs !== null && 'bestCase' in log.costs,
  );
  return {
    note,
    baselineVariant: 'RETEST_LIMIT_ONLY',
    overall: dualMetrics(logs),
    ambiguousScenarios: {
      count: ambiguous.length,
      bestCaseGrossR: ambiguous.reduce((sum, log) => sum + log.costs.bestCase.grossR, 0),
      bestCaseNetR: ambiguous.reduce((sum, log) => sum + log.costs.bestCase.netR, 0),
      worstCaseGrossR: ambiguous.reduce((sum, log) => sum + log.costs.worstCase.grossR, 0),
      worstCaseNetR: ambiguous.reduce((sum, log) => sum + log.costs.worstCase.netR, 0),
    },
    byCoin: groupMetrics(logs, coins, (log) => log.coin),
    bySetupFamily: groupMetrics(
      logs,
      ['A_COMPRESSION_BREAKOUT', 'B_BREAK_PULLBACK_FAILURE'],
      (log) => log.setupFamily,
    ),
    byDirection: groupMetrics(logs, ['BULL', 'BEAR'], (log) => log.tradePlan.direction),
    minimumStopDistanceBlocked: {
      total: Object.values(minimumStopBlockedByCoin).reduce((sum, count) => sum + count, 0),
      byCoin: Object.fromEntries(coins.map((coin) => [coin, minimumStopBlockedByCoin[coin] ?? 0])),
    },
  };
}

export function runNukidaBacktest(input: {
  coins: readonly CoinBacktestInput[];
  warning?: string;
}): NukidaBacktestResult {
  const coinResults = input.coins.map((coin) => ({ coin: coin.coin, ...runCoin(coin) }));
  const tradeLogs = coinResults.flatMap((result) => result.logs).sort(
    (left, right) => left.entryFillTimestamp - right.entryFillTimestamp,
  );
  const minimumStopBlockedByCoin = Object.fromEntries(
    coinResults.map((result) => [result.coin, result.minimumStopBlocked]),
  );
  return {
    warning: input.warning ?? IN_SAMPLE_WARNING,
    tradeLogs,
    report: buildBacktestReport(
      tradeLogs,
      input.coins.map((coin) => coin.coin),
      minimumStopBlockedByCoin,
      input.warning ?? IN_SAMPLE_WARNING,
    ),
  };
}

export const DEFAULT_COIN_BACKTEST_CONFIG = Object.freeze({
  BTCUSDT: { tickSize: 0.1, lotSize: 0.001, leverage: 20 },
  ETHUSDT: { tickSize: 0.01, lotSize: 0.001, leverage: 20 },
  SOLUSDT: { tickSize: 0.01, lotSize: 0.01, leverage: 10 },
  HYPEUSDT: { tickSize: 0.001, lotSize: 0.01, leverage: 10 },
  DOGEUSDT: { tickSize: 0.00001, lotSize: 1, leverage: 10 },
});

async function loadM15File(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  const all = rows.map((row, index) => {
    const values = row.split(',').map(Number);
    if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid M15 CSV row ${index + 2}`);
    }
    const [openTime, open, high, low, close, volume] = values;
    return { openTime, open, high, low, close, volume };
  });
  if (all.length === 0) throw new Error('M15 CSV contains no candles');
  return all;
}

export async function loadM15CandlesBetween(
  csvPath: string,
  startInclusive: number,
  endExclusive: number,
): Promise<Candle[]> {
  if (!Number.isSafeInteger(startInclusive) || !Number.isSafeInteger(endExclusive)) {
    throw new Error('M15 window bounds must be UTC epoch millisecond integers');
  }
  if (endExclusive <= startInclusive) throw new Error('M15 window end must be after start');
  const result = (await loadM15File(csvPath)).filter(
    (candle) => candle.openTime >= startInclusive && candle.openTime < endExclusive,
  );
  if (result.length === 0) throw new Error('M15 CSV has no candles in the requested window');
  return result;
}

async function loadRecentM15(csvPath: string): Promise<Candle[]> {
  const all = await loadM15File(csvPath);
  const cutoff = all.at(-1)!.openTime - 180 * DAY_MS;
  return all.filter((candle) => candle.openTime >= cutoff);
}

export function defaultDataGate(candles: readonly Candle[], index: number) {
  if (index === 0) return { accepted: true };
  const accepted = candles[index].openTime - candles[index - 1].openTime === 900_000;
  return { accepted, reasonCode: accepted ? undefined : 'M15_GAP_OR_DUPLICATE' };
}

export async function runFullNukidaBacktest(dataDirectory: string): Promise<{
  result: NukidaBacktestResult;
  coinRuns: Record<string, { status: 'COMPLETED' | 'SKIPPED'; error?: string }>;
}> {
  const coinRuns: Record<string, { status: 'COMPLETED' | 'SKIPPED'; error?: string }> = {};
  const completed: CoinBacktestInput[] = [];
  for (const [coin, config] of Object.entries(DEFAULT_COIN_BACKTEST_CONFIG)) {
    try {
      const m15Candles = await loadRecentM15(resolve(dataDirectory, `${coin}_15m_3y.csv`));
      const m15Anchor = m15Candles.at(-1)!.openTime;
      const m1Candles = await loadRecentM1Candles(
        resolve(dataDirectory, `${coin}_rt094_1m.csv`),
        180,
        m15Anchor,
      );
      completed.push({
        coin,
        m15Candles,
        m1Candles,
        fsmConfig: {
          ...config,
          riskBudgetUsd: 100,
          dataGate: defaultDataGate,
        },
      });
      coinRuns[coin] = { status: 'COMPLETED' };
    } catch (error) {
      coinRuns[coin] = {
        status: 'SKIPPED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { result: runNukidaBacktest({ coins: completed }), coinRuns };
}

export async function writeBacktestArtifacts(
  dataDirectory: string,
  result: NukidaBacktestResult,
  coinRuns: Record<string, { status: 'COMPLETED' | 'SKIPPED'; error?: string }>,
  artifactStem = 'nukida-backtest',
): Promise<{ tradesPath: string; reportPath: string }> {
  const tradesPath = resolve(dataDirectory, `${artifactStem}-trades-6m.json`);
  const reportPath = resolve(dataDirectory, `${artifactStem}-report-6m.json`);
  await writeFile(tradesPath, `${JSON.stringify(result.tradeLogs, null, 2)}\n`, 'utf8');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        warning: result.warning,
        generatedAt: new Date().toISOString(),
        strategyFingerprint: computeStrategyFingerprint(),
        executionAssumptions: {
          periodDays: 180,
          riskBudgetUsd: 100,
          minimumStopDistanceAtrMultiple: MIN_STOP_DISTANCE_ATR_MULTIPLE,
          takerFeeRate: BINANCE_USDM_REGULAR_USER_TAKER_FEE_RATE,
          adverseSlippageRate: DEFAULT_ADVERSE_SLIPPAGE_RATE,
          spreadProxy: 'M1_RANGE_FRACTION_AT_ENTRY_AND_EXIT',
          spreadProxyM1RangeFraction: SPREAD_PROXY_M1_RANGE_FRACTION,
          exchangeFilterSource: 'BINANCE_FUTURES_EXCHANGE_INFO_2026-09-01',
          coinConfig: DEFAULT_COIN_BACKTEST_CONFIG,
        },
        coinRuns,
        report: result.report,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { tradesPath, reportPath };
}

function printMetrics(label: string, metrics: DualCostMetrics): void {
  for (const [costLabel, values] of Object.entries(metrics)) {
    console.info(
      `${label} ${costLabel}: closed=${values.closedTrades}, grossR=${values.grossR.toFixed(2)}, ` +
        `feeR=${values.feeR.toFixed(2)}, spreadR=${values.spreadR.toFixed(2)}, ` +
        `slippageR=${values.slippageR.toFixed(2)}, netR=${values.netR.toFixed(2)}, ` +
        `PF=${values.profitFactor?.toFixed(2) ?? 'N/A'}, ` +
        `expectancy=${values.expectancyPerTrade?.toFixed(3) ?? 'N/A'}R, ` +
        `maxDD=${values.maxDrawdownR.toFixed(2)}R, winRate=` +
        `${values.winRate === null ? 'N/A' : `${(values.winRate * 100).toFixed(1)}%`}, ` +
        `AMBIGUOUS=${values.ambiguousTrades}, OPEN=${values.openTrades}`,
    );
  }
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  console.info(IN_SAMPLE_WARNING);
  console.info('Baseline: retest/limit only; breakout-entry variant is not part of this run.');
  const { result, coinRuns } = await runFullNukidaBacktest(dataDirectory);
  const paths = await writeBacktestArtifacts(dataDirectory, result, coinRuns);
  console.info(
    `Coin runs: ${Object.entries(coinRuns)
      .map(([coin, run]) => `${coin}=${run.status}`)
      .join(', ')}`,
  );
  printMetrics('OVERALL', result.report.overall);
  console.info(
    `MIN_STOP_DISTANCE blocked=${result.report.minimumStopDistanceBlocked.total}; ` +
      Object.entries(result.report.minimumStopDistanceBlocked.byCoin)
        .map(([coin, count]) => `${coin}=${count}`)
        .join(', '),
  );
  console.info(
    `AMBIGUOUS scenarios: count=${result.report.ambiguousScenarios.count}, ` +
      `bestGrossR=${result.report.ambiguousScenarios.bestCaseGrossR.toFixed(2)}, ` +
      `bestNetR=${result.report.ambiguousScenarios.bestCaseNetR.toFixed(2)}, ` +
      `worstGrossR=${result.report.ambiguousScenarios.worstCaseGrossR.toFixed(2)}, ` +
      `worstNetR=${result.report.ambiguousScenarios.worstCaseNetR.toFixed(2)}`,
  );
  for (const [coin, metrics] of Object.entries(result.report.byCoin)) printMetrics(coin, metrics);
  for (const [family, metrics] of Object.entries(result.report.bySetupFamily)) {
    printMetrics(family, metrics);
  }
  for (const [direction, metrics] of Object.entries(result.report.byDirection)) {
    printMetrics(direction, metrics);
  }
  console.info(`Trades: ${paths.tradesPath}`);
  console.info(`Report: ${paths.reportPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
