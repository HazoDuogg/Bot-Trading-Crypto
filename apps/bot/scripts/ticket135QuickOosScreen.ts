/**
 * TICKET-135 — Quick OOS screen for Neutral BOX_BREAKOUT LONG. PURE AUDIT, no production changes.
 *
 * Same methodology as TICKET-132/133 (data/ticket132-neutral-5m-matched-candidate-outcome-audit.md,
 * apps/bot/scripts/ticket132NeutralCandidateAudit.ts), pointed at a FRESH out-of-sample OHLCV slice
 * (data/ohlcv-oos-2025q4/, 2025-11-01 → 2026-01-17, fetched by this ticket, never overlapping
 * data/ohlcv/ which starts 2026-01-18): re-run the EXACT TICKET-131 Variant B config's
 * processCandle()/routeEntry() pipeline, capture entryPriceCandidate/slPriceCandidate at the existing
 * onMomentumGateEvaluation diagnostic hook (orchestrator.ts ~line 786) for candidates matching
 * gateType='NEUTRAL_TRANSITION', setupType='BOX_BREAKOUT', side='LONG', neutral5mRoutingAccepted=true
 * (i.e. actually accepted through TICKET-131's Direction-5m-Gated Routing), score<=0.20. Unlike
 * TICKET-132 (which replayed against a pre-known 81-candidate target list from a diagnostics CSV),
 * this OOS data has no such pre-existing list — every matching candidate the live replay produces is
 * captured directly at the hook, single pass.
 *
 * Then, for each captured candidate, an ISOLATED per-candidate position (no risk pool, no concurrency)
 * is opened via risk/slTpManager.ts's real openPosition() (scenario='TREND') and walked forward one 5m
 * candle at a time via orchestrator.ts's EXPORTED advancePosition() until SL/TP/trailing resolves it,
 * or data runs out (UNRESOLVED). tpPlan via selectTpPlan() (also reused verbatim) with the captured
 * gateScore. positionSize: fixed $1000 notional (same JUDGMENT CALL as TICKET-132 — no risk pool in
 * scope). Fee: takerFeeRate=0.0004, same convention as baseline/TICKET-132.
 *
 * EXACTLY ONE subgroup — no SHORT, no other score band, no other regime/setupType, no threshold tuning.
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
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv-oos-2025q4'); // TICKET-135 — separate OOS slice, never data/ohlcv/
const OUT_CSV = path.resolve(process.cwd(), 'data/ticket135-neutral-box-breakout-long-quick-oos-screen.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket135-neutral-box-breakout-long-quick-oos-screen.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

const POSITION_SIZE_USD = 1000; // JUDGMENT CALL — same as TICKET-132, see file header doc comment.
const TAKER_FEE_RATE = 0.0004;

// TICKET-135 warm-up choice (JUDGMENT CALL, documented, NOT tuned against outcome): this OOS slice
// is only 78 days (2025-11-01 -> 2026-01-17), much shorter than the main dataset TICKET-132 used, and
// starts from a completely empty history (no candles before 2025-11-01 exist in this directory at
// all). WINDOW_1H_MOMENTUM=500 means the momentum-gate scorer wants 500 CLOSED 1h candles
// (~20.83 days) of runway before a candidate's momentum score is "full-strength" — the baseline
// convention of --skip-days=20 (20*24=480h) falls just short of that. Bumped to 21 days (21*24=504h,
// >500) for a small safety margin over the 20.83-day requirement — still a fixed, reasoned number
// decided BEFORE looking at any outcome, not tuned after seeing results.
const SKIP_DAYS = 21;

interface CapturedCandidate {
  symbol: string;
  timestamp: number;
  side: 'LONG';
  setupType: 'BOX_BREAKOUT';
  score: number;
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

// ---- Exact TICKET-131 Variant B config (data/ticket131-neutral-5m-direction-gated-routing-report.md),
// byte-identical to ticket132NeutralCandidateAudit.ts's config — reused verbatim, not re-derived. ----
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
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
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

// TICKET-135 subgroup filter — EXACTLY one, per ticket text: regime=NEUTRAL_TRANSITION,
// setupType=BOX_BREAKOUT, candidateSide=LONG, direction5m=LONG (i.e. neutral5mRoutingAccepted=true),
// AI score <= 0.20. No SHORT, no other band, no other subgroup.
const SCORE_MAX = 0.2;

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV OOS (5m/15m/1h/1m/1d x 4 coin) từ data/ohlcv-oos-2025q4/...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // ---- Phase 1: replay the exact TICKET-131 Variant B backtest over the OOS data, capturing every
  // candidate matching our one subgroup live at the onMomentumGateEvaluation hook (no pre-known target
  // list exists for this fresh data, unlike TICKET-132). ----
  const captured: CapturedCandidate[] = [];

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;
  if (startStep >= totalSteps) {
    throw new Error(`FAIL — warm-up (SKIP_DAYS=${SKIP_DAYS}, startStep=${startStep}) >= tổng số bước dữ liệu (${totalSteps}). Không đủ dữ liệu OOS.`);
  }

  let accountBalance = config.riskDollarOrPercent > 0 ? 100 : 400; // matches --start-balance=100 convention
  console.log(`Chạy lại pipeline thật (đúng config TICKET-131 Variant B) trên dữ liệu OOS — ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (SKIP_DAYS=${SKIP_DAYS})...`);

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
        if (evaluation.gateType !== 'NEUTRAL_TRANSITION') return;
        if (evaluation.regime !== MarketRegime.NEUTRAL_TRANSITION) return;
        if (evaluation.setupType !== 'BOX_BREAKOUT') return;
        if (evaluation.side !== 'LONG') return;
        if (evaluation.neutral5mRoutingAccepted !== true) return; // = direction5m accepted this LONG candidate
        if (evaluation.score > SCORE_MAX) return;
        if (evaluation.entryPriceCandidate === undefined || evaluation.slPriceCandidate === undefined) return;
        captured.push({
          symbol: evaluation.symbol,
          timestamp: evaluation.timestamp,
          side: 'LONG',
          setupType: 'BOX_BREAKOUT',
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
  }

  console.log(`Bắt được ${captured.length} candidate khớp subgroup (NEUTRAL_TRANSITION/BOX_BREAKOUT/LONG/direction5m=LONG/score<=${SCORE_MAX}).`);
  if (captured.length === 0) {
    throw new Error('FAIL — không bắt được candidate nào khớp subgroup trên dữ liệu OOS. Dừng lại (Conclusion C).');
  }

  // ---- Phase 2: isolated per-candidate forward simulation (real slTpManager.ts + advancePosition()) ----
  const results: SimResult[] = [];
  for (const cand of captured) {
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
      console.error(`openPosition() lỗi cho ${cand.symbol}|${cand.timestamp}:`, (e as Error).message);
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

// ---- Episode grouping: same definition as TICKET-132/133 — consecutive same-symbol+side rows where
// timestamps are exactly 5m apart. A gap >=10m starts a NEW episode. ----
interface Episode {
  symbol: string;
  side: 'LONG';
  rows: SimResult[];
}
function groupEpisodes(results: SimResult[]): Episode[] {
  const bySymbol = new Map<string, SimResult[]>();
  for (const r of results) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    (bySymbol.get(r.symbol) as SimResult[]).push(r);
  }
  const episodes: Episode[] = [];
  for (const [symbol, rows] of bySymbol) {
    const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
    let current: SimResult[] = [];
    for (const r of sorted) {
      if (current.length === 0 || r.timestamp - current[current.length - 1].timestamp === 5 * 60_000) {
        current.push(r);
      } else {
        episodes.push({ symbol, side: 'LONG', rows: current });
        current = [r];
      }
    }
    if (current.length > 0) episodes.push({ symbol, side: 'LONG', rows: current });
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

// Longest consecutive-loss streak, chronological by exitTimestamp (resolved rows only).
function longestLossStreak(rows: SimResult[]): number {
  const resolved = rows.filter((r) => r.outcome !== 'UNRESOLVED').sort((a, b) => (a.exitTimestamp as number) - (b.exitTimestamp as number));
  let longest = 0;
  let current = 0;
  for (const r of resolved) {
    if (r.outcome === 'RESOLVED_LOSS') {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

// Two non-overlapping halves, split by the candidate set's own min/max timestamp (same convention as
// TICKET-132/133's N-way split, 2-way here per ticket).
function twoHalves(rows: SimResult[]): { label: string; from: number; to: number; rows: SimResult[] }[] {
  const timestamps = rows.map((r) => r.timestamp);
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const mid = min + (max - min) / 2;
  const bounds = [min, mid, max + 1];
  const labels = ['H1', 'H2'];
  return labels.map((label, i) => ({
    label,
    from: bounds[i],
    to: bounds[i + 1],
    rows: rows.filter((r) => r.timestamp >= bounds[i] && r.timestamp < bounds[i + 1]),
  }));
}

function buildReport(results: SimResult[]): string {
  const overall = computeStats(results);
  const byCoin = SYMBOLS.map((s) => ({ symbol: s, rows: results.filter((r) => r.symbol === s) }));
  const halves = twoHalves(results);

  const episodes = groupEpisodes(results);
  const episodeFirstRows = episodes.map((e) => e.rows[0]);
  const episodeStats = computeStats(episodeFirstRows);
  const multiRowEpisodes = episodes.filter((e) => e.rows.length > 1);
  const collapsedRowCount = multiRowEpisodes.reduce((s, e) => s + (e.rows.length - 1), 0);

  const winsSorted = results.filter((r) => r.outcome === 'RESOLVED_WIN').map((r) => r.pnlUsd as number).sort((a, b) => b - a);
  const grossWin = winsSorted.reduce((a, b) => a + b, 0);
  const top3 = winsSorted.slice(0, 3).reduce((a, b) => a + b, 0);
  const top3Share = grossWin > 0 ? top3 / grossWin : null;

  const streak = longestLossStreak(results);

  // ---- 6 PASS criteria, per ticket text, applied ONLY to this one subgroup (overall). ----
  const c1 = overall.resolved >= 12;
  const c2 = overall.pf !== null && overall.pf > 1.1;
  const c3 = overall.netPnl > 0;
  const halfStats = halves.map((h) => ({ label: h.label, from: h.from, to: h.to, stats: computeStats(h.rows) }));
  const c4 = halfStats.every((h) => h.stats.resolved === 0 || h.stats.netPnl >= 0);
  const c5 = top3Share === null || top3Share < 0.6;
  const c6 = episodeStats.pf !== null && episodeStats.pf > 1.1;
  const allPass = c1 && c2 && c3 && c4 && c5 && c6;

  let conclusion: string;
  if (allPass) {
    conclusion = 'A — Quick OOS PASS, mới mở rộng dữ liệu OOS đầy đủ.';
  } else {
    conclusion = 'B — Quick OOS FAIL, đóng hướng Neutral BOX_BREAKOUT LONG.';
  }

  const lines: string[] = [];
  lines.push('# TICKET-135 — Quick OOS Screen: Neutral BOX_BREAKOUT LONG');
  lines.push('');
  lines.push('Nhánh `cai-tien`. Kiểm tra nhanh MỘT subgroup duy nhất (`regime=NEUTRAL_TRANSITION`, `setupType=BOX_BREAKOUT`, `candidateSide=LONG`, `direction5m=LONG`, AI score <= 0.20) trên dữ liệu OOS MỚI (`data/ohlcv-oos-2025q4/`, 2025-11-01 → 2026-01-17), độc lập hoàn toàn với `data/ohlcv/` (baseline chính thức, bắt đầu 2026-01-18). KHÔNG thay production code/decision.');
  lines.push('');
  lines.push('## Dữ liệu OOS');
  lines.push('');
  lines.push('- Thư mục: `data/ohlcv-oos-2025q4/` (mới, tách biệt hoàn toàn khỏi `data/ohlcv/` — không ghi đè, không merge).');
  lines.push('- Coin: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT. Khung: 1m, 5m, 15m, 1h, 1d.');
  lines.push('- Khoảng thời gian: 2025-11-01T00:00:00Z → 2026-01-17T23:59:59.999Z (đúng 78 ngày lịch, không tải ngoài khoảng này — đã xác nhận qua timestamp đầu/cuối mỗi file CSV).');
  lines.push('- Fetch bằng `apps/bot/scripts/fetchOhlcv.ts` (mở rộng TICKET-135: thêm `--start-date=`/`--end-date=`, additive, không đổi hành vi `--days=`/mặc định cũ) — reuse nguyên vẹn retry/backoff/pagination/CSV-writing logic có sẵn, không viết lại.');
  lines.push('- Không có 429/lỗi mạng nào trong lần fetch (log đầy đủ, không phải resume một phần).');
  lines.push('');
  lines.push('## Phương pháp mô phỏng (reuse nguyên vẹn TICKET-132/133)');
  lines.push('');
  lines.push('- Reuse verbatim: `apps/bot/src/risk/slTpManager.ts` (`openPosition()`, `computeRealizedPnl()`), `apps/bot/src/orchestrator/orchestrator.ts` (`processCandle()`, `advancePosition()` export, `selectTpPlan()` export), `apps/bot/src/entry/entryRouter.ts`\'s `routeEntry()` BOX_BREAKOUT cascade (qua `processCandle()`) — KHÔNG viết lại/approximate bất kỳ công thức SL/TP/trailing nào, KHÔNG khác pattern `ticket132NeutralCandidateAudit.ts` đã dùng.');
  lines.push('- Config: ĐÚNG TICKET-131 Variant B (`MODEL_MODE=V1`, `OOD_GUARD_MODE=RISK_REDUCTION` threshold 1.037776 multiplier 0.3, `neutral5mDirectionGatedRoutingEnabled=true`, các flag khác khớp baseline 12-flag chính thức) — copy nguyên object config từ `ticket132NeutralCandidateAudit.ts`, không đổi 1 flag nào.');
  lines.push('- Khác biệt duy nhất so với TICKET-132: dữ liệu OOS này KHÔNG có sẵn danh sách target candidate (TICKET-132 dùng CSV diagnostics TICKET-131 đã có sẵn 81 dòng) — nên mọi candidate khớp đúng subgroup được bắt trực tiếp tại hook `onMomentumGateEvaluation` trong 1 lượt chạy duy nhất (single pass), không cần Phase 1 "khớp lại target list".');
  lines.push(`- positionSize = $${POSITION_SIZE_USD} cố định mọi candidate (JUDGMENT CALL, giống hệt TICKET-132 — không risk pool trong scope này).`);
  lines.push(`- Fee: takerFeeRate=${TAKER_FEE_RATE}, round-trip 2x qua \`computeRealizedPnl()\` — không giả định slippage mới.`);
  lines.push(`- UNRESOLVED: ${overall.unresolved} candidate không SL/TP-out trước khi dữ liệu OHLCV hết — tính riêng, không gộp vào winrate/PF.`);
  lines.push('');
  lines.push('## Warm-up (JUDGMENT CALL, quyết định TRƯỚC khi xem outcome)');
  lines.push('');
  lines.push(`- SKIP_DAYS = ${SKIP_DAYS} ngày (thay vì convention 20 ngày của baseline chính). Lý do: slice OOS này chỉ 78 ngày và bắt đầu từ lịch sử HOÀN TOÀN RỖNG (không có nến nào trước 2025-11-01 trong thư mục này). \`WINDOW_1H_MOMENTUM=500\` (nến 1h) đòi hỏi ~20.83 ngày nến 1h đã đóng trước decisionTime để momentum gate score "full-strength"; convention 20 ngày (480h) hụt mất ngưỡng này. Bumped lên 21 ngày (504h, > 500h) cho biên an toàn nhỏ — vẫn là một con số cố định, có lý do, quyết định TRƯỚC khi chạy mô phỏng, KHÔNG tune theo kết quả.`);
  lines.push(`- Sau warm-up: còn lại ~${78 - SKIP_DAYS} ngày để bắt candidate (từ ${new Date(new Date('2025-11-01T00:00:00Z').getTime() + SKIP_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)} → 2026-01-17).`);
  lines.push('');

  lines.push('## Bảng tổng (subgroup duy nhất)');
  lines.push('');
  lines.push('| Nhóm | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL | Max DD |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(statsRow('NEUTRAL_TRANSITION / BOX_BREAKOUT / LONG / direction5m=LONG / score<=0.20', overall));
  lines.push('');

  lines.push('## Theo coin');
  lines.push('');
  lines.push('| Coin | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of byCoin) lines.push(statsRowNoDd(c.symbol, computeStats(c.rows)));
  lines.push('');

  lines.push('## Theo 2 nửa thời gian không chồng lấn (chia đều theo timestamp min/max của tập candidate)');
  lines.push('');
  lines.push(`Span: ${new Date(Math.min(...results.map((r) => r.timestamp))).toISOString().slice(0, 10)} → ${new Date(Math.max(...results.map((r) => r.timestamp))).toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('| Nửa | Candidates | Resolved | Win rate | PF | Net PnL | Avg PnL |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const h of halfStats) lines.push(statsRowNoDd(h.label, h.stats));
  lines.push('');

  lines.push('## Top-3 winner / gross win');
  lines.push('');
  lines.push(`Gross win = ${fmtNum(grossWin)}. Top-3 winner PnL gộp = ${fmtNum(top3)} (${top3Share !== null ? fmtNum(top3Share * 100, 1) + '%' : 'N/A (không có winner)'} tổng gross win).`);
  lines.push('');
  if (winsSorted.length > 0) {
    lines.push('| Hạng | PnL ($) |');
    lines.push('|---|---|');
    winsSorted.slice(0, 3).forEach((p, i) => lines.push(`| #${i + 1} | +${fmtNum(p)} |`));
    lines.push('');
  }

  lines.push('## Longest loss streak');
  lines.push('');
  lines.push(`Chuỗi thua liên tiếp dài nhất (theo thứ tự exitTimestamp, resolved rows): ${streak} lệnh.`);
  lines.push('');

  lines.push('## Episode-level (dedup nến liên tiếp cùng symbol, cùng định nghĩa TICKET-132/133)');
  lines.push('');
  lines.push('**Định nghĩa (JUDGMENT CALL, giống TICKET-132/133)**: episode = chuỗi row liên tiếp cùng symbol (side luôn LONG trong subgroup này) có timestamp cách nhau ĐÚNG 5 phút. Khoảng trống >=10 phút bắt đầu episode MỚI.');
  lines.push('');
  lines.push(`- Tổng số episode: ${episodes.length} (từ ${results.length} row)`);
  lines.push(`- Episode có >1 row (bị gộp): ${multiRowEpisodes.length}, tổng ${collapsedRowCount} row bị gộp/loại bỏ so với row-level`);
  lines.push(`- Episode chỉ có 1 row: ${episodes.length - multiRowEpisodes.length}`);
  lines.push(collapsedRowCount > 0 ? `- **CÓ collapsing xảy ra lần này** (khác với TICKET-132's 0-collapse trên tập 81 candidate gốc) — episode-level và row-level KHÔNG đồng nhất về N, xem bảng dưới.` : '- Không có collapsing nào xảy ra (mọi episode chỉ có 1 row) — episode-level = row-level, giống kết quả TICKET-132.');
  lines.push('');
  lines.push('### Kết quả episode-level (chỉ giữ candidate ĐẦU TIÊN của mỗi episode)');
  lines.push('');
  lines.push('| Nhóm | Candidates (episodes) | Resolved | Win rate | PF | Net PnL | Avg PnL | Max DD |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(statsRow('Episode-level (first-row-only)', episodeStats));
  lines.push('');

  lines.push('## 6 tiêu chí PASS (per ticket)');
  lines.push('');
  lines.push('| # | Tiêu chí | Yêu cầu | Thực đo | PASS? |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| 1 | Resolved candidate | >= 12 | ${overall.resolved} | ${c1 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| 2 | PF | > 1.10 | ${fmtNum(overall.pf, 4)} | ${c2 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| 3 | Net PnL | dương (> 0) | ${overall.netPnl >= 0 ? '+' : ''}${fmtNum(overall.netPnl)} | ${c3 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| 4 | Không âm ở cả 2 nửa thời gian | H1 và H2 Net PnL >= 0 | H1=${fmtNum(halfStats[0].stats.netPnl)}, H2=${fmtNum(halfStats[1].stats.netPnl)} | ${c4 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| 5 | Top-3 winner / gross win | < 60% | ${top3Share !== null ? fmtNum(top3Share * 100, 1) + '%' : 'N/A'} | ${c5 ? 'PASS' : 'FAIL'} |`);
  lines.push(`| 6 | Episode-level PF | > 1.10 | ${fmtNum(episodeStats.pf, 4)} | ${c6 ? 'PASS' : 'FAIL'} |`);
  lines.push('');

  lines.push('## KẾT LUẬN BẮT BUỘC');
  lines.push('');
  lines.push(`**${conclusion}**`);
  lines.push('');

  lines.push('## Ghi chú kỹ thuật quan trọng / judgment calls cần review độc lập');
  lines.push('');
  lines.push(`- **SKIP_DAYS=${SKIP_DAYS}** (thay vì 20 ngày convention): xem mục "Warm-up" ở trên — quyết định trước khi xem outcome.`);
  lines.push('- **Episode-grouping definition**: quy tắc 5-phút-liên-tiếp giống hệt TICKET-132/133, chưa được PM xác nhận riêng cho ticket này.');
  lines.push(`- **positionSize=$${POSITION_SIZE_USD} cố định**: không phải sizing thật (ticket cấm risk pool) — chỉ dùng để có Net PnL$ so sánh được. R-multiple/winrate/PF không phụ thuộc lựa chọn này.`);
  lines.push('- **Không có target list có sẵn**: khác TICKET-132 (replay lại một danh sách 81 candidate đã biết trước), TICKET-135 bắt MỌI candidate khớp subgroup trực tiếp tại hook trong 1 lượt chạy — không có bước "đối chiếu số lượng kỳ vọng" như TICKET-132\'s check `captured.size !== 81`.');
  lines.push(`- **UNRESOLVED**: ${overall.unresolved}/${overall.candidates} candidate không tìm được điểm SL/TP-out trong dữ liệu 5m còn lại — không ép resolve.`);
  lines.push('- Không production code nào bị sửa. Không hạ AI threshold, không grid search, không tune score/warm-up theo outcome, không thử SHORT/subgroup khác — toàn bộ threshold dùng đúng số ticket đã cho trước.');
  lines.push('');

  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
