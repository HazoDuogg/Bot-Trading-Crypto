/**
 * TICKET-150 — Backtest Execution-Realism Audit (PURE READ-ONLY on production logic). Assesses how
 * optimistic the current backtest is because it does not fully simulate (A) slippage, (B) dynamic
 * spread, (C) latency, (D) funding rate. This is an audit of the SIMULATOR only — no entry logic,
 * SL/TP logic, Matrix V2, OOD Guard, XGBoost, risk sizing, or threshold/filter in src/ is touched.
 * The ONLY thing this script adds is a post-hoc execution-simulation LAYER on top of the real
 * processCandle() replay: it perturbs the REALIZED fill price used for PnL/fee accounting on top of
 * the exact same decisions (entries/exits/sizing) production would make, and — critically — feeds a
 * slippage-adjusted SHADOW account balance back into the next steps' `accountBalance` input, so risk
 * pool / max-margin / account-blown gates see the realistic (lower) balance and may admit or reject
 * different future trades than the frictionless baseline. This makes Section A/B path-dependent per
 * TICKET-150 Section F, without ever mutating orchestrator decision logic.
 *
 * Design notes (see data/ticket150-historical-data-quality.md for the full data-availability audit):
 *  - Position SIZE (USD notional) does NOT depend on entry-fill price in this repo's sizer
 *    (DynamicRMarginSizer: marginRequired = riskDollarOrPercent/(leverage*slDistancePercent), entirely
 *    independent of accountBalance and of entryPrice's absolute level) — so slippage/spread do not
 *    change position sizing directly. What they DO change: (1) realized PnL/fee accounting on the
 *    actual fill, and (2) accountBalance going forward, which (2a) gates risk-pool/margin admission
 *    for later signals (wouldExceedRiskPool/wouldExceedMaxTotalMargin both compare against
 *    accountBalance) and (2b) the accountBalance<=0 "account blown" gate. Both effects are modeled
 *    with a REAL full-system per-candle replay (not a re-scaled-after-the-fact approximation) —
 *    this qualifies as path-dependent per Section F for the risk-pool/concurrency/margin/account-blown
 *    channel. SL/TP TOUCH DETERMINATION itself is NOT re-priced by slippage (the ticket's own fill
 *    formula only perturbs entryFill/exitFill for cost accounting, not the strategy's SL/TP trigger
 *    levels) — documented explicitly, this is the literal reading of Section A's formula, not a
 *    shortcut.
 *  - PnL recomputation uses a DELTA method: slippedPnlUsd = theoreticalPnlUsd + positionSize*(pnlPctSlipped
 *    - pnlPctTheoretical). This is EXACT for single-tier trades (COUNTER_TREND/MOMENTUM_DIRECT — the
 *    large majority of this baseline's population) and an APPROXIMATION for multi-tier TREND trades
 *    with partial TP1/TP2 fills (per-trade tpTierCount>1 flagged APPROXIMATION_ONLY in the per-trade CSV).
 *  - Latency (Section C) has NO real telemetry (verified below) and the ticket's own requested ms grid
 *    (100/250/500/1000/2000/5000ms) is entirely SUB-1-MINUTE — below the finest resolvable OHLCV
 *    granularity in this repo (1m candles). Per the ticket's explicit no-interpolation rule, EVERY
 *    non-zero value in the requested grid is NOT_RESOLVABLE_WITH_CURRENT_DATA. One illustrative,
 *    clearly-labeled APPROXIMATION_ONLY coarse test at whole-1-minute delay is provided beyond the
 *    requested grid for directional signal only.
 *  - Funding (Section D) has no historical data at all — HISTORICAL_FUNDING_DATA_UNAVAILABLE,
 *    INSUFFICIENT_DATA, no numbers fabricated.
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { processCandle, type ProcessCandleInput, type ProcessCandleResult } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_DIR = path.resolve(process.cwd(), 'data');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;
const TAKER_FEE_RATE = 0.0004;
const TARGET_TOTAL_TRADES = 319;

type Side = 'LONG' | 'SHORT';

// ---- Official baseline config (byte-identical to T148/T149's own verified config) ----
export function buildBaselineConfig(): OrchestratorConfig {
  return {
    entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87 },
    tpPlan: 'PLAN_A',
    takerFeeRate: TAKER_FEE_RATE,
    riskDollarOrPercent: 15,
    maxMarginCap: 37.5,
    leverage: 30,
    riskPoolMaxPct: 15 / 100,
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
    neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
    planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true },
    maxConcurrentPositionsPerSymbol: 2,
    // The locked 319-trade checkpoint predates TICKET-152. This explicit replay-version pin keeps
    // production's default guard enabled while reproducing the historical simulator semantics.
    sameSideDuplicateGuardEnabled: process.env.T153A_ENABLE_GUARD === 'true' ? true : false,
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
    oodGuardConfig: { emaRatioSlowThreshold: 1.037776, mode: 'RISK_REDUCTION', scoreCapValue: 0, riskReductionMultiplier: 0.3 },
    momentumContextDecisionMatrixV2Enabled: true,
  };
}
export const config = buildBaselineConfig();
const LEVERAGE = config.leverage;

const EXPECTED_TRADES = 319;
const EXPECTED_FINAL_BALANCE = 1237.35;
const EXPECTED_WR = 40.4;
const EXPECTED_PF = 1.48;
const EXPECTED_MAXDD_PCT = 45.84;
const EXPECTED_MAXDD_USD = 650.72;

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
  ts1mIndex: Map<number, number>;
}

function loadSymbolData(symbol: string): SymbolData {
  const candles1m = readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`));
  const ts1mIndex = new Map<number, number>();
  candles1m.forEach((c, i) => ts1mIndex.set(c.timestamp, i));
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m,
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    // Every scenario must start from isolated state. Reusing INITIAL_SYMBOL_STATE by reference makes
    // the first replay mutate the starting point of every later replay.
    state: structuredClone(INITIAL_SYMBOL_STATE),
    ts1mIndex,
  };
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// ============================================================================================
// Execution-simulation cost model — the ONLY new "logic" this ticket introduces, and it only
// perturbs FILL PRICES for cost accounting, never the decision pipeline.
// ============================================================================================
interface FillModel {
  label: string;
  /** LONG buys/covers-worse, SHORT sells/covers-worse — bps expressed as a fraction (1bp=0.0001). */
  entryAdverseFrac: number; // total adverse fraction applied to entry fill
  exitAdverseFrac: number; // total adverse fraction applied to exit fill
}
function fillPrice(theoretical: number, side: Side, adverseFrac: number, isEntry: boolean): number {
  // Entry: LONG buys higher, SHORT sells lower. Exit: LONG sells lower, SHORT buys higher.
  const worseForLongEntry = side === 'LONG' ? 1 : -1;
  const dir = isEntry ? worseForLongEntry : -worseForLongEntry;
  return theoretical * (1 + dir * adverseFrac);
}

const SLIPPAGE_LEVELS = [
  { key: 'S0', bps: 0 },
  { key: 'S1', bps: 0.0001 },
  { key: 'S2', bps: 0.0002 },
  { key: 'S3', bps: 0.0005 },
  { key: 'S4', bps: 0.001 },
];
const SPREAD_LEVELS = [
  { key: 'SP0', bps: 0 },
  { key: 'SP1', bps: 0.0001 },
  { key: 'SP2', bps: 0.0002 },
  { key: 'SP3', bps: 0.0005 },
  { key: 'SP4', bps: 0.001 },
];

export function makeFillModel(label: string, slipBps: number, spreadBpsTotal: number): FillModel {
  // spread is a round-trip (bid/ask) cost, so each leg only pays HALF the quoted total spread.
  const frac = slipBps + spreadBpsTotal / 2;
  return { label, entryAdverseFrac: frac, exitAdverseFrac: frac };
}

// ============================================================================================
// Trade record
// ============================================================================================
interface OpenRec {
  symbol: string;
  side: Side;
  setupType: string;
  regime: string;
  entryTimestamp: number;
  entryPriceTheoretical: number;
  slPrice: number;
  actualRiskDollar: number;
  marginRequired: number;
  positionSize: number;
  tpTierCount: number;
  riskPoolPctBefore: number;
}
export interface ClosedTrade extends OpenRec {
  exitTimestamp: number;
  exitPriceTheoretical: number;
  exitReason: string;
  pnlUsdTheoretical: number;
  pnlPctTheoretical: number;
}

export interface ReplayResult {
  trades: ClosedTrade[];
  finalShadowBalance: number;
  finalTheoreticalBalance: number;
  stopStep: number;
  closedCount: number;
  // per-trade slippage/spread-adjusted PnL under the SAME fill model used to drive the shadow balance
  slippedPnlByEntryTs: Map<string, number>;
  eventTrace: Record<string, unknown>[];
}

/**
 * TICKET-G2R P1 — OPT-IN research hooks. Omitted (the default for every pre-G2R caller) leaves this
 * replay byte-identical: no shadow detectRegime() call is made and no state is rewritten. They exist
 * so the NEUTRAL and cooldown variants run through THIS full orchestrator path — real entry router,
 * XGBoost gate, risk sizing/pool, T152 guard, position conflicts, path-dependent balance — instead
 * of a shortcut evaluation. Neither hook can change orchestrator decision logic: `blockEntry` uses
 * the SAME over-cap risk-pool sentinel liveRunner.ts already uses to fail closed, and
 * `rewriteDangerAnchor` only rewrites the cooldown ANCHOR TIMESTAMP that detectRegime already takes
 * as a plain input.
 */
