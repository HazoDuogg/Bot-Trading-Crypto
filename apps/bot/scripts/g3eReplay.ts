import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, computeMetrics, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';

const VARIANT = process.env.G3E_VARIANT ?? '';
const SCENARIO = process.env.G3E_SCENARIO ?? 'CENTRAL';
const SCENARIO_BPS: Record<string, [number, number]> = { FEE_ONLY: [0, 0], LIGHT: [1, 1], CENTRAL: [2, 2], CONSERVATIVE: [5, 5] };
if (!(SCENARIO in SCENARIO_BPS)) throw new Error(`invalid G3E_SCENARIO ${SCENARIO}`);
if (!['G3E_BASELINE_OFF', 'G3E_MOMENTUM_DIRECT_BODY_RATIO_0_5'].includes(VARIANT)) throw new Error(`invalid G3E_VARIANT ${VARIANT}`);
const STOP_STEP = 57833;

async function main(): Promise<void> {
  const [slip, spread] = SCENARIO_BPS[SCENARIO];
  const cfg = {
    ...buildBaselineConfig(),
    sameSideDuplicateGuardEnabled: true,
    momentumDirectBodyRatioEnabled: VARIANT === 'G3E_MOMENTUM_DIRECT_BODY_RATIO_0_5',
  };
  const fillModel = slip === 0 && spread === 0 ? null : makeFillModel(SCENARIO, slip / 10_000, spread / 10_000);
  const started = Date.now();
  const replay = await runReplay(cfg, fillModel, STOP_STEP);
  const pnl = (t: ClosedTrade): number => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
  const metrics = computeMetrics(replay.trades, pnl, 100);
  const bump = (out: Record<string, { n: number; net: number; wins: number }>, key: string, value: number): void => {
    out[key] ??= { n: 0, net: 0, wins: 0 };
    out[key].n++;
    out[key].net += value;
    if (value > 0) out[key].wins++;
  };
  const bySetup: Record<string, { n: number; net: number; wins: number }> = {};
  const bySymbol: Record<string, { n: number; net: number; wins: number }> = {};
  const bySide: Record<string, { n: number; net: number; wins: number }> = {};
  const byMonth: Record<string, { n: number; net: number; wins: number }> = {};
  for (const trade of replay.trades) {
    const value = pnl(trade);
    bump(bySetup, trade.setupType, value);
    bump(bySymbol, trade.symbol, value);
    bump(bySide, trade.side, value);
    bump(byMonth, new Date(trade.entryTimestamp).toISOString().slice(0, 7), value);
  }
  const outDir = path.resolve(process.cwd(), 'data/g3e-runs');
  mkdirSync(outDir, { recursive: true });
  const tag = `${VARIANT}-${SCENARIO}`;
  writeFileSync(path.join(outDir, `${tag}-summary.json`), JSON.stringify({
    variant: VARIANT, scenario: SCENARIO, slipBps: slip, spreadBpsTotal: spread, stopStep: STOP_STEP,
    trades: metrics.n, winRate: metrics.wr, profitFactor: metrics.pf, netPnl: metrics.netPnl,
    expectancy: metrics.expectancy, finalEquity: metrics.finalBalance, maxDdPct: metrics.maxDdPct,
    maxDdUsd: metrics.maxDdUsd, bySetup, bySymbol, bySide, byMonth,
    tradeSource: 'BACKTEST_PROXY', runtimeSec: Math.round((Date.now() - started) / 1000),
  }, null, 2) + '\n');
  const esc = (value: unknown): string => { const s = String(value ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['variant','scenario','tradeSource','symbol','side','setupType','regime','entryTimestamp','entryIso','exitTimestamp','exitIso','exitReason','entryPrice','slPrice','positionSize','actualRiskDollar','netPnl','pnlTheoretical'];
  const rows = replay.trades.map((t) => [VARIANT,SCENARIO,'BACKTEST_PROXY',t.symbol,t.side,t.setupType,t.regime,t.entryTimestamp,new Date(t.entryTimestamp).toISOString(),t.exitTimestamp,new Date(t.exitTimestamp).toISOString(),t.exitReason,t.entryPriceTheoretical,t.slPrice,t.positionSize,t.actualRiskDollar,pnl(t).toFixed(6),t.pnlUsdTheoretical.toFixed(6)]);
  writeFileSync(path.join(outDir, `${tag}-trades.csv`), [header.join(','), ...rows.map((row) => row.map(esc).join(','))].join('\n') + '\n');
  console.log(`${tag}: trades=${metrics.n} wr=${metrics.wr} pf=${metrics.pf} net=${metrics.netPnl} expectancy=${metrics.expectancy} maxDdPct=${metrics.maxDdPct}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
