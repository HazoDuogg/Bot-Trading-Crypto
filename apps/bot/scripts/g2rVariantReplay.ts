/**
 * TICKET-G2R P1 — NEUTRAL and post-DANGER-cooldown variants, each run through the FULL orchestrator
 * (real entry router, XGBoost gate, risk sizing + risk pool, T152 same-side guard, position
 * conflicts, execution costs, path-dependent balance) via the EXISTING T153B/T158/T159 harness
 * (ticket150BacktestExecutionRealismAudit.ts's runReplay + makeFillModel + computeMetrics).
 * No new cost engine, no shortcut DraftSetup evaluation.
 *
 * Usage: G2R_VARIANT=<id> G2R_SCENARIO=<FEE_ONLY|LIGHT|CENTRAL|CONSERVATIVE> node g2rVariantReplay.js
 * Writes one JSON + one trade ledger CSV per (variant, scenario) into data/g2r-runs/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, computeMetrics, type ClosedTrade, type ReplayVariantHooks } from './ticket150BacktestExecutionRealismAudit.js';
import { MarketRegime } from '../dist/regime/types.js';

const VARIANT = process.env.G2R_VARIANT ?? '';
const SCENARIO = process.env.G2R_SCENARIO ?? 'CENTRAL';

// Same four scenarios (and same bps values) the T153B harness registered in docs/baseline-registry.md.
const SCENARIO_BPS: Record<string, [number, number]> = { FEE_ONLY: [0, 0], LIGHT: [1, 1], CENTRAL: [2, 2], CONSERVATIVE: [5, 5] };
if (!(SCENARIO in SCENARIO_BPS)) throw new Error(`G2R_SCENARIO must be one of ${Object.keys(SCENARIO_BPS).join('|')}`);

const COOLDOWN_C2_HOURS = 24; // PRE-REGISTERED in data/g2r-cooldown-preregistration.md before any run
const STOP_STEP = 57833; // identical fixed checkpoint window T153B/T157/T158/T159 all use

type VariantId = 'N0_CURRENT' | 'N1_BLOCK_ALL' | 'N2_NO_POST_DANGER_DOWNGRADE' | 'C0_CURRENT' | 'C1_ENTRY_ANCHORED' | 'C2_SHORTER_WINDOW';

/**
 * Per-symbol episode memory for C1_ENTRY_ANCHORED: remembers the anchor written when the CURRENT
 * DANGER episode was first entered, so later DANGER candles in the same episode cannot refresh it.
 */
const episodeAnchor: Record<string, number | null> = {};
const inDangerEpisode: Record<string, boolean> = {};

function hooksFor(variant: VariantId, counters: { neutralSteps: number; blockedSteps: number }): ReplayVariantHooks | undefined {
  switch (variant) {
    case 'N0_CURRENT':
    case 'C0_CURRENT':
      // Baseline: NO hooks at all -> runReplay stays byte-identical to every pre-G2R caller.
      return undefined;

    case 'N1_BLOCK_ALL':
      return {
        blockEntry: ({ regime }) => {
          if (regime !== MarketRegime.NEUTRAL_TRANSITION) return false;
          counters.blockedSteps++;
          return true;
        },
        onStepRegime: ({ regime }) => { if (regime === MarketRegime.NEUTRAL_TRANSITION) counters.neutralSteps++; },
      };

    case 'N2_NO_POST_DANGER_DOWNGRADE':
      // Suppresses ONLY the 72h cooldown mechanism: with no anchor, regimeDetector's cooldown branch
      // never fires and the raw candidate stands. Nothing else about NEUTRAL is touched.
      return {
        rewriteDangerAnchor: () => null,
        onStepRegime: ({ regime }) => { if (regime === MarketRegime.NEUTRAL_TRANSITION) counters.neutralSteps++; },
      };

    case 'C1_ENTRY_ANCHORED':
      return {
        rewriteDangerAnchor: ({ symbol, regime, current }) => {
          const isDanger = regime === MarketRegime.DANGER_ZONE;
          if (isDanger && !inDangerEpisode[symbol]) {
            inDangerEpisode[symbol] = true;
            episodeAnchor[symbol] = current; // first candle of this episode — keep exactly this stamp
          } else if (!isDanger) {
            inDangerEpisode[symbol] = false;
          }
          // Inside an ongoing episode the detector has already refreshed `current`; pin it back.
          return inDangerEpisode[symbol] ? episodeAnchor[symbol] ?? current : current;
        },
        onStepRegime: ({ regime }) => { if (regime === MarketRegime.NEUTRAL_TRANSITION) counters.neutralSteps++; },
      };

    case 'C2_SHORTER_WINDOW':
      // Equivalent to POST_DANGER_COOLDOWN_HOURS = 24 without mutating the shared RegimeConfig:
      // an anchor older than the shorter window is retired, so the detector's own 72h test can
      // never see it again.
      return {
        rewriteDangerAnchor: ({ timestamp, current }) => (current !== null && timestamp - current >= COOLDOWN_C2_HOURS * 3_600_000 ? null : current),
        onStepRegime: ({ regime }) => { if (regime === MarketRegime.NEUTRAL_TRANSITION) counters.neutralSteps++; },
      };

    default:
      throw new Error(`unknown G2R_VARIANT ${variant}`);
  }
}

