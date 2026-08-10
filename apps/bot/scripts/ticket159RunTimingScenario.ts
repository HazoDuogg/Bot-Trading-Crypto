import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, makeFillModel, runReplay, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';

type Variant = 'OVEREXTENSION_GUARD' | 'BREAKOUT_PULLBACK_CONTINUATION';
type Scenario = 'FEE_ONLY' | 'LIGHT' | 'CENTRAL' | 'CONSERVATIVE';
const variant = process.env.T159_VARIANT as Variant;
const scenario = process.env.T159_SCENARIO as Scenario;
if (!variant || !scenario) throw new Error('T159_VARIANT and T159_SCENARIO are required');
const costs = { FEE_ONLY: [0, 0], LIGHT: [1, 1], CENTRAL: [2, 2], CONSERVATIVE: [5, 5] } as const;
const [slippageBps, spreadBps] = costs[scenario];
const cfg = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true } as ReturnType<typeof buildBaselineConfig> & {
  momentumEntryTimingResearch?: { mode: Variant; maxExtensionAtr: number; minAvailableRewardR: number; maxWaitCandles5m: number };
};
cfg.entryRouterConfig = { ...cfg.entryRouterConfig, obEnabled: false };
cfg.momentumEntryTimingResearch = {
  mode: variant,
  maxExtensionAtr: Number(process.env.T159_EXTENSION ?? 1),
  minAvailableRewardR: Number(process.env.T159_REWARD ?? 1.2),
  maxWaitCandles5m: Number(process.env.T159_WAIT ?? 12),
};

function metrics(trades: ClosedTrade[], pnl: (trade: ClosedTrade) => number) {
  const values = trades.map(pnl);
  const gains = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfit = gains.reduce((sum, value) => sum + value, 0);
  const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  let equity = 100, peak = 100, maxDd = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp)) {
    equity += pnl(trade); peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
  }
  const netPnl = values.reduce((sum, value) => sum + value, 0);
  return { trades: trades.length, wins: gains.length, winRate: trades.length ? gains.length / trades.length * 100 : 0, pf: grossLoss ? grossProfit / grossLoss : null, netPnl, expectancy: trades.length ? netPnl / trades.length : 0, maxDd, averageWin: gains.length ? grossProfit / gains.length : 0, averageLoss: losses.length ? -grossLoss / losses.length : 0 };
}

function csv(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n') + '\n';
}

async function main() {
  const model = scenario === 'FEE_ONLY' ? null : makeFillModel(`T159-${variant}-${scenario}`, slippageBps / 10_000, spreadBps / 10_000);
  const replay = await runReplay(cfg, model, 57_833);
  const pnl = (trade: ClosedTrade) => replay.slippedPnlByEntryTs.get(`${trade.symbol}|${trade.entryTimestamp}`) ?? trade.pnlUsdTheoretical;
  const rows = replay.trades.map((trade) => ({ variant, scenario, orderId: `${trade.symbol}-${trade.entryTimestamp}`, symbol: trade.symbol, side: trade.side, setup: trade.setupType, regime: trade.regime, entryTimestamp: trade.entryTimestamp, exitTimestamp: trade.exitTimestamp, entryPrice: trade.entryPriceTheoretical, exitPrice: trade.exitPriceTheoretical, exitReason: trade.exitReason, positionSize: trade.positionSize, netPnl: pnl(trade) }));
  const summary = { ticket: 'T159', variant, scenario, configHash: createHash('sha256').update(JSON.stringify(cfg)).digest('hex'), portfolio: metrics(replay.trades, pnl), momentumDirect: metrics(replay.trades.filter((trade) => trade.setupType === 'MOMENTUM_DIRECT'), pnl), productionBehaviorModified: false };
  const suffix = `${variant.toLowerCase()}-${scenario.toLowerCase()}`;
  writeFileSync(path.join(process.cwd(), 'data', `ticket159-${suffix}-ledger.csv`), csv(rows));
  writeFileSync(path.join(process.cwd(), 'data', `ticket159-${suffix}-summary.json`), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
main().catch((error) => { console.error(error); process.exit(1); });