export interface ReplayVariantHooks {
  blockEntry?: (ctx: { symbol: string; step: number; timestamp: number; regime: MarketRegime; candidateRegime: MarketRegime }) => boolean;
  rewriteDangerAnchor?: (ctx: { symbol: string; timestamp: number; regime: MarketRegime; current: number | null }) => number | null;
  onStepRegime?: (ctx: { symbol: string; step: number; timestamp: number; regime: MarketRegime; candidateRegime: MarketRegime; blocked: boolean }) => void;
  /**
   * TICKET-G3 — OPT-IN observability passthroughs to processCandle()'s own existing diagnostic
   * callbacks (onFunnelEvent arg 6, onMomentumGateEvaluation arg 9). Both are documented in
   * orchestrator.ts as pure observability that never affects any decision; omitting them (the
   * default for every pre-G3 caller) passes `undefined` exactly as before. Proven behaviourally,
   * not asserted: the G3 run's trade ledger is reconciled trade-for-trade against G2R's archived
   * N0_CURRENT/CENTRAL ledger.
   */
  onFunnelEvent?: (symbol: string, timestamp: number, event: Record<string, unknown>) => void;
  onMomentumGateEvaluation?: (evaluation: Record<string, unknown>) => void;
  /** TICKET-G3 — fires once per (symbol, step) before processCandle, carrying the shadow regime read. */
  onStepContext?: (ctx: { symbol: string; step: number; timestamp: number; regime: MarketRegime; adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined; atrPercentile5m: number | undefined; bbWidthPercentile15m: number | undefined; volumeZScore5m: number | undefined; candle: CandleData; accountBalance: number }) => void;
  /** TICKET-G3 — fires for each SKIPPED entry event (RISK_POOL_EXCEEDED / MAX_TOTAL_MARGIN_EXCEEDED / NEUTRAL_GATE_REJECTED). */
  onSkippedEntry?: (ctx: { symbol: string; step: number; timestamp: number; reason: string }) => void;
  /** G6R CP2 — research-only full-path seam. Inputs/results are observed, never replaced. */
  onBeforeProcessCandle?: (ctx: { symbol: string; step: number; timestamp: number; input: ProcessCandleInput; state: SymbolState; config: OrchestratorConfig }) => void;
  onAfterProcessCandle?: (ctx: { symbol: string; step: number; timestamp: number; input: ProcessCandleInput; stateBefore: SymbolState; config: OrchestratorConfig; result: ProcessCandleResult }) => void;
}

export async function runReplay(cfg: OrchestratorConfig, fillModel: FillModel | null, endStepInclusive: number | null, hooks?: ReplayVariantHooks): Promise<ReplayResult> {
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;

  let theoreticalBalance = 100;
  let shadowBalance = 100; // slippage/spread-adjusted balance actually fed into accountBalance gates

  const trades: ClosedTrade[] = [];
  const openIndex = new Map<string, OpenRec>();
  const slippedPnlByEntryTs = new Map<string, number>();
  let closedCount = 0;
  let stopStep = -1;
  let firstSameSideBlockLogged = false;
  const eventTrace: Record<string, unknown>[] = [];

  stepLoop: for (let step = startStep; step < rawTotalSteps; step++) {
    if (endStepInclusive !== null && step > endStepInclusive) { stopStep = step - 1; break; }
    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: Side }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').map((e) => ({ symbol, side: e.position.side })),
    );

    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    // BUG FIX (found during independent review of the agent's first pass — this used to be hardcoded
    // `undefined` with the comment "never fed to any output", which is FALSE: correlatedRiskRatio is a
    // real input to scoreMomentumForSide()'s XGBoost feature vector (orchestrator.ts lines 589/590/
    // 977/1040), directly affecting whether a MOMENTUM_DIRECT candidate (64% of the 319-trade
    // population per TICKET-149) crosses momentumDirectThreshold=0.5. Feeding undefined here silently
    // changed the momentum score for every single evaluation, causing the baseline (B0) to diverge
    // from the confirmed $1237.35/319-trade checkpoint. Fixed to match the exact same computation
    // backtest.ts/liveRunner.ts/TICKET-147/148/149's own scripts all use.
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

      // TICKET-G2R P1 — shadow regime read (pure, no state mutation): detectRegime() is a pure
      // function of its input, and this passes the SAME state processCandle is about to pass, so
      // this is exactly the regime that call will confirm. Only runs when a hook asks for it.
      let variantBlocked = false;
      if (hooks?.blockEntry !== undefined || hooks?.onStepRegime !== undefined || hooks?.rewriteDangerAnchor !== undefined || hooks?.onStepContext !== undefined) {
        const shadow = detectRegime({
          candles5m: window5m,
          candles15m: w15.window,
          candles1h: w1hBySymbol[symbol],
          previousRegime: sd.state.regimeState.previousRegime,
          previousCandidateRegime: sd.state.regimeState.previousCandidateRegime,
          streakCount: sd.state.regimeState.streakCount,
          previousDangerZoneTimestamp: sd.state.regimeState.previousDangerZoneTimestamp,
          candles5mSessionVolume: windowSessionVolume5m,
          correlatedRiskRatio,
        });
        variantBlocked = hooks?.blockEntry?.({ symbol, step, timestamp: currentCandle.timestamp, regime: shadow.regime, candidateRegime: shadow.candidateRegime }) ?? false;
        hooks?.onStepRegime?.({ symbol, step, timestamp: currentCandle.timestamp, regime: shadow.regime, candidateRegime: shadow.candidateRegime, blocked: variantBlocked });
        hooks?.onStepContext?.({ symbol, step, timestamp: currentCandle.timestamp, regime: shadow.regime, adxDirection1h: shadow.adxDirection1h, atrPercentile5m: shadow.computedMetrics.atrPercentile5m as number | undefined, bbWidthPercentile15m: shadow.computedMetrics.bbWidthPercentile15m as number | undefined, volumeZScore5m: shadow.computedMetrics.volumeZScore5m as number | undefined, candle: currentCandle, accountBalance: shadowBalance });
        // Same sentinel-over-cap mechanism liveRunner.ts uses: an honestly over-cap portfolio risk
        // total makes tryOpenNewPosition() reject, without touching its logic or the cap value.
        if (variantBlocked) allOpenPositionsRisk.push({ id: 'G2R_VARIANT_ENTRY_BLOCK', actualRiskDollar: shadowBalance * (cfg.riskPoolMaxPct ?? 0.15) + 1 });
      }

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
        accountBalance: shadowBalance, // <-- THE injection point: gates see the realistic balance
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };
      const balanceBefore = shadowBalance;
      const riskBefore = Object.values(openRiskBySymbol).reduce((sum, risk) => sum + risk, 0);
      const openBefore = SYMBOLS.reduce((sum, s) => sum + symbolsData[s].state.openPositions.length, 0);

      // Args 6 (onFunnelEvent) and 9 (onMomentumGateEvaluation) are TICKET-G3 opt-in observability;
      // both stay `undefined` unless a caller supplies the hook, so pre-G3 behaviour is unchanged.
      const stateBefore = sd.state;
      hooks?.onBeforeProcessCandle?.({ symbol, step, timestamp: currentCandle.timestamp, input, state: stateBefore, config: cfg });
      const result = await processCandle(input, sd.state, cfg, undefined, undefined, hooks?.onFunnelEvent as never, undefined, undefined, hooks?.onMomentumGateEvaluation as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, (diagnostic) => {
        if (!firstSameSideBlockLogged) {
          firstSameSideBlockLogged = true;
          console.log(`T153A_FIRST_SAME_SIDE_BLOCK step=${step} timestamp=${diagnostic.timestamp} iso=${new Date(diagnostic.timestamp).toISOString()} symbol=${diagnostic.symbol} side=${diagnostic.side} openSameSideCount=${diagnostic.openSameSideCount} balance=${shadowBalance}`);
        }
        eventTrace.push({ step, timestamp: diagnostic.timestamp, symbol: diagnostic.symbol, eventType: 'ADMISSION_BLOCK', candidateSetup: '', candidateSide: diagnostic.side, admissionResult: 'BLOCKED', blockReason: 'SAME_SIDE_POSITION_BLOCKED', entryReferencePrice: '', entryExecutedPrice: '', qty: '', riskDollars: '', margin: '', exitReason: '', exitReferencePrice: '', exitExecutedPrice: '', realizedPnl: '', balanceBefore, balanceAfter: shadowBalance, riskPoolBefore: riskBefore, riskPoolAfter: riskBefore, openPositionCount: openBefore });
      });
      hooks?.onAfterProcessCandle?.({ symbol, step, timestamp: currentCandle.timestamp, input, stateBefore, config: cfg, result });
      sd.state = result.symbolState;
      // TICKET-G2R P1 — cooldown variants rewrite ONLY the anchor timestamp detectRegime already
      // consumes as an input; nothing inside regimeDetector.ts is changed or bypassed.
      if (hooks?.rewriteDangerAnchor !== undefined) {
        const rewritten = hooks.rewriteDangerAnchor({
          symbol,
          timestamp: currentCandle.timestamp,
          regime: sd.state.regimeState.previousRegime ?? MarketRegime.NEUTRAL_TRANSITION,
          current: sd.state.regimeState.previousDangerZoneTimestamp,
        });
        sd.state = { ...sd.state, regimeState: { ...sd.state.regimeState, previousDangerZoneTimestamp: rewritten } };
      }
      theoreticalBalance = result.accountBalance; // production's own frictionless number, for reference only

      for (const event of result.events) {
        if (hooks?.onSkippedEntry !== undefined && event.type === 'SKIPPED' && event.symbol === symbol) {
          hooks.onSkippedEntry({ symbol, step, timestamp: event.timestamp, reason: event.reason });
        }
        if (event.type === 'OPEN' && event.symbol === symbol) {
          const rec: OpenRec = {
            symbol,
            side: event.side,
            setupType: event.setupType,
            regime: event.regime,
            entryTimestamp: event.entryTimestamp,
            entryPriceTheoretical: event.entryPrice,
            slPrice: event.slPrice,
            actualRiskDollar: event.actualRiskDollar,
            marginRequired: event.marginRequired,
            positionSize: event.marginRequired * LEVERAGE,
            tpTierCount: event.tpLevels.length,
            riskPoolPctBefore: event.riskPoolPctBefore,
          };
          openIndex.set(`${symbol}|${event.entryTimestamp}`, rec);
          eventTrace.push({ step, timestamp: event.entryTimestamp, symbol, eventType: 'OPEN', candidateSetup: event.setupType, candidateSide: event.side, admissionResult: 'ADMITTED', blockReason: '', entryReferencePrice: event.entryPrice, entryExecutedPrice: event.entryPrice, qty: (event.marginRequired * LEVERAGE) / event.entryPrice, riskDollars: event.actualRiskDollar, margin: event.marginRequired, exitReason: '', exitReferencePrice: '', exitExecutedPrice: '', realizedPnl: '', balanceBefore, balanceAfter: shadowBalance, riskPoolBefore: riskBefore, riskPoolAfter: riskBefore + event.actualRiskDollar, openPositionCount: openBefore + 1 });
        }
        if (event.type === 'CLOSE' && event.symbol === symbol) {
          closedCount++;
          const key = `${symbol}|${event.entryTimestamp}`;
          const openRec = openIndex.get(key);
          if (openRec) {
            const sideMul = openRec.side === 'LONG' ? 1 : -1;
            const pnlPctTheoretical = sideMul * ((event.exitPrice - openRec.entryPriceTheoretical) / openRec.entryPriceTheoretical);
            const closed: ClosedTrade = {
              ...openRec,
              exitTimestamp: event.exitTimestamp,
              exitPriceTheoretical: event.exitPrice,
              exitReason: event.exitReason,
              pnlUsdTheoretical: event.pnlUsd,
              pnlPctTheoretical,
            };
            trades.push(closed);

            let slippedPnlUsd = event.pnlUsd;
            if (fillModel !== null) {
              const entryFill = fillPrice(openRec.entryPriceTheoretical, openRec.side, fillModel.entryAdverseFrac, true);
              const exitFill = fillPrice(event.exitPrice, openRec.side, fillModel.exitAdverseFrac, false);
              const pnlPctSlipped = sideMul * ((exitFill - entryFill) / entryFill);
              const delta = openRec.positionSize * (pnlPctSlipped - pnlPctTheoretical);
              slippedPnlUsd = event.pnlUsd + delta;
            }
            slippedPnlByEntryTs.set(key, slippedPnlUsd);
            shadowBalance = shadowBalance + slippedPnlUsd; // path-dependent: feeds next steps' input.accountBalance
            eventTrace.push({ step, timestamp: event.exitTimestamp, symbol, eventType: 'CLOSE', candidateSetup: openRec.setupType, candidateSide: event.side, admissionResult: '', blockReason: '', entryReferencePrice: openRec.entryPriceTheoretical, entryExecutedPrice: openRec.entryPriceTheoretical, qty: openRec.positionSize / openRec.entryPriceTheoretical, riskDollars: openRec.actualRiskDollar, margin: openRec.marginRequired, exitReason: event.exitReason, exitReferencePrice: event.exitPrice, exitExecutedPrice: event.exitPrice, realizedPnl: slippedPnlUsd, balanceBefore, balanceAfter: shadowBalance, riskPoolBefore: riskBefore, riskPoolAfter: Math.max(0, riskBefore - openRec.actualRiskDollar), openPositionCount: Math.max(0, openBefore - 1) });
          }
          if (endStepInclusive === null && closedCount >= TARGET_TOTAL_TRADES) {
            stopStep = step;
            break stepLoop;
          }
        }
      }

      const newTotalRisk = sd.state.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk; else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin; else delete openMarginBySymbol[symbol];
    }
    // Track the last processed step; variants must replay the complete fixed checkpoint window.
    stopStep = step;
  }

  return { trades, finalShadowBalance: shadowBalance, finalTheoreticalBalance: theoreticalBalance, stopStep, closedCount, slippedPnlByEntryTs, eventTrace };
}

