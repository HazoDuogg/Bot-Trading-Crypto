import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBacktestReport,
  DEFAULT_COIN_BACKTEST_CONFIG,
  type TradeLogEntry,
} from '../src/backtest/runNukidaBacktest.js';
import { runNukidaWalkForwardRolling } from '../src/backtest/runNukidaWalkForwardRolling.js';

const CONDITIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] as const;
const COINS = Object.keys(DEFAULT_COIN_BACKTEST_CONFIG);
// Known-good baseline from TICKET-044 (D5=1.95, no bypass) — verified before running variants.
const EXPECTED_BASELINE_TRADES = 61;
const EXPECTED_BASELINE_NET_R_PER_TRADE = 0.1468;

interface Row {
  removedCondition: string;
  closedTrades: number;
  winRate: number | null;
  netRPerTrade: number | null;
  totalNetR: number;
  maxDrawdownR: number;
}

async function runScenario(dataDirectory: string, disabledCondition: string | null): Promise<Row> {
  const result = await runNukidaWalkForwardRolling(dataDirectory, {
    fsmConfigOverride: {
      compressionMaxBandwidthAtrRatioOverride: 1.95,
      disabledConditions: disabledCondition === null ? undefined : new Set([disabledCondition]),
    },
  });
  const allTradeLogs: TradeLogEntry[] = result.windows.flatMap((window) => window.tradeLogs);
  const report = buildBacktestReport(allTradeLogs, COINS);
  const metrics = report.overall.realisticCost;
  return {
    removedCondition: disabledCondition ?? 'none',
    closedTrades: metrics.closedTrades,
    winRate: metrics.winRate,
    netRPerTrade: metrics.expectancyPerTrade,
    totalNetR: metrics.netR,
    maxDrawdownR: metrics.maxDrawdownR,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));

  console.info('Baseline (no bypass, D5=1.95)...');
  const baseline = await runScenario(dataDirectory, null);
  console.info(`baseline: n=${baseline.closedTrades}, netR/trade=${baseline.netRPerTrade?.toFixed(4)}`);

  const baselineMatches =
    baseline.closedTrades === EXPECTED_BASELINE_TRADES &&
    baseline.netRPerTrade !== null &&
    Math.abs(baseline.netRPerTrade - EXPECTED_BASELINE_NET_R_PER_TRADE) < 0.001;
  if (!baselineMatches) {
    console.error(
      `MISMATCH vs known TICKET-044 baseline (expected n=${EXPECTED_BASELINE_TRADES}, ` +
        `netR/trade=${EXPECTED_BASELINE_NET_R_PER_TRADE}; got n=${baseline.closedTrades}, ` +
        `netR/trade=${baseline.netRPerTrade}). Stopping before running the 8 variants.`,
    );
    const outputPath = resolve(dataDirectory, 'nukida-ticket045-ablation.json');
    await writeFile(
      outputPath,
      `${JSON.stringify({ error: 'BASELINE_MISMATCH', baseline }, null, 2)}\n`,
      'utf8',
    );
    console.info(`Partial output (baseline only): ${outputPath}`);
    return;
  }
  console.info('Baseline matches TICKET-044 exactly — proceeding to 8 variants.');

  const rows: Row[] = [baseline];
  for (const condition of CONDITIONS) {
    console.info(`Running variant: disable ${condition}...`);
    const variant = await runScenario(dataDirectory, condition);
    rows.push(variant);
    console.info(`${condition}: n=${variant.closedTrades}, netR/trade=${variant.netRPerTrade?.toFixed(4)}`);
  }

  const output = rows.map((row) => ({
    ...row,
    netRPerTradeDeltaVsBaseline:
      row.removedCondition === 'none' || row.netRPerTrade === null || baseline.netRPerTrade === null
        ? 0
        : row.netRPerTrade - baseline.netRPerTrade,
  }));

  const elapsedMinutes = (Date.now() - startedAt) / 60_000;
  const outputPath = resolve(dataDirectory, 'nukida-ticket045-ablation.json');
  await writeFile(
    outputPath,
    `${JSON.stringify({ warning: 'Ablation study on top of D5=1.95 (TICKET-042/044 baseline), not a production config change.', rows: output, elapsedMinutes }, null, 2)}\n`,
    'utf8',
  );

  console.info('\n--- Summary ---');
  for (const row of output) {
    console.info(
      `${row.removedCondition.padEnd(6)} n=${String(row.closedTrades).padStart(4)} ` +
        `winRate=${row.winRate === null ? 'N/A' : `${(100 * row.winRate).toFixed(1)}%`} ` +
        `netR/trade=${row.netRPerTrade?.toFixed(4) ?? 'N/A'} totalNetR=${row.totalNetR.toFixed(4)} ` +
        `maxDD=${row.maxDrawdownR.toFixed(4)}R delta=${row.netRPerTradeDeltaVsBaseline.toFixed(4)}`,
    );
  }
  console.info(`Elapsed: ${elapsedMinutes.toFixed(1)} min`);
  console.info(`Output: ${outputPath}`);
}

await main();
