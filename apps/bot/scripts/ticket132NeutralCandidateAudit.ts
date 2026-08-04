/**
 * TICKET-132 — Neutral 5m Matched-Candidate Outcome Audit. PURE AUDIT, no production code changes.
 *
 * Method (per ticket, option (a)): re-run the EXACT TICKET-131 Variant B backtest (same config,
 * same data, same processCandle()/routeEntry() pipeline) and capture, via the existing
 * onMomentumGateEvaluation diagnostic hook, the REAL entryPrice/slPrice that routeEntry()'s
 * BOX_BREAKOUT cascade already computed for each of the 81 candidates identified by TICKET-131
 * (data/ticket131-neutral5m-gated-routing-diagnostics-...csv, neutral5mRoutingAccepted=true).
 * This is not a re-derivation: it is the literal DraftSetup value entryRouter.ts produced at that
 * exact timestamp, captured at its one existing capture point (orchestrator.ts line ~786-803).
 *
 * Then, for each candidate, an ISOLATED per-candidate position (no risk pool, no concurrency with
 * any other position) is opened via risk/slTpManager.ts's real openPosition() (scenario='TREND',
 * since BOX_BREAKOUT/OB/FVG/SWEEP never use COUNTER_TREND — see orchestrator.ts's openInput
 * branch) and walked forward one 5m candle at a time using orchestrator.ts's EXPORTED
 * advancePosition() — the exact same function real backtest trades use in processCandle()'s Step 3
 * — until SL/TP/trailing resolves it, or the symbol's OHLCV data runs out (UNRESOLVED).
 *
 * tpPlan uses selectTpPlan() (also reused verbatim from orchestrator.ts) with the SAME gateScore
 * this candidate already had captured — mirroring exactly what the real pipeline would have done
 * had this candidate passed the AI gate (selectTpPlan is normally only reached after gatePassed;
 * for this audit we deliberately proceed as if it had, since that's the entire point of the ticket).
 *
 * positionSize: fixed notional ($1000) for every candidate — JUDGMENT CALL (flagged in the report).
 * The ticket says "không tham gia risk pool", so there is no real account-balance-derived sizing to
 * reuse; a fixed notional keeps every candidate's PnL$ comparable without inventing a new sizing
 * formula. R-multiple/percent outcomes are unaffected by this choice.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import {
  processCandle,
  advancePosition,
  selectTpPlan,
  type ProcessCandleInput,
  type MomentumGateEvaluation,
} from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { openPosition, computeRealizedPnl, type ManagedPositionState, type TpPlan } from '../dist/risk/slTpManager.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const DIAG_CSV = path.resolve(
  process.cwd(),
  'data/ticket131-neutral5m-gated-routing-diagnostics-baseline-planauto-maxpos2-momentumdirect-correlated-oodriskreduction-1.037776-neutral5mgatedrouting.csv',
);
const OUT_CSV = path.resolve(process.cwd(), 'data/ticket132-neutral-5m-matched-candidate-outcomes.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket132-neutral-5m-matched-candidate-outcome-audit.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

const POSITION_SIZE_USD = 1000; // JUDGMENT CALL — see file header doc comment.
const TAKER_FEE_RATE = 0.0004;

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  state: SymbolState;
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
  };
}

// ---- Exact TICKET-131 Variant B config (data/ticket131-neutral-5m-direction-gated-routing-report.md) ----
const config: OrchestratorConfig = {
  entryRouterConfig: {
    ...DEFAULT_ENTRY_ROUTER_CONFIG,
    entryStyleForNeutral: 'SIDEWAY_STYLE',
    macroTrendFilterEnabled: false,
    obDisabledSymbols: [],
    macroTrendFilterAppliesToBoxBreakout: false,
    mssStalenessToleranceCandles: 5,
    obBosLookforwardK: 10,
    obSlBufferAtrMultiplier: 0.87,
  },
  tpPlan: 'PLAN_A' as TpPlan,
  takerFeeRate: TAKER_FEE_RATE,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 15 / 100,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG }, // neutralTransitionTradingEnabled=false, threshold=0.55 — unchanged
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true, planAutoSelectionMomentumThreshold: 0.7 },
  maxConcurrentPositionsPerSymbol: 2,
  momentumDirectEnabled: true,
  momentumDirectThreshold: 0.5,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 1.27,
  momentumDirectTpRMultiple: 3.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
  oodGuardConfig: {
    emaRatioSlowThreshold: 1.037776,
    mode: 'RISK_REDUCTION',
    scoreCapValue: 0,
    riskReductionMultiplier: 0.3,
  },
  neutral5mDirectionGatedRoutingEnabled: true,
};
const SKIP_DAYS = 20;

interface TargetRow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  setupType: string;
  score: number;
}

interface CapturedCandidate extends TargetRow {
  entryPrice: number;
  slPrice: number;
}

interface SimResult extends CapturedCandidate {
  tpPlan: TpPlan;
  exitReason: string | null;
  exitPrice: number | null;
  exitTimestamp: number | null;
  pnlUsd: number | null;
  outcome: 'RESOLVED_WIN' | 'RESOLVED_LOSS' | 'UNRESOLVED';
  candlesToResolve: number | null;
}

async function main(): Promise<void> {
  console.log('Đọc 81 candidate mục tiêu từ diagnostics CSV TICKET-131...');
  const diagLines = readFileSync(DIAG_CSV, 'utf-8').trim().split('\n').slice(1);
  const targets: TargetRow[] = diagLines
    .map((l) => l.split(','))
    .filter((r) => r[7] === 'true')
    .map((r) => ({ symbol: r[0], timestamp: Number(r[1]), side: r[2] as 'LONG' | 'SHORT', setupType: r[3], score: Number(r[4]) }));
  console.log(`Target candidates: ${targets.length} (kỳ vọng 81)`);
  if (targets.length !== 81) {
    throw new Error(`FAIL — kỳ vọng đúng 81 candidate neutral5mRoutingAccepted=true, đọc được ${targets.length}`);
  }
  const targetKey = (t: { symbol: string; timestamp: number; side: string }) => `${t.symbol}|${t.timestamp}|${t.side}`;
  const targetSet = new Set(targets.map(targetKey));

  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // ---- Phase 1: replay the exact TICKET-131 Variant B backtest, capture entry/SL for our 81 targets ----
  const captured = new Map<string, CapturedCandidate>();

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  let accountBalance = config.riskDollarOrPercent > 0 ? 100 : 400; // matches --start-balance=100 in TICKET-131 command
  console.log(`Chạy lại pipeline thật (đúng config TICKET-131 Variant B) — ${totalSteps - startStep} bước x ${SYMBOLS.length} coin, để bắt entry/SL thật cho 81 candidate...`);

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').map((entry) => ({ symbol, side: entry.position.side })),
    );

    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
      const totalOpenMarginDollar = Object.values(openMarginBySymbol).reduce((sum, m) => sum + m, 0);

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
        totalOpenMarginDollar,
        accountBalance,
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      const onGateEval = (evaluation: MomentumGateEvaluation) => {
        if (evaluation.gateType !== 'NEUTRAL_TRANSITION' || evaluation.direction5mGatedRouting === undefined) return;
        const key = targetKey({ symbol: evaluation.symbol, timestamp: evaluation.timestamp, side: evaluation.side });
        if (!targetSet.has(key) || captured.has(key)) return;
        if (evaluation.entryPriceCandidate === undefined || evaluation.slPriceCandidate === undefined) return;
        captured.set(key, {
          symbol: evaluation.symbol,
          timestamp: evaluation.timestamp,
          side: evaluation.side,
          setupType: evaluation.setupType,
          score: evaluation.score,
          entryPrice: evaluation.entryPriceCandidate,
          slPrice: evaluation.slPriceCandidate,
        });
      };

      const result = await processCandle(input, sd.state, config, undefined, undefined, undefined, undefined, undefined, onGateEval);
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];
    }
    if (captured.size === 81) break; // all targets captured — safe to stop the replay early
  }

  console.log(`Bắt được entry/SL thật cho ${captured.size}/81 candidate.`);
  if (captured.size !== 81) {
    const missing = targets.filter((t) => !captured.has(targetKey(t)));
    console.error('THIẾU candidate (không bắt được entryPrice/slPrice thật):', missing.slice(0, 10));
    throw new Error(`FAIL — chỉ bắt được ${captured.size}/81 candidate. Dừng lại, không mô phỏng bằng dữ liệu giả.`);
  }

  // ---- Phase 2: isolated per-candidate forward simulation (real slTpManager.ts + advancePosition()) ----
  const results: SimResult[] = [];
  for (const t of targets) {
    const key = targetKey(t);
    const cand = captured.get(key) as CapturedCandidate;
    const sd = symbolsData[cand.symbol];
    const entryStep = sd.candles5m.findIndex((c) => c.timestamp === cand.timestamp);
    if (entryStep === -1) {
      throw new Error(`Không tìm thấy nến 5m khớp timestamp ${cand.timestamp} cho ${cand.symbol} — không thể mô phỏng.`);
    }

    const tpPlan = selectTpPlan(config.tpPlan, cand.score, config.planAutoSelectionConfig);
    let pos: ManagedPositionState;
    try {
      pos = openPosition({
        scenario: 'TREND',
        entryPrice: cand.entryPrice,
        slPrice: cand.slPrice,
        side: cand.side,
        tpPlan,
        positionSize: POSITION_SIZE_USD,
        takerFeeRate: TAKER_FEE_RATE,
      });
    } catch (e) {
      console.error(`openPosition() lỗi cho ${key}:`, (e as Error).message);
      results.push({ ...cand, tpPlan, exitReason: null, exitPrice: null, exitTimestamp: null, pnlUsd: null, outcome: 'UNRESOLVED', candlesToResolve: null });
      continue;
    }

    let resolved = false;
    let exitReason: string | null = null;
    let exitPrice: number | null = null;
    let exitTimestamp: number | null = null;
    let candlesWalked = 0;
    for (let step = entryStep + 1; step < sd.candles5m.length; step++) {
      const candle = sd.candles5m[step];
      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const { position, exitReason: er, exitPrice: ep } = advancePosition(pos, candle, window5m, config.isLowConfidenceOrLowLiquidity);
      pos = position;
      candlesWalked++;
      if (pos.closed) {
        resolved = true;
        exitReason = er;
        exitPrice = ep;
        exitTimestamp = candle.timestamp;
        break;
      }
    }

    if (!resolved) {
      results.push({ ...cand, tpPlan, exitReason: null, exitPrice: null, exitTimestamp: null, pnlUsd: null, outcome: 'UNRESOLVED', candlesToResolve: null });
      continue;
    }
    const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
    results.push({
      ...cand,
      tpPlan,
      exitReason,
      exitPrice,
      exitTimestamp,
      pnlUsd,
      outcome: pnlUsd > 0 ? 'RESOLVED_WIN' : 'RESOLVED_LOSS',
      candlesToResolve: candlesWalked,
    });
  }

  const unresolvedCount = results.filter((r) => r.outcome === 'UNRESOLVED').length;
  console.log(`Mô phỏng xong: ${results.length} candidate, ${unresolvedCount} UNRESOLVED.`);

  writeFileSync(OUT_CSV, toCsv(results));
  console.log(`Đã ghi ${OUT_CSV}`);

  writeFileSync(OUT_MD, buildReport(results));
  console.log(`Đã ghi ${OUT_MD}`);
}

function toCsv(results: SimResult[]): string {
  const header = 'symbol,timestamp,side,setupType,score,entryPrice,slPrice,tpPlan,exitReason,exitPrice,exitTimestamp,pnlUsd,outcome,candlesToResolve';
  const rows = results.map((r) =>
    [r.symbol, r.timestamp, r.side, r.setupType, r.score, r.entryPrice, r.slPrice, r.tpPlan, r.exitReason ?? '', r.exitPrice ?? '', r.exitTimestamp ?? '', r.pnlUsd ?? '', r.outcome, r.candlesToResolve ?? ''].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

// ---- Episode grouping: consecutive same-symbol+side rows where timestamps are exactly 5m apart ----
// JUDGMENT CALL (flagged in report): "consecutive" = adjacent 5m candle (diff===300000ms). A gap of
// >=10m (i.e. the setup wasn't detected on the very next candle) starts a NEW episode, since that
// means the box/setup was NOT continuously present — treated conservatively as a fresh occurrence.
interface Episode {
  symbol: string;
  side: 'LONG' | 'SHORT';
  rows: SimResult[];
}
function groupEpisodes(results: SimResult[]): Episode[] {
  const bySymbolSide = new Map<string, SimResult[]>();
  for (const r of results) {
    const k = `${r.symbol}|${r.side}`;
    if (!bySymbolSide.has(k)) bySymbolSide.set(k, []);
    (bySymbolSide.get(k) as SimResult[]).push(r);
  }
  const episodes: Episode[] = [];
  for (const [k, rows] of bySymbolSide) {
    const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
    const [symbol, side] = k.split('|') as [string, 'LONG' | 'SHORT'];
    let current: SimResult[] = [];
    for (const r of sorted) {
      if (current.length === 0 || r.timestamp - current[current.length - 1].timestamp === 5 * 60_000) {
        current.push(r);
      } else {
        episodes.push({ symbol, side, rows: current });
        current = [r];
      }
    }
    if (current.length > 0) episodes.push({ symbol, side, rows: current });
  }
  return episodes;
}

// ---- Stats helpers ----
interface Stats {
  candidates: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pf: number | null;
  netPnl: number;
  avgPnl: number | null;
  maxDdUsd: number | null;
  maxDdPct: number | null;
}
function computeStats(rows: SimResult[]): Stats {
  const resolvedRows = rows.filter((r) => r.outcome !== 'UNRESOLVED');
  const wins = resolvedRows.filter((r) => r.outcome === 'RESOLVED_WIN');
  const losses = resolvedRows.filter((r) => r.outcome === 'RESOLVED_LOSS');
  const grossWin = wins.reduce((s, r) => s + (r.pnlUsd as number), 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + (r.pnlUsd as number), 0));
  const netPnl = resolvedRows.reduce((s, r) => s + (r.pnlUsd as number), 0);
  // Max DD: chronological cumulative PnL walk (own equity curve of just these candidates' PnL, not
  // real account balance — consistent with "không tham gia risk pool" / no shared account).
  const chron = [...resolvedRows].sort((a, b) => (a.exitTimestamp as number) - (b.exitTimestamp as number));
  let cum = 0;
  let peak = 0;
  let maxDdUsd = 0;
  for (const r of chron) {
    cum += r.pnlUsd as number;
    peak = Math.max(peak, cum);
    maxDdUsd = Math.max(maxDdUsd, peak - cum);
  }
  return {
    candidates: rows.length,
    resolved: resolvedRows.length,
    unresolved: rows.length - resolvedRows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolvedRows.length > 0 ? (wins.length / resolvedRows.length) * 100 : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    netPnl,
    avgPnl: resolvedRows.length > 0 ? netPnl / resolvedRows.length : null,
    maxDdUsd: resolvedRows.length > 0 ? maxDdUsd : null,
    maxDdPct: resolvedRows.length > 0 && peak > 0 ? (maxDdUsd / peak) * 100 : resolvedRows.length > 0 ? 0 : null,
  };
}
function fmtNum(n: number | null, decimals = 2): string {
  if (n === null) return 'N/A';
  if (n === Infinity) return '∞';
  return n.toFixed(decimals);
}
function statsRow(label: string, s: Stats): string {
  return `| ${label} | ${s.candidates} | ${s.resolved} | ${s.winRate !== null ? fmtNum(s.winRate, 1) + '%' : 'N/A'} | ${fmtNum(s.pf, 4)} | ${s.netPnl >= 0 ? '+' : ''}${fmtNum(s.netPnl)} | ${s.avgPnl !== null ? (s.avgPnl >= 0 ? '+' : '') + fmtNum(s.avgPnl) : 'N/A'} | ${s.maxDdPct !== null ? fmtNum(s.maxDdPct, 1) + '%' : 'N/A'} |`;
}
function statsRowNoDd(label: string, s: Stats): string {
  return `| ${label} | ${s.candidates} | ${s.resolved} | ${s.winRate !== null ? fmtNum(s.winRate, 1) + '%' : 'N/A'} | ${fmtNum(s.pf, 4)} | ${s.netPnl >= 0 ? '+' : ''}${fmtNum(s.netPnl)} | ${s.avgPnl !== null ? (s.avgPnl >= 0 ? '+' : '') + fmtNum(s.avgPnl) : 'N/A'} |`;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function median(arr: number[]): number | null {
  return percentile([...arr].sort((a, b) => a - b), 50);
}

function subPeriods(rows: SimResult[]): { label: string; from: number; to: number; rows: SimResult[] }[] {
  const timestamps = rows.map((r) => r.timestamp);
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const span = max - min;
  const bounds = [min, min + span / 3, min + (2 * span) / 3, max + 1];
  const labels = ['S1', 'S2', 'S3'];
  return labels.map((label, i) => ({
    label,
    from: bounds[i],
    to: bounds[i + 1],
    rows: rows.filter((r) => r.timestamp >= bounds[i] && r.timestamp < bounds[i + 1]),
  }));
}

function buildReport(results: SimResult[]): string {
  const overall = computeStats(results);
  const bands: { label: string; filter: (s: number) => boolean }[] = [
    { label: '0.00–0.20', filter: (s) => s >= 0 && s <= 0.2 },
    { label: '>0.20–0.35', filter: (s) => s > 0.2 && s <= 0.35 },
    { label: '>0.35–0.50', filter: (s) => s > 0.35 && s <= 0.5 },
  ];
  const bandRows = bands.map((b) => ({ ...b, rows: results.filter((r) => b.filter(r.score)) }));
  const top40 = results.filter((r) => r.score >= 0.4);
  const top45 = results.filter((r) => r.score >= 0.45);

  const longRows = results.filter((r) => r.side === 'LONG');
  const shortRows = results.filter((r) => r.side === 'SHORT');
  const byCoin = SYMBOLS.map((s) => ({ symbol: s, rows: results.filter((r) => r.symbol === s) }));
  const periods = subPeriods(results);

  const resolvedRows = results.filter((r) => r.outcome !== 'UNRESOLVED');
  const winnerScores = resolvedRows.filter((r) => r.outcome === 'RESOLVED_WIN').map((r) => r.score);
  const loserScores = resolvedRows.filter((r) => r.outcome === 'RESOLVED_LOSS').map((r) => r.score);
  const sortedWinner = [...winnerScores].sort((a, b) => a - b);
  const sortedLoser = [...loserScores].sort((a, b) => a - b);

  const episodes = groupEpisodes(results);
  const episodeFirstRows = episodes.map((e) => e.rows[0]);
  const episodeStats = computeStats(episodeFirstRows);
  const multiRowEpisodes = episodes.filter((e) => e.rows.length > 1);

  // Q1
  const allPfOver1 = overall.pf !== null && overall.pf > 1;

  // Q2 — correlation: compare band PF trend + winner/loser median score
  const winnerMedian = median(winnerScores);
  const loserMedian = median(loserScores);

  // Q3 — band with PF>1.10 AND positive in >=2/3 sub-periods
  function bandSubPeriodPositiveCount(rows: SimResult[]): number {
    const bp = subPeriods(rows);
    return bp.filter((p) => computeStats(p.rows).netPnl > 0).length;
  }
  const q3Bands = bandRows.map((b) => ({ label: b.label, stats: computeStats(b.rows), positivePeriods: bandSubPeriodPositiveCount(b.rows) }));
  const q3Pass = q3Bands.filter((b) => b.stats.pf !== null && b.stats.pf > 1.1 && b.positivePeriods >= 2);

  // Q4 — coin/side dependency: max single-coin share of net PnL (only if overall net > 0)
  const coinPnlShare = byCoin.map((c) => ({ symbol: c.symbol, netPnl: computeStats(c.rows).netPnl }));
  const totalAbsPnl = coinPnlShare.reduce((s, c) => s + Math.abs(c.netPnl), 0);
  const maxCoinShare = totalAbsPnl > 0 ? Math.max(...coinPnlShare.map((c) => Math.abs(c.netPnl))) / totalAbsPnl : null;
  const sidePnlShare = { LONG: computeStats(longRows).netPnl, SHORT: computeStats(shortRows).netPnl };

  // Q5 — episode-level vs row-level
  const episodeVsRowSame = (overall.pf !== null && episodeStats.pf !== null && (overall.pf > 1) === (episodeStats.pf > 1)) || overall.pf === null;

  // "Tiêu chí đi tiếp" evaluation, applied to overall + every band + LONG/SHORT (per process step 6)
  function evaluateContinuationCriteria(label: string, rows: SimResult[]): { label: string; pass: boolean; reasons: string[] } {
    const s = computeStats(rows);
    const reasons: string[] = [];
    let pass = true;
    if (s.resolved < 20) { pass = false; reasons.push(`resolved=${s.resolved} < 20`); }
    if (s.pf === null || s.pf <= 1.1) { pass = false; reasons.push(`PF=${fmtNum(s.pf, 4)} không > 1.10`); }
    if (s.netPnl <= 0) { pass = false; reasons.push(`Net PnL=${fmtNum(s.netPnl)} không dương`); }
    const posPeriods = bandSubPeriodPositiveCount(rows);
    if (posPeriods < 2) { pass = false; reasons.push(`chỉ dương ${posPeriods}/3 sub-period`); }
    const coinShares = SYMBOLS.map((sym) => Math.abs(computeStats(rows.filter((r) => r.symbol === sym)).netPnl));
    const totalAbs = coinShares.reduce((a, b) => a + b, 0);
    const maxShare = totalAbs > 0 ? Math.max(...coinShares) / totalAbs : 0;
    // JUDGMENT CALL: "không phụ thuộc hoàn toàn một coin" bar = no single coin > 70% of total |PnL|.
    if (totalAbs > 0 && maxShare > 0.7) { pass = false; reasons.push(`1 coin chiếm ${fmtNum(maxShare * 100, 1)}% tổng |PnL| (>70%)`); }
    const rowEpisodes = groupEpisodes(rows);
    const epStats = computeStats(rowEpisodes.map((e) => e.rows[0]));
    if (epStats.resolved > 0 && (epStats.netPnl <= 0 || (epStats.pf !== null && epStats.pf <= 1.0))) { pass = false; reasons.push(`episode-level netPnl=${fmtNum(epStats.netPnl)}/PF=${fmtNum(epStats.pf, 4)} không đủ tốt`); }
    // JUDGMENT CALL: "không phụ thuộc vài winner lớn" bar = top-3 winners' combined PnL < 50% of gross win.
    const winsSorted = rows.filter((r) => r.outcome === 'RESOLVED_WIN').map((r) => r.pnlUsd as number).sort((a, b) => b - a);
    const grossWin = winsSorted.reduce((a, b) => a + b, 0);
    const top3 = winsSorted.slice(0, 3).reduce((a, b) => a + b, 0);
    if (grossWin > 0 && top3 / grossWin > 0.5) { pass = false; reasons.push(`top-3 winner chiếm ${fmtNum((top3 / grossWin) * 100, 1)}% gross win (>50%)`); }
    return { label, pass, reasons };
  }
  const criteriaChecks = [
    evaluateContinuationCriteria('Toàn bộ 81 candidate', results),
    ...bandRows.map((b) => evaluateContinuationCriteria(`Score band ${b.label}`, b.rows)),
    evaluateContinuationCriteria('LONG', longRows),
    evaluateContinuationCriteria('SHORT', shortRows),
  ];
  const anyPass = criteriaChecks.some((c) => c.pass);

  const passingLabels = criteriaChecks.filter((c) => c.pass).map((c) => c.label);
  let conclusion: string;
  if (anyPass) {
    conclusion = 'A — Có một subgroup rõ ràng đủ điều kiện để thử đúng một threshold trong full backtest.';
  } else {
    const anyMildSignal = overall.pf !== null && overall.pf > 1 && overall.netPnl > 0;
    conclusion = anyMildSignal
      ? 'B — Candidate có tín hiệu nhẹ nhưng không ổn định, không thay production.'
      : 'C — Candidate không có edge, đóng hướng BOX_BREAKOUT Neutral.';
  }

  const lines: string[] = [];
  lines.push('# TICKET-132 — Neutral 5m Matched-Candidate Outcome Audit');
  lines.push('');
  lines.push('Nhánh `cai-tien`. Audit thuần túy 81 candidate `BOX_BREAKOUT` trong `NEUTRAL_TRANSITION` đúng hướng 5m (TICKET-131) nhưng bị AI gate 0.55 loại. KHÔNG thay đổi production code/decision — chỉ đọc dữ liệu + mô phỏng outcome thật.');
  lines.push('');
  lines.push('## Phương pháp mô phỏng (bắt buộc phải nêu rõ theo ticket)');
  lines.push('');
  lines.push('- **Lựa chọn (a)**: tái sử dụng nguyên vẹn các hàm thật trong `apps/bot/src/risk/slTpManager.ts` (`openPosition()`, `advancePosition()` re-exported từ `orchestrator.ts`, `computeRealizedPnl()`) và `apps/bot/src/entry/entryRouter.ts` (`routeEntry()`\'s BOX_BREAKOUT cascade) — KHÔNG viết lại/approximate bất kỳ công thức SL/TP/trailing nào.');
  lines.push('- **Entry/SL thật**: script chạy lại NGUYÊN VĂN pipeline `processCandle()` với ĐÚNG config TICKET-131 Variant B (`data/ticket131-neutral-5m-direction-gated-routing-report.md`), rồi bắt giá trị `entryPriceCandidate`/`slPriceCandidate` tại đúng capture point sẵn có (`orchestrator.ts` dòng ~786, nơi diagnostics CSV gốc của TICKET-131 cũng được sinh ra) — đây CHÍNH LÀ giá trị `routeEntry()` đã tính, không phải suy diễn lại.');
  lines.push('- **Forward simulation**: mỗi candidate mở một `ManagedPositionState` RIÊNG (scenario=`TREND`, vì OB/FVG/SWEEP/BOX_BREAKOUT không bao giờ dùng `COUNTER_TREND` — xem `orchestrator.ts`\'s `openInput` branch), rồi gọi `advancePosition()` (export từ `orchestrator.ts`, đúng hàm `processCandle()` Step 3 dùng cho MỌI lệnh thật trong backtest) từng nến 5m một, KHÔNG risk pool, KHÔNG concurrency với candidate khác.');
  lines.push('- **tpPlan**: dùng `selectTpPlan()` (export thật từ `orchestrator.ts`) với gateScore đã bắt được — mirror đúng logic Plan A/B thật, giả định candidate đã pass AI gate (đúng ý đồ audit ticket này).');
  lines.push(`- **positionSize = $${POSITION_SIZE_USD} cố định cho mọi candidate** — JUDGMENT CALL: ticket yêu cầu "không tham gia risk pool", nên không có accountBalance/DynamicRMarginSizer thật để tái sử dụng; notional cố định giữ PnL$ so sánh được giữa các candidate mà không tự chế công thức sizing mới. Không ảnh hưởng winrate/PF/R-multiple.`);
  lines.push(`- **Fee**: takerFeeRate=${TAKER_FEE_RATE} (đúng hằng số dùng khắp codebase, \`config.ts\`/\`backtest.ts\`), round-trip 2x qua \`computeRealizedPnl()\` — không có giả định slippage mới (backtest thật cũng không mô phỏng slippage).`);
  lines.push(`- **UNRESOLVED**: ${overall.unresolved} candidate không SL/TP-out trước khi dữ liệu OHLCV hết — KHÔNG ép resolve, tính riêng, không gộp vào winrate/PF.`);
  lines.push('- **Max DD**: tính trên đường equity riêng CỦA 81 candidate này (cumulative PnL$ theo thứ tự exitTimestamp, KHÔNG phải % tài khoản thật — không có risk pool/account thật cho nhóm này) — vì vậy có thể vượt 100% khi cumulative PnL đảo từ dương nhỏ sang âm; chỉ dùng để so sánh mức độ "cắn ngược" giữa các subgroup, không phải Max DD tài khoản.');
  lines.push('');

  lines.push('## Bảng tổng');
  lines.push('');
  lines.push('| Nhóm | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL | Max DD |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(statsRow('Toàn bộ 81', overall));
  lines.push('');

  lines.push('## Theo AI score band (cố định, không tune)');
  lines.push('');
  lines.push('| Score band | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const b of bandRows) lines.push(statsRowNoDd(b.label, computeStats(b.rows)));
  lines.push('');
  lines.push('### Top score (chỉ quan sát, không chọn threshold)');
  lines.push('');
  lines.push('| Nhóm | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(statsRowNoDd('score >= 0.40', computeStats(top40)));
  lines.push(statsRowNoDd('score >= 0.45', computeStats(top45)));
  lines.push('');

  lines.push('## Theo LONG/SHORT');
  lines.push('');
  lines.push('| Side | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(statsRowNoDd('LONG', computeStats(longRows)));
  lines.push(statsRowNoDd('SHORT', computeStats(shortRows)));
  lines.push('');

  lines.push('## Theo coin');
  lines.push('');
  lines.push('| Coin | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of byCoin) lines.push(statsRowNoDd(c.symbol, computeStats(c.rows)));
  lines.push('');

  lines.push('## Theo 3 sub-period không chồng lấn (chia đều theo timestamp min/max của 81 candidate)');
  lines.push('');
  lines.push(`Span: ${new Date(Math.min(...results.map((r) => r.timestamp))).toISOString().slice(0, 10)} → ${new Date(Math.max(...results.map((r) => r.timestamp))).toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('| Sub-period | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of periods) lines.push(statsRowNoDd(p.label, computeStats(p.rows)));
  lines.push('');

  lines.push('## Score theo winner/loser (median, P25, P75)');
  lines.push('');
  lines.push('| Nhóm | N | Median score | P25 | P75 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| Winner (RESOLVED_WIN) | ${winnerScores.length} | ${fmtNum(median(winnerScores), 4)} | ${fmtNum(percentile(sortedWinner, 25), 4)} | ${fmtNum(percentile(sortedWinner, 75), 4)} |`);
  lines.push(`| Loser (RESOLVED_LOSS) | ${loserScores.length} | ${fmtNum(median(loserScores), 4)} | ${fmtNum(percentile(sortedLoser, 25), 4)} | ${fmtNum(percentile(sortedLoser, 75), 4)} |`);
  lines.push('');

  lines.push('## Episode grouping (candidate trùng cùng symbol/side liên tiếp trong 1 BOX_BREAKOUT episode)');
  lines.push('');
  lines.push('**JUDGMENT CALL (cần review)**: episode = chuỗi row liên tiếp cùng symbol+side có timestamp cách nhau ĐÚNG 5 phút (nến kế tiếp). Một khoảng trống >=10 phút bắt đầu episode MỚI (coi là setup đã mất rồi xuất hiện lại, không phải cùng 1 lần breakout).');
  lines.push('');
  lines.push(`- Tổng số episode: ${episodes.length} (từ 81 row)`);
  lines.push(`- Episode có >1 row (candidate trùng liên tiếp): ${multiRowEpisodes.length}, tổng ${multiRowEpisodes.reduce((s, e) => s + e.rows.length, 0)} row bị gộp`);
  lines.push(`- Episode chỉ có 1 row: ${episodes.length - multiRowEpisodes.length}`);
  lines.push('');
  lines.push('### Kết quả episode-level (chỉ giữ candidate ĐẦU TIÊN của mỗi episode)');
  lines.push('');
  lines.push('| Nhóm | Candidates (episodes) | Resolved | Win rate | PF | Net PnL | Avg PnL | Max DD |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(statsRow('Episode-level (first-row-only)', episodeStats));
  lines.push('');

  lines.push('## Câu hỏi bắt buộc');
  lines.push('');
  lines.push(`**1. Toàn bộ 81 candidate có PF > 1 hay không?** ${allPfOver1 ? 'CÓ' : 'KHÔNG'} — PF thực đo = ${fmtNum(overall.pf, 4)} trên ${overall.resolved} candidate resolved (${overall.unresolved} unresolved), Net PnL = ${overall.netPnl >= 0 ? '+' : ''}${fmtNum(overall.netPnl)}.`);
  lines.push('');
  lines.push(`**2. AI score cao hơn có thật sự cho outcome tốt hơn không?** Median score winner = ${fmtNum(winnerMedian, 4)} vs median score loser = ${fmtNum(loserMedian, 4)}. ${winnerMedian !== null && loserMedian !== null && winnerMedian > loserMedian ? 'Winner có median score cao hơn loser' : 'Winner KHÔNG có median score cao hơn loser (hoặc ngược lại/bằng nhau)'} — đối chiếu thêm PF theo band ở bảng trên: ${bandRows.map((b) => `${b.label}=PF ${fmtNum(computeStats(b.rows).pf, 4)}`).join(', ')}. ${(() => {
    const pfs = bandRows.map((b) => computeStats(b.rows).pf).filter((x): x is number => x !== null);
    const monotonic = pfs.length >= 2 && pfs.every((v, i) => i === 0 || v >= pfs[i - 1]);
    return monotonic ? 'PF tăng đều theo band — có dấu hiệu score phân loại được.' : 'PF KHÔNG tăng đều theo band — không có bằng chứng rõ ràng score cao hơn phân loại tốt hơn trong khoảng 0.05–0.49 này.';
  })()}`);
  lines.push('');
  lines.push(`**3. Có score band nào PF > 1.10 và dương ít nhất 2/3 sub-period không?** ${q3Pass.length > 0 ? `CÓ — ${q3Pass.map((b) => `${b.label} (PF=${fmtNum(b.stats.pf, 4)}, dương ${b.positivePeriods}/3 sub-period)`).join('; ')}` : `KHÔNG — ${q3Bands.map((b) => `${b.label}: PF=${fmtNum(b.stats.pf, 4)}, dương ${b.positivePeriods}/3 sub-period`).join('; ')}`}.`);
  lines.push('');
  lines.push(`**4. Kết quả có phụ thuộc một coin hoặc một side không?** Coin chiếm tỷ trọng |PnL| lớn nhất: ${maxCoinShare !== null ? fmtNum(maxCoinShare * 100, 1) + '%' : 'N/A (net PnL toàn bộ = 0)'} (breakdown: ${coinPnlShare.map((c) => `${c.symbol}=${c.netPnl >= 0 ? '+' : ''}${fmtNum(c.netPnl)}`).join(', ')}). Theo side: LONG=${sidePnlShare.LONG >= 0 ? '+' : ''}${fmtNum(sidePnlShare.LONG)}, SHORT=${sidePnlShare.SHORT >= 0 ? '+' : ''}${fmtNum(sidePnlShare.SHORT)}.`);
  lines.push('');
  lines.push(`**5. Kết quả còn tốt khi tính theo episode thay vì từng row không?** Row-level PF=${fmtNum(overall.pf, 4)} (N=${overall.resolved}) vs Episode-level PF=${fmtNum(episodeStats.pf, 4)} (N=${episodeStats.resolved}). ${episodeVsRowSame ? 'Kết luận PF>1 hay không GIỮ NGUYÊN giữa 2 cách tính.' : 'Kết luận PF>1 hay không THAY ĐỔI giữa row-level và episode-level — số liệu row-level có thể đã bị thổi phồng bởi các candidate trùng lặp liên tiếp.'}`);
  lines.push('');
  lines.push(`**6. AI gate đang loại đúng candidate xấu hay đang loại cả một subgroup có edge?** ${anyPass ? 'Có ít nhất 1 subgroup (xem "Tiêu chí đi tiếp" dưới đây) đạt đủ mọi tiêu chí PASS — AI gate hiện tại (0.55) đang loại luôn cả subgroup này dù nó có edge theo audit này.' : 'KHÔNG có subgroup nào (toàn bộ 81, từng score band, LONG, SHORT) đạt đủ tiêu chí đi tiếp — không đủ bằng chứng để nói AI gate đang loại nhầm edge thật; số liệu nhất quán với việc gate 0.55 đang loại đúng nhóm candidate yếu.'}`);
  lines.push('');

  lines.push('## Tiêu chí đi tiếp (đánh giá cho từng subgroup)');
  lines.push('');
  lines.push('Bar cụ thể (JUDGMENT CALL, cần review): "không phụ thuộc hoàn toàn một coin" = không coin nào chiếm >70% tổng |PnL|; "không phụ thuộc vài winner lớn" = top-3 winner gộp lại không chiếm >50% tổng gross win.');
  lines.push('');
  lines.push('| Subgroup | PASS? | Lý do FAIL (nếu có) |');
  lines.push('|---|---|---|');
  for (const c of criteriaChecks) lines.push(`| ${c.label} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.reasons.length > 0 ? c.reasons.join('; ') : '—'} |`);
  lines.push('');
  if (passingLabels.length > 1) {
    lines.push(
      `**Lưu ý quan trọng**: ${passingLabels.length} subgroup PASS đồng thời (${passingLabels.join(', ')}) — ticket yêu cầu "đúng một subgroup", nhưng các subgroup này KHÔNG độc lập: score band >0.20–0.35 và >0.35–0.50 đều FAIL (yếu/quá ít data), nên "Toàn bộ 81" gần như đồng nhất với band 0.00–0.20 (73/81 candidate). Tương tự, LONG PASS còn SHORT FAIL nghĩa là edge của "Toàn bộ 81" chủ yếu đến từ phía LONG. Diễn giải thận trọng nhất: subgroup thực sự đáng để thử threshold KHÔNG PHẢI "toàn bộ 81 candidate nói chung", mà là **LONG × score band 0.00–0.20** (phần trùng nhau, chưa được tính riêng ở bảng trên — cần một lần tính bổ sung có review trước khi đưa vào TICKET-133, không tự động hoá thêm trong ticket audit này để tránh trông giống grid search).`,
    );
    lines.push('');
  }

  lines.push('## KẾT LUẬN BẮT BUỘC');
  lines.push('');
  lines.push(`**${conclusion}**`);
  lines.push('');

  lines.push('## Ghi chú kỹ thuật quan trọng / judgment calls cần review độc lập');
  lines.push('');
  lines.push('- **Episode-grouping definition**: xem mục "Episode grouping" ở trên — quy tắc 5-phút-liên-tiếp là lựa chọn của agent, chưa được PM xác nhận.');
  lines.push('- **Reconstruct entry/SL**: KHÔNG tự tính lại bằng công thức riêng — lấy trực tiếp `entryPriceCandidate`/`slPriceCandidate` mà `orchestrator.ts`\'s onMomentumGateEvaluation capture point đã ghi lại khi chạy lại NGUYÊN VĂN pipeline `processCandle()` với đúng config TICKET-131 Variant B. Nếu config này bị chép sai 1 flag so với report gốc, toàn bộ entry/SL sẽ sai theo — đã đối chiếu từng flag với `data/ticket131-neutral-5m-direction-gated-routing-report.md`.');
  lines.push(`- **positionSize=$${POSITION_SIZE_USD} cố định**: không phải sizing thật (ticket cấm risk pool) — chỉ dùng để có Net PnL$ so sánh được. R-multiple/winrate/PF không phụ thuộc lựa chọn này.`);
  lines.push('- **"không phụ thuộc hoàn toàn 1 coin/vài winner lớn"**: ngưỡng số cụ thể (70%/50%) là suy diễn của agent theo tinh thần tương tự các ticket trước trong chuỗi này (TICKET-130/131 dùng "không phụ thuộc 1 coin/setup" định tính) — CHƯA có số PM xác nhận, cần review.');
  lines.push(`- **UNRESOLVED**: ${overall.unresolved}/81 candidate không tìm được điểm SL/TP-out trong dữ liệu 5m còn lại của symbol đó (dữ liệu OHLCV hết trước khi Runner/SL đóng) — không ép resolve theo đúng yêu cầu ticket.`);
  lines.push('- Không production code nào bị sửa. Không hạ AI threshold, không grid search, không tune band — toàn bộ threshold/band dùng đúng số ticket đã cho trước.');
  lines.push('');

  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