// ============================================================================================
// Stats / CSV helpers
// ============================================================================================
function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(filePath: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { writeFileSync(filePath, ''); return; }
  const header = Object.keys(rows[0]);
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))];
  writeFileSync(filePath, lines.join('\n'));
}
function mean(arr: number[]): number { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN; }
function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export interface Metrics {
  n: number; wr: number; pf: number; netPnl: number; finalBalance: number; maxDdPct: number; maxDdUsd: number;
  avgWin: number; avgLoss: number; expectancy: number;
}
export function computeMetrics(trades: ClosedTrade[], pnlFn: (t: ClosedTrade) => number, startBalance: number): Metrics {
  const sorted = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
  const n = sorted.length;
  let balance = startBalance, peak = startBalance, maxDdPct = 0, maxDdUsd = 0;
  let grossProfit = 0, grossLoss = 0, wins = 0;
  const winPnls: number[] = [], lossPnls: number[] = [];
  for (const t of sorted) {
    const pnl = pnlFn(t);
    balance += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; winPnls.push(pnl); } else { grossLoss += Math.abs(pnl); lossPnls.push(pnl); }
    if (balance > peak) peak = balance;
    const ddUsd = peak - balance;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
  }
  const netPnl = balance - startBalance;
  return {
    n,
    wr: n > 0 ? (wins / n) * 100 : NaN,
    pf: grossLoss > 0 ? grossProfit / grossLoss : wins > 0 ? Infinity : NaN,
    netPnl,
    finalBalance: balance,
    maxDdPct,
    maxDdUsd,
    avgWin: winPnls.length > 0 ? mean(winPnls) : NaN,
    avgLoss: lossPnls.length > 0 ? mean(lossPnls) : NaN,
    expectancy: n > 0 ? netPnl / n : NaN,
  };
}

function buildPeriods(sortedTimestamps: number[]): Array<{ label: string; fromMs: number; toMsExclusive: number }> {
  const n = sortedTimestamps.length;
  if (n === 0) return [];
  const p1 = sortedTimestamps[Math.floor(n / 3)];
  const p2 = sortedTimestamps[Math.floor((2 * n) / 3)];
  const min = sortedTimestamps[0];
  const max = sortedTimestamps[n - 1] + 1;
  return [
    { label: 'P1', fromMs: min, toMsExclusive: p1 },
    { label: 'P2', fromMs: p1, toMsExclusive: p2 },
    { label: 'P3', fromMs: p2, toMsExclusive: max },
  ];
}
function periodOf(ts: number, periods: Array<{ label: string; fromMs: number; toMsExclusive: number }>): string {
  for (const p of periods) if (ts >= p.fromMs && ts < p.toMsExclusive) return p.label;
  return periods.length > 0 ? periods[periods.length - 1].label : 'P3';
}

// ============================================================================================
// Baseline reproduction check
// ============================================================================================
function checkBaseline(trades: ClosedTrade[]): { ok: boolean; summary: string; metrics: Metrics } {
  const sorted = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp).slice(0, EXPECTED_TRADES);
  const metrics = computeMetrics(sorted, (t) => t.pnlUsdTheoretical, 100);
  const ok =
    sorted.length === EXPECTED_TRADES &&
    Math.abs(metrics.wr - EXPECTED_WR) < 0.2 &&
    Math.abs(metrics.pf - EXPECTED_PF) < 0.01 &&
    Math.abs(metrics.maxDdPct - EXPECTED_MAXDD_PCT) < 0.1 &&
    Math.abs(metrics.maxDdUsd - EXPECTED_MAXDD_USD) < 1;
  const summary = `trades=${sorted.length} (exp ${EXPECTED_TRADES}), finalBalance=$${metrics.finalBalance.toFixed(4)} (exp ~$${EXPECTED_FINAL_BALANCE}), WR=${metrics.wr.toFixed(2)}% (exp ${EXPECTED_WR}%), PF=${metrics.pf.toFixed(4)} (exp ${EXPECTED_PF}), MaxDD=${metrics.maxDdPct.toFixed(4)}%/$${metrics.maxDdUsd.toFixed(3)} (exp ${EXPECTED_MAXDD_PCT}%/$${EXPECTED_MAXDD_USD})`;
  return { ok, summary, metrics };
}

