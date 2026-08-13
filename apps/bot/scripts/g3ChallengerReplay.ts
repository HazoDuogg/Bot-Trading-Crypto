/**
 * TICKET-G3 P1 — pre-registered entry challengers, each run through the FULL orchestrator via the
 * EXISTING T153B/T157/T158/T159/G2R harness (runReplay + makeFillModel + computeMetrics). Same
 * fixed checkpoint window, same cost scenarios, same path-dependent shadow balance. No new cost
 * engine, no new replay loop, no source file under src/ modified — both challengers are expressed
 * purely through already-existing OrchestratorConfig fields.
 *
 * Variants are fixed in data/g3-candidate-preregistration.md, written BEFORE any run here.
 *
 * Usage: G3_CHALLENGER=<E0_CURRENT|E1_OB_DISABLED|E2_MOMENTUM_OVEREXTENSION_3ATR> G3_SCENARIO=<...> node g3ChallengerReplay.js
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, computeMetrics, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';

const VARIANT = process.env.G3_CHALLENGER ?? '';
const SCENARIO = process.env.G3_SCENARIO ?? 'CENTRAL';
const SCENARIO_BPS: Record<string, [number, number]> = { FEE_ONLY: [0, 0], LIGHT: [1, 1], CENTRAL: [2, 2], CONSERVATIVE: [5, 5] };
if (!(SCENARIO in SCENARIO_BPS)) throw new Error(`G3_SCENARIO must be one of ${Object.keys(SCENARIO_BPS).join('|')}`);
const STOP_STEP = 57833;
const MAX_EXTENSION_ATR = 3.0; // PRE-REGISTERED single value, data/g3-candidate-preregistration.md

async function main(): Promise<void> {
  const [slip, spread] = SCENARIO_BPS[SCENARIO];
  const base = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  let cfg = base;
  if (VARIANT === 'E1_OB_DISABLED') cfg = { ...base, entryRouterConfig: { ...base.entryRouterConfig, obEnabled: false } };
  else if (VARIANT === 'E2_MOMENTUM_OVEREXTENSION_3ATR') cfg = { ...base, momentumEntryTimingResearch: { mode: 'OVEREXTENSION_GUARD', maxExtensionAtr: MAX_EXTENSION_ATR, minAvailableRewardR: 0 } };
  else if (VARIANT !== 'E0_CURRENT') throw new Error(`unknown G3_CHALLENGER ${VARIANT}`);

  const fillModel = slip === 0 && spread === 0 ? null : makeFillModel(SCENARIO, slip / 10000, spread / 10000);
  console.log(`G3 challenger=${VARIANT} scenario=${SCENARIO} slip=${slip}bps spread=${spread}bps stopStep=${STOP_STEP}`);
  const started = Date.now();
  const replay = await runReplay(cfg, fillModel, STOP_STEP);
  const pnl = (t: ClosedTrade): number => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
  const m = computeMetrics(replay.trades, pnl, 100);

  const bump = (b: Record<string, { n: number; net: number }>, k: string, v: number): void => { b[k] = b[k] ?? { n: 0, net: 0 }; b[k].n++; b[k].net += v; };
  const bySetup: Record<string, { n: number; net: number }> = {}, byRegime: Record<string, { n: number; net: number }> = {};
  const bySymbol: Record<string, { n: number; net: number }> = {}, bySide: Record<string, { n: number; net: number }> = {};
  const byMonth: Record<string, { n: number; net: number }> = {}, byExit: Record<string, { n: number; net: number }> = {};
  for (const t of replay.trades) { const v = pnl(t); bump(bySetup, t.setupType, v); bump(byRegime, t.regime, v); bump(bySymbol, t.symbol, v); bump(bySide, t.side, v); bump(byMonth, new Date(t.exitTimestamp).toISOString().slice(0, 7), v); bump(byExit, t.exitReason, v); }

  const outDir = path.resolve(process.cwd(), 'data/g3-runs');
  mkdirSync(outDir, { recursive: true });
  const tag = `${VARIANT}-${SCENARIO}`;
  writeFileSync(path.join(outDir, `${tag}-summary.json`), JSON.stringify({
    challenger: VARIANT, scenario: SCENARIO, slipBps: slip, spreadBpsTotal: spread, stopStep: STOP_STEP,
    maxExtensionAtr: VARIANT === 'E2_MOMENTUM_OVEREXTENSION_3ATR' ? MAX_EXTENSION_ATR : null,
    tradeSource: 'BACKTEST_PROXY', dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS',
    trades: m.n, winRate: m.wr, profitFactor: m.pf, netPnl: m.netPnl, expectancy: m.expectancy,
    finalEquity: m.finalBalance, maxDdPct: m.maxDdPct, maxDdUsd: m.maxDdUsd,
    bySetup, byRegime, bySymbol, bySide, byMonth, byExit, runtimeSec: Math.round((Date.now() - started) / 1000),
  }, null, 2) + '\n');

  const csvEscape = (v: unknown): string => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['challenger', 'scenario', 'tradeSource', 'symbol', 'side', 'setupType', 'regime', 'entryTimestamp', 'entryIso', 'exitTimestamp', 'exitIso', 'exitReason', 'entryPrice', 'slPrice', 'positionSize', 'actualRiskDollar', 'netPnl', 'pnlTheoretical'];
  const rows = replay.trades.map((t) => [VARIANT, SCENARIO, 'BACKTEST_PROXY', t.symbol, t.side, t.setupType, t.regime, t.entryTimestamp, new Date(t.entryTimestamp).toISOString(), t.exitTimestamp, new Date(t.exitTimestamp).toISOString(), t.exitReason, t.entryPriceTheoretical, t.slPrice, t.positionSize, t.actualRiskDollar, pnl(t).toFixed(6), t.pnlUsdTheoretical.toFixed(6)]);
  writeFileSync(path.join(outDir, `${tag}-trades.csv`), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');

  console.log(`${tag}: trades=${m.n} wr=${m.wr.toFixed(4)}% pf=${Number(m.pf).toFixed(10)} net=$${m.netPnl.toFixed(8)} exp=$${m.expectancy.toFixed(6)} maxDD=${m.maxDdPct.toFixed(6)}%/$${m.maxDdUsd.toFixed(6)} (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(`  bySetup: ${JSON.stringify(bySetup)}`);
  console.log(`  bySide: ${JSON.stringify(bySide)}  bySymbol: ${JSON.stringify(bySymbol)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
