/**
 * TICKET-G3 P0 — single-pass entry-decision audit through the FULL orchestrator via the EXISTING
 * T153B/T157/T158/T159/G2R harness (runReplay + makeFillModel + computeMetrics). No new cost engine,
 * no new replay loop, no shortcut DraftSetup evaluation.
 *
 * Everything this script adds is OBSERVABILITY: processCandle()'s own already-existing
 * onFunnelEvent / onMomentumGateEvaluation diagnostic callbacks, plus a shadow-regime step context.
 * The resulting trade ledger is reconciled trade-for-trade against G2R's archived N0_CURRENT/CENTRAL
 * ledger to PROVE (not assert) that enabling the diagnostics changed no decision.
 *
 * Usage: G3_SCENARIO=<FEE_ONLY|LIGHT|CENTRAL|CONSERVATIVE> node g3EntryAudit.js
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineConfig, runReplay, makeFillModel, computeMetrics, type ClosedTrade } from './ticket150BacktestExecutionRealismAudit.js';

const SCENARIO = process.env.G3_SCENARIO ?? 'CENTRAL';
const SCENARIO_BPS: Record<string, [number, number]> = { FEE_ONLY: [0, 0], LIGHT: [1, 1], CENTRAL: [2, 2], CONSERVATIVE: [5, 5] };
if (!(SCENARIO in SCENARIO_BPS)) throw new Error(`G3_SCENARIO must be one of ${Object.keys(SCENARIO_BPS).join('|')}`);
const STOP_STEP = 57833; // identical fixed checkpoint window T153B/T157/T158/T159/G2R all use

/** REAL_LIVE decision timestamps supplied by the operator (see data/g3-live-trade-replay.md). */
const LIVE_TARGETS = [
  { iso: '2026-07-28T13:30:00Z', symbol: 'XRPUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
  { iso: '2026-07-28T14:15:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
  { iso: '2026-07-28T17:30:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
  { iso: '2026-07-29T03:00:00Z', symbol: 'SOLUSDT', side: 'SHORT', reported: 'TREND_RIDER / OB' },
  { iso: '2026-08-08T12:35:00Z', symbol: 'XRPUSDT', side: 'LONG', reported: 'SIDEWAY_SCALPER / BOX_BREAKOUT' },
  { iso: '2026-08-08T12:50:00Z', symbol: 'XRPUSDT', side: 'LONG', reported: 'SIDEWAY_SCALPER / BOX_BREAKOUT' },
].map((t) => ({ ...t, ts: Date.parse(t.iso) }));
const LIVE_TS = new Set(LIVE_TARGETS.map((t) => `${t.symbol}|${t.ts}`));

const OUT = path.resolve(process.cwd(), 'data');
const csvEscape = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file: string, header: string[], rows: unknown[][]): void =>
  writeFileSync(path.join(OUT, file), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');

// ------------------------------------------------------------------ collectors
interface StepCtx { regime: string; adx: string; atrPct: number | undefined; close: number; ts: number; step: number; balance: number }
const stepCtx: Record<string, StepCtx> = {};

/** funnel[regime][stage][passed?reason] = count */
const funnel: Record<string, Record<string, Record<string, number>>> = {};
const bump = (regime: string, stage: string, key: string): void => {
  funnel[regime] = funnel[regime] ?? {};
  funnel[regime][stage] = funnel[regime][stage] ?? {};
  funnel[regime][stage][key] = (funnel[regime][stage][key] ?? 0) + 1;
};
/** SETUP PASS broken down by setupType — the ticket's "candidate count per setup". */
const setupPassByType: Record<string, Record<string, number>> = {};
/** MSS_TIMEOUT lateness samples (candles late), for the dominant-gate forensic. */
const mssTimeoutLate: number[] = [];

interface GateRow { symbol: string; ts: number; side: string; gateType: string; setupType: string; score: number; threshold: number; passed: boolean; entry: number; sl: number; regime: string }
const gateRows: GateRow[] = [];
let gateRowCount = 0;
/** Rejected MOMENTUM_DIRECT candidates — reservoir-sampled ledger for the missed-opportunity file. */
const rejectedMd: GateRow[] = [];
const REJECT_SAMPLE_EVERY = 25;

const skipped: Array<{ symbol: string; ts: number; reason: string; regime: string }> = [];
/** Verbatim decision trace at the REAL_LIVE target timestamps. */
const liveTrace: Record<string, unknown>[] = [];

// TREND_STYLE candidates that reached MSS and were rejected there (the dominant gate).
const mssRejected: Array<{ symbol: string; ts: number; side: string; reason: string; late: number | ''; close: number; atrPct: number | undefined }> = [];
const MSS_SAMPLE_EVERY = 20;
let mssRejSeen = 0;

async function main(): Promise<void> {
  const [slip, spread] = SCENARIO_BPS[SCENARIO];
  const cfg = { ...buildBaselineConfig(), sameSideDuplicateGuardEnabled: true };
  const fillModel = slip === 0 && spread === 0 ? null : makeFillModel(SCENARIO, slip / 10000, spread / 10000);

  let cur: StepCtx | null = null;
  let curSymbol = '';

  const hooks = {
    onStepContext: (c: { symbol: string; step: number; timestamp: number; regime: string; adxDirection1h: string | undefined; atrPercentile5m: number | undefined; candle: { close: number }; accountBalance: number }): void => {
      cur = { regime: String(c.regime), adx: c.adxDirection1h ?? 'UNDEF', atrPct: c.atrPercentile5m, close: c.candle.close, ts: c.timestamp, step: c.step, balance: c.accountBalance };
      curSymbol = c.symbol;
      stepCtx[`${c.symbol}|${c.timestamp}`] = cur;
      bump(String(c.regime), 'STATE_CONFIRMED', 'PASS');
      if (LIVE_TS.has(`${c.symbol}|${c.timestamp}`)) {
        liveTrace.push({ kind: 'STEP', symbol: c.symbol, ts: c.timestamp, iso: new Date(c.timestamp).toISOString(), regime: c.regime, adxDirection1h: c.adxDirection1h ?? 'UNDEFINED', atrPercentile5m: c.atrPercentile5m, close: c.candle.close, step: c.step, shadowBalance: c.accountBalance });
      }
    },
    onFunnelEvent: (symbol: string, timestamp: number, ev: Record<string, unknown>): void => {
      const regime = cur?.regime ?? 'UNKNOWN';
      const stage = String(ev.stage);
      const passed = ev.passed === true;
      bump(regime, stage, passed ? 'PASS' : `FAIL:${String(ev.reason ?? 'NONE')}`);
      if (stage === 'SETUP' && passed) {
        const st = String(ev.setupType);
        setupPassByType[regime] = setupPassByType[regime] ?? {};
        setupPassByType[regime][st] = (setupPassByType[regime][st] ?? 0) + 1;
      }
      if (stage === 'MSS' && !passed) {
        const late = ev.candlesLate === undefined ? '' : Number(ev.candlesLate);
        if (typeof late === 'number') mssTimeoutLate.push(late);
        mssRejSeen++;
        if (mssRejSeen % MSS_SAMPLE_EVERY === 0) {
          mssRejected.push({ symbol, ts: timestamp, side: cur?.adx === 'UP' ? 'LONG' : cur?.adx === 'DOWN' ? 'SHORT' : 'UNKNOWN', reason: String(ev.reason ?? 'NONE'), late, close: cur?.close ?? 0, atrPct: cur?.atrPct });
        }
      }
      if (LIVE_TS.has(`${symbol}|${timestamp}`)) liveTrace.push({ kind: 'FUNNEL', symbol, ts: timestamp, iso: new Date(timestamp).toISOString(), ...ev });
    },
    onMomentumGateEvaluation: (e: Record<string, unknown>): void => {
      gateRowCount++;
      const row: GateRow = {
        symbol: String(e.symbol), ts: Number(e.timestamp), side: String(e.side), gateType: String(e.gateType), setupType: String(e.setupType),
        score: Number(e.score), threshold: Number(e.threshold), passed: e.passed === true,
        entry: Number(e.entryPriceCandidate), sl: Number(e.slPriceCandidate), regime: String(e.regime),
      };
      bump(row.regime, `AI_GATE_${row.gateType}`, row.passed ? 'PASS' : 'FAIL');
      if (row.passed) gateRows.push(row);
      else if (gateRowCount % REJECT_SAMPLE_EVERY === 0) rejectedMd.push(row);
      if (LIVE_TS.has(`${row.symbol}|${row.ts}`)) liveTrace.push({ kind: 'AI_GATE', ...row, iso: new Date(row.ts).toISOString() });
    },
    onSkippedEntry: (c: { symbol: string; timestamp: number; reason: string }): void => {
      skipped.push({ symbol: c.symbol, ts: c.timestamp, reason: c.reason, regime: cur?.regime ?? 'UNKNOWN' });
      if (LIVE_TS.has(`${c.symbol}|${c.timestamp}`)) liveTrace.push({ kind: 'SKIPPED', symbol: c.symbol, ts: c.timestamp, iso: new Date(c.timestamp).toISOString(), reason: c.reason });
    },
  };

  console.log(`G3 entry audit — scenario=${SCENARIO} slip=${slip}bps spread=${spread}bps stopStep=${STOP_STEP}`);
  const started = Date.now();
  const replay = await runReplay(cfg, fillModel, STOP_STEP, hooks as never);
  const pnl = (t: ClosedTrade): number => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
  const m = computeMetrics(replay.trades, pnl, 100);
  console.log(`G3/${SCENARIO}: trades=${m.n} wr=${m.wr.toFixed(4)}% pf=${Number(m.pf).toFixed(10)} net=$${m.netPnl.toFixed(8)} maxDD=${m.maxDdPct.toFixed(6)}% (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(`  funnelEvents(setupPass)=${JSON.stringify(setupPassByType)} gateEvals=${gateRowCount} allowedGate=${gateRows.length} skipped=${skipped.length} liveTraceRows=${liveTrace.length}`);

  mkdirSync(path.join(OUT, 'g3-runs'), { recursive: true });
  writeFileSync(path.join(OUT, 'g3-runs', `G3-${SCENARIO}-summary.json`), JSON.stringify({
    scenario: SCENARIO, tradeSource: 'BACKTEST_PROXY', dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS',
    trades: m.n, winRate: m.wr, profitFactor: m.pf, netPnl: m.netPnl, expectancy: m.expectancy, maxDdPct: m.maxDdPct, maxDdUsd: m.maxDdUsd,
    funnel, setupPassByType, gateEvaluations: gateRowCount, allowedGateCandidates: gateRows.length, skipped: skipped.length,
    mssTimeoutLate: mssTimeoutLate.length === 0 ? null : {
      n: mssTimeoutLate.length, min: Math.min(...mssTimeoutLate), max: Math.max(...mssTimeoutLate),
      median: mssTimeoutLate.slice().sort((a, b) => a - b)[Math.floor(mssTimeoutLate.length / 2)],
    },
    runtimeSec: Math.round((Date.now() - started) / 1000),
  }, null, 2) + '\n');

  // ---- trade ledger (also the attribution source) ----
  writeCsv(`g3-runs/G3-${SCENARIO}-trades.csv`,
    ['scenario', 'tradeSource', 'symbol', 'side', 'setupType', 'regime', 'entryTimestamp', 'entryIso', 'exitTimestamp', 'exitIso', 'exitReason', 'entryPrice', 'slPrice', 'positionSize', 'actualRiskDollar', 'netPnl', 'pnlTheoretical'],
    replay.trades.map((t) => [SCENARIO, 'BACKTEST_PROXY', t.symbol, t.side, t.setupType, t.regime, t.entryTimestamp, new Date(t.entryTimestamp).toISOString(), t.exitTimestamp, new Date(t.exitTimestamp).toISOString(), t.exitReason, t.entryPriceTheoretical, t.slPrice, t.positionSize, t.actualRiskDollar, pnl(t).toFixed(6), t.pnlUsdTheoretical.toFixed(6)]));

  // ---- decision funnel ----
  const funnelRows: unknown[][] = [];
  for (const [regime, stages] of Object.entries(funnel))
    for (const [stage, outcomes] of Object.entries(stages))
      for (const [outcome, count] of Object.entries(outcomes)) funnelRows.push([SCENARIO, regime, stage, outcome, count]);
  writeCsv('g3-decision-funnel.csv', ['scenario', 'regime', 'stage', 'outcome', 'count'], funnelRows);

  // ---- missed-opportunity ledger (rejected candidates, sampled) ----
  writeCsv('g3-missed-opportunity-ledger.csv',
    ['scenario', 'source', 'symbol', 'iso', 'timestamp', 'regime', 'side', 'gate', 'detail', 'refPrice', 'slPrice'],
    [
      ...rejectedMd.map((r) => [SCENARIO, 'MOMENTUM_DIRECT_AI_GATE', r.symbol, new Date(r.ts).toISOString(), r.ts, r.regime, r.side, 'AI_SCORE_BELOW_THRESHOLD', `score=${r.score.toFixed(6)} thr=${r.threshold}`, r.entry, r.sl]),
      ...mssRejected.map((r) => [SCENARIO, 'TREND_STYLE_MSS', r.symbol, new Date(r.ts).toISOString(), r.ts, 'TREND_RIDER', r.side, `MSS_${r.reason}`, `candlesLate=${r.late}`, r.close, '']),
      ...skipped.map((s) => [SCENARIO, 'ADMISSION', s.symbol, new Date(s.ts).toISOString(), s.ts, s.regime, '', s.reason, '', '', '']),
    ]);

  // ---- REAL_LIVE decision-timestamp trace ----
  writeFileSync(path.join(OUT, 'g3-runs', `G3-${SCENARIO}-live-trace.json`), JSON.stringify({ targets: LIVE_TARGETS, trace: liveTrace }, null, 2) + '\n');

  // ---- reconciliation against G2R's archived CENTRAL ledger ----
  if (SCENARIO === 'CENTRAL') {
    const ref = process.env.G3_REF_LEDGER;
    if (ref) {
      const lines = readFileSync(ref, 'utf-8').trim().split('\n').slice(1);
      const refIds = new Set(lines.map((l) => { const p = l.split(','); return `${p[3]}|${p[7]}`; }));
      const mineIds = new Set(replay.trades.map((t) => `${t.symbol}|${t.entryTimestamp}`));
      const missing = [...refIds].filter((k) => !mineIds.has(k));
      const added = [...mineIds].filter((k) => !refIds.has(k));
      console.log(`RECONCILE vs ${ref}: ref=${refIds.size} mine=${mineIds.size} missing=${missing.length} added=${added.length}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