const csvEscape = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main(): Promise<void> {
  const variant = VARIANT as VariantId;
  const [slip, spread] = SCENARIO_BPS[SCENARIO];
  const cfg = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  const fillModel = slip === 0 && spread === 0 ? null : makeFillModel(SCENARIO, slip / 10000, spread / 10000);

  const counters = { neutralSteps: 0, blockedSteps: 0 };
  const hooks = hooksFor(variant, counters);

  console.log(`G2R variant=${variant} scenario=${SCENARIO} slip=${slip}bps spread=${spread}bps stopStep=${STOP_STEP}`);
  const started = Date.now();
  const replay = await runReplay(cfg, fillModel, STOP_STEP, hooks);
  const pnl = (t: ClosedTrade): number => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
  const m = computeMetrics(replay.trades, pnl, 100);
  const wins = replay.trades.filter((t) => pnl(t) > 0).length;

  const outDir = path.resolve(process.cwd(), 'data/g2r-runs');
  mkdirSync(outDir, { recursive: true });
  const tag = `${variant}-${SCENARIO}`;

  const byRegime: Record<string, { n: number; net: number }> = {};
  const bySetup: Record<string, { n: number; net: number }> = {};
  const bySymbol: Record<string, { n: number; net: number }> = {};
  const bySide: Record<string, { n: number; net: number }> = {};
  const byMonth: Record<string, { n: number; net: number }> = {};
  const byExit: Record<string, { n: number; net: number }> = {};
  const bump = (b: Record<string, { n: number; net: number }>, k: string, v: number): void => {
    b[k] = b[k] ?? { n: 0, net: 0 };
    b[k].n++; b[k].net += v;
  };
  for (const t of replay.trades) {
    const v = pnl(t);
    bump(byRegime, t.regime, v);
    bump(bySetup, t.setupType, v);
    bump(bySymbol, t.symbol, v);
    bump(bySide, t.side, v);
    bump(byMonth, new Date(t.exitTimestamp).toISOString().slice(0, 7), v);
    bump(byExit, t.exitReason, v);
  }

  const summary = {
    variant, scenario: SCENARIO, slipBps: slip, spreadBpsTotal: spread, stopStep: STOP_STEP,
    cooldownC2Hours: variant === 'C2_SHORTER_WINDOW' ? COOLDOWN_C2_HOURS : null,
    tradeSource: 'BACKTEST_PROXY', // never REAL_LIVE — no live execution history exists in this repo
    dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS',
    trades: m.n, wins, losses: m.n - wins, winRate: m.wr, profitFactor: m.pf,
    netPnl: m.netPnl, finalEquity: m.finalBalance, expectancy: m.expectancy,
    maxDdPct: m.maxDdPct, maxDdUsd: m.maxDdUsd,
    neutralConfirmedSteps: counters.neutralSteps, entryBlockedSteps: counters.blockedSteps,
    finalShadowBalance: replay.finalShadowBalance,
    byRegime, bySetup, bySymbol, bySide, byMonth, byExit,
    runtimeSec: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(path.join(outDir, `${tag}-summary.json`), JSON.stringify(summary, null, 2) + '\n');

  const header = ['variant', 'scenario', 'tradeSource', 'symbol', 'side', 'setupType', 'regime', 'entryTimestamp', 'entryIso', 'exitTimestamp', 'exitIso', 'exitReason', 'entryPrice', 'slPrice', 'positionSize', 'actualRiskDollar', 'netPnl', 'pnlTheoretical'];
  const rows = replay.trades.map((t) => [
    variant, SCENARIO, 'BACKTEST_PROXY', t.symbol, t.side, t.setupType, t.regime,
    t.entryTimestamp, new Date(t.entryTimestamp).toISOString(), t.exitTimestamp, new Date(t.exitTimestamp).toISOString(),
    t.exitReason, t.entryPriceTheoretical, t.slPrice, t.positionSize, t.actualRiskDollar, pnl(t).toFixed(6), t.pnlUsdTheoretical.toFixed(6),
  ]);
  writeFileSync(path.join(outDir, `${tag}-trades.csv`), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');

  console.log(`${tag}: trades=${m.n} wr=${m.wr.toFixed(2)}% pf=${Number(m.pf).toFixed(4)} net=$${m.netPnl.toFixed(4)} maxDD=${m.maxDdPct.toFixed(2)}% neutralSteps=${counters.neutralSteps} blocked=${counters.blockedSteps} (${summary.runtimeSec}s)`);
  console.log(`  byRegime: ${JSON.stringify(byRegime)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