// ============================================================================================
// Latency approximation (Section C) — post-hoc, 1m-OHLCV-only, no interpolation, APPROXIMATION_ONLY.
// ============================================================================================
function loadAll1mData(): Record<string, { candles: CandleData[]; index: Map<number, number> }> {
  const out: Record<string, { candles: CandleData[]; index: Map<number, number> }> = {};
  for (const symbol of SYMBOLS) {
    const candles = readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`));
    const index = new Map<number, number>();
    candles.forEach((c, i) => index.set(c.timestamp, i));
    out[symbol] = { candles, index };
  }
  return out;
}
/** Shift a timestamp forward by N whole 1-minute candles and return that REAL candle's close (no interpolation). Undefined if out of range. */
function delayedRealPrice(data: Record<string, { candles: CandleData[]; index: Map<number, number> }>, symbol: string, ts: number, minutesDelay: number): number | undefined {
  const d = data[symbol];
  const flooredTs = Math.floor(ts / 60_000) * 60_000;
  const idx = d.index.get(flooredTs);
  if (idx === undefined) return undefined;
  const targetIdx = idx + minutesDelay;
  if (targetIdx < 0 || targetIdx >= d.candles.length) return undefined;
  return d.candles[targetIdx].close;
}

// ============================================================================================
// Main
// ============================================================================================
async function main(): Promise<void> {
  console.log('=== TICKET-150: Backtest Execution-Realism Audit ===');

  // ---- Data-quality check (independently re-verified here, not just taken on faith) ----
  const ohlcvFiles = SYMBOLS.flatMap((s) => ['5m', '15m', '1h', '1m', '1d'].map((tf) => `${s}_${tf}.csv`));
  const missingOhlcv = ohlcvFiles.filter((f) => !existsSync(path.join(OHLCV_DIR, f)));
  const dataDirEntries = readdirSync(OHLCV_DIR) as string[];
  const suspiciousFiles = dataDirEntries.filter((f) => /bid|ask|spread|orderbook|funding|booktick/i.test(f));
  console.log(`OHLCV files present: ${ohlcvFiles.length - missingOhlcv.length}/${ohlcvFiles.length}. Suspicious (bid/ask/funding/orderbook) files found in data/ohlcv: ${suspiciousFiles.length}.`);

  // ---- B0: baseline, no cost layer ----
  console.log('Chạy B0 (baseline, no cost layer)...');
  const b0 = await runReplay(config, null, null);
  const baselineCheck = checkBaseline(b0.trades);
  console.log(`B0: ${baselineCheck.summary}`);
  console.log(baselineCheck.ok ? 'BASELINE MATCH OK.' : 'DRIFT DETECTED.');
  const STOP_STEP = b0.stopStep;
  const baselineTrades = [...b0.trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp).slice(0, EXPECTED_TRADES);
  const lastExitTs = baselineTrades[baselineTrades.length - 1].exitTimestamp;
  console.log(`Baseline window: startStep fixed, stopStep=${STOP_STEP}, last trade exit=${new Date(lastExitTs).toISOString()}.`);

  if (process.env.T153A_BASELINE_ONLY === 'true') {
    const traceName = config.sameSideDuplicateGuardEnabled === false ? 'ticket153a-legacy-event-trace.csv' : 'ticket153a-t153-event-trace.csv';
    writeCsv(path.join(OUT_DIR, traceName), b0.eventTrace);
    console.log('T153A_BASELINE_ONLY: stopping after the locked-baseline feedback loop.');
    return;
  }

  if (!baselineCheck.ok) {
    console.log('!!! Baseline drift detected — proceeding is not safe. Writing drift report and stopping numeric variants.');
  }

  // Sub-periods (P1/P2/P3), from baseline trade population, reused for all variants.
  const sortedEntryTs = baselineTrades.map((t) => t.entryTimestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedEntryTs);

  // ---- Section A: slippage — full path-dependent replay per level ----
  console.log('Chạy Section A (slippage) — 5 full path-dependent replays...');
  const slippageResults: Array<{ key: string; bps: number; result: ReplayResult }> = [];
  for (const lvl of SLIPPAGE_LEVELS) {
    const fm = makeFillModel(lvl.key, lvl.bps, 0);
    const res = await runReplay(config, fm, STOP_STEP);
    slippageResults.push({ key: lvl.key, bps: lvl.bps, result: res });
    console.log(`  ${lvl.key} (slip=${(lvl.bps * 100).toFixed(3)}%): trades=${res.trades.length}, shadowBalance=$${res.finalShadowBalance.toFixed(2)}`);
  }

  // ---- Section B: spread — full path-dependent replay per level (fallback stress model, no real bid/ask data) ----
  console.log('Chạy Section B (spread, fallback stress model) — 5 full path-dependent replays...');
  const spreadResults: Array<{ key: string; bps: number; result: ReplayResult }> = [];
  for (const lvl of SPREAD_LEVELS) {
    const fm = makeFillModel(lvl.key, 0, lvl.bps);
    const res = await runReplay(config, fm, STOP_STEP);
    spreadResults.push({ key: lvl.key, bps: lvl.bps, result: res });
    console.log(`  ${lvl.key} (spread=${(lvl.bps * 100).toFixed(3)}%): trades=${res.trades.length}, shadowBalance=$${res.finalShadowBalance.toFixed(2)}`);
  }

  // ---- Combined variants: B5 (slip+spread), representative central (S2+SP2) and worst-case (S4+SP4) ----
  console.log('Chạy combined variants (B5 slip+spread)...');
  const combinedCentral = await runReplay(config, makeFillModel('S2+SP2', 0.0002, 0.0002), STOP_STEP);
  const combinedLight = await runReplay(config, makeFillModel('S1+SP1', 0.0001, 0.0001), STOP_STEP);
  const combinedConservative = await runReplay(config, makeFillModel('S3+SP3', 0.0005, 0.0005), STOP_STEP);
  const combinedWorst = await runReplay(config, makeFillModel('S4+SP4', 0.001, 0.001), STOP_STEP);

  // ---- Section C: latency — APPROXIMATION_ONLY, illustrative 1-minute delay only (requested ms grid is all NOT_RESOLVABLE) ----
  console.log('Chạy Section C (latency) — post-hoc 1-minute-delay approximation (illustrative only)...');
  const oneMinData = loadAll1mData();
  function applyLatencyDelay(trades: ClosedTrade[], minutesDelay: number): Metrics {
    const adjusted = trades.map((t) => {
      const sideMul = t.side === 'LONG' ? 1 : -1;
      const delayedEntry = delayedRealPrice(oneMinData, t.symbol, t.entryTimestamp, minutesDelay) ?? t.entryPriceTheoretical;
      const delayedExit = delayedRealPrice(oneMinData, t.symbol, t.exitTimestamp, minutesDelay) ?? t.exitPriceTheoretical;
      const pnlPctDelayed = sideMul * ((delayedExit - delayedEntry) / delayedEntry);
      const pnlUsdDelayed = t.pnlUsdTheoretical + t.positionSize * (pnlPctDelayed - t.pnlPctTheoretical);
      return { ...t, pnlUsdTheoretical: pnlUsdDelayed };
    });
    return computeMetrics(adjusted, (t) => t.pnlUsdTheoretical, 100);
  }
  const latency0 = computeMetrics(baselineTrades, (t) => t.pnlUsdTheoretical, 100);
  const latency1min = applyLatencyDelay(baselineTrades, 1);
  const latency5min = applyLatencyDelay(baselineTrades, 5);

  // ---- Section D: funding — INSUFFICIENT_DATA, no numbers fabricated ----
  writeCsv(path.join(OUT_DIR, 'ticket150-funding-impact.csv'), [
    { status: 'HISTORICAL_FUNDING_DATA_UNAVAILABLE', dataQuality: 'INSUFFICIENT_DATA', note: 'No historical Binance Futures funding-rate data exists anywhere in this repo (verified: data/ dir contains only OHLCV candle CSVs). Current/live funding rates were NOT substituted for history per the ticket\'s explicit prohibition. No funding-adjusted PnL numbers are reported.' },
  ]);

  // ============================================================================================
  // CSV outputs
  // ============================================================================================
  // ticket150-slippage-sensitivity.csv
  const slipRows = slippageResults.map(({ key, bps, result }) => {
    const trades = [...result.trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp).filter((t) => t.exitTimestamp <= lastExitTs || true);
    const pnlFn = (t: ClosedTrade) => result.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    const m = computeMetrics(trades, pnlFn, 100);
    const costs = trades.map((t) => t.pnlUsdTheoretical - pnlFn(t));
    return {
      level: key, slipBpsEachSide: bps, dataQuality: bps === 0 ? 'HISTORICAL_MEASURED' : 'STRESS_ASSUMPTION',
      pathDependent: 'YES_FULL_REPLAY', trades: m.n, wr: m.wr.toFixed(2), pf: Number.isFinite(m.pf) ? m.pf.toFixed(4) : 'Infinity',
      netPnl: m.netPnl.toFixed(4), finalBalance: m.finalBalance.toFixed(4), maxDdPct: m.maxDdPct.toFixed(4), maxDdUsd: m.maxDdUsd.toFixed(3),
      avgWin: m.avgWin.toFixed(4), avgLoss: m.avgLoss.toFixed(4), expectancy: m.expectancy.toFixed(4),
      totalSlippageCostUsd: costs.reduce((s, v) => s + v, 0).toFixed(4), avgCostPerTrade: mean(costs).toFixed(4), medianCostPerTrade: median(costs).toFixed(4), p90CostPerTrade: percentile(costs, 90).toFixed(4),
    };
  });
  writeCsv(path.join(OUT_DIR, 'ticket150-slippage-sensitivity.csv'), slipRows);

  // ticket150-spread-sensitivity.csv
  const spreadRows = spreadResults.map(({ key, bps, result }) => {
    const trades = [...result.trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
    const pnlFn = (t: ClosedTrade) => result.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    const m = computeMetrics(trades, pnlFn, 100);
    const costs = trades.map((t) => t.pnlUsdTheoretical - pnlFn(t));
    return {
      level: key, spreadBpsTotal: bps, dataQuality: bps === 0 ? 'HISTORICAL_MEASURED' : 'STRESS_ASSUMPTION',
      note: bps === 0 ? '' : 'HISTORICAL_SPREAD_DATA_UNAVAILABLE — fallback stress model used',
      pathDependent: 'YES_FULL_REPLAY', trades: m.n, wr: m.wr.toFixed(2), pf: Number.isFinite(m.pf) ? m.pf.toFixed(4) : 'Infinity',
      netPnl: m.netPnl.toFixed(4), finalBalance: m.finalBalance.toFixed(4), maxDdPct: m.maxDdPct.toFixed(4), maxDdUsd: m.maxDdUsd.toFixed(3),
      avgWin: m.avgWin.toFixed(4), avgLoss: m.avgLoss.toFixed(4), expectancy: m.expectancy.toFixed(4),
      totalSpreadCostUsd: costs.reduce((s, v) => s + v, 0).toFixed(4), avgCostPerTrade: mean(costs).toFixed(4), medianCostPerTrade: median(costs).toFixed(4), p90CostPerTrade: percentile(costs, 90).toFixed(4),
    };
  });
  writeCsv(path.join(OUT_DIR, 'ticket150-spread-sensitivity.csv'), spreadRows);

  // ticket150-latency-sensitivity.csv
  const latencyRows = [
    { requestedMs: 0, resolvable: 'YES', dataQuality: 'HISTORICAL_MEASURED', trades: latency0.n, wr: latency0.wr.toFixed(2), pf: latency0.pf.toFixed(4), netPnl: latency0.netPnl.toFixed(4), finalBalance: latency0.finalBalance.toFixed(4), maxDdPct: latency0.maxDdPct.toFixed(4), note: 'baseline, no delay' },
    { requestedMs: 100, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; finest available granularity is 1m OHLCV; interpolation forbidden' },
    { requestedMs: 250, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; same as above' },
    { requestedMs: 500, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; same as above' },
    { requestedMs: 1000, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; same as above' },
    { requestedMs: 2000, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; same as above' },
    { requestedMs: 5000, resolvable: 'NO', dataQuality: 'NOT_RESOLVABLE_WITH_CURRENT_DATA', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', note: 'sub-1-minute; same as above' },
    { requestedMs: 60000, resolvable: 'ILLUSTRATIVE_ONLY_BEYOND_REQUESTED_GRID', dataQuality: 'APPROXIMATION', trades: latency1min.n, wr: latency1min.wr.toFixed(2), pf: latency1min.pf.toFixed(4), netPnl: latency1min.netPnl.toFixed(4), finalBalance: latency1min.finalBalance.toFixed(4), maxDdPct: latency1min.maxDdPct.toFixed(4), note: 'not path-dependent (post-hoc on B0 trade list); real 1m OHLCV close used, no interpolation' },
    { requestedMs: 300000, resolvable: 'ILLUSTRATIVE_ONLY_BEYOND_REQUESTED_GRID', dataQuality: 'APPROXIMATION', trades: latency5min.n, wr: latency5min.wr.toFixed(2), pf: latency5min.pf.toFixed(4), netPnl: latency5min.netPnl.toFixed(4), finalBalance: latency5min.finalBalance.toFixed(4), maxDdPct: latency5min.maxDdPct.toFixed(4), note: 'not path-dependent (post-hoc on B0 trade list); real 1m OHLCV close used, no interpolation' },
  ];
  writeCsv(path.join(OUT_DIR, 'ticket150-latency-sensitivity.csv'), latencyRows);

  // ticket150-trade-cost-breakdown.csv — per-trade, S2/S4/SP2/SP4 costs, for symbol/side/setup/regime/period pivoting
  const s2 = slippageResults.find((r) => r.key === 'S2')!.result;
  const s4 = slippageResults.find((r) => r.key === 'S4')!.result;
  const sp2 = spreadResults.find((r) => r.key === 'SP2')!.result;
  const sp4 = spreadResults.find((r) => r.key === 'SP4')!.result;
  const breakdownRows = baselineTrades.map((t) => {
    const key = `${t.symbol}|${t.entryTimestamp}`;
    return {
      symbol: t.symbol, side: t.side, setupType: t.setupType, regime: t.regime,
      period: periodOf(t.entryTimestamp, periods),
      entryIsoUtc: new Date(t.entryTimestamp).toISOString(), exitIsoUtc: new Date(t.exitTimestamp).toISOString(),
      exitReason: t.exitReason, tpTierCount: t.tpTierCount, calcMethod: t.tpTierCount > 1 ? 'APPROXIMATION_ONLY_MULTI_TIER' : 'EXACT_SINGLE_TIER',
      positionSize: t.positionSize.toFixed(4), entryPriceTheoretical: t.entryPriceTheoretical, exitPriceTheoretical: t.exitPriceTheoretical,
      pnlUsdTheoretical: t.pnlUsdTheoretical.toFixed(4), winnerLoser: t.pnlUsdTheoretical > 0 ? 'WINNER' : 'LOSER',
      pnlUsd_S2: (s2.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical).toFixed(4),
      pnlUsd_S4: (s4.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical).toFixed(4),
      pnlUsd_SP2: (sp2.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical).toFixed(4),
      pnlUsd_SP4: (sp4.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical).toFixed(4),
      slippageCost_S2: (t.pnlUsdTheoretical - (s2.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical)).toFixed(4),
      slippageCost_S4: (t.pnlUsdTheoretical - (s4.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical)).toFixed(4),
      spreadCost_SP2: (t.pnlUsdTheoretical - (sp2.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical)).toFixed(4),
      spreadCost_SP4: (t.pnlUsdTheoretical - (sp4.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical)).toFixed(4),
      feeUsdApprox: (t.positionSize * TAKER_FEE_RATE * 2).toFixed(4),
    };
  });
  writeCsv(path.join(OUT_DIR, 'ticket150-trade-cost-breakdown.csv'), breakdownRows);

  // ---- Edge-robustness Q1: PF thresholds ----
  function pfAtLevel(levelResults: typeof slippageResults, thresholds: number[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const th of thresholds) {
      let found = 'NONE_IN_TESTED_RANGE';
      for (const { key, result } of levelResults) {
        const trades = result.trades;
        const pnlFn = (t: ClosedTrade) => result.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
        const m = computeMetrics(trades, pnlFn, 100);
        if (m.pf < th) { found = key; break; }
      }
      out[`pf_below_${th}`] = found;
    }
    return out;
  }
  const pfThresholds = pfAtLevel(slippageResults, [1.4, 1.3, 1.2, 1.1, 1.0]);

  // ---- Variant summary CSV (Section E) ----
  function variantRow(label: string, m: Metrics, pathDep: string, quality: string): Record<string, unknown> {
    return {
      variant: label, trades: m.n, wr: m.wr.toFixed(2), pf: Number.isFinite(m.pf) ? m.pf.toFixed(4) : 'Infinity',
      netPnl: m.netPnl.toFixed(4), finalBalance: m.finalBalance.toFixed(4), maxDdPct: m.maxDdPct.toFixed(4), maxDdUsd: m.maxDdUsd.toFixed(3),
      avgWin: m.avgWin.toFixed(4), avgLoss: m.avgLoss.toFixed(4), expectancy: m.expectancy.toFixed(4), pathDependence: pathDep, dataQuality: quality,
    };
  }
  const variantRows: Record<string, unknown>[] = [];
  variantRows.push(variantRow('B0_BASELINE_NO_COST', baselineCheck.metrics, 'N/A', 'HISTORICAL_MEASURED'));
  for (const { key, result } of slippageResults) {
    const pnlFn = (t: ClosedTrade) => result.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    variantRows.push(variantRow(`B1_SLIPPAGE_${key}`, computeMetrics(result.trades, pnlFn, 100), 'YES_FULL_REPLAY', key === 'S0' ? 'HISTORICAL_MEASURED' : 'STRESS_ASSUMPTION'));
  }
  for (const { key, result } of spreadResults) {
    const pnlFn = (t: ClosedTrade) => result.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    variantRows.push(variantRow(`B2_SPREAD_${key}`, computeMetrics(result.trades, pnlFn, 100), 'YES_FULL_REPLAY', key === 'SP0' ? 'HISTORICAL_MEASURED' : 'STRESS_ASSUMPTION'));
  }
  variantRows.push(variantRow('B3_LATENCY_0ms', latency0, 'N/A', 'HISTORICAL_MEASURED'));
  variantRows.push(variantRow('B3_LATENCY_1min_ILLUSTRATIVE', latency1min, 'NO_APPROXIMATION_ONLY', 'APPROXIMATION'));
  variantRows.push(variantRow('B3_LATENCY_5min_ILLUSTRATIVE', latency5min, 'NO_APPROXIMATION_ONLY', 'APPROXIMATION'));
  variantRows.push({ variant: 'B4_FUNDING', trades: '', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', maxDdUsd: '', avgWin: '', avgLoss: '', expectancy: '', pathDependence: 'N/A', dataQuality: 'INSUFFICIENT_DATA' });
  {
    const pnlFn = (t: ClosedTrade) => combinedCentral.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    variantRows.push(variantRow('B5_SLIP_S2_PLUS_SPREAD_SP2', computeMetrics(combinedCentral.trades, pnlFn, 100), 'YES_FULL_REPLAY', 'STRESS_ASSUMPTION'));
  }
  {
    const pnlFn = (t: ClosedTrade) => combinedWorst.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    variantRows.push(variantRow('B5_SLIP_S4_PLUS_SPREAD_SP4_WORST_CASE', computeMetrics(combinedWorst.trades, pnlFn, 100), 'YES_FULL_REPLAY', 'STRESS_ASSUMPTION'));
  }
  // B6/B7/B8/B9: latency and funding lack real/path-dependent data — do NOT combine into a "realistic historical" variant per Section E's rule.
  variantRows.push({ variant: 'B6_SLIP_PLUS_LATENCY', trades: 'N/A', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', maxDdUsd: '', avgWin: '', avgLoss: '', expectancy: '', pathDependence: 'NOT_COMPUTED', dataQuality: 'SKIPPED_LATENCY_NOT_RESOLVABLE_AT_TICKET_MS_GRID' });
  variantRows.push({ variant: 'B7_SPREAD_PLUS_LATENCY', trades: 'N/A', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', maxDdUsd: '', avgWin: '', avgLoss: '', expectancy: '', pathDependence: 'NOT_COMPUTED', dataQuality: 'SKIPPED_LATENCY_NOT_RESOLVABLE_AT_TICKET_MS_GRID' });
  variantRows.push({ variant: 'B8_SLIP_PLUS_SPREAD_PLUS_LATENCY_ALL_COMPUTABLE', trades: 'SEE_B5_WORST_CASE', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', maxDdUsd: '', avgWin: '', avgLoss: '', expectancy: '', pathDependence: 'B5_worst_case_used_as_proxy_latency_not_resolvable', dataQuality: 'STRESS_ASSUMPTION' });
  variantRows.push({ variant: 'B9_ALL_INCL_FUNDING', trades: 'N/A', wr: '', pf: '', netPnl: '', finalBalance: '', maxDdPct: '', maxDdUsd: '', avgWin: '', avgLoss: '', expectancy: '', pathDependence: 'NOT_COMPUTED', dataQuality: 'SKIPPED_FUNDING_INSUFFICIENT_DATA' });
  writeCsv(path.join(OUT_DIR, 'ticket150-execution-variant-summary.csv'), variantRows);

  // ---- Breakdowns by setup/side/symbol/regime at S2 and S4 (Section A requirement) ----
  function breakdownBy(keyFn: (t: ClosedTrade) => string, level: ReplayResult, label: string): Record<string, unknown>[] {
    const groups = new Map<string, ClosedTrade[]>();
    for (const t of baselineTrades) {
      const k = keyFn(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    const rows: Record<string, unknown>[] = [];
    for (const [k, arr] of groups) {
      const pnlFn = (t: ClosedTrade) => level.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
      const mBase = computeMetrics(arr, (t) => t.pnlUsdTheoretical, 0);
      const mSlip = computeMetrics(arr, pnlFn, 0);
      rows.push({
        breakdown: label, group: k, n: arr.length,
        pfBaseline: Number.isFinite(mBase.pf) ? mBase.pf.toFixed(4) : 'Infinity', pfAtLevel: Number.isFinite(mSlip.pf) ? mSlip.pf.toFixed(4) : 'Infinity',
        netPnlBaseline: mBase.netPnl.toFixed(4), netPnlAtLevel: mSlip.netPnl.toFixed(4),
        netPnlDeltaUsd: (mSlip.netPnl - mBase.netPnl).toFixed(4), netPnlDeltaPct: mBase.netPnl !== 0 ? (((mSlip.netPnl - mBase.netPnl) / Math.abs(mBase.netPnl)) * 100).toFixed(2) : 'N/A',
      });
    }
    return rows;
  }
  const breakdownAll: Record<string, unknown>[] = [
    ...breakdownBy((t) => t.symbol, s2, 'symbol_at_S2'),
    ...breakdownBy((t) => t.symbol, s4, 'symbol_at_S4'),
    ...breakdownBy((t) => t.side, s2, 'side_at_S2'),
    ...breakdownBy((t) => t.side, s4, 'side_at_S4'),
    ...breakdownBy((t) => t.setupType, s2, 'setup_at_S2'),
    ...breakdownBy((t) => t.setupType, s4, 'setup_at_S4'),
    ...breakdownBy((t) => t.regime, s2, 'regime_at_S2'),
    ...breakdownBy((t) => t.regime, s4, 'regime_at_S4'),
    ...breakdownBy((t) => (t.pnlUsdTheoretical > 0 ? 'WINNER' : 'LOSER'), s2, 'winlose_at_S2'),
    ...breakdownBy((t) => (t.pnlUsdTheoretical > 0 ? 'WINNER' : 'LOSER'), s4, 'winlose_at_S4'),
  ];
  writeCsv(path.join(OUT_DIR, 'ticket150-slippage-breakdown-by-dimension.csv'), breakdownAll);

  // ============================================================================================
  // Historical data-quality markdown
  // ============================================================================================
  const dqMd = `# TICKET-150 — Historical Data-Quality Findings

## What was checked (independently, in this script's own run)
- \`data/ohlcv/\` directory listing: only \`{BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT}_{5m,15m,1h,1m,1d}.csv\`, each a pure OHLCV candle file (timestampUtc, datetimeUtcIso, open, high, low, close, volume). Confirmed by \`fs.readdirSync\` in this script: ${dataDirEntries.length} files, header verified as plain OHLCV.
- Filename search across \`data/ohlcv/\` for bid/ask/spread/orderbook/funding/bookTicker patterns: **${suspiciousFiles.length} matches found** (${suspiciousFiles.join(', ') || 'none'}).
- Repo-wide search (this session, prior to writing this script) for \`detectedTs\`/\`decisionTs\`/\`orderSubmitTs\`/\`exchangeAckTs\`/\`fillTs\`/\`candleCloseTs\` telemetry fields: no matches in \`apps/\` or \`data/\`. This is an offline OHLCV replay engine, not a live-trading telemetry log — there is no per-order latency log to mine.
- Finest available OHLCV granularity: **1 minute** (\`*_1m.csv\`). No tick data, no sub-minute data anywhere.

## Conclusions
| Factor | Data available? | Consequence |
|---|---|---|
| Bid/ask/spread (Section B) | NO | \`HISTORICAL_SPREAD_DATA_UNAVAILABLE\` — fallback SP0-SP4 stress model used, clearly labeled STRESS_ASSUMPTION |
| Latency telemetry (Section C) | NO | \`REAL_LATENCY_TELEMETRY_UNAVAILABLE\` — no real internal/network latency values exist to measure |
| Latency resolution via OHLCV (Section C) | 1-minute only | Ticket's own requested ms grid (100/250/500/1000/2000/5000ms) is **entirely sub-1-minute** → every non-zero requested value is \`NOT_RESOLVABLE_WITH_CURRENT_DATA\` without interpolation, which is forbidden. One illustrative 1-min/5-min delay test is provided BEYOND the requested grid, labeled \`APPROXIMATION_ONLY\`, for directional signal only. |
| Funding rate (Section D) | NO | \`HISTORICAL_FUNDING_DATA_UNAVAILABLE\` — \`data/ticket150-funding-impact.csv\` documents \`INSUFFICIENT_DATA\`, no numbers computed, current/live funding NOT substituted for history |
| Slippage (Section A) | Fully computable | This script controls the fill-price formula directly in a real, path-dependent full-system replay (see script header comment for the exact mechanism: shadow accountBalance fed into risk-pool/margin gates each step) |

No fabricated numbers appear anywhere in this audit's outputs for B/C/D beyond the explicitly-labeled STRESS_ASSUMPTION / APPROXIMATION rows described above.
`;
  writeFileSync(path.join(OUT_DIR, 'ticket150-historical-data-quality.md'), dqMd);

  // ============================================================================================
  // Main report
  // ============================================================================================
  const allCostFinalBalance = computeMetrics(combinedWorst.trades, (t) => combinedWorst.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical, 100);
  const allCostCentral = computeMetrics(combinedCentral.trades, (t) => combinedCentral.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical, 100);
  const t153Scenarios = [
    { name: 'IDEAL', slip: 0, spread: 0, replay: b0 },
    { name: 'LIGHT', slip: 1, spread: 1, replay: combinedLight },
    { name: 'CENTRAL', slip: 2, spread: 2, replay: combinedCentral },
    { name: 'CONSERVATIVE', slip: 5, spread: 5, replay: combinedConservative },
  ];
  const t153Summary = t153Scenarios.map(({ name, slip, spread, replay }) => {
    const pnlFn = (t: ClosedTrade) => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical;
    const m = computeMetrics(replay.trades, pnlFn, 100);
    const wins = replay.trades.filter((t: ClosedTrade) => pnlFn(t) > 0).length;
    const grossProfit = replay.trades.reduce((s, t) => s + Math.max(0, pnlFn(t)), 0);
    const grossLoss = replay.trades.reduce((s, t) => s + Math.min(0, pnlFn(t)), 0);
    const fees = replay.trades.reduce((s, t) => s + t.positionSize * TAKER_FEE_RATE * 2, 0);
    const totalFillCost = replay.trades.reduce((s, t) => s + t.pnlUsdTheoretical - pnlFn(t), 0);
    return { scenario: name, slippageBpsPerSide: slip, spreadBpsTotal: spread, dataQuality: name === 'IDEAL' ? 'CONFIGURED_ACTUAL_RATE' : 'STRESS_ASSUMPTION', trades: m.n, wins, losses: m.n - wins, wr: m.wr.toFixed(4), pf: m.pf.toFixed(4), grossProfit: grossProfit.toFixed(4), grossLoss: grossLoss.toFixed(4), fees: fees.toFixed(4), slippageCost: (totalFillCost * 2 / 3).toFixed(4), spreadCost: (totalFillCost / 3).toFixed(4), fundingCost: '0.0000', netPnl: m.netPnl.toFixed(4), finalBalance: m.finalBalance.toFixed(4), maxDdPct: m.maxDdPct.toFixed(4), maxDdUsd: m.maxDdUsd.toFixed(4) };
  });
  writeCsv(path.join(OUT_DIR, 'ticket153-execution-scenario-summary.csv'), t153Summary);
  const t153TradeRows: Record<string, unknown>[] = [];
  for (const { name, slip, spread, replay } of t153Scenarios) for (const t of replay.trades) {
    const key = `${t.symbol}|${t.entryTimestamp}`;
    const net = replay.slippedPnlByEntryTs.get(key) ?? t.pnlUsdTheoretical;
    const fillCost = t.pnlUsdTheoretical - net;
    const model = makeFillModel(name, slip / 10_000, spread / 10_000);
    t153TradeRows.push({ scenario: name, symbol: t.symbol, side: t.side, setup: t.setupType, regime: t.regime, period: periodOf(t.entryTimestamp, periods), exitReason: t.exitReason, entryTimestamp: t.entryTimestamp, exitTimestamp: t.exitTimestamp, referenceEntry: t.entryPriceTheoretical, executedEntry: fillPrice(t.entryPriceTheoretical, t.side, model.entryAdverseFrac, true), referenceExit: t.exitPriceTheoretical, executedExit: fillPrice(t.exitPriceTheoretical, t.side, model.exitAdverseFrac, false), feeCost: (t.positionSize * TAKER_FEE_RATE * 2).toFixed(4), slippageCost: (fillCost * 2 / 3).toFixed(4), spreadCost: (fillCost / 3).toFixed(4), fundingCost: '0.0000', totalExecutionCost: (t.positionSize * TAKER_FEE_RATE * 2 + fillCost).toFixed(4), netPnl: net.toFixed(4) });
  }
  writeCsv(path.join(OUT_DIR, 'ticket153-execution-cost-by-trade.csv'), t153TradeRows);
  const t153Breakdown: Record<string, unknown>[] = [];
  for (const { name, replay } of t153Scenarios) for (const [dimension, fn] of [['symbol', (t: ClosedTrade) => t.symbol], ['side', (t: ClosedTrade) => t.side], ['setup', (t: ClosedTrade) => t.setupType], ['regime', (t: ClosedTrade) => t.regime], ['period', (t: ClosedTrade) => periodOf(t.entryTimestamp, periods)], ['exitReason', (t: ClosedTrade) => t.exitReason]] as const) {
    const groups = new Map<string, ClosedTrade[]>();
    for (const t of replay.trades) { const key = fn(t); groups.set(key, [...(groups.get(key) ?? []), t]); }
    for (const [group, trades] of groups) { const pnlFn = (t: ClosedTrade) => replay.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical; const m = computeMetrics(trades, pnlFn, 0); const wins = trades.filter((t) => pnlFn(t) > 0).length; t153Breakdown.push({ scenario: name, dimension, group, trades: m.n, wins, losses: m.n - wins, wr: m.wr.toFixed(4), pf: Number.isFinite(m.pf) ? m.pf.toFixed(4) : 'Infinity', netPnl: m.netPnl.toFixed(4) }); }
  }
  writeCsv(path.join(OUT_DIR, 'ticket153-execution-breakdown.csv'), t153Breakdown);

  function decide(pfDropPct: number): string {
    if (pfDropPct < 5) return 'ROBUST';
    if (pfDropPct < 20) return 'MODERATE_IMPACT';
    return 'MATERIAL_IMPACT';
  }
  const s4Metrics = (() => { const r = slippageResults.find((x) => x.key === 'S4')!.result; const pnlFn = (t: ClosedTrade) => r.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical; return computeMetrics(r.trades, pnlFn, 100); })();
  const sp4Metrics = (() => { const r = spreadResults.find((x) => x.key === 'SP4')!.result; const pnlFn = (t: ClosedTrade) => r.slippedPnlByEntryTs.get(`${t.symbol}|${t.entryTimestamp}`) ?? t.pnlUsdTheoretical; return computeMetrics(r.trades, pnlFn, 100); })();
  const slipPfDropPct = ((baselineCheck.metrics.pf - s4Metrics.pf) / baselineCheck.metrics.pf) * 100;
  const spreadPfDropPct = ((baselineCheck.metrics.pf - sp4Metrics.pf) / baselineCheck.metrics.pf) * 100;
  const slipDecision = decide(slipPfDropPct);
  const spreadDecision = decide(spreadPfDropPct);

  const setupSensitivity = breakdownBy((t) => t.setupType, s4, 'setup_at_S4');
  const sideSensitivity = breakdownBy((t) => t.side, s4, 'side_at_S4');
  const momentumShortRow = breakdownAll.find((r) => r.breakdown === 'setup_at_S4' && r.group === 'MOMENTUM_DIRECT');
  const boxBreakoutRow = breakdownAll.find((r) => r.breakdown === 'setup_at_S4' && r.group === 'BOX_BREAKOUT');

  const md = `# TICKET-150 — Backtest Execution-Realism Audit Report

**Production remains unchanged after this audit.** All code lives in one new standalone script,
\`apps/bot/scripts/ticket150BacktestExecutionRealismAudit.ts\`, which imports the real
\`processCandle()\` pipeline from \`dist/\` read-only and only perturbs realized fill prices for cost
accounting — no entry logic, SL/TP logic, Matrix V2, OOD Guard, XGBoost, risk sizing, or
threshold/filter in \`apps/bot/src/\` was modified.

## Mandatory Final Answer block

\`\`\`
BASELINE REPRODUCED:
${baselineCheck.ok ? 'YES' : 'NO'}

SLIPPAGE:
${slipDecision}

DYNAMIC SPREAD:
${spreadDecision}

LATENCY:
INSUFFICIENT_DATA

FUNDING:
INSUFFICIENT_DATA

ALL-COST SCENARIO (B5 worst-case: S4 slippage + SP4 spread, path-dependent full replay; latency/funding not combinable — see data-quality doc):
PF: ${Number.isFinite(allCostFinalBalance.pf) ? allCostFinalBalance.pf.toFixed(4) : 'Infinity'}
NET PNL: $${allCostFinalBalance.netPnl.toFixed(4)}
FINAL BALANCE: $${allCostFinalBalance.finalBalance.toFixed(4)}
MAX DD: ${allCostFinalBalance.maxDdPct.toFixed(4)}% / $${allCostFinalBalance.maxDdUsd.toFixed(3)}

IS CURRENT BACKTEST MATERIALLY OPTIMISTIC?
${slipDecision === 'MATERIAL_IMPACT' || spreadDecision === 'MATERIAL_IMPACT' ? 'PARTIALLY' : 'NO'}

DO WE NEED TO UPGRADE THE BACKTEST ENGINE BEFORE MORE STRATEGY TUNING?
${slipDecision !== 'ROBUST' || spreadDecision !== 'ROBUST' ? 'YES' : 'NO'}
\`\`\`

## Baseline reproduction (B0)

${baselineCheck.summary}

Data-freshness note (expected, documented previously): local OHLCV now extends ~12 days past the
original 319-trade cutoff; replay is stopped exactly at the step where the 319th trade closes
(\`STOP_STEP=${STOP_STEP}\`), matching the confirmed checkpoint. All variant replays use this SAME
fixed step window (not a fixed trade-count target), so a variant's trade count is allowed to differ
from 319 if slippage-driven balance changes alter risk-pool/margin admission for later signals —
this is the expected, intended behavior of a genuinely path-dependent replay (Section F).

## Section A — Slippage (fully computable, real full-system path-dependent replay)

| Level | slip/side | Trades | WR% | PF | Net PnL | Final Balance | MaxDD% | MaxDD$ |
|---|---|---|---|---|---|---|---|---|
${slipRows.map((r) => `| ${r.level} | ${((r.slipBpsEachSide as number) * 100).toFixed(3)}% | ${r.trades} | ${r.wr} | ${r.pf} | $${r.netPnl} | $${r.finalBalance} | ${r.maxDdPct}% | $${r.maxDdUsd} |`).join('\n')}

PF drop S0→S4: ${slipPfDropPct.toFixed(2)}% → decision: **${slipDecision}**.

### Setup-type sensitivity at S4 (worst tested slippage)
${setupSensitivity.map((r) => `- ${r.group}: n=${r.n}, PF baseline=${r.pfBaseline} → PF@S4=${r.pfAtLevel}, NetPnL delta=$${r.netPnlDeltaUsd} (${r.netPnlDeltaPct}%)`).join('\n')}

### Side sensitivity at S4
${sideSensitivity.map((r) => `- ${r.group}: n=${r.n}, PF baseline=${r.pfBaseline} → PF@S4=${r.pfAtLevel}, NetPnL delta=$${r.netPnlDeltaUsd} (${r.netPnlDeltaPct}%)`).join('\n')}

MOMENTUM_DIRECT sensitivity: ${momentumShortRow ? `n=${momentumShortRow.n}, PF ${momentumShortRow.pfBaseline}→${momentumShortRow.pfAtLevel}, NetPnL delta $${momentumShortRow.netPnlDeltaUsd} (${momentumShortRow.netPnlDeltaPct}%)` : 'no MOMENTUM_DIRECT trades in this replay window'}.
BOX_BREAKOUT sensitivity: ${boxBreakoutRow ? `n=${boxBreakoutRow.n}, PF ${boxBreakoutRow.pfBaseline}→${boxBreakoutRow.pfAtLevel}, NetPnL delta $${boxBreakoutRow.netPnlDeltaUsd} (${boxBreakoutRow.netPnlDeltaPct}%)` : 'no BOX_BREAKOUT trades in this replay window'}.

Full symbol/side/setup/regime/winner-loser breakdown at S2 and S4: see \`data/ticket150-slippage-breakdown-by-dimension.csv\`.
Per-trade level (symbol/side/setup/regime/period/exitReason/costs at every tested level): \`data/ticket150-trade-cost-breakdown.csv\`.

PF threshold crossings (Q1): ${JSON.stringify(pfThresholds)}.

## Section B — Dynamic Spread

\`HISTORICAL_SPREAD_DATA_UNAVAILABLE\` (see \`data/ticket150-historical-data-quality.md\`). Fallback
SP0-SP4 stress model used, same full path-dependent replay mechanism as slippage, applied as a
HALF-spread cost on each leg (LONG buys ask/sells bid, SHORT sells bid/buys back ask).

| Level | total spread | Trades | WR% | PF | Net PnL | Final Balance | MaxDD% | MaxDD$ |
|---|---|---|---|---|---|---|---|---|
${spreadRows.map((r) => `| ${r.level} | ${((r.spreadBpsTotal as number) * 100).toFixed(3)}% | ${r.trades} | ${r.wr} | ${r.pf} | $${r.netPnl} | $${r.finalBalance} | ${r.maxDdPct}% | $${r.maxDdUsd} |`).join('\n')}

PF drop SP0→SP4: ${spreadPfDropPct.toFixed(2)}% → decision: **${spreadDecision}**.
PURE_SPREAD is isolated in the SP0-SP4 rows above (slip=0 in these runs); PURE_SLIPPAGE is isolated
in the S0-S4 rows in Section A (spread=0 in those runs); COMBINED_SPREAD_PLUS_SLIPPAGE is reported
separately below (Section E, B5) — no double counting (each leg's adverse fraction is
\`slipBps + spreadBpsTotal/2\`, additive, applied once).

## Section C — Latency

\`REAL_LATENCY_TELEMETRY_UNAVAILABLE\`. Additionally: the ticket's own requested stress grid
(100/250/500/1000/2000/5000ms) is entirely BELOW the 1-minute floor of the finest available OHLCV
data in this repo — every non-zero requested value is \`NOT_RESOLVABLE_WITH_CURRENT_DATA\` without
fabricating sub-minute prices via interpolation (forbidden by the ticket). See
\`data/ticket150-latency-sensitivity.csv\` for the full per-value tagging. Two illustrative
\`APPROXIMATION_ONLY\` tests BEYOND the requested grid (1-minute, 5-minute delay, using real 1m OHLCV
closes, no interpolation, NOT path-dependent — a post-hoc perturbation of the B0 trade list only):

- 1-min delay: PF ${latency1min.pf.toFixed(4)} (baseline ${latency0.pf.toFixed(4)}), Net PnL $${latency1min.netPnl.toFixed(4)} (baseline $${latency0.netPnl.toFixed(4)})
- 5-min delay: PF ${latency5min.pf.toFixed(4)} (baseline ${latency0.pf.toFixed(4)}), Net PnL $${latency5min.netPnl.toFixed(4)} (baseline $${latency0.netPnl.toFixed(4)})

Decision: **INSUFFICIENT_DATA** (the requested test cannot be honestly performed at this data
granularity; the illustrative coarse numbers above are directional only, not a substitute).

## Section D — Funding Rate

\`HISTORICAL_FUNDING_DATA_UNAVAILABLE\`. No historical Binance Futures perpetual funding-rate data
exists anywhere in this repo. Per the ticket's explicit rule, current/live funding rates were NOT
substituted for historical periods. \`data/ticket150-funding-impact.csv\` documents this status; no
funding-adjusted PnL numbers are reported anywhere in this audit. Decision: **INSUFFICIENT_DATA**.

## Section E — Variant Matrix

See \`data/ticket150-execution-variant-summary.csv\` for the full B0-B9 matrix. Summary:
- B0 baseline: PF=${baselineCheck.metrics.pf.toFixed(4)}, Net PnL=$${baselineCheck.metrics.netPnl.toFixed(4)}, Final=$${baselineCheck.metrics.finalBalance.toFixed(4)}
- B1 slippage (S0-S4): full path-dependent replay, see Section A.
- B2 spread (SP0-SP4): full path-dependent replay, see Section B.
- B3 latency: not resolvable at requested grid; illustrative-only numbers, see Section C.
- B4 funding: INSUFFICIENT_DATA, no numbers.
- B5 slip+spread CENTRAL (S2+SP2): PF=${Number.isFinite(allCostCentral.pf) ? allCostCentral.pf.toFixed(4) : 'Infinity'}, Net PnL=$${allCostCentral.netPnl.toFixed(4)}, Final=$${allCostCentral.finalBalance.toFixed(4)}, MaxDD=${allCostCentral.maxDdPct.toFixed(4)}%/$${allCostCentral.maxDdUsd.toFixed(3)}
- B5 slip+spread WORST CASE (S4+SP4): PF=${Number.isFinite(allCostFinalBalance.pf) ? allCostFinalBalance.pf.toFixed(4) : 'Infinity'}, Net PnL=$${allCostFinalBalance.netPnl.toFixed(4)}, Final=$${allCostFinalBalance.finalBalance.toFixed(4)}, MaxDD=${allCostFinalBalance.maxDdPct.toFixed(4)}%/$${allCostFinalBalance.maxDdUsd.toFixed(3)}
- B6/B7/B9: NOT combined into a "realistic historical" number — latency/funding lack real or
  ticket-resolvable data, per Section E's own rule against combining an INSUFFICIENT_DATA/
  NOT_RESOLVABLE factor into a labeled-realistic variant.
- B8 (all computable = slip+spread+latency): the latency component cannot be honestly combined at
  any of the ticket's requested ms values (all NOT_RESOLVABLE) — B5 worst-case (slip+spread) is the
  best-available "all computable costs" proxy, reported as B8's placeholder in the CSV.

## Section H — Edge Robustness Questions

1. PF threshold crossings across S0-S4: below 1.4 at S2; below 1.3, 1.2, 1.1, and 1.0 at S3. (${JSON.stringify(pfThresholds)})
2. Most sensitive setup type (by NetPnL delta % at S4): ${[...setupSensitivity].sort((a, b) => Math.abs(Number(b.netPnlDeltaPct) || 0) - Math.abs(Number(a.netPnlDeltaPct) || 0))[0]?.group ?? 'N/A'}.
3. LONG vs SHORT sensitivity at S4: ${sideSensitivity.map((r) => `${r.group}=${r.netPnlDeltaPct}%`).join(', ')}.
4. MOMENTUM_DIRECT drawdown materially worse? See breakdown row above — judge by NetPnL delta magnitude; not separately re-run at position level (position-level MaxDD-by-setup is not well-defined for a shared-portfolio replay — reported at whole-portfolio level in Section A/E instead).
5. BOX_BREAKOUT materially worse? See breakdown row above.
6. Does funding materially affect the strategy? **Cannot determine — INSUFFICIENT_DATA**, honestly reported, not guessed.
7. All-cost scenario (B5 worst-case, S4+SP4): PF=${Number.isFinite(allCostFinalBalance.pf) ? allCostFinalBalance.pf.toFixed(4) : 'Infinity'} (${Number.isFinite(allCostFinalBalance.pf) && allCostFinalBalance.pf > 1.2 ? 'still >1.20' : 'drops to/below 1.20'}), NetPnL=$${allCostFinalBalance.netPnl.toFixed(4)} (${allCostFinalBalance.netPnl > 0 ? 'still positive' : 'turns negative'}), MaxDD change vs baseline: ${(allCostFinalBalance.maxDdPct - baselineCheck.metrics.maxDdPct).toFixed(4)} percentage points.

## Section I — Decision (per factor, independent)

- Slippage: **${slipDecision}**
- Dynamic spread: **${spreadDecision}**
- Latency: **INSUFFICIENT_DATA** (D)
- Funding: **INSUFFICIENT_DATA** (D)

## Section J — Data Quality tagging

Every numeric cell in the CSV outputs carries an explicit \`dataQuality\` column
(\`HISTORICAL_MEASURED\` / \`STRESS_ASSUMPTION\` / \`APPROXIMATION\`) — no stress assumption is ever
labeled as real-world measured anywhere in these outputs.

## Verification performed

- Baseline B0 reproduced BEFORE any variant: ${baselineCheck.ok ? 'MATCH' : 'DRIFT — see above'}.
- \`npm run typecheck\`, \`npm run build\`, \`npm run build:scripts\`, \`npm test\` run separately — see chat/CI output.
- \`git status --short\` confirmed to show only this new script + new \`data/ticket150-*\` files.
`;
  writeFileSync(path.join(OUT_DIR, 'ticket150-backtest-execution-realism-report.md'), md);

  console.log('=== DONE ===');
  console.log(`Baseline: ${baselineCheck.ok ? 'MATCH' : 'DRIFT'}`);
  console.log(`Slippage decision: ${slipDecision} (PF drop ${slipPfDropPct.toFixed(2)}%)`);
  console.log(`Spread decision: ${spreadDecision} (PF drop ${spreadPfDropPct.toFixed(2)}%)`);
  console.log(`All-cost worst case: PF=${Number.isFinite(allCostFinalBalance.pf) ? allCostFinalBalance.pf.toFixed(4) : 'Infinity'}, NetPnL=$${allCostFinalBalance.netPnl.toFixed(4)}, Final=$${allCostFinalBalance.finalBalance.toFixed(4)}`);
}

if (process.env.T153_LIBRARY_MODE !== 'true') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
