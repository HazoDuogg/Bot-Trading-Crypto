import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultStrategyAdapter } from '../src/orchestrator/nukidaFsm.js';
import {
  buildBacktestReport,
  DEFAULT_COIN_BACKTEST_CONFIG,
  loadM15CandlesBetween,
  type TradeLogEntry,
} from '../src/backtest/runNukidaBacktest.js';
import {
  buildCoinWindowAssignments,
  buildRollingWindows,
  runNukidaWalkForwardRolling,
  type RollingWindow,
  type TimestampCoverage,
} from '../src/backtest/runNukidaWalkForwardRolling.js';

const COINS = Object.keys(DEFAULT_COIN_BACKTEST_CONFIG);

// Same 2-line coverage read as runNukidaWalkForwardRolling.ts's private readM15Coverage (not exported).
async function readM15Coverage(csvPath: string): Promise<TimestampCoverage> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u);
  return { firstOpenTime: Number(rows[1].split(',')[0]), lastOpenTime: Number(rows.at(-1)!.split(',')[0]) };
}

// Raw D1-D8 signal count: setups returned by the strategy adapter itself, before the M1 retest
// window, MIN_STOP_DISTANCE, or any other downstream filter ever sees them.
async function countRawD1D8Signals(
  dataDirectory: string,
  windows: readonly RollingWindow[],
  compressionMaxBandwidthAtrRatioOverride: number | undefined,
): Promise<number> {
  const coverageByCoin = new Map(
    await Promise.all(
      COINS.map(async (coin) => [coin, await readM15Coverage(resolve(dataDirectory, `${coin}_15m_3y.csv`))] as const),
    ),
  );
  let total = 0;
  for (const window of windows) {
    const btcM15CandlesForWindow = await loadM15CandlesBetween(
      resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'),
      window.startInclusive,
      window.endExclusive,
    );
    for (const coin of COINS) {
      const assignment = buildCoinWindowAssignments([window], coverageByCoin.get(coin)!)[0];
      if (assignment.status === 'SKIPPED_NO_DATA') continue;
      const m15Candles = await loadM15CandlesBetween(
        resolve(dataDirectory, `${coin}_15m_3y.csv`),
        window.startInclusive,
        window.endExclusive,
      );
      const adapter = createDefaultStrategyAdapter({
        btcM15Candles: btcM15CandlesForWindow,
        compressionMaxBandwidthAtrRatioOverride,
      });
      for (let index = 0; index < m15Candles.length; index += 1) {
        total += adapter.onClosedCandle(m15Candles, index).setups.length;
      }
    }
  }
  return total;
}

interface ThresholdSummary {
  rawD1D8SignalCount: number;
  windowsRun: number;
  closedTrades: number;
  winRate: number | null;
  zeroCost: { netRPerTrade: number | null; totalNetR: number; maxDrawdownR: number };
  realisticCost: { netRPerTrade: number | null; totalNetR: number; maxDrawdownR: number };
}

async function runThreshold(
  dataDirectory: string,
  windows: readonly RollingWindow[],
  compressionMaxBandwidthAtrRatioOverride: number | undefined,
): Promise<ThresholdSummary> {
  const rawD1D8SignalCount = await countRawD1D8Signals(
    dataDirectory,
    windows,
    compressionMaxBandwidthAtrRatioOverride,
  );
  const result = await runNukidaWalkForwardRolling(dataDirectory, {
    fsmConfigOverride:
      compressionMaxBandwidthAtrRatioOverride === undefined
        ? undefined
        : { compressionMaxBandwidthAtrRatioOverride },
  });
  const allTradeLogs: TradeLogEntry[] = result.windows.flatMap((window) => window.tradeLogs);
  const report = buildBacktestReport(allTradeLogs, COINS);
  return {
    rawD1D8SignalCount,
    windowsRun: result.windows.length,
    closedTrades: report.overall.realisticCost.closedTrades,
    winRate: report.overall.realisticCost.winRate,
    zeroCost: {
      netRPerTrade: report.overall.zeroCost.expectancyPerTrade,
      totalNetR: report.overall.zeroCost.netR,
      maxDrawdownR: report.overall.zeroCost.maxDrawdownR,
    },
    realisticCost: {
      netRPerTrade: report.overall.realisticCost.expectancyPerTrade,
      totalNetR: report.overall.realisticCost.netR,
      maxDrawdownR: report.overall.realisticCost.maxDrawdownR,
    },
  };
}

