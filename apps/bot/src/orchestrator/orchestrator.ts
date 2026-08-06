/**
 * TICKET-010 Phần B — wires Regime -> Entry -> Position Sizing -> RiskPool -> SL/TP Manager for
 * one symbol's newly-closed 5m candle. Pure function: caller persists the returned SymbolState
 * and accountBalance, feeding them back on the next call (same pattern as regime/'s hysteresis).
 * Does NOT invent TP/SL/fee/sizing formulas — only calls the existing functions in risk/.
 */
import { detectRegime } from '../regime/regimeDetector.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { MarketRegime, type CandleData, type ComputedMetrics, type RegimeOutput } from '../regime/types.js';
import { classifyHtfContextCandidate } from '../regime/htfContext.js';
import { classifySafetyState5mCandidate, applySafetyState5mHysteresis } from '../regime/safetyState5m.js';
import { applySafetyState5mStabilization } from '../regime/safetyState5mTracker.js';
import { applySafetyState5mFinalStabilization } from '../regime/safetyState5mTrackerV2.js';
import { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import { computeLocalTradeThesis5m, type LocalTradeThesis5mResult } from './localTradeThesis5m.js';
import { computeMomentumThesis, computeMomentumCandidateIntegrity } from './setupThesis/momentumThesis.js';
import type { MomentumCandidateIntegrityResult } from './setupThesis/momentumThesis.js';
import { computeMomentumContextDecision } from './momentumContextDecisionMatrix.js';
import { computePullbackThesis } from './setupThesis/pullbackThesis.js';
import { computeBreakoutThesis } from './setupThesis/breakoutThesis.js';
import { computeReversalThesis } from './setupThesis/reversalThesis.js';
import type { SetupThesisResult } from './setupThesis/types.js';
import { routeEntry } from '../entry/entryRouter.js';
import { EntryConfig } from '../entry/config.js';
import { detectMomentumDirect } from '../entry/momentumDirect.js';
import type { DraftSetup, FunnelCallback } from '../entry/types.js';
import { detectSwingPoints, latestSwingPointBefore } from '../entry/detectors/swingPoints.js';
import { computeDirection5m, type Direction5m } from './neutral5mDirectionSelector.js';
import { computeDirection5mRelaxed } from './neutral5mDirectionGatedRouting.js';
import { is5mConfirmed } from './neutralMacroConflictOverride.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../xgbFilter/momentumScorer.js';
import { computeMomentumMultiplier } from '../xgbFilter/momentumMultiplier.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH, MOMENTUM_BEARISH_MODEL_PATH, MOMENTUM_BEARISH_SCHEMA_PATH, type PlanAutoSelectionConfig } from '../xgbFilter/config.js';
import { DynamicRMarginSizer } from '../risk/dynamicRMarginSizer.js';
import { checkRiskPool, wouldExceedRiskPool, wouldExceedMaxTotalMargin, type OpenPositionRisk } from '../risk/riskPool.js';
import {
  applyAtrTrailing,
  computeRealizedPnl,
  computeTierNetPnl,
  isSlHitAtPrice,
  isTpHit,
  onCounterTrendTpHit,
  onSlHit,
  onTp1Hit,
  onTp2Hit,
  openPosition,
  priceAtR,
  updateGivebackProtection,
  type ManagedPositionState,
  type SlTpManagerInput,
  type TpLevel,
  type TpPlan,
} from '../risk/slTpManager.js';
import type {
  ExitReason,
  MomentumDirectCircuitBreakerSideState,
  OpenPositionEntry,
  OpenTradeEvent,
  OrchestratorConfig,
  OrchestratorEvent,
  SkippedEntryEvent,
  SymbolState,
} from './types.js';

export interface ProcessCandleInput {
  symbol: string;
  /** Ending at "now" — last element is the 5m candle that just closed. Caller controls window size (no look-ahead). */
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  /** TICKET-017 Phần A: daily candles, ending at "now" like the other timeframes — feeds the macro trend filter (unused unless EntryRouterConfig.macroTrendFilterEnabled is true). */
  candles1d: CandleData[];
  /**
   * TICKET-024 Phần B: 1h candles ending at "now", SEPARATE from `candles1h` above and sized much
   * longer (>= EMA_1H_SLOW_PERIOD = 200 candles) — momentum's emaRatioSlow needs 200 1h candles of
   * history, far more than regime/entry's own `candles1h` window (40) ever needed. Deliberately kept
   * as its own field rather than just enlarging `candles1h` itself: Wilder's RMA-style smoothing
   * (used throughout regime/) is NOT invariant to how far back the window starts — a longer window
   * changes the seed point and therefore the tail ADX/DI values regime classification reads, which
   * would silently change entry/backtest results this ticket must not touch. Unused unless
   * momentumFilterConfig.momentumFilterEnabled is true.
   */
  candles1hMomentum: CandleData[];
  /**
   * TICKET-028: 5m candles ending at "now", SEPARATE from `candles5m` above and sized for
   * RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS+ days of history — same reasoning as
   * `candles1hMomentum` above (LOW_LIQUIDITY's session-relative volume needs far more 5m history
   * than regime/entry's own candles5m window ever needed). Optional: omit to leave LOW_LIQUIDITY
   * permanently unreachable (no error) rather than change any existing metric's behavior.
   */
  candles5mSessionVolume?: CandleData[];
  /**
   * TICKET-030: pre-computed cross-symbol correlation ratio (regime/correlatedRisk.ts), same value
   * for all 4 symbols at this time-step — the caller (backtest.ts / live wiring) computes this ONCE
   * per step across all 4 coins and passes the same number into every symbol's processCandle() call.
   * Orchestrator does NOT compute this itself, only passes it through to detectRegime(). Optional:
   * omit to leave CORRELATED_RISK permanently unreachable (no error).
   */
  correlatedRiskRatio?: number;
  accountBalance: number;
  /**
   * TICKET-056: renamed from `otherOpenPositionsRisk` — MUST now include THIS symbol's own
   * already-open position(s) too (previously excluded by construction, since a symbol could never
   * have an open position when routeEntry() was tried). Caller (backtest.ts) is responsible for
   * summing/listing every currently open position across every symbol, including this one.
   */
  allOpenPositionsRisk: OpenPositionRisk[];
  /**
   * TICKET-068 — total count of currently open setupType='MOMENTUM_DIRECT' positions across ALL
   * symbols (including this one), same one-step-lag convention as allOpenPositionsRisk (caller
   * computes it once per step, before that step's per-symbol processCandle() calls, from each
   * symbol's own state entering the step). Optional: omit to leave momentumDirectMaxTotalConcurrent
   * permanently non-blocking (treated as 0 open — never blocks on its own).
   */
  momentumDirectOpenPositionsTotal?: number;
  /**
   * TICKET-070 — per-position detail (symbol + side) of every currently open setupType='MOMENTUM_DIRECT'
   * position across ALL symbols, same one-step-lag convention as momentumDirectOpenPositionsTotal
   * above (caller computes it once per step, before that step's per-symbol processCandle() calls).
   * Optional: omit to leave momentumDirectCorrelationBlockThreshold permanently non-blocking (treated
   * as no other same-side positions open).
   */
  momentumDirectOpenPositions?: Array<{ symbol: string; side: 'LONG' | 'SHORT' }>;
  /**
   * TICKET-101 Việc 2 — sum of `meta.marginRequired` across every currently open position on ALL 4
   * symbols combined (not just this one) — a SINGLE aggregate number, unlike `allOpenPositionsRisk`'s
   * per-symbol breakdown, since `wouldExceedMaxTotalMargin()` only ever needs the total. Caller is
   * responsible for keeping this live-updated WITHIN a single step/tick as earlier symbols open new
   * positions (same fix TICKET-101 Việc 1 applied to `allOpenPositionsRisk`) — a stale pre-step
   * snapshot would under-count real concentration exactly like the Việc 1 bug did. Optional: omit to
   * leave `config.maxTotalMarginPct` permanently non-blocking (treated as 0 margin in use).
   */
  totalOpenMarginDollar?: number;
}

export interface ProcessCandleResult {
  symbolState: SymbolState;
  accountBalance: number;
  /** TICKET-056: was `event: OrchestratorEvent | null` — a single candle can now produce multiple events (e.g. one or more CLOSEs plus an OPEN/SKIPPED) since a symbol may hold multiple concurrent positions. Empty array = no events this candle. */
  events: OrchestratorEvent[];
}

/**
 * TICKET-027 — diagnostic-only payload for the moment regime freshly transitions into MANIPULATED
 * (fast-in confirmation, not just candidate). Not part of normal orchestrator output — only built
 * and delivered when the caller passes onManipulatedConfirmed to processCandle.
 */
export interface ManipulatedDiagnostic {
  symbol: string;
  timestamp: number;
  upperSweepCount: number;
  lowerSweepCount: number;
  volumeZScore5m: number;
  lookbackWindow: CandleData[];
}

/**
 * TICKET-033 — diagnostic-only payload for the moment regime freshly transitions into DANGER_ZONE
 * (fast-in confirmation, not just candidate). Same pattern as ManipulatedDiagnostic/TICKET-027 —
 * not part of normal orchestrator output, only built and delivered when the caller passes
 * onDangerZoneConfirmed to processCandle.
 */
export interface DangerZoneDiagnostic {
  symbol: string;
  timestamp: number;
  atrPercentile5m: number;
  volumeZScore5m: number;
}

/**
 * TICKET-055 — TEMPORARY, verification-only payload: fires whenever regime is confirmed TREND_RIDER
 * and routeEntry() returns without ever firing a stage='SETUP' FunnelEvent — i.e. runTrendStyle()
 * took some early-return path before reaching either `onFunnelEvent(..., {stage:'SETUP', passed:true})`
 * or the `NO_SETUP_FOUND`-replacement fail event. Exists to verify TICKET-054's claim (all 1,677
 * SETUP-FAIL-breakdown gap cases are the single known adxDirection1h undefined/FLAT early return in
 * entryRouter.ts's runTrendStyle()) with real counted data instead of trusting the code-reading alone.
 * Not part of normal orchestrator output — only built/delivered when the caller passes
 * onSetupNotFiredDiagnostic to processCandle. Not required to be kept long-term once verified.
 */
export interface SetupNotFiredDiagnostic {
  symbol: string;
  timestamp: number;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
}

/**
 * TICKET-109 — diagnostic-only payload for EVERY momentum-gate score computed, both PASSED and
 * REJECTED (unlike OpenTradeEvent, which only ever shows the eventual accepted trade). Fires at the
 * two existing gate points that already compute a score + pass/fail every relevant step:
 * tryMomentumDirect() (both LONG and SHORT scored every call) and the NEUTRAL_TRANSITION regime's
 * mandatory momentum gate (routeEntry()'s own DraftSetup.side only). Same pattern as
 * ManipulatedDiagnostic/DangerZoneDiagnostic/SetupNotFiredDiagnostic above — pure pass-through, never
 * read here, never affects any decision. Only built/delivered when the caller passes
 * onMomentumGateEvaluation to processCandle.
 */
export interface MomentumGateEvaluation {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  gateType: 'MOMENTUM_DIRECT' | 'NEUTRAL_TRANSITION';
  /** Underlying DraftSetup setupType: always 'MOMENTUM_DIRECT' for gateType='MOMENTUM_DIRECT'; one of OB/FVG/BOX_BREAKOUT/SWEEP for gateType='NEUTRAL_TRANSITION' (routeEntry() never builds a NEUTRAL_TRANSITION DraftSetup with setupType='MOMENTUM_DIRECT' — that path is handled entirely by tryMomentumDirect()). */
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  score: number;
  threshold: number;
  passed: boolean;
  /** The candle close price at this timestamp — the hypothetical entry if this candidate had been taken. */
  entryPriceCandidate: number;
  /** The SL price this candidate WOULD have used, computed via the exact same existing formula the real setup uses for this gateType (never a new formula). */
  slPriceCandidate: number;
  /** TICKET-119 — diagnostic-only pass-through of regimeOutput.regime at this call site, for offline analysis (regime-segmented AUC breakdowns). Optional: never read by any decision logic. */
  regime?: MarketRegime;
  /** TICKET-122 — diagnostic-only: true when this SHORT MOMENTUM_DIRECT evaluation's emaRatioSlow was flagged OOD by config.oodGuardConfig (undefined/false whenever the guard is inert, and always undefined for LONG). Never itself read by any decision logic — only for offline counting of "candidates affected by the guard". */
  oodFlagged?: boolean;
  /**
   * TICKET-130 — diagnostic-only pass-through of the Neutral 5m Direction Selector's verdict at
   * this call site. undefined whenever the selector is inactive (config.neutral5mDirectionSelectorEnabled
   * !== true, or regime !== NEUTRAL_TRANSITION) — same value on both the LONG and SHORT evaluation
   * rows for a given symbol+timestamp (it's computed once per tryMomentumDirect() call, not per side).
   * Never itself read by any decision logic here — only for offline report breakdowns.
   */
  direction5m?: Direction5m;
  /**
   * TICKET-130 — diagnostic-only: true when this exact side would have passed the AI momentum gate
   * (longPassesAiOnly/shortPassesAiOnly) but was vetoed solely because it disagreed with
   * direction5m. Always false/undefined when the selector is inactive. Lets offline reports isolate
   * "candidates the selector actually rejected" from "candidates the AI gate itself rejected".
   */
  rejectedByDirectionSelector?: boolean;
  /**
   * TICKET-131 — diagnostic-only pass-through of the RELAXED (2-of-2 EMA+DI) Neutral 5m
   * Direction-Gated Routing verdict at this call site (gateType='NEUTRAL_TRANSITION' rows only,
   * setupType one of OB/FVG/BOX_BREAKOUT/SWEEP). `undefined` whenever the routing is inactive
   * (config.neutral5mDirectionGatedRoutingEnabled !== true, or regime !== NEUTRAL_TRANSITION, or the
   * candidate is MOMENTUM_DIRECT — this routing never applies to that setupType). Never itself read by
   * any decision logic here — only for offline report breakdowns (distinguishing candidates blocked by
   * NONE vs blocked by side mismatch vs let through).
   */
  direction5mGatedRouting?: Direction5m;
  /**
   * TICKET-131 — diagnostic-only: true when this candidate's own side matched direction5mGatedRouting
   * and it was let through to the (unmodified) AI momentum gate check below; false when it was
   * rejected by the new routing logic itself (direction5m===NONE, or direction5m disagreed with this
   * candidate's side) before ever reaching that AI gate. Always undefined when the routing is inactive.
   */
  neutral5mRoutingAccepted?: boolean;
  /**
   * TICKET-131 — diagnostic-only pass-through of neutral5mDirectionGatedRouting.ts's structural break
   * sub-computation, which NEVER affects direction5mGatedRouting's own verdict (structure is
   * diagnostic-only for this ticket, unlike TICKET-130 where it's a hard 3rd requirement). Undefined
   * whenever direction5mGatedRouting itself is undefined.
   */
  structuralBreakDiagnostic5m?: Direction5m;
  /**
   * TICKET-138 — diagnostic-only: true when THIS side's candidate conflicts with the 1D macro
   * direction ((side==='LONG' && macroDirection==='DOWN') || (side==='SHORT' && macroDirection==='UP')).
   * Computed and reported for gateType='MOMENTUM_DIRECT' rows whenever regime===NEUTRAL_TRANSITION,
   * REGARDLESS of config.neutralMacroConflictOverrideMode (so offline reports can see the conflict
   * rate even on a 'NONE'/'UNFILTERED' run) — never itself read by any decision logic here. undefined
   * for every other regime (macro conflict is only ever actionable for NEUTRAL_TRANSITION per this
   * ticket's scope).
   */
  macroConflict?: boolean;
  /**
   * TICKET-138 — diagnostic-only pass-through of neutralMacroConflictOverride.ts's is5mConfirmed()
   * verdict for this exact side. Only computed (non-undefined) when macroConflict===true (no reason to
   * evaluate it otherwise) — computed REGARDLESS of config.neutralMacroConflictOverrideMode, so a
   * 'NONE'/'UNFILTERED' offline report can still see what the CONDITIONAL_5M rule would have decided.
   * Never itself read by any decision logic here except inside tryMomentumDirect()'s own
   * evaluateMacroConflictOverride() when mode==='CONDITIONAL_5M' — this field is a pure pass-through of
   * that same computation, not a second independent evaluation.
   */
  macroConflict5mConfirmed?: boolean;
  /**
   * TICKET-138 — diagnostic-only: true when this side's macro conflict was ACTUALLY overridden (the
   * hard block was skipped) per config.neutralMacroConflictOverrideMode. Always false when
   * macroConflict!==true, or when the mode is 'NONE'. Note: this reflects what evaluateMacroConflictOverride()
   * computed for this side in the pre-side-selection diagnostic pass — the REAL production decision is
   * only ever applied to whichever side tryMomentumDirect() actually selected as `side` further down.
   */
  macroConflictOverridden?: boolean;
}

/**
 * TICKET-143 — diagnostic-only pass-through, fires ONLY when config.momentumContextDecisionMatrixEnabled
 * is true, once per real tryMomentumDirect() candidate that reaches the decision point (post AI gate,
 * post circuit breaker — same point the old unconditional macro-conflict block used to fire). Never
 * read by any decision logic — this is purely for the ticket's required CSV/report output.
 */
export interface MomentumContextDecisionDiagnostic {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  htfContext: HTFContext;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroConflict: boolean;
  safetyState5m: SafetyState5m;
  modelScore: number;
  momentumScore: number;
  decision: 'ALLOW_NORMAL' | 'ALLOW_REDUCED_RISK' | 'BLOCK';
  riskMultiplier: number;
  decisionReason: string;
}

function touchesFavorable(side: 'LONG' | 'SHORT', candle: CandleData, price: number): boolean {
  return side === 'LONG' ? isTpHit(side, candle.high, price) : isTpHit(side, candle.low, price);
}

function touchesAdverse(side: 'LONG' | 'SHORT', candle: CandleData, price: number): boolean {
  return side === 'LONG' ? isSlHitAtPrice(side, candle.low, price) : isSlHitAtPrice(side, candle.high, price);
}

/**
 * Step 3 (Part B): advance an already-open position by one 5m candle. Returns the new state and,
 * if it closed this candle, the exit reason + price. Exported (TICKET-019): generateTrainingData.ts
 * reuses this exact function for its parallel shadow simulation, instead of re-deriving SL/TP logic.
 */
export function advancePosition(
  pos: ManagedPositionState,
  candle: CandleData,
  candles5m: CandleData[],
  isLowConfidenceOrLowLiquidity: boolean,
): { position: ManagedPositionState; exitReason: ExitReason | null; exitPrice: number | null } {
  if (pos.scenario === 'COUNTER_TREND') {
    const tp = pos.tpLevels[0];
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tpTouched = tp.price !== null && touchesFavorable(pos.side, candle, tp.price);
    if (slTouched && tpTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice }; // same-candle rule: SL first
    if (tpTouched) return { position: onCounterTrendTpHit(pos), exitReason: 'COUNTER_TREND_TP', exitPrice: tp.price as number };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  const tp1 = pos.tpLevels.find((t) => t.label === 'TP1');
  const tp2 = pos.tpLevels.find((t) => t.label === 'TP2');
  const tp1Filled = pos.filledTiers.includes('TP1');
  const tp2Filled = pos.filledTiers.includes('TP2');

  if (!tp1Filled && tp1) {
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tp1Touched = tp1.price !== null && touchesFavorable(pos.side, candle, tp1.price);
    if (slTouched && tp1Touched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    if (tp1Touched) return { position: onTp1Hit(pos), exitReason: null, exitPrice: null };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  if (!tp2Filled && tp2) {
    // TICKET-016: TP1 already filled here, so this SL is the post-TP1 breakeven+fee stop, not a
    // raw loss — distinct label from the !tp1Filled branch above.
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tp2Touched = tp2.price !== null && touchesFavorable(pos.side, candle, tp2.price);
    if (slTouched && tp2Touched) return { position: onSlHit(pos), exitReason: 'BREAKEVEN_SL', exitPrice: pos.currentSlPrice };
    if (tp2Touched) return { position: onTp2Hit(pos), exitReason: null, exitPrice: null };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'BREAKEVEN_SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  // Runner phase — trail with ATR (Structure trailing not used this ticket), then Giveback, then check the (possibly tightened) SL.
  const favorablePrice = pos.side === 'LONG' ? candle.high : candle.low;
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  let trailed = pos;
  if (atr !== undefined) {
    trailed = applyAtrTrailing(pos, favorablePrice, atr);
    trailed = updateGivebackProtection(trailed, favorablePrice, isLowConfidenceOrLowLiquidity);
  }
  const slTouched = touchesAdverse(trailed.side, candle, trailed.currentSlPrice);
  if (slTouched) return { position: onSlHit(trailed), exitReason: 'RUNNER_SL', exitPrice: trailed.currentSlPrice };
  return { position: trailed, exitReason: null, exitPrice: null };
}

// TICKET-024 Phần B.1 / TICKET-025 Phần C: cached across calls — read once, never re-parsed per
// candle. Schema content itself is still always read fresh from disk on first use, never
// hard-coded in TS. Bullish (LONG) and bearish (SHORT) are separately-trained models — their
// schemas are NOT assumed identical (category order can legitimately differ) and are cached apart.
// TICKET-098: keyed by path (Map, same pattern momentumScorer.ts's own sessionCache already uses)
// since config.momentumSchemaPath/momentumBearishSchemaPath can now vary per OrchestratorConfig
// (--momentum-model-version A/B testing) — a single cached value would go stale across configs.
const schemaCache = new Map<string, FeatureSchema>();
function getSchemaCached(schemaPath: string): FeatureSchema {
  let cached = schemaCache.get(schemaPath);
  if (cached === undefined) {
    cached = loadFeatureSchema(schemaPath);
    schemaCache.set(schemaPath, cached);
  }
  return cached;
}

/**
 * Shared by the soft momentumMultiplier (TICKET-024/025) and the hard NEUTRAL_TRANSITION Momentum
 * Gate (TICKET-036) — same scoring call, same LONG/SHORT model split, never re-derived twice.
 * Undefined = insufficient EMA/ATR history for computeMomentumCrossFeatures (never itself an error;
 * each caller decides what "no score" means for its own purpose).
 */
/**
 * TICKET-098: correlatedRiskRatio + distanceToNearestSwingAtr are only ever READ by
 * buildFeatureVector() when the loaded schema's feature_order actually references them (model V3+
 * — schema-driven, never hardcoded per TICKET-024's original design) — computing them unconditionally
 * here is cheap and keeps this function oblivious to which model version is active.
 * distanceToNearestSwingAtr reuses detectSwingPoints/latestSwingPointBefore exactly as
 * entry/detectors/orderBlock.ts does: candles5m here is already the caller's own window truncated to
 * "now" (this function's own contract, unchanged), so — unlike generateMomentumTrainingDataV2/V3.ts's
 * precompute-over-full-history case — no `i - fractalN` offset is needed; detectSwingPoints's own
 * loop bound already refuses to confirm a point too close to the end of a "now"-truncated window.
 */
function computeDistanceToNearestSwingAtr(candles5m: CandleData[]): number | undefined {
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined || atr <= 0) return undefined;
  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);
  const lastIndex = candles5m.length - 1;
  const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', lastIndex);
  const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', lastIndex);
  if (nearestHigh === null && nearestLow === null) return undefined;
  const close = candles5m[lastIndex].close;
  const distHigh = nearestHigh !== null ? Math.abs(close - nearestHigh.price) : Infinity;
  const distLow = nearestLow !== null ? Math.abs(close - nearestLow.price) : Infinity;
  return Math.min(distHigh, distLow) / atr;
}

async function scoreMomentumForSide(
  side: 'LONG' | 'SHORT',
  symbol: string,
  candles5m: CandleData[],
  candles1hMomentum: CandleData[],
  regimeOutput: RegimeOutput,
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
  correlatedRiskRatio: number | undefined,
  config: OrchestratorConfig,
): Promise<number | undefined> {
  const crossFeatures = computeMomentumCrossFeatures(candles5m, candles1hMomentum);
  if (crossFeatures === undefined) return undefined;
  const isLong = side === 'LONG';
  // TICKET-098: defaults to the production v1 paths (xgbFilter/config.ts) when config doesn't
  // override them — matches every ticket before this one exactly.
  const modelPath = isLong ? (config.momentumModelPath ?? MOMENTUM_MODEL_PATH) : (config.momentumBearishModelPath ?? MOMENTUM_BEARISH_MODEL_PATH);
  const schemaPath = isLong ? (config.momentumSchemaPath ?? MOMENTUM_SCHEMA_PATH) : (config.momentumBearishSchemaPath ?? MOMENTUM_BEARISH_SCHEMA_PATH);
  const schema = getSchemaCached(schemaPath);
  const featureVector = buildFeatureVector(
    {
      symbol,
      adx1h: regimeOutput.computedMetrics.adx1h as number,
      atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
      atrTrend5m: regimeOutput.computedMetrics.atrTrend5m as string,
      adxDirection1h: regimeOutput.adxDirection1h as string,
      macroDirection,
      correlatedRiskRatio,
      distanceToNearestSwingAtr: computeDistanceToNearestSwingAtr(candles5m),
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

/**
 * TICKET-052 — AI-driven Plan A/B selection. Pure function, no formula changes to computeTpLevels()
 * itself: a highly-confident entry (own-side momentum score >= threshold) uses PLAN_B, everything
 * else — including an undetermined score (insufficient EMA/ATR history), same "an toàn" requirement
 * as every other gate in this file — falls back to whatever tpPlan the caller already chose.
 * Off by default: config.planAutoSelectionEnabled=false always returns defaultPlan unchanged.
 * TREND scenario only by construction: only ever called from the one place that builds a TREND
 * SlTpManagerInput (entryRouter.ts has had no COUNTER_TREND path since TICKET-051 removed BOX_BOUNCE
 * — Plan A/B has no meaning for COUNTER_TREND's single-exit Mục 7 design regardless).
 */
export function selectTpPlan(defaultPlan: TpPlan, momentumScore: number | undefined, config: PlanAutoSelectionConfig): TpPlan {
  if (!config.planAutoSelectionEnabled) return defaultPlan;
  if (momentumScore !== undefined && momentumScore >= config.planAutoSelectionMomentumThreshold) return 'PLAN_B';
  return defaultPlan;
}

/**
 * TICKET-059 — mirrors scripts/entryFunnelReport.ts's STATE_FAIL_REGIMES (same 5 MarketRegime
 * values, "Entry Funnel Analytics 'STATE PASS'"). Duplicated locally rather than imported: src/ is
 * its own compilation unit and cannot depend on scripts/ (which itself depends on dist/, built FROM
 * src/ — importing the other way would be a wrong-direction/circular dependency).
 */
export const MOMENTUM_DIRECT_BLOCKED_REGIMES: readonly MarketRegime[] = [
  MarketRegime.DANGER_ZONE,
  MarketRegime.MANIPULATED,
  MarketRegime.LOW_LIQUIDITY,
  MarketRegime.VOLATILE_CHOP,
  MarketRegime.CORRELATED_RISK,
];

/**
 * TICKET-109 — extracted verbatim from tryMomentumDirect()'s inline SL computation below (no
 * behavior change to the real path) so the same exact formula can also produce a hypothetical SL
 * price for the diagnostic-only MomentumGateEvaluation of the SIDE THAT DIDN'T become the actual
 * candidate (tryMomentumDirect only ever computed this for its one chosen `side` before this ticket).
 */
export function computeMomentumDirectSlPrice(side: 'LONG' | 'SHORT', entryPrice: number, currentCandle: CandleData, atr: number, config: OrchestratorConfig): number {
  // Sweep-style SL: nearest extreme point (current candle's own low/high, since MOMENTUM_DIRECT has
  // no OB/FVG/Sweep zone to anchor to) ± ATR buffer.
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;

  // TICKET-064 Phần A — widen the SL out to momentumDirectMinSlPercent when the ATR-based distance
  // is narrower than that floor; leave it untouched when it's already wider.
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < config.momentumDirectMinSlPercent) {
    const flooredDistance = (config.momentumDirectMinSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  return slPrice;
}

/**
 * TICKET-138 — single shared evaluation for both (a) the pre-side-selection diagnostic capture (both
 * LONG and SHORT, always computed whenever regime===NEUTRAL_TRANSITION, independent of `mode` — see
 * MomentumGateEvaluation's macroConflict / is5mConfirmed doc comments) and (b) the real decision at the
 * mandatory macro-alignment check further down (only for the finally-chosen `side`). Kept as one
 * function so the diagnostic fields and the real decision can never drift out of sync with each other.
 * `mode==='NONE'` (or regime!==NEUTRAL_TRANSITION, or no macro conflict at all) never overrides —
 * byte-identical to every ticket before this one.
 */
export function evaluateMacroConflictOverride(
  side: 'LONG' | 'SHORT',
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
  regime: MarketRegime,
  candles5m: CandleData[],
  mode: 'NONE' | 'UNFILTERED' | 'CONDITIONAL_5M',
): { macroConflict: boolean; is5mConfirmed?: boolean; overridden: boolean } {
  const macroConflict = (side === 'LONG' && macroDirection === 'DOWN') || (side === 'SHORT' && macroDirection === 'UP');
  if (!macroConflict || regime !== MarketRegime.NEUTRAL_TRANSITION) {
    return { macroConflict, overridden: false };
  }
  // Always computed once macroConflict+NEUTRAL_TRANSITION hold, regardless of `mode` — cheap
  // (EMA9/EMA21/DI on the existing 5m window) and lets offline reports see the CONDITIONAL_5M verdict
  // even on a 'NONE'/'UNFILTERED' run.
  const confirmed = is5mConfirmed(candles5m, side);
  const overridden = mode === 'UNFILTERED' ? true : mode === 'CONDITIONAL_5M' ? confirmed : false;
  return { macroConflict, is5mConfirmed: confirmed, overridden };
}

/**
 * TICKET-059 Phần B — the AI momentum score used DIRECTLY as an entry signal, independent of
 * OB/FVG/Sweep/Box Breakout/MSS. Only ever tried by the caller when routeEntry()'s cascade already
 * returned null for this candle (see tryOpenNewPosition below) — never replaces or short-circuits it.
 * Mirrors (does not call — entryRouter.ts stays untouched per the ticket) the same macro-trend-filter
 * condition and ATR-based SL buffer formula runTrendStyle() uses for its Sweep fallback.
 */
async function tryMomentumDirect(
  input: ProcessCandleInput,
  config: OrchestratorConfig,
  regimeOutput: RegimeOutput,
  currentCandle: CandleData,
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
  circuitBreakerState: { LONG: MomentumDirectCircuitBreakerSideState; SHORT: MomentumDirectCircuitBreakerSideState },
  onMomentumGateEvaluation: ((evaluation: MomentumGateEvaluation) => void) | undefined,
  // TICKET-143 — SafetyState5m for the Decision Matrix's own independent tracker (see SymbolState.
  // momentumContextSafetyState5m), computed by the caller BEFORE this call so it can share the same
  // per-candle classification the T139/T140/T140B diagnostic blocks compute, without sharing THEIR
  // tracker state. Undefined when config.momentumContextDecisionMatrixEnabled is not true.
  momentumContextSafetyState5m: SafetyState5m | undefined,
  onMomentumContextDecision: ((diagnostic: MomentumContextDecisionDiagnostic) => void) | undefined,
): Promise<DraftSetup | null> {
  if (MOMENTUM_DIRECT_BLOCKED_REGIMES.includes(regimeOutput.regime)) return null;

  // TICKET-068 — system-wide concurrency cap: TICKET-067 found 4 concurrent same-direction
  // MOMENTUM_DIRECT positions (2 symbols × 2 each, all SHORT) lost together in one correlated move,
  // driving the -39.68% Max Drawdown. This is a SEPARATE, parallel check from
  // maxConcurrentPositionsPerSymbol (still enforced independently by the caller before
  // tryOpenNewPosition/tryMomentumDirect is even attempted) — a candidate must clear BOTH. Missing
  // input (momentumDirectOpenPositionsTotal undefined) is treated as 0 open, never blocking on its own.
  if ((input.momentumDirectOpenPositionsTotal ?? 0) >= config.momentumDirectMaxTotalConcurrent) return null;

  // TICKET-062 — volatility cap: TICKET-061 found MOMENTUM_DIRECT fires mostly during extreme
  // volatility (atrPercentile5m mean 83.90 vs ~48.5 baseline), and that exact high-volatility group
  // drags winrate down (30.05% vs 42.05% for the rest). Undefined (insufficient 5m ATR history)
  // can't be confirmed within the cap, so it blocks too — never defaults to passing on missing data,
  // same "an toàn" convention as every other gate in this file.
  const atrPercentile5m = regimeOutput.computedMetrics.atrPercentile5m;
  if (atrPercentile5m === undefined || atrPercentile5m > config.momentumDirectMaxAtrPercentile) return null;

  const longScore = await scoreMomentumForSide('LONG', input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection, input.correlatedRiskRatio, config);
  const shortScore = await scoreMomentumForSide('SHORT', input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection, input.correlatedRiskRatio, config);

  // TICKET-122 — Bearish (SHORT) MOMENTUM_DIRECT OOD guard, Bearish-model-specific per the ticket
  // (LONG side untouched). Recomputes crossFeatures via the SAME computeMomentumCrossFeatures()
  // scoreMomentumForSide() already calls internally — never a new formula, same non-invasive reuse
  // pattern TICKET-109/119 used. config.oodGuardConfig undefined (default) => isShortOod is always
  // false and every branch below is a no-op: byte-identical to pre-TICKET-122 behavior.
  const oodGuardConfig = config.oodGuardConfig;
  const oodCrossFeatures = oodGuardConfig ? computeMomentumCrossFeatures(input.candles5m, input.candles1hMomentum) : undefined;
  const isShortOod = oodGuardConfig !== undefined && oodCrossFeatures !== undefined && oodCrossFeatures.emaRatioSlow > oodGuardConfig.emaRatioSlowThreshold;

  // SCORE_CAP: use min(shortScore, scoreCapValue) as the EFFECTIVE score for the pass/fail check
  // only — the diagnostic MomentumGateEvaluation below still logs the real, uncapped shortScore.
  const shortScoreEffective = isShortOod && oodGuardConfig!.mode === 'SCORE_CAP' && shortScore !== undefined ? Math.min(shortScore, oodGuardConfig!.scoreCapValue) : shortScore;

  // TICKET-130 — Neutral 5m Direction Selector. Opt-in (config.neutral5mDirectionSelectorEnabled),
  // active ONLY while regime===NEUTRAL_TRANSITION — direction5m stays undefined (fully inert) for
  // every other regime or when the flag is off, byte-identical to every ticket before this one.
  // Never touches neutralTransitionGateConfig/the OB-FVG-Sweep-BoxBreakout cascade in any way — this
  // only affects tryMomentumDirect()'s own LONG/SHORT candidate gating below.
  const direction5m: Direction5m | undefined =
    config.neutral5mDirectionSelectorEnabled === true && regimeOutput.regime === MarketRegime.NEUTRAL_TRANSITION
      ? computeDirection5m(input.candles5m, input.candles1m)
      : undefined;
  // Mirrors TICKET-122's oodGuardConfig HARD_REJECT pattern exactly: force the DISAGREEING side's
  // `passes` to false, never touch the agreeing side, never flip LONG<->SHORT. direction5m==='NONE'
  // (or undefined, selector inactive) rejects nothing — existing NEUTRAL behavior unchanged.
  const longRejectedByDirection5m = direction5m === 'SHORT';
  const shortRejectedByDirection5m = direction5m === 'LONG';

  // Raw AI-gate-only pass/fail (unchanged formula) — kept separate from the selector's veto below so
  // the diagnostic capture can distinguish "AI rejected it anyway" from "AI passed it but the
  // selector vetoed it for disagreeing with direction5m" (TICKET-130 report needs this distinction).
  const longPassesAiOnly = longScore !== undefined && detectMomentumDirect(longScore, 'LONG', config.momentumDirectThreshold);
  // HARD_REJECT: force shortPasses=false regardless of the actual (or capped) score — never becomes
  // a candidate.
  const shortPassesAiOnly =
    !(isShortOod && oodGuardConfig!.mode === 'HARD_REJECT') &&
    shortScoreEffective !== undefined &&
    detectMomentumDirect(shortScoreEffective, 'SHORT', config.momentumDirectThreshold);

  const longPasses = longPassesAiOnly && !longRejectedByDirection5m;
  const shortPasses = shortPassesAiOnly && !shortRejectedByDirection5m;

  // TICKET-109 — fire for EVERY score actually computed this call (both LONG and SHORT), passed or
  // rejected, BEFORE any of the early returns below — this is the "runs regardless of outcome"
  // capture point. Diagnostic-only: reading atr here just for the hypothetical SL candidate does not
  // change anything the real code below still independently (re)checks.
  // TICKET-138 — mode used both here (diagnostic capture, both sides) and at the real decision point
  // further down (chosen `side` only). Defaults to 'NONE' (undefined field), byte-identical to every
  // ticket before this one.
  const macroOverrideMode = config.neutralMacroConflictOverrideMode ?? 'NONE';

  if (onMomentumGateEvaluation) {
    const gateAtr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
    if (gateAtr !== undefined) {
      const entryPriceCandidate = currentCandle.close;
      if (longScore !== undefined) {
        const longMacroOverride = evaluateMacroConflictOverride('LONG', macroDirection, regimeOutput.regime, input.candles5m, macroOverrideMode);
        onMomentumGateEvaluation({
          symbol: input.symbol,
          timestamp: currentCandle.timestamp,
          side: 'LONG',
          gateType: 'MOMENTUM_DIRECT',
          setupType: 'MOMENTUM_DIRECT',
          score: longScore,
          threshold: config.momentumDirectThreshold,
          passed: longPasses,
          entryPriceCandidate,
          slPriceCandidate: computeMomentumDirectSlPrice('LONG', entryPriceCandidate, currentCandle, gateAtr, config),
          regime: regimeOutput.regime,
          // TICKET-130 — diagnostic-only pass-through, never read by any decision logic above.
          direction5m,
          rejectedByDirectionSelector: longPassesAiOnly && longRejectedByDirection5m,
          // TICKET-138 — diagnostic-only pass-through, see evaluateMacroConflictOverride() above.
          macroConflict: longMacroOverride.macroConflict || undefined,
          macroConflict5mConfirmed: longMacroOverride.is5mConfirmed,
          macroConflictOverridden: longMacroOverride.macroConflict ? longMacroOverride.overridden : undefined,
        });
      }
      if (shortScore !== undefined) {
        const shortMacroOverride = evaluateMacroConflictOverride('SHORT', macroDirection, regimeOutput.regime, input.candles5m, macroOverrideMode);
        onMomentumGateEvaluation({
          symbol: input.symbol,
          timestamp: currentCandle.timestamp,
          side: 'SHORT',
          gateType: 'MOMENTUM_DIRECT',
          setupType: 'MOMENTUM_DIRECT',
          score: shortScore,
          threshold: config.momentumDirectThreshold,
          passed: shortPasses,
          entryPriceCandidate,
          slPriceCandidate: computeMomentumDirectSlPrice('SHORT', entryPriceCandidate, currentCandle, gateAtr, config),
          regime: regimeOutput.regime,
          oodFlagged: isShortOod,
          // TICKET-130 — diagnostic-only pass-through, never read by any decision logic above.
          direction5m,
          rejectedByDirectionSelector: shortPassesAiOnly && shortRejectedByDirection5m,
          // TICKET-138 — diagnostic-only pass-through, see evaluateMacroConflictOverride() above.
          macroConflict: shortMacroOverride.macroConflict || undefined,
          macroConflict5mConfirmed: shortMacroOverride.is5mConfirmed,
          macroConflictOverridden: shortMacroOverride.macroConflict ? shortMacroOverride.overridden : undefined,
        });
      }
    }
  }

  if (!longPasses && !shortPasses) return null;

  // Both sides rarely pass at once (opposite-direction models scoring the same candle) — if they
  // do, take the higher-scoring side rather than leaving this undefined behavior.
  const side: 'LONG' | 'SHORT' =
    longPasses && shortPasses ? ((longScore as number) >= (shortScore as number) ? 'LONG' : 'SHORT') : longPasses ? 'LONG' : 'SHORT';

  // TICKET-081 — per symbol+side circuit breaker: N consecutive SL losses on this exact symbol+side
  // pauses MOMENTUM_DIRECT signals for that side only, until cooldownUntilTimestamp passes. Other
  // symbols/sides are untouched (separate state per side, per symbol).
  const cooldownUntil = circuitBreakerState[side].cooldownUntilTimestamp;
  if (cooldownUntil !== null && currentCandle.timestamp < cooldownUntil) return null;

  // TICKET-071 — replaces TICKET-070's outright block with a SIZE REDUCTION on the exact same
  // trigger condition: correlatedRiskRatio elevated AND another symbol already has a same-side
  // MOMENTUM_DIRECT position open (TICKET-067's 4-concurrent-same-side Drawdown episode).
  // TICKET-068/070 both found outright blocking makes Max Drawdown WORSE (path-dependent effect —
  // dropping a trade reshuffles the entire chain of trades after it). Shrinking the position instead
  // keeps the trade IN the chain (same entry/exit timing, same downstream state) while cutting its
  // dollar risk if the dangerous situation actually plays out. Missing correlatedRiskRatio never
  // shrinks on its own (same as CORRELATED_RISK regime's own handling elsewhere — undefined means
  // "not enough history", not "assume high risk").
  const correlationElevated = input.correlatedRiskRatio !== undefined && input.correlatedRiskRatio >= config.momentumDirectCorrelationRiskThreshold;
  const hasOtherSymbolSameSideOpen = (input.momentumDirectOpenPositions ?? []).some((p) => p.symbol !== input.symbol && p.side === side);
  const correlationRiskMultiplier = correlationElevated && hasOtherSymbolSameSideOpen ? config.momentumDirectCorrelationRiskMultiplier : 1.0;

  // TICKET-122 — RISK_REDUCTION mode: still allow the OOD SHORT candidate through normally, but
  // shrink its size via the EXACT SAME multiplication point correlationRiskMultiplier above already
  // uses (TICKET-071 precedent) — no new plumbing. side==='SHORT' is implied by isShortOod (only ever
  // computed for the SHORT score), checked explicitly here for clarity since `side` may end up LONG
  // when both sides passed and LONG scored higher.
  const oodRiskMultiplier = side === 'SHORT' && isShortOod && oodGuardConfig?.mode === 'RISK_REDUCTION' ? oodGuardConfig.riskReductionMultiplier : 1.0;

  // Mandatory macro alignment check — unlike routeEntry()'s cascade, NOT gated behind
  // entryRouterConfig.macroTrendFilterEnabled (TICKET-059 Phần B lists this as an unconditional
  // step for MOMENTUM_DIRECT, not an A/B-testable optional filter).
  // TICKET-138 — opt-in, scope-restricted (regime===NEUTRAL_TRANSITION only, enforced inside
  // evaluateMacroConflictOverride()) conditional override of this same block. `macroOverrideMode`
  // defaults to 'NONE' -> overridden always false -> this early-return fires exactly as before this
  // ticket (byte-identical when the flag is unset). MOMENTUM_DIRECT_BLOCKED_REGIMES at the top of this
  // function already unconditionally excludes MANIPULATED/VOLATILE_CHOP/DANGER_ZONE/LOW_LIQUIDITY (and
  // CORRELATED_RISK) before this line is ever reached, so the ticket's "also block if state is
  // MANIPULATED/VOLATILE_CHOP/DANGER_ZONE/LOW_LIQUIDITY" requirement is already vacuously satisfied
  // for every candidate that can reach here — no additional check needed (see TICKET-138 report for
  // the full reasoning).
  // TICKET-143 — when the Decision Matrix is enabled, it REPLACES this entire block (not just
  // NEUTRAL_TRANSITION's scoped T138 override) — runs across every regime tryMomentumDirect() can
  // reach here. macroOverrideMode/evaluateMacroConflictOverride() are never consulted in this branch,
  // so the two flags cannot interfere with each other; when momentumContextDecisionMatrixEnabled is
  // false/unset (default), the `else` branch below is byte-identical to every ticket before this one.
  let macroConflictRiskMultiplier: number;
  if (config.momentumContextDecisionMatrixEnabled) {
    const macroConflict = (side === 'LONG' && macroDirection === 'DOWN') || (side === 'SHORT' && macroDirection === 'UP');
    const matrixMode = config.momentumContextDecisionMatrixMode ?? 'V1';
    // TICKET-143 §"MomentumThesis không hợp lệ" — by this point the candidate already cleared the AI
    // score threshold, OOD guard, TICKET-130 direction5m veto, and the circuit breaker above; the
    // ticket's thesis-invalid BLOCK condition is structurally unreachable here (see report's judgment
    // calls section) — always true in this real wiring, only meaningfully false in the offline CSV.
    const momentumThesisValid = true;
    // Mode B (AUDIT_UNFILTERED) — separate, non-production audit variant: never blocks on
    // macroConflict, riskMultiplier stays 1.0 (no reduction applied). Never itself a production path.
    const decisionResult =
      matrixMode === 'AUDIT_UNFILTERED'
        ? ({ decision: 'ALLOW_NORMAL', riskMultiplier: 1.0, reason: 'audit_unfiltered_no_macro_block' } as const)
        : computeMomentumContextDecision({
            symbol: input.symbol,
            macroConflict,
            safetyState5m: momentumContextSafetyState5m ?? SafetyState5m.NORMAL,
            momentumThesisValid,
          });
    if (onMomentumContextDecision) {
      const htfContextCandidate = classifyHtfContextCandidate(regimeOutput.computedMetrics);
      onMomentumContextDecision({
        symbol: input.symbol,
        timestamp: currentCandle.timestamp,
        side,
        htfContext: htfContextCandidate,
        macroDirection,
        macroConflict,
        safetyState5m: momentumContextSafetyState5m ?? SafetyState5m.NORMAL,
        modelScore: (side === 'LONG' ? longScore : shortScore) as number,
        momentumScore: (side === 'LONG' ? longScore : shortScoreEffective) as number,
        decision: decisionResult.decision,
        riskMultiplier: decisionResult.riskMultiplier,
        decisionReason: decisionResult.reason,
      });
    }
    if (decisionResult.decision === 'BLOCK') return null;
    macroConflictRiskMultiplier = decisionResult.riskMultiplier;
  } else {
    const macroOverride = evaluateMacroConflictOverride(side, macroDirection, regimeOutput.regime, input.candles5m, macroOverrideMode);
    if (macroOverride.macroConflict && !macroOverride.overridden) return null;
    // TICKET-138 — ticket-given constant (0.30), not tuned here. 1.0 (no-op) unless the override above
    // actually fired for this exact candidate.
    macroConflictRiskMultiplier = macroOverride.macroConflict && macroOverride.overridden ? 0.3 : 1.0;
  }

  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) return null; // not enough 5m history to size the SL buffer

  const entryPrice = currentCandle.close;
  // TICKET-109: extracted to computeMomentumDirectSlPrice() (verbatim, same formula) so the
  // diagnostic-only MomentumGateEvaluation above can reuse it for the non-chosen side too.
  const slPrice = computeMomentumDirectSlPrice(side, entryPrice, currentCandle, atr, config);

  // TICKET-064 Phần B — replaces the old fixed 0.5% TP (EntryConfig.MOMENTUM_DIRECT_TP_PCT, removed
  // by this ticket) with an R-multiple of the (possibly floored) SL distance above, reusing
  // slTpManager.ts's own priceAtR() rather than re-deriving the R-multiple math here.
  const r = Math.abs(entryPrice - slPrice);
  const tpPriceOverride = priceAtR(entryPrice, r, config.momentumDirectTpRMultiple, side);

  return {
    side,
    entryPrice,
    slPrice,
    setupType: 'MOMENTUM_DIRECT',
    regime: regimeOutput.regime,
    // TICKET-071: correlationRiskMultiplier (1.0 unless the combined risk trigger fired) folds into
    // this same riskMultiplier field, which tryOpenNewPosition() already multiplies together with
    // momentumMultiplier into combinedRiskMultiplier before sizing — no new plumbing, reuses the
    // exact mechanism regimeRiskMultiplier/momentumMultiplier already combine through.
    riskMultiplier: config.entryRouterConfig.regimeRiskMultiplier[regimeOutput.regime] * correlationRiskMultiplier * oodRiskMultiplier * macroConflictRiskMultiplier,
    tpPriceOverride,
  };
}

interface EntryAttemptResult {
  event: OpenTradeEvent | SkippedEntryEvent | null;
  newEntry: OpenPositionEntry | null;
}

/**
 * TICKET-056 — extracted verbatim from the old single-position Step 2 (no behavior change, only
 * restructured to RETURN its outcome instead of early-returning from processCandle() directly) so
 * a symbol that already has an open position can still attempt another one, up to
 * config.maxConcurrentPositionsPerSymbol. Does NOT loosen any signal-detection condition — the same
 * Regime/OB/FVG/Sweep/Breakout/MSS/Momentum Gate pipeline runs independently for this attempt,
 * exactly as it did for the very first position on this symbol.
 */
async function tryOpenNewPosition(
  input: ProcessCandleInput,
  config: OrchestratorConfig,
  regimeOutput: RegimeOutput,
  currentCandle: CandleData,
  accountBalance: number,
  onFunnelEvent: FunnelCallback | undefined,
  onSetupNotFiredDiagnostic: ((diagnostic: SetupNotFiredDiagnostic) => void) | undefined,
  circuitBreakerState: { LONG: MomentumDirectCircuitBreakerSideState; SHORT: MomentumDirectCircuitBreakerSideState },
  onMomentumGateEvaluation: ((evaluation: MomentumGateEvaluation) => void) | undefined,
  momentumContextSafetyState5m: SafetyState5m | undefined,
  onMomentumContextDecision: ((diagnostic: MomentumContextDecisionDiagnostic) => void) | undefined,
): Promise<EntryAttemptResult> {
  // TICKET-017 Phần A: same direction function as adxDirection1h, applied to 1D candles instead.
  const macroDirectionSeries = wilderDIDirectionSeries(input.candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
  const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

  // TICKET-055: TEMPORARY verification wrapper — tracks whether routeEntry() ever fired a
  // stage='SETUP' event this call, without changing what onFunnelEvent itself receives or how
  // routeEntry() decides anything. Only wraps when onSetupNotFiredDiagnostic is actually passed
  // (opt-in, same as every other diagnostic in this file).
  let setupEventFired = false;
  const funnelEventWrapper: FunnelCallback | undefined = onSetupNotFiredDiagnostic
    ? (symbol, timestamp, event) => {
        if (event.stage === 'SETUP') setupEventFired = true;
        onFunnelEvent?.(symbol, timestamp, event);
      }
    : onFunnelEvent;

  const draftSetup = routeEntry(
    {
      regime: regimeOutput.regime,
      symbol: input.symbol,
      adxDirection1h: regimeOutput.adxDirection1h,
      macroDirection,
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      candlesMss: input.candles1m,
      bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m,
    },
    config.entryRouterConfig,
    funnelEventWrapper,
  );

  if (onSetupNotFiredDiagnostic && regimeOutput.regime === MarketRegime.TREND_RIDER && !setupEventFired) {
    onSetupNotFiredDiagnostic({ symbol: input.symbol, timestamp: currentCandle.timestamp, adxDirection1h: regimeOutput.adxDirection1h });
  }

  // TICKET-059 Phần B — only tried when the cascade above found NOTHING for this candle. Runs
  // entirely parallel to routeEntry(): never replaces it, never runs when routeEntry() already
  // succeeded. Off by default (config.momentumDirectEnabled=false) — draftSetup===null still falls
  // straight through to the early return below, byte-identical to every ticket before this one.
  let effectiveDraftSetup: DraftSetup | null = draftSetup;
  if (effectiveDraftSetup === null && config.momentumDirectEnabled) {
    effectiveDraftSetup = await tryMomentumDirect(
      input,
      config,
      regimeOutput,
      currentCandle,
      macroDirection,
      circuitBreakerState,
      onMomentumGateEvaluation,
      momentumContextSafetyState5m,
      onMomentumContextDecision,
    );
  }

  if (effectiveDraftSetup === null) return { event: null, newEntry: null };

  // TICKET-036 — mandatory Momentum Gate, NEUTRAL_TRANSITION only. Runs BEFORE anything else
  // (account-balance check, soft momentumMultiplier below) since it can outright discard the
  // DraftSetup rather than just scale it. entryRouter.ts's routeEntry() always builds a real
  // DraftSetup for NEUTRAL_TRANSITION now (Phần A) — neutralTransitionTradingEnabled=false must
  // still reproduce the exact pre-TICKET-036 behavior (no event at all, same as draftSetup===null
  // above), NOT a SKIPPED event, since NEUTRAL_TRANSITION genuinely never entered before this ticket.
  // TICKET-059: excludes MOMENTUM_DIRECT-sourced setups — this gate is specific to routeEntry()'s
  // own NEUTRAL_TRANSITION cascade path, a different mechanism from MOMENTUM_DIRECT's own threshold
  // check (tryMomentumDirect already applied its own gating above).
  if (effectiveDraftSetup.regime === MarketRegime.NEUTRAL_TRANSITION && effectiveDraftSetup.setupType !== 'MOMENTUM_DIRECT') {
    // TICKET-131 — diagnostic values threaded through to the existing gateScore capture below (only
    // ever set when neutral5mDirectionGatedRoutingEnabled===true AND the candidate was actually let
    // through by the new routing path, i.e. neutralTransitionTradingEnabled was false but direction5m
    // agreed with this candidate's side). Stay undefined on every other path (routing disabled, or
    // neutralTransitionTradingEnabled itself already true — the original production-config path).
    let direction5mGatedRoutingDiag: Direction5m | undefined;
    let structuralBreakDiagnostic5mDiag: Direction5m | undefined;
    let neutral5mRoutingAcceptedDiag: boolean | undefined;

    if (!config.neutralTransitionGateConfig.neutralTransitionTradingEnabled) {
      // TICKET-131 — opt-in ALTERNATE way past this early-return, additional to (never a replacement
      // for) neutralTransitionGateConfig.neutralTransitionTradingEnabled, whose own value is NEVER
      // written to anywhere in this ticket. Only ever consulted when the flag is explicitly true.
      let routingAccepted = false;
      if (config.neutral5mDirectionGatedRoutingEnabled === true) {
        const relaxed = computeDirection5mRelaxed(input.candles5m, input.candles1m);
        direction5mGatedRoutingDiag = relaxed.direction5m;
        structuralBreakDiagnostic5mDiag = relaxed.structuralBreakDiagnostic;
        // direction5m===NONE never matches 'LONG'/'SHORT' -> naturally rejected, same as a side mismatch.
        routingAccepted = relaxed.direction5m === effectiveDraftSetup.side;
        neutral5mRoutingAcceptedDiag = routingAccepted;
      }

      if (!routingAccepted) {
        // TICKET-131 — diagnostic-only: this candidate never reaches the AI gateScore check below (no
        // score computed), so it needs its own capture point here, distinct from the TICKET-109 one.
        // Only fires when the routing was actually active (direction5mGatedRoutingDiag !== undefined) —
        // never fires on the byte-identical-to-before-this-ticket disabled path.
        if (onMomentumGateEvaluation && direction5mGatedRoutingDiag !== undefined) {
          onMomentumGateEvaluation({
            symbol: input.symbol,
            timestamp: currentCandle.timestamp,
            side: effectiveDraftSetup.side,
            gateType: 'NEUTRAL_TRANSITION',
            setupType: effectiveDraftSetup.setupType,
            score: 0,
            threshold: 0,
            passed: false,
            entryPriceCandidate: effectiveDraftSetup.entryPrice,
            slPriceCandidate: effectiveDraftSetup.slPrice,
            regime: regimeOutput.regime,
            direction5mGatedRouting: direction5mGatedRoutingDiag,
            neutral5mRoutingAccepted: neutral5mRoutingAcceptedDiag,
            structuralBreakDiagnostic5m: structuralBreakDiagnostic5mDiag,
          });
        }
        return { event: null, newEntry: null };
      }
      // direction5m agreed with this candidate's side — falls through to the SAME unmodified AI gate
      // check below (gateScore/gatePassed), never bypassing, weakening, or duplicating that check.
    }
    const gateScore = await scoreMomentumForSide(effectiveDraftSetup.side, input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection, input.correlatedRiskRatio, config);
    // Missing score (insufficient EMA/ATR history) -> gateScore undefined -> comparison is false ->
    // rejected, same as an explicit low score. Never defaults to passing (PM's explicit "an toàn" requirement).
    const gatePassed = gateScore !== undefined && gateScore >= config.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold;

    // TICKET-109 — diagnostic-only, fires whenever a score was actually computed (same guard as
    // the MOMENTUM_DIRECT capture point above). entryPriceCandidate/slPriceCandidate reuse
    // effectiveDraftSetup's own entryPrice/slPrice verbatim — routeEntry() already computed them via
    // this setupType's real OB/FVG/Sweep/Box-Breakout + ATR-buffer formula, no new formula here.
    // TICKET-131: also carries direction5mGatedRoutingDiag/etc pass-through (undefined unless this
    // exact candidate reached here via the new routing path above).
    if (onMomentumGateEvaluation && gateScore !== undefined) {
      onMomentumGateEvaluation({
        symbol: input.symbol,
        timestamp: currentCandle.timestamp,
        side: effectiveDraftSetup.side,
        gateType: 'NEUTRAL_TRANSITION',
        setupType: effectiveDraftSetup.setupType,
        score: gateScore,
        threshold: config.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold,
        passed: gatePassed,
        entryPriceCandidate: effectiveDraftSetup.entryPrice,
        slPriceCandidate: effectiveDraftSetup.slPrice,
        regime: regimeOutput.regime,
        direction5mGatedRouting: direction5mGatedRoutingDiag,
        neutral5mRoutingAccepted: neutral5mRoutingAcceptedDiag,
        structuralBreakDiagnostic5m: structuralBreakDiagnostic5mDiag,
      });
    }

    if (!gatePassed) {
      return {
        event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'NEUTRAL_GATE_REJECTED' },
        newEntry: null,
      };
    }
    // Gate passed — falls through to the normal pipeline below (account-balance check, sizing,
    // riskPool, AND the soft momentumMultiplier below still applies on top — this gate is an
    // ADDITIONAL hard filter before entry, not a replacement for the existing soft one).
  }

  // Account blown (balance <= 0): no new positions can be sized. Not a NOT_IMPLEMENTED-style
  // error — a real, expected end state for a backtest/live account, so it's just "no entry"
  // rather than an exception (PositionSizingInput itself throws on accountBalance <= 0).
  // TICKET-056: `accountBalance` here already reflects any same-candle close on this same symbol
  // (PM-confirmed sequencing — see processCandle's Step 3, which runs before this is called).
  if (accountBalance <= 0) return { event: null, newEntry: null };

  // TICKET-024 Phần C/D — soft risk-multiplier from the momentum model, applied to the sizer's
  // REQUESTED risk (riskDollarOrPercent) so it flows through maxMarginCap capping the same way a
  // smaller riskDollarOrPercent naturally would. Never gates entry outright — only scales size.
  // Off by default: momentumMultiplier stays 1.0 and combinedRiskMultiplier === effectiveDraftSetup.riskMultiplier
  // (itself always 1.0 for every regime that currently reaches this point), so behavior is
  // byte-for-byte unchanged from before this ticket unless momentumFilterConfig.momentumFilterEnabled.
  //
  // TICKET-052: TREND-scenario Plan A/B selection (below, right before openInput) also needs this
  // exact same own-side momentum score — computed ONCE here and reused, never re-scored twice for
  // two purposes. Score is fetched whenever EITHER feature needs it, independent of each other
  // (either can be on while the other stays off).
  let momentumScore: number | undefined;
  if (config.momentumFilterConfig.momentumFilterEnabled || config.planAutoSelectionConfig.planAutoSelectionEnabled) {
    // TICKET-036: reuses the same scoreMomentumForSide() helper the Gate above calls — no
    // re-derivation of the LONG/SHORT model split or feature vector construction.
    momentumScore = await scoreMomentumForSide(effectiveDraftSetup.side, input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection, input.correlatedRiskRatio, config);
  }
  let momentumMultiplier = 1.0;
  if (config.momentumFilterConfig.momentumFilterEnabled && momentumScore !== undefined) {
    momentumMultiplier = computeMomentumMultiplier(momentumScore, config.momentumFilterConfig);
  }
  // momentumScore undefined (insufficient EMA/ATR history) -> momentumMultiplier stays 1.0, same as disabled.
  const combinedRiskMultiplier = effectiveDraftSetup.riskMultiplier * momentumMultiplier;

  const slDistancePercent = Math.abs(effectiveDraftSetup.entryPrice - effectiveDraftSetup.slPrice) / effectiveDraftSetup.entryPrice;
  const sizingOutput = new DynamicRMarginSizer().calculate({
    accountBalance,
    riskDollarOrPercent: config.riskDollarOrPercent * combinedRiskMultiplier,
    entryPrice: effectiveDraftSetup.entryPrice,
    slDistancePercent,
    leverage: config.leverage,
    maxMarginCap: config.maxMarginCap,
  });

  // TICKET-056 Phần C: `input.allOpenPositionsRisk` must now include this symbol's own already-open
  // position(s) too (caller's responsibility) — no longer excludes "this symbol" by construction.
  if (wouldExceedRiskPool(input.allOpenPositionsRisk, sizingOutput.actualRiskDollar, accountBalance, { riskPoolMaxPct: config.riskPoolMaxPct })) {
    return {
      event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'RISK_POOL_EXCEEDED' },
      newEntry: null,
    };
  }

  // TICKET-101 Việc 2 — SEPARATE cap from Risk Pool above: bounds real margin$ committed across ALL
  // 4 symbols combined, independent of the risk$-if-SL-hits figure Risk Pool bounds. A candidate can
  // pass the Risk Pool check yet still be rejected here if it would push total margin over the cap.
  if (wouldExceedMaxTotalMargin(input.totalOpenMarginDollar ?? 0, sizingOutput.marginRequired, accountBalance, config.maxTotalMarginPct)) {
    return {
      event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'MAX_TOTAL_MARGIN_EXCEEDED' },
      newEntry: null,
    };
  }

  // TICKET-052: AI-driven Plan A/B selection — TREND scenario only, reuses momentumScore already
  // computed above (never re-scored). Off by default: returns config.tpPlan unchanged. Meaningless
  // for MOMENTUM_DIRECT's COUNTER_TREND scenario below (single fixed-price exit, no tiers) — still
  // computed unconditionally (cheap, pure) but simply unused in that branch.
  const selectedTpPlan = selectTpPlan(config.tpPlan, momentumScore, config.planAutoSelectionConfig);

  // TICKET-059: MOMENTUM_DIRECT uses Mục 7's COUNTER_TREND scenario (single fixed-price exit at
  // tpPriceOverride, no tiers, no Runner) — everything else (OB/FVG/Sweep/Breakout) stays on the
  // TREND scenario exactly as before this ticket; entryRouter.ts has no COUNTER_TREND path itself.
  const openInput: SlTpManagerInput =
    effectiveDraftSetup.setupType === 'MOMENTUM_DIRECT'
      ? {
          scenario: 'COUNTER_TREND',
          entryPrice: effectiveDraftSetup.entryPrice,
          slPrice: effectiveDraftSetup.slPrice,
          side: effectiveDraftSetup.side,
          tpPlan: config.tpPlan, // ignored by computeTpLevels() for COUNTER_TREND — field is required but unused
          tpPriceOverride: effectiveDraftSetup.tpPriceOverride,
          positionSize: sizingOutput.positionSize,
          takerFeeRate: config.takerFeeRate,
        }
      : {
          scenario: 'TREND',
          entryPrice: effectiveDraftSetup.entryPrice,
          slPrice: effectiveDraftSetup.slPrice,
          side: effectiveDraftSetup.side,
          tpPlan: selectedTpPlan,
          positionSize: sizingOutput.positionSize,
          takerFeeRate: config.takerFeeRate,
        };
  const newPosition = openPosition(openInput);

  // TICKET-078 — pure surfacing of numbers already computed above (checkRiskPool reused exactly as
  // wouldExceedRiskPool already uses it, no new formula), for Telegram's "Risk Pool trước% → sau%" line.
  const riskPoolBefore = checkRiskPool(input.allOpenPositionsRisk, accountBalance, { riskPoolMaxPct: config.riskPoolMaxPct });
  const riskPoolAfter = checkRiskPool(
    [...input.allOpenPositionsRisk, { id: '__new__', actualRiskDollar: sizingOutput.actualRiskDollar }],
    accountBalance,
    { riskPoolMaxPct: config.riskPoolMaxPct },
  );

  const event: OpenTradeEvent = {
    type: 'OPEN',
    symbol: input.symbol,
    side: effectiveDraftSetup.side,
    regime: effectiveDraftSetup.regime,
    setupType: effectiveDraftSetup.setupType,
    tpPlan: openInput.tpPlan,
    entryTimestamp: currentCandle.timestamp,
    entryPrice: effectiveDraftSetup.entryPrice,
    riskMultiplier: combinedRiskMultiplier,
    actualRiskDollar: sizingOutput.actualRiskDollar,
    marginRequired: sizingOutput.marginRequired,
    slPrice: effectiveDraftSetup.slPrice,
    tpLevels: newPosition.tpLevels,
    adx1h: regimeOutput.computedMetrics.adx1h,
    atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m,
    momentumScore,
    riskPoolPctBefore: (riskPoolBefore.totalRiskDollar / accountBalance) * 100,
    riskPoolPctAfter: (riskPoolAfter.totalRiskDollar / accountBalance) * 100,
  };

  return {
    event,
    newEntry: {
      position: newPosition,
      meta: {
        regime: effectiveDraftSetup.regime,
        setupType: effectiveDraftSetup.setupType,
        entryTimestamp: currentCandle.timestamp,
        actualRiskDollar: sizingOutput.actualRiskDollar,
        marginRequired: sizingOutput.marginRequired,
        riskMultiplier: combinedRiskMultiplier,
      },
    },
  };
}

export async function processCandle(
  input: ProcessCandleInput,
  state: SymbolState,
  config: OrchestratorConfig,
  onManipulatedConfirmed?: (diagnostic: ManipulatedDiagnostic) => void,
  onDangerZoneConfirmed?: (diagnostic: DangerZoneDiagnostic) => void,
  // TICKET-042: pure pass-through to entryRouter.ts's routeEntry() — pure observability, never
  // read here, never affects any decision in this function.
  onFunnelEvent?: FunnelCallback,
  // TICKET-055: TEMPORARY verification-only diagnostic — see SetupNotFiredDiagnostic doc comment.
  onSetupNotFiredDiagnostic?: (diagnostic: SetupNotFiredDiagnostic) => void,
  // TICKET-078 — pure pass-through of regimeOutput.computedMetrics every call (adx1h,
  // atrPercentile5m, etc.), same observability pattern as onManipulatedConfirmed/onFunnelEvent above
  // — never read here, never affects any decision. Lets a caller (e.g. Telegram notifications) show
  // the metrics behind a regime confirmation/change without recomputing detectRegime() itself.
  onRegimeMetrics?: (computedMetrics: ComputedMetrics) => void,
  // TICKET-109 — pure pass-through, fires for EVERY momentum-gate score computed this call (both
  // MOMENTUM_DIRECT sides + NEUTRAL_TRANSITION's own gate), passed AND rejected — never read here,
  // never affects any decision. See MomentumGateEvaluation's own doc comment.
  onMomentumGateEvaluation?: (evaluation: MomentumGateEvaluation) => void,
  // TICKET-139 — diagnostic-only, fires ONLY when config.htfSafetySplitDiagnosticEnabled is true
  // AND the confirmed HTFContext actually changed vs the previous candle (not every candle). Never
  // read here, never affects any decision — see OrchestratorConfig.htfSafetySplitDiagnosticEnabled.
  onHtfContextChange?: (change: { symbol: string; from: HTFContext; to: HTFContext; timestamp: number }) => void,
  // TICKET-139 — same contract as onHtfContextChange, for the confirmed SafetyState5m instead.
  onSafetyState5mChange?: (change: { symbol: string; from: SafetyState5m; to: SafetyState5m; timestamp: number }) => void,
  // TICKET-140 — diagnostic-only, fires ONLY when config.safetyState5mStabilizationEnabled is true
  // AND the confirmed STABILIZED SafetyState5m actually changed vs the previous candle. Never read
  // here, never affects any decision — see OrchestratorConfig.safetyState5mStabilizationEnabled.
  onSafetyState5mStabilized?: (change: { symbol: string; from: SafetyState5m; to: SafetyState5m; timestamp: number }) => void,
  // TICKET-140B — diagnostic-only, fires ONLY when config.safetyState5mFinalStabilizationEnabled is
  // true AND the confirmed FINAL-stabilized SafetyState5m actually changed vs the previous candle.
  // Never read here, never affects any decision — see OrchestratorConfig.safetyState5mFinalStabilizationEnabled.
  onSafetyState5mFinalStabilized?: (change: { symbol: string; from: SafetyState5m; to: SafetyState5m; timestamp: number }) => void,
  // TICKET-141 — diagnostic-only, fires ONLY when config.localTradeThesis5mEnabled is true, EVERY
  // closed 5m candle (not just on change — §8's CSV wants one row per candle). Never read here,
  // never affects any decision — see OrchestratorConfig.localTradeThesis5mEnabled.
  onLocalTradeThesis5m?: (result: LocalTradeThesis5mResult) => void,
  // TICKET-142 — diagnostic-only, fires ONLY when config.setupSpecificThesisEnabled is true, EVERY
  // closed 5m candle, with all 4 setup-specific thesis modules' results for that candle. Never read
  // here, never affects any decision — see OrchestratorConfig.setupSpecificThesisEnabled.
  onSetupSpecificThesis?: (results: SetupThesisResult[]) => void,
  // TICKET-142A — diagnostic-only, fires ONLY when config.momentumCandidateIntegrityEnabled is true,
  // EVERY closed 5m candle. Never read here, never affects any decision — see
  // OrchestratorConfig.momentumCandidateIntegrityEnabled.
  onMomentumCandidateIntegrity?: (result: MomentumCandidateIntegrityResult) => void,
  // TICKET-143 — diagnostic-only, fires ONLY when config.momentumContextDecisionMatrixEnabled is true,
  // once per real tryMomentumDirect() candidate that reaches the decision point. Never read here,
  // never affects any decision — see MomentumContextDecisionDiagnostic's own doc comment.
  onMomentumContextDecision?: (diagnostic: MomentumContextDecisionDiagnostic) => void,
): Promise<ProcessCandleResult> {
  // Step 1 — regime, always runs.
  const regimeOutput = detectRegime({
    candles5m: input.candles5m,
    candles15m: input.candles15m,
    candles1h: input.candles1h,
    previousRegime: state.regimeState.previousRegime,
    previousCandidateRegime: state.regimeState.previousCandidateRegime,
    streakCount: state.regimeState.streakCount,
    previousDangerZoneTimestamp: state.regimeState.previousDangerZoneTimestamp,
    candles5mSessionVolume: input.candles5mSessionVolume,
    correlatedRiskRatio: input.correlatedRiskRatio,
  });
  const regimeState = {
    previousRegime: regimeOutput.regime,
    previousCandidateRegime: regimeOutput.candidateRegime,
    streakCount: regimeOutput.streakCount,
    previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
  };
  const currentCandle = input.candles5m[input.candles5m.length - 1];

  onRegimeMetrics?.(regimeOutput.computedMetrics);

  // TICKET-139 — gated entirely behind the flag: when off/unset, htfSafetyDiagnostic stays
  // undefined and nothing below this block runs, so this is byte-identical to pre-TICKET-139
  // behavior. Diagnostic only — never read by any decision below.
  let htfSafetyDiagnostic: NonNullable<SymbolState['htfSafetyDiagnostic']> | undefined;
  if (config.htfSafetySplitDiagnosticEnabled) {
    const htfContextCandidate = classifyHtfContextCandidate(regimeOutput.computedMetrics);
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousDiagnostic = state.htfSafetyDiagnostic ?? { previousHtfContext: null, safetyHysteresis: null };
    const newSafetyHysteresis = applySafetyState5mHysteresis(safetyCandidate, previousDiagnostic.safetyHysteresis);

    if (previousDiagnostic.previousHtfContext !== null && previousDiagnostic.previousHtfContext !== htfContextCandidate) {
      onHtfContextChange?.({ symbol: input.symbol, from: previousDiagnostic.previousHtfContext, to: htfContextCandidate, timestamp: currentCandle.timestamp });
    }
    if (
      previousDiagnostic.safetyHysteresis !== null &&
      previousDiagnostic.safetyHysteresis.state !== newSafetyHysteresis.state
    ) {
      onSafetyState5mChange?.({
        symbol: input.symbol,
        from: previousDiagnostic.safetyHysteresis.state,
        to: newSafetyHysteresis.state,
        timestamp: currentCandle.timestamp,
      });
    }

    htfSafetyDiagnostic = { previousHtfContext: htfContextCandidate, safetyHysteresis: newSafetyHysteresis };
  }

  // TICKET-140 — gated entirely behind its own flag, independent of htfSafetySplitDiagnosticEnabled
  // above: when off/unset, safetyState5mStabilizedDiagnostic stays undefined and nothing below this
  // block runs, so this is byte-identical to pre-TICKET-140 behavior. Diagnostic only — never read
  // by any decision below. Reuses TICKET-139's unchanged classifySafetyState5mCandidate() formula.
  let safetyState5mStabilizedDiagnostic: NonNullable<SymbolState['safetyState5mStabilizedDiagnostic']> | undefined;
  if (config.safetyState5mStabilizationEnabled) {
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.safetyState5mStabilizedDiagnostic?.tracker ?? null;
    const newTracker = applySafetyState5mStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);

    if (previousTracker !== null && previousTracker.currentState !== newTracker.currentState) {
      onSafetyState5mStabilized?.({
        symbol: input.symbol,
        from: previousTracker.currentState,
        to: newTracker.currentState,
        timestamp: currentCandle.timestamp,
      });
    }

    safetyState5mStabilizedDiagnostic = { tracker: newTracker };
  }

  // TICKET-140B — gated entirely behind its own flag, fully independent of both
  // htfSafetySplitDiagnosticEnabled and safetyState5mStabilizationEnabled above (can run
  // simultaneously with either/both, each with its own per-symbol state field, never colliding):
  // when off/unset, safetyState5mFinalStabilizedDiagnostic stays undefined and nothing below this
  // block runs — byte-identical to pre-TICKET-140B behavior. Diagnostic only — never read by any
  // decision below. Reuses TICKET-139's unchanged classifySafetyState5mCandidate() formula.
  let safetyState5mFinalStabilizedDiagnostic: NonNullable<SymbolState['safetyState5mFinalStabilizedDiagnostic']> | undefined;
  if (config.safetyState5mFinalStabilizationEnabled) {
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.safetyState5mFinalStabilizedDiagnostic?.tracker ?? null;
    const newTracker = applySafetyState5mFinalStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);

    if (previousTracker !== null && previousTracker.currentState !== newTracker.currentState) {
      onSafetyState5mFinalStabilized?.({
        symbol: input.symbol,
        from: previousTracker.currentState,
        to: newTracker.currentState,
        timestamp: currentCandle.timestamp,
      });
    }

    safetyState5mFinalStabilizedDiagnostic = { tracker: newTracker };
  }

  // TICKET-143 — gated entirely behind config.momentumContextDecisionMatrixEnabled, fully independent
  // of every T139/T140/T140B/T141/T142/T142A block above (own tracker field, own state, never shares
  // with any of them — see MomentumContextSafetyState5mState's doc comment). When off/unset,
  // momentumContextSafetyState5m stays undefined and nothing below this block runs — byte-identical to
  // pre-TICKET-143 behavior. The resulting currentState is passed into tryOpenNewPosition/
  // tryMomentumDirect below for the REAL Decision Matrix decision (this is the one diagnostic-shaped
  // block in this file whose output actually feeds a live decision, when the flag is on).
  let momentumContextSafetyState5mDiagnostic: NonNullable<SymbolState['momentumContextSafetyState5m']> | undefined;
  if (config.momentumContextDecisionMatrixEnabled) {
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.momentumContextSafetyState5m?.tracker ?? null;
    const newTracker = applySafetyState5mFinalStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);
    momentumContextSafetyState5mDiagnostic = { tracker: newTracker };
  }

  // TICKET-141 — gated entirely behind its own flag, fully independent of the T139/T140/T140B blocks
  // above (its own tracker field, never shares state with T140B's — see LocalTradeThesis5mDiagnosticState
  // doc comment). When off/unset, localTradeThesis5mDiagnostic stays undefined and nothing below this
  // block runs — byte-identical to pre-TICKET-141 behavior. Diagnostic only — never read by any
  // decision below, never used to ALLOW/BLOCK any entry (§11/§13). Runs EVERY closed 5m candle (not
  // just on change), unlike the change-only callbacks above — §8's CSV wants one row per candle.
  let localTradeThesis5mDiagnostic: NonNullable<SymbolState['localTradeThesis5mDiagnostic']> | undefined;
  if (config.localTradeThesis5mEnabled) {
    const htfContextCandidate = classifyHtfContextCandidate(regimeOutput.computedMetrics);
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.localTradeThesis5mDiagnostic?.tracker ?? null;
    const newTracker = applySafetyState5mFinalStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);

    const thesisResult = computeLocalTradeThesis5m({
      symbol: input.symbol,
      timestamp: currentCandle.timestamp,
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      candles1m: input.candles1m,
      computedMetrics: regimeOutput.computedMetrics,
      safetyState5m: newTracker.currentState,
      htfContext: htfContextCandidate,
      obSlBufferAtrMultiplier: config.entryRouterConfig.obSlBufferAtrMultiplier,
      tpPlan: config.tpPlan,
    });

    onLocalTradeThesis5m?.(thesisResult);
    localTradeThesis5mDiagnostic = { tracker: newTracker, lastResult: thesisResult };
  }

  // TICKET-142 — gated entirely behind its own flag, fully independent of every T139/T140/T140B/T141
  // block above (own tracker field, never shares state). When off/unset, setupSpecificThesisDiagnostic
  // stays undefined and nothing below this block runs — byte-identical to pre-TICKET-142 behavior.
  // Diagnostic only — never read by any decision below, never used to ALLOW/BLOCK any entry.
  let setupSpecificThesisDiagnostic: NonNullable<SymbolState['setupSpecificThesisDiagnostic']> | undefined;
  if (config.setupSpecificThesisEnabled) {
    const htfContextCandidate = classifyHtfContextCandidate(regimeOutput.computedMetrics);
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.setupSpecificThesisDiagnostic?.tracker ?? null;
    const newTracker = applySafetyState5mFinalStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);

    // Same macroDirection formula tryOpenNewPosition() computes locally — reused verbatim, not a new one.
    const macroDirectionSeries = wilderDIDirectionSeries(input.candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

    const common = { symbol: input.symbol, timestamp: currentCandle.timestamp, htfContext: htfContextCandidate, safetyState5m: newTracker.currentState };

    const momentumResults = await computeMomentumThesis({
      ...common,
      candles5m: input.candles5m,
      candles1hMomentum: input.candles1hMomentum,
      regimeOutput,
      macroDirection,
      correlatedRiskRatio: input.correlatedRiskRatio,
      momentumDirectThreshold: config.momentumDirectThreshold,
      momentumDirectMinSlPercent: config.momentumDirectMinSlPercent,
      momentumDirectTpRMultiple: config.momentumDirectTpRMultiple,
      momentumModelPath: config.momentumModelPath,
      momentumSchemaPath: config.momentumSchemaPath,
      momentumBearishModelPath: config.momentumBearishModelPath,
      momentumBearishSchemaPath: config.momentumBearishSchemaPath,
    });
    const pullbackResults = computePullbackThesis({
      ...common,
      candles5m: input.candles5m,
      candles1m: input.candles1m,
      obSlBufferAtrMultiplier: config.entryRouterConfig.obSlBufferAtrMultiplier,
      tpPlan: config.tpPlan,
    });
    const breakoutResults = computeBreakoutThesis({
      ...common,
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      computedMetrics: regimeOutput.computedMetrics,
      tpPlan: config.tpPlan,
    });
    const reversalResults = computeReversalThesis({
      ...common,
      candles5m: input.candles5m,
      candles1m: input.candles1m,
      tpPlan: config.tpPlan,
    });

    const results = [...momentumResults, ...pullbackResults, ...breakoutResults, ...reversalResults];
    onSetupSpecificThesis?.(results);
    setupSpecificThesisDiagnostic = { tracker: newTracker, lastResults: results };
  }

  // TICKET-142A — gated entirely behind its own flag, fully independent of setupSpecificThesisEnabled
  // above (own tracker field, own activeRun consecutive-run pointer, never shares state). When
  // off/unset, momentumCandidateIntegrityDiagnostic stays undefined and nothing below this block runs
  // — byte-identical to pre-TICKET-142A behavior. Diagnostic only — never read by any decision below,
  // never used to ALLOW/BLOCK any entry.
  let momentumCandidateIntegrityDiagnostic: NonNullable<SymbolState['momentumCandidateIntegrityDiagnostic']> | undefined;
  if (config.momentumCandidateIntegrityEnabled) {
    const htfContextCandidate = classifyHtfContextCandidate(regimeOutput.computedMetrics);
    const safetyCandidate = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
    const previousTracker = state.momentumCandidateIntegrityDiagnostic?.tracker ?? null;
    const newTracker = applySafetyState5mFinalStabilization(safetyCandidate, currentCandle.timestamp, previousTracker);

    // Same macroDirection formula tryOpenNewPosition()/T142's block above compute locally — reused verbatim.
    const macroDirectionSeries = wilderDIDirectionSeries(input.candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

    const { result, nextActiveRun } = await computeMomentumCandidateIntegrity(
      {
        symbol: input.symbol,
        timestamp: currentCandle.timestamp,
        htfContext: htfContextCandidate,
        safetyState5m: newTracker.currentState,
        candles5m: input.candles5m,
        candles1m: input.candles1m,
        candles1hMomentum: input.candles1hMomentum,
        regimeOutput,
        macroDirection,
        correlatedRiskRatio: input.correlatedRiskRatio,
        momentumDirectThreshold: config.momentumDirectThreshold,
        momentumDirectMinSlPercent: config.momentumDirectMinSlPercent,
        momentumDirectTpRMultiple: config.momentumDirectTpRMultiple,
        momentumModelPath: config.momentumModelPath,
        momentumSchemaPath: config.momentumSchemaPath,
        momentumBearishModelPath: config.momentumBearishModelPath,
        momentumBearishSchemaPath: config.momentumBearishSchemaPath,
        circuitBreakerState: state.momentumDirectCircuitBreaker,
        oodGuardConfig: config.oodGuardConfig,
        neutral5mDirectionSelectorEnabled: config.neutral5mDirectionSelectorEnabled,
        macroOverrideMode: config.neutralMacroConflictOverrideMode ?? 'NONE',
        momentumDirectMaxAtrPercentile: config.momentumDirectMaxAtrPercentile,
      },
      state.momentumCandidateIntegrityDiagnostic?.activeRun ?? null,
    );

    onMomentumCandidateIntegrity?.(result);
    momentumCandidateIntegrityDiagnostic = { tracker: newTracker, activeRun: nextActiveRun, lastResult: result };
  }

  // TICKET-027 — diagnostic-only, no effect on any decision below: fires once per fresh transition
  // into MANIPULATED (state.regimeState.previousRegime was something else, now confirmed MANIPULATED).
  if (
    onManipulatedConfirmed &&
    regimeOutput.regime === MarketRegime.MANIPULATED &&
    state.regimeState.previousRegime !== MarketRegime.MANIPULATED
  ) {
    onManipulatedConfirmed({
      symbol: input.symbol,
      timestamp: currentCandle.timestamp,
      upperSweepCount: regimeOutput.computedMetrics.upperSweepCount5m as number,
      lowerSweepCount: regimeOutput.computedMetrics.lowerSweepCount5m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
      lookbackWindow: input.candles5m.slice(-RegimeConfig.MANIPULATED_LOOKBACK_CANDLES),
    });
  }

  // TICKET-033 — diagnostic-only, no effect on any decision below: fires once per fresh transition
  // into DANGER_ZONE (state.regimeState.previousRegime was something else, now confirmed DANGER_ZONE).
  // Same pattern as the MANIPULATED block above (TICKET-027).
  if (
    onDangerZoneConfirmed &&
    regimeOutput.regime === MarketRegime.DANGER_ZONE &&
    state.regimeState.previousRegime !== MarketRegime.DANGER_ZONE
  ) {
    onDangerZoneConfirmed({
      symbol: input.symbol,
      timestamp: currentCandle.timestamp,
      atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
    });
  }

  const events: OrchestratorEvent[] = [];
  let accountBalance = input.accountBalance;
  const remainingPositions: OpenPositionEntry[] = [];
  // TICKET-081 — per-side circuit breaker state, updated below as MOMENTUM_DIRECT positions close.
  const circuitBreakerState: { LONG: MomentumDirectCircuitBreakerSideState; SHORT: MomentumDirectCircuitBreakerSideState } = {
    LONG: { ...state.momentumDirectCircuitBreaker.LONG },
    SHORT: { ...state.momentumDirectCircuitBreaker.SHORT },
  };

  // Step 3 — advance every currently open position for this symbol, independently. TICKET-056: was
  // "the one open position, if any" — now a loop, since a symbol can hold more than one. A same-candle
  // close of one position never affects any other still-open position's own SL/TP/trailing state.
  for (const entry of state.openPositions) {
    const { position, exitReason, exitPrice } = advancePosition(entry.position, currentCandle, input.candles5m, config.isLowConfidenceOrLowLiquidity);

    if (!position.closed) {
      // TICKET-078 — TP1/TP2 just filled without closing the position: surfaces the state
      // transition slTpManager.ts's onTp1Hit/onTp2Hit already made, no new decision logic.
      const newlyFilledTier = position.filledTiers.length > entry.position.filledTiers.length ? position.filledTiers[position.filledTiers.length - 1] : undefined;
      if (newlyFilledTier === 'TP1' || newlyFilledTier === 'TP2') {
        const tier = position.tpLevels.find((t) => t.label === newlyFilledTier) as TpLevel;
        events.push({
          type: 'PARTIAL_CLOSE',
          symbol: input.symbol,
          side: position.side,
          tier: newlyFilledTier,
          closePercent: tier.closePercent,
          // TICKET-107: was computeTierGrossPnl() (no fee deducted) — Telegram "Đã chốt X%" never
          // matched Binance's real net number. computeTierNetPnl() subtracts an ESTIMATED
          // proportional fee (workaround, not the root fix — see its own doc comment).
          pnlUsd: computeTierNetPnl(position, newlyFilledTier),
          newSlPrice: position.currentSlPrice,
          remainingPercent: position.remainingPositionSize / position.positionSize,
          accountBalanceAfter: accountBalance,
          timestamp: currentCandle.timestamp,
        });
      }
      remainingPositions.push({ position, meta: entry.meta });
      continue;
    }

    // Closed this candle: log + free up this slot.
    const pnlUsd = computeRealizedPnl(position, exitPrice as number);
    accountBalance += pnlUsd;
    const pnlPct = (pnlUsd / entry.meta.marginRequired) * 100;
    events.push({
      type: 'CLOSE',
      symbol: input.symbol,
      side: position.side,
      regime: entry.meta.regime,
      setupType: entry.meta.setupType,
      tpPlan: position.tpPlan,
      entryTimestamp: entry.meta.entryTimestamp,
      entryPrice: position.entryPrice,
      exitTimestamp: currentCandle.timestamp,
      exitPrice: exitPrice as number,
      exitReason: exitReason as ExitReason,
      pnlUsd,
      pnlPct,
      riskMultiplier: entry.meta.riskMultiplier,
      accountBalanceAfter: accountBalance,
      adx1h: regimeOutput.computedMetrics.adx1h,
    });

    // TICKET-081 — only MOMENTUM_DIRECT's own loss history drives this side's circuit breaker;
    // other setupTypes closing never touch it.
    if (entry.meta.setupType === 'MOMENTUM_DIRECT') {
      const sideState = circuitBreakerState[position.side];
      if (exitReason === 'SL') {
        sideState.consecutiveSlLosses += 1;
        if (sideState.consecutiveSlLosses >= config.momentumDirectCircuitBreakerLossThreshold) {
          sideState.cooldownUntilTimestamp = currentCandle.timestamp + config.momentumDirectCircuitBreakerCooldownMs;
        }
      } else {
        sideState.consecutiveSlLosses = 0;
        sideState.cooldownUntilTimestamp = null;
      }
    }
  }

  // Step 2 — try a new entry iff still under the per-symbol concurrency limit. TICKET-056: gated on
  // the INCOMING position count (state.openPositions.length), NOT `remainingPositions.length` — a
  // same-candle close must not unlock a same-candle re-entry, so behavior at the default limit of 1
  // stays byte-for-byte identical to every ticket before this one (close now, re-enter next candle).
  // PM-confirmed (2026-07-22): `accountBalance` passed to the sizer here already reflects this same
  // candle's own close(s) above, same sequencing already used across symbols within one backtest step.
  if (state.openPositions.length < config.maxConcurrentPositionsPerSymbol) {
    const { event, newEntry } = await tryOpenNewPosition(
      input,
      config,
      regimeOutput,
      currentCandle,
      accountBalance,
      onFunnelEvent,
      onSetupNotFiredDiagnostic,
      circuitBreakerState,
      onMomentumGateEvaluation,
      momentumContextSafetyState5mDiagnostic?.tracker.currentState,
      onMomentumContextDecision,
    );
    if (event) events.push(event);
    if (newEntry) remainingPositions.push(newEntry);
  }

  return {
    symbolState: {
      regimeState,
      openPositions: remainingPositions,
      momentumDirectCircuitBreaker: circuitBreakerState,
      ...(htfSafetyDiagnostic !== undefined ? { htfSafetyDiagnostic } : {}),
      ...(safetyState5mStabilizedDiagnostic !== undefined ? { safetyState5mStabilizedDiagnostic } : {}),
      ...(safetyState5mFinalStabilizedDiagnostic !== undefined ? { safetyState5mFinalStabilizedDiagnostic } : {}),
      ...(momentumContextSafetyState5mDiagnostic !== undefined ? { momentumContextSafetyState5m: momentumContextSafetyState5mDiagnostic } : {}),
      ...(localTradeThesis5mDiagnostic !== undefined ? { localTradeThesis5mDiagnostic } : {}),
      ...(setupSpecificThesisDiagnostic !== undefined ? { setupSpecificThesisDiagnostic } : {}),
      ...(momentumCandidateIntegrityDiagnostic !== undefined ? { momentumCandidateIntegrityDiagnostic } : {}),
    },
    accountBalance,
    events,
  };
}
