import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import {
  EMA_TREND_V1_PERIOD,
  EMA_TREND_V1_SLOPE_LOOKBACK_CANDLES,
  evaluateEmaTrend,
  type EmaTrendSnapshot,
} from '../structure/emaTrendFilter.js';
import { DEFAULT_COIN_BACKTEST_CONFIG, loadM15CandlesBetween } from './runNukidaBacktest.js';
import {
  TICKET_020_STRATEGY_FINGERPRINT,
  runNukidaWalkForwardRolling,
  type RollingTradeLogEntry,
} from './runNukidaWalkForwardRolling.js';

// AUDIT ONLY (TICKET-029): this measures whether a single preregistered EMA50/M15 trend
// filter would have correlated with Setup A's PF instability across the 7 rolling windows.
// It does not activate a filter and does not conclude anything on its own — see LIMITATIONS.
export const LIMITATIONS = [
  'n=7 rolling windows only; not enough windows for a statistically confident conclusion.',
  'Exactly one EMA period (50) and one slope lookback (10) were tried, both preregistered ' +
    'before any PF comparison ran. This audits ONE hypothesis, not "EMA trend filters in general" ' +
    '— trying other periods requires a separate, independent ticket, never a cross-period sweep.',
  'This is a correlational measurement, not causal evidence. It does not activate a filter, ' +
    'and a correlation here would not by itself justify adding one.',
  'PF/netR are reported per (coin, window) to avoid pooling diluting a real per-coin effect; ' +
    'the bad/good window alignment-ratio comparison is reported both per-coin and pooled ' +
    '(pooling is reasonable there because it answers a single ratio question, not a PF question).',
];

const FOCUS_WINDOWS = [1, 5] as const; // "bad" windows, PF 0.66 / 0.90ish per TICKET-024-026 history
const REFERENCE_WINDOWS = [0, 2, 4] as const; // "good" windows

export interface EmaAlignmentTradeRow {
  coin: string;
  windowIndex: number;
  direction: 'BULL' | 'BEAR';
  triggerIndex: number;
  triggerOpenTime: number;
  emaTrend: EmaTrendSnapshot | null;
  alignedWithEmaTrend: boolean | null;
  netR: number | null;
  excludedReason: 'INSUFFICIENT_EMA_HISTORY' | 'OPEN_OR_AMBIGUOUS_TRADE' | null;
}

export interface EmaAlignmentAggregateRow {
  coin: string;
  windowIndex: number;
  alignedWithEmaTrend: boolean;
  closedTrades: number;
  netR: number;
  profitFactor: number | null;
}

interface AlignmentRatio {
  windows: readonly number[];
  totalTrades: number;
  alignedTrades: number;
  alignedRatio: number | null;
}

export interface EmaAlignmentGroupComparisonRow {
  coin: string;
  focus: AlignmentRatio;
  reference: AlignmentRatio;
  alignedRatioDelta: number | null;
}

export interface EmaTrendAuditReport {
  warning: string;
  generatedAt: string;
  strategyFingerprint: ReturnType<typeof computeStrategyFingerprint>;
  registeredParameters: { emaPeriod: number; slopeLookbackCandles: number };
  limitations: string[];
  windowGroups: { focus: readonly number[]; reference: readonly number[] };
  tradeRows: EmaAlignmentTradeRow[];
  aggregateByCoinWindow: EmaAlignmentAggregateRow[];
  groupComparisonByCoin: EmaAlignmentGroupComparisonRow[];
  groupComparisonPooled: EmaAlignmentGroupComparisonRow;
}

function profitFactor(netRValues: readonly number[]): number | null {
  const wins = netRValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -netRValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  if (losses === 0) return wins === 0 ? null : Number.POSITIVE_INFINITY;
  return wins / losses;
}

function alignmentRatio(
  windows: readonly number[],
  rows: readonly EmaAlignmentTradeRow[],
): AlignmentRatio {
  const inScope = rows.filter(
    (row) => windows.includes(row.windowIndex) && row.alignedWithEmaTrend !== null,
  );
  const alignedTrades = inScope.filter((row) => row.alignedWithEmaTrend === true).length;
  return {
    windows,
    totalTrades: inScope.length,
    alignedTrades,
    alignedRatio: inScope.length === 0 ? null : alignedTrades / inScope.length,
  };
}

function groupComparisonRow(coin: string, rows: readonly EmaAlignmentTradeRow[]): EmaAlignmentGroupComparisonRow {
  const focus = alignmentRatio(FOCUS_WINDOWS, rows);
  const reference = alignmentRatio(REFERENCE_WINDOWS, rows);
  return {
    coin,
    focus,
    reference,
    alignedRatioDelta:
      focus.alignedRatio === null || reference.alignedRatio === null
        ? null
        : focus.alignedRatio - reference.alignedRatio,
  };
}