// Root-cause note (bisected 2026-09-03, see report.bisectionTrail below): the "601 trades"
// figure predates TICKET-037, which lowered D5's own default 1.95 -> 1.50 and added a D7 cap;
// it is not reproducible on current code and its absence here is not a defect.
const BISECTION_TRAIL = [
  { commit: 'e17d717 TICKET-033', d5Default: 1.95, closedTrades: 601, note: 'cited "601" baseline' },
  { commit: '108bf8d TICKET-035', d5Default: 1.95, closedTrades: 601, note: 'unchanged' },
  { commit: '5b18645 TICKET-036', d5Default: 1.95, closedTrades: 554, note: 'unrelated change' },
  {
    commit: 'd63cdb7 TICKET-037',
    d5Default: 1.5,
    closedTrades: 52,
    note: 'D5 default lowered 1.95->1.50 + new D7 max-body-ratio cap added',
  },
  { commit: '81ffdfa TICKET-038', d5Default: 1.5, closedTrades: 30, note: 'BTC trend alignment gate added' },
  { commit: '9190955 TICKET-039', d5Default: 1.5, closedTrades: 16, note: 'single M1-candle retest window rewrite' },
  { commit: 'd772cda TICKET-040', d5Default: 1.5, closedTrades: 15, note: 'liquidity sweep gate added' },
  { commit: '69e406e TICKET-041', d5Default: 1.5, closedTrades: 16, note: 'position management V2 (exit engine only)' },
] as const;

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const btcCoverage = await readM15Coverage(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const windows = buildRollingWindows(btcCoverage.firstOpenTime, btcCoverage.lastOpenTime);

  console.info(`Windows: ${windows.length}`);
  console.info('Running D5=1.50 (default, no override)...');
  const baseline = await runThreshold(dataDirectory, windows, undefined);
  console.info('Running D5=1.95 (old pre-TICKET-037 default, on current engine)...');
  const old195 = await runThreshold(dataDirectory, windows, 1.95);
  console.info('Running D5=2.20 (audit override)...');
  const relaxed = await runThreshold(dataDirectory, windows, 2.2);

  const output = {
    warning:
      'TICKET-042 AUDIT ONLY: compares the D5 compression threshold at 1.50 (production default, ' +
      'unchanged), 1.95 (old pre-TICKET-037 default, re-run on the current engine), and 2.20 ' +
      '(relaxed). Not a recommendation and not a production config change. Scope excludes the ' +
      'undefined M5/M15 accumulation mechanism referenced in the ticket.',
    generatedAt: new Date().toISOString(),
    windowCount: windows.length,
    thresholds: { baseline: 1.5, old195: 1.95, relaxed: 2.2 },
    baseline,
    old195,
    relaxed,
    bisectionNote:
      'The ticket\'s cited "601 trades" baseline was measured at TICKET-033 (D5 default was 1.95 ' +
      'then). TICKET-037 deliberately lowered the D5 default to 1.50 and added a D7 max-body-ratio ' +
      'cap (554->52 trades). TICKET-038/039/040/041 each further changed entry/exit mechanics ' +
      '(52->30->16->15->16). This is the cumulative, intentional effect of four separate later ' +
      'tickets, not a defect, and "601" cannot be reproduced on current code by design.',
    bisectionTrail: BISECTION_TRAIL,
  };

  const outputPath = resolve(dataDirectory, 'nukida-ticket042-d5-relaxed-audit.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  const line = (label: string, s: ThresholdSummary) =>
    console.info(
      `${label}: signals=${s.rawD1D8SignalCount}, closedTrades=${s.closedTrades}, ` +
        `winRate=${s.winRate === null ? 'N/A' : `${(s.winRate * 100).toFixed(1)}%`}, ` +
        `realisticNetR/trade=${s.realisticCost.netRPerTrade?.toFixed(4) ?? 'N/A'}, ` +
        `realisticTotalNetR=${s.realisticCost.totalNetR.toFixed(4)}, ` +
        `realisticMaxDD=${s.realisticCost.maxDrawdownR.toFixed(4)}R`,
    );
  line('D5=1.50', baseline);
  line('D5=1.95', old195);
  line('D5=2.20', relaxed);
  console.info(`Report: ${outputPath}`);
}

await main();