export async function buildEmaTrendAuditReport(dataDirectory: string): Promise<EmaTrendAuditReport> {
  const rolling = await runNukidaWalkForwardRolling(dataDirectory);
  const coins = Object.keys(DEFAULT_COIN_BACKTEST_CONFIG);
  const tradeRows: EmaAlignmentTradeRow[] = [];

  for (const window of rolling.windows) {
    const setupATrades = window.tradeLogs.filter(
      (trade): trade is RollingTradeLogEntry =>
        trade.setupFamily === 'A_COMPRESSION_BREAKOUT',
    );
    const tradesByCoin = new Map<string, RollingTradeLogEntry[]>();
    for (const trade of setupATrades) {
      tradesByCoin.set(trade.coin, [...(tradesByCoin.get(trade.coin) ?? []), trade]);
    }
    for (const coin of coins) {
      const trades = tradesByCoin.get(coin);
      if (trades === undefined || trades.length === 0) continue;
      const candles = await loadM15CandlesBetween(
        resolve(dataDirectory, `${coin}_15m_3y.csv`),
        window.window.startInclusive,
        window.window.endExclusive,
      );
      for (const trade of trades) {
        const triggerIndex = trade.reasonTrace.d2.brokeAt;
        const emaTrend = evaluateEmaTrend(candles, triggerIndex);
        const netR =
          trade.costs !== null && 'grossR' in trade.costs ? trade.costs.netR : null;
        const alignedWithEmaTrend =
          emaTrend === null
            ? null
            : (trade.tradePlan.direction === 'BULL' && emaTrend.aboveEma) ||
              (trade.tradePlan.direction === 'BEAR' && !emaTrend.aboveEma);
        tradeRows.push({
          coin,
          windowIndex: window.window.index,
          direction: trade.tradePlan.direction,
          triggerIndex,
          triggerOpenTime: candles[triggerIndex]?.openTime ?? candles.at(-1)!.openTime,
          emaTrend,
          alignedWithEmaTrend,
          netR,
          excludedReason:
            emaTrend === null
              ? 'INSUFFICIENT_EMA_HISTORY'
              : netR === null
                ? 'OPEN_OR_AMBIGUOUS_TRADE'
                : null,
        });
      }
    }
  }

  const aggregateByCoinWindow: EmaAlignmentAggregateRow[] = [];
  const windowIndexes = [...new Set(tradeRows.map((row) => row.windowIndex))].sort((a, b) => a - b);
  for (const coin of coins) {
    for (const windowIndex of windowIndexes) {
      for (const alignedWithEmaTrend of [true, false]) {
        const rows = tradeRows.filter(
          (row) =>
            row.coin === coin &&
            row.windowIndex === windowIndex &&
            row.alignedWithEmaTrend === alignedWithEmaTrend &&
            row.netR !== null,
        );
        if (rows.length === 0) continue;
        const netRValues = rows.map((row) => row.netR!);
        aggregateByCoinWindow.push({
          coin,
          windowIndex,
          alignedWithEmaTrend,
          closedTrades: rows.length,
          netR: netRValues.reduce((sum, value) => sum + value, 0),
          profitFactor: profitFactor(netRValues),
        });
      }
    }
  }

  return {
    warning:
      'AUDIT ONLY: EMA-trend alignment measurement for Setup A. Does not activate a filter ' +
      'and is not sufficient evidence to add one — see limitations.',
    generatedAt: new Date().toISOString(),
    strategyFingerprint: computeStrategyFingerprint(),
    registeredParameters: {
      emaPeriod: EMA_TREND_V1_PERIOD,
      slopeLookbackCandles: EMA_TREND_V1_SLOPE_LOOKBACK_CANDLES,
    },
    limitations: LIMITATIONS,
    windowGroups: { focus: FOCUS_WINDOWS, reference: REFERENCE_WINDOWS },
    tradeRows,
    aggregateByCoinWindow,
    groupComparisonByCoin: coins.map((coin) =>
      groupComparisonRow(
        coin,
        tradeRows.filter((row) => row.coin === coin),
      ),
    ),
    groupComparisonPooled: groupComparisonRow('ALL', tradeRows),
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const report = await buildEmaTrendAuditReport(dataDirectory);
  if (report.strategyFingerprint.hash !== TICKET_020_STRATEGY_FINGERPRINT) {
    throw new Error(
      `Strategy fingerprint mismatch: expected ${TICKET_020_STRATEGY_FINGERPRINT}, received ${report.strategyFingerprint.hash}`,
    );
  }
  console.info(report.warning);
  for (const row of report.aggregateByCoinWindow) {
    console.info(
      `${row.coin} window ${row.windowIndex} aligned=${row.alignedWithEmaTrend}: ` +
        `n=${row.closedTrades} netR=${row.netR.toFixed(2)} PF=${row.profitFactor?.toFixed(3) ?? 'N/A'}`,
    );
  }
  console.info('\nBad windows (1,5) vs good windows (0,2,4) — aligned ratio:');
  for (const row of report.groupComparisonByCoin) {
    console.info(
      `${row.coin}: focus=${row.focus.alignedTrades}/${row.focus.totalTrades} ` +
        `(${row.focus.alignedRatio === null ? 'N/A' : (row.focus.alignedRatio * 100).toFixed(1) + '%'}) vs ` +
        `reference=${row.reference.alignedTrades}/${row.reference.totalTrades} ` +
        `(${row.reference.alignedRatio === null ? 'N/A' : (row.reference.alignedRatio * 100).toFixed(1) + '%'})`,
    );
  }
  console.info(
    `POOLED: focus=${report.groupComparisonPooled.focus.alignedTrades}/${report.groupComparisonPooled.focus.totalTrades} vs ` +
      `reference=${report.groupComparisonPooled.reference.alignedTrades}/${report.groupComparisonPooled.reference.totalTrades}`,
  );
  const outputPath = resolve(dataDirectory, 'nukida-ticket029-ema-trend-audit.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(`\nReport: ${outputPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
