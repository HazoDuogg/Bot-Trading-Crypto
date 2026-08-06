import type { MarketRegime } from '../regime/types.js';
import type { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import type { SafetyHysteresisState } from '../regime/safetyState5m.js';
import type { SafetyState5mTrackerState } from '../regime/safetyState5mTracker.js';
import type { ManagedPositionState, TpLevel, TpPlan } from '../risk/slTpManager.js';
import type { EntryRouterConfig } from '../entry/types.js';
import type { MomentumFilterConfig, NeutralTransitionGateConfig, PlanAutoSelectionConfig } from '../xgbFilter/config.js';
import type { LocalTradeThesis5mResult } from './localTradeThesis5m.js';

export interface RegimeHysteresisState {
  previousRegime: MarketRegime | null;
  previousCandidateRegime: MarketRegime | null;
  streakCount: number;
  /** TICKET-014 Phần B: timestamp (ms) of the last candle where regime was confirmed DANGER_ZONE. Null if never. */
  previousDangerZoneTimestamp: number | null;
}

/**
 * Attributes of the trade at OPEN time that neither ManagedPositionState nor the entry/regime
 * layers persist on their own, but Part D's trade log needs at CLOSE time (regime/setupType can
 * change or go out of scope after entry; ManagedPositionState doesn't know about them at all).
 */
export interface OpenTradeMeta {
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  entryTimestamp: number;
  actualRiskDollar: number;
  marginRequired: number;
  riskMultiplier: number;
}

/**
 * TICKET-056: position + its trade-log metadata always created/removed together — paired into one
 * entry (rather than two parallel arrays) so there is no possibility of an index-sync bug between them.
 */
export interface OpenPositionEntry {
  position: ManagedPositionState;
  meta: OpenTradeMeta;
}

/**
 * TICKET-139 — diagnostic-only state for the split HTFContext/SafetyState5m state machines.
 * Only ever populated/read when OrchestratorConfig.htfSafetySplitDiagnosticEnabled is true;
 * undefined otherwise (see processCandle()). Never read by any entry/risk decision.
 */
export interface HtfSafetyDiagnosticState {
  previousHtfContext: HTFContext | null;
  safetyHysteresis: SafetyHysteresisState | null;
}

/**
 * TICKET-140 — diagnostic-only state for the stabilized SafetyState5m tracker. Only ever
 * populated/read when OrchestratorConfig.safetyState5mStabilizationEnabled is true; undefined
 * otherwise (see processCandle()). Never read by any entry/risk decision.
 */
export interface SafetyState5mStabilizedDiagnosticState {
  tracker: SafetyState5mTrackerState;
}

/**
 * TICKET-140B — diagnostic-only state for the FINAL stabilized SafetyState5m tracker (on top of
 * T140's, run independently side-by-side). Only ever populated/read when
 * OrchestratorConfig.safetyState5mFinalStabilizationEnabled is true; undefined otherwise (see
 * processCandle()). Never read by any entry/risk decision. Reuses SafetyState5mTrackerState's shape
 * (same fields, produced by regime/safetyState5mTrackerV2.ts's applySafetyState5mFinalStabilization()
 * instead of T140's applySafetyState5mStabilization()) — kept as its own named type so the two
 * diagnostics never get confused at the type level either.
 */
export interface SafetyState5mFinalStabilizedDiagnosticState {
  tracker: SafetyState5mTrackerState;
}

/**
 * TICKET-141 — diagnostic-only state for the Local Trade Thesis 5m engine's own independent
 * SafetyState5m final-stabilization tracker (deliberately its OWN tracker, not a read of T140B's
 * safetyState5mFinalStabilizedDiagnostic field, so localTradeThesis5mEnabled works standalone
 * without requiring safetyState5mFinalStabilizationEnabled to also be on — see TICKET-141 report's
 * "Judgment calls" section). Only ever populated/read when
 * OrchestratorConfig.localTradeThesis5mEnabled is true; undefined otherwise. Never read by any
 * entry/risk decision.
 */
export interface LocalTradeThesis5mDiagnosticState {
  tracker: SafetyState5mTrackerState;
  lastResult: LocalTradeThesis5mResult;
}

export interface SymbolState {
  regimeState: RegimeHysteresisState;
  /** TICKET-056: was `openPosition: ManagedPositionState | null` + `openMeta` — up to config.maxConcurrentPositionsPerSymbol entries now, each tracked fully independently (its own TP/SL/trailing). */
  openPositions: OpenPositionEntry[];
  /** TICKET-081 — per-side (LONG/SHORT) MOMENTUM_DIRECT loss-streak circuit breaker for THIS symbol. */
  momentumDirectCircuitBreaker: { LONG: MomentumDirectCircuitBreakerSideState; SHORT: MomentumDirectCircuitBreakerSideState };
  /** TICKET-139 — see HtfSafetyDiagnosticState doc comment. Undefined when the flag is off/unused so far. */
  htfSafetyDiagnostic?: HtfSafetyDiagnosticState;
  /** TICKET-140 — see SafetyState5mStabilizedDiagnosticState doc comment. Undefined when the flag is off/unused so far. */
  safetyState5mStabilizedDiagnostic?: SafetyState5mStabilizedDiagnosticState;
  /** TICKET-140B — see SafetyState5mFinalStabilizedDiagnosticState doc comment. Its own field, independent of T140's above — never collides/shares state with it. Undefined when the flag is off/unused so far. */
  safetyState5mFinalStabilizedDiagnostic?: SafetyState5mFinalStabilizedDiagnosticState;
  /** TICKET-141 — see LocalTradeThesis5mDiagnosticState doc comment. Undefined when the flag is off/unused so far. */
  localTradeThesis5mDiagnostic?: LocalTradeThesis5mDiagnosticState;
}

export const INITIAL_SYMBOL_STATE: SymbolState = {
  regimeState: { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null },
  openPositions: [],
  momentumDirectCircuitBreaker: {
    LONG: { consecutiveSlLosses: 0, cooldownUntilTimestamp: null },
    SHORT: { consecutiveSlLosses: 0, cooldownUntilTimestamp: null },
  },
};

export type ExitReason = 'TP1' | 'TP2' | 'RUNNER_SL' | 'SL' | 'BREAKEVEN_SL' | 'COUNTER_TREND_TP';

export interface OpenTradeEvent {
  type: 'OPEN';
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  tpPlan: TpPlan;
  entryTimestamp: number;
  entryPrice: number;
  riskMultiplier: number;
  actualRiskDollar: number;
  marginRequired: number;
  /** TICKET-078 — surfaced for Telegram notifications, already computed at open time, no new formula. */
  slPrice: number;
  /** TICKET-078 — the position's own computed TP tiers (TREND: TP1/TP2/TP3_RUNNER, COUNTER_TREND: single COUNTER_TREND_TP). */
  tpLevels: TpLevel[];
  /** TICKET-078 — undefined when regime's own ATR/ADX history was insufficient (same as everywhere else in this codebase). */
  adx1h?: number;
  atrPercentile5m?: number;
  /** TICKET-078 — undefined unless momentumFilterConfig/planAutoSelectionConfig/MOMENTUM_DIRECT actually needed the score this candle. */
  momentumScore?: number;
  /** TICKET-078 — this symbol's existing risk pool usage (% of accountBalance) before/after this position, from the exact same numbers wouldExceedRiskPool() already checked. */
  riskPoolPctBefore: number;
  riskPoolPctAfter: number;
}

export interface CloseTradeEvent {
  type: 'CLOSE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  tpPlan: TpPlan;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: ExitReason;
  pnlUsd: number;
  /** % return on margin deployed at open (marginRequired), not on notional. */
  pnlPct: number;
  riskMultiplier: number;
  accountBalanceAfter: number;
  /** TICKET-078 — surfaced for Telegram notifications; undefined when insufficient ATR/ADX history. */
  adx1h?: number;
}

/**
 * TICKET-078 — fires when TP1/TP2 fills WITHOUT closing the position (SL choreography moves but
 * `closed` stays false) — surfaces an already-happening internal state transition (onTp1Hit/onTp2Hit
 * in slTpManager.ts), no new decision logic. pnlUsd is GROSS for just this tier's slice (fees are
 * only finalized once at full close, per computeRealizedPnl's own doc comment — never split per tier).
 */
export interface PartialCloseEvent {
  type: 'PARTIAL_CLOSE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  tier: 'TP1' | 'TP2';
  closePercent: number;
  pnlUsd: number;
  newSlPrice: number;
  /** Fraction (0-1) of the ORIGINAL positionSize still open after this tier. */
  remainingPercent: number;
  /** Unchanged from before this fill — PNL isn't credited to accountBalance until the position fully closes. */
  accountBalanceAfter: number;
  timestamp: number;
}

export interface SkippedEntryEvent {
  type: 'SKIPPED';
  symbol: string;
  timestamp: number;
  /**
   * TICKET-036: NEUTRAL_GATE_REJECTED = the mandatory Momentum Gate rejected a NEUTRAL_TRANSITION
   * DraftSetup — a distinct reason from risk-pool capacity, never conflated.
   * TICKET-101 Việc 2: MAX_TOTAL_MARGIN_EXCEEDED = a SEPARATE cap from RISK_POOL_EXCEEDED — the sum
   * of real margin$ committed across ALL 4 symbols (not the risk$-if-SL-hits figure Risk Pool bounds)
   * would exceed config.maxTotalMarginPct × accountBalance. A candidate can clear the Risk Pool check
   * (small risk$) yet still be rejected here (large margin$) — both checks are independent.
   */
  reason: 'RISK_POOL_EXCEEDED' | 'NEUTRAL_GATE_REJECTED' | 'MAX_TOTAL_MARGIN_EXCEEDED';
}

export type OrchestratorEvent = OpenTradeEvent | CloseTradeEvent | PartialCloseEvent | SkippedEntryEvent;

export interface OrchestratorConfig {
  entryRouterConfig: EntryRouterConfig;
  tpPlan: TpPlan;
  takerFeeRate: number;
  riskDollarOrPercent: number;
  maxMarginCap: number;
  leverage: number;
  riskPoolMaxPct: number;
  /** No Confidence Score exists yet to set this dynamically — defaults false (normal 60% Giveback lock). */
  isLowConfidenceOrLowLiquidity: boolean;
  /** TICKET-024 Phần C: soft risk-multiplier from the momentum ONNX model — backtest-only A/B testing, not wired into live. */
  momentumFilterConfig: MomentumFilterConfig;
  /** TICKET-036: hard Momentum Gate for NEUTRAL_TRANSITION only — backtest-only A/B testing, not wired into live. */
  neutralTransitionGateConfig: NeutralTransitionGateConfig;
  /** TICKET-052: AI-driven Plan A/B selection, TREND scenario only — backtest-only A/B testing, not wired into live. */
  planAutoSelectionConfig: PlanAutoSelectionConfig;
  /**
   * TICKET-056: max simultaneously-open positions per symbol. Default 1 — matches every behavior
   * before this ticket exactly (routeEntry() only ever tried when the symbol had zero open positions).
   * Does NOT loosen any signal-detection condition — each additional slot still goes through the
   * exact same Regime/OB/FVG/Sweep/Breakout/MSS/Momentum Gate pipeline independently.
   */
  maxConcurrentPositionsPerSymbol: number;
  /**
   * TICKET-059 — AI momentum score used DIRECTLY as an independent entry signal (not just a
   * filter/multiplier on top of OB/FVG/Sweep/Breakout), only tried when routeEntry()'s existing
   * cascade found NOTHING for this candle. Default false — matches every ticket before this one exactly.
   */
  momentumDirectEnabled: boolean;
  /** TODO_CONFIRM: PM suggested 0.75. Momentum score (own-side model) must be >= this to trigger MOMENTUM_DIRECT. */
  momentumDirectThreshold: number;
  /**
   * TICKET-062 — TODO_CONFIRM: PM suggested 80 (matches TICKET-061's group-split threshold).
   * atrPercentile5m at the candidate candle must be <= this for MOMENTUM_DIRECT to trigger; undefined
   * (insufficient history) always blocks. Default 100 = no real-world cap (percentile rank never
   * exceeds 100), matching every ticket before this one exactly.
   */
  momentumDirectMaxAtrPercentile: number;
  /**
   * TICKET-064 Phần A — TODO_CONFIRM: PM suggested 0.5 (%). After computing the ATR-based SL for
   * MOMENTUM_DIRECT, if the resulting SL distance (%) is narrower than this floor, the SL is widened
   * out to exactly this floor instead — dilutes the fixed 2-way taker fee against a wider risk
   * distance (TICKET-063: fees ate 32.64% of the median SL distance pre-ticket).
   */
  momentumDirectMinSlPercent: number;
  /**
   * TICKET-064 Phần B — TODO_CONFIRM: PM suggested 2.0. Replaces the old fixed 0.5% TP
   * (EntryConfig.MOMENTUM_DIRECT_TP_PCT, removed by this ticket): TP = this × R, where R is the SL
   * distance AFTER the momentumDirectMinSlPercent floor above has already been applied.
   */
  momentumDirectTpRMultiple: number;
  /**
   * TICKET-068 — TODO_CONFIRM: PM suggested 2. Caps the TOTAL number of currently open
   * setupType='MOMENTUM_DIRECT' positions across ALL symbols combined (not per-symbol —
   * maxConcurrentPositionsPerSymbol above still applies independently, in parallel; a candidate must
   * clear BOTH). TICKET-067 found 4 concurrent same-direction MOMENTUM_DIRECT positions (2 symbols ×
   * 2 each) all lost together in one correlated move, driving the -39.68% Max Drawdown. Default a
   * very large number (e.g. 999) = no real-world cap, matching every ticket before this one exactly.
   */
  momentumDirectMaxTotalConcurrent: number;
  /**
   * TICKET-071 (renamed from momentumDirectCorrelationBlockThreshold, TICKET-070 — same value,
   * different action) — TODO_CONFIRM: PM suggested 0.90. Combined (not standalone) risk trigger:
   * fires only when BOTH are true at once — correlatedRiskRatio (already computed, TICKET-030) at or
   * above this threshold AND at least 1 other-symbol setupType='MOMENTUM_DIRECT' position already
   * open on the SAME side as this candidate. TICKET-069 found correlatedRiskRatio alone doesn't
   * separate winners from losers (0.0029 mean difference), but was elevated (0.90-0.93) exactly
   * during TICKET-067's 4-concurrent-same-side Drawdown episode. TICKET-068/070 found outright
   * BLOCKING on this trigger makes Max Drawdown worse (path-dependent effect) — TICKET-071 instead
   * scales the trade's size down via momentumDirectCorrelationRiskMultiplier below, keeping it in
   * the trade sequence. Default a value no real correlatedRiskRatio ever reaches (e.g. 999) = never
   * fires, matching every ticket before this one exactly.
   */
  momentumDirectCorrelationRiskThreshold: number;
  /**
   * TICKET-071 — TODO_CONFIRM: PM suggested 0.5. When the combined trigger above fires, this
   * multiplies into the DraftSetup's own riskMultiplier (same field regimeRiskMultiplier already
   * populates) — tryOpenNewPosition() already multiplies riskMultiplier × momentumMultiplier into
   * combinedRiskMultiplier before sizing, so this reuses that exact mechanism, no new plumbing.
   * Default 1.0 = no size change, matching every ticket before this one exactly when the trigger
   * never fires (momentumDirectCorrelationRiskThreshold=999 default).
   */
  momentumDirectCorrelationRiskMultiplier: number;
  /**
   * TICKET-081 — TODO_CONFIRM: PM suggested 3. Per symbol+side circuit breaker (khác hẳn
   * momentumDirectCorrelationRiskThreshold ở trên — cái đó phản ứng theo tương quan/biến động THỜI
   * ĐIỂM HIỆN TẠI, chỉ số đã được TICKET-069 xác nhận KHÔNG phân biệt được thắng/thua; cái này phản
   * ứng theo LỊCH SỬ THUA THẬT của chính symbol+side đó). Khi setupType='MOMENTUM_DIRECT' đóng lệnh
   * với exitReason='SL' đủ số lần liên tiếp này trên CÙNG symbol+side, tạm dừng bắn tín hiệu
   * MOMENTUM_DIRECT cho ĐÚNG symbol+side đó (không ảnh hưởng symbol/side khác). Default một số rất
   * lớn (999999) = không bao giờ kích hoạt, giống mọi ticket trước ticket này.
   */
  momentumDirectCircuitBreakerLossThreshold: number;
  /**
   * TICKET-081 — TODO_CONFIRM: PM suggested 2 giờ (7_200_000 ms). Thời gian tạm dừng sau khi cầu dao
   * kích hoạt. Bộ đếm reset về 0 ngay khi có 1 lệnh MOMENTUM_DIRECT đóng KHÔNG PHẢI 'SL' (tức thắng)
   * trên đúng symbol+side đó — không cần chờ hết thời gian nghỉ mới reset đếm.
   */
  momentumDirectCircuitBreakerCooldownMs: number;
  /**
   * TICKET-098 — CLI-overridable momentum model file paths (bullish + bearish, .onnx + feature
   * schema), so backtest.ts's --momentum-model-version=v1|v3 flag can A/B a retrained model without
   * touching xgbFilter/config.ts's production paths or hardcoding a version anywhere. undefined =
   * use xgbFilter/config.ts's MOMENTUM_MODEL_PATH/MOMENTUM_SCHEMA_PATH/MOMENTUM_BEARISH_* (default
   * v1 production paths), matching every ticket before this one exactly.
   */
  momentumModelPath?: string;
  momentumSchemaPath?: string;
  momentumBearishModelPath?: string;
  momentumBearishSchemaPath?: string;
  /**
   * TICKET-101 Việc 2 — TODO_CONFIRM (PM gợi ý 50-60%, chưa chốt số): trần TỔNG MARGIN thật đang mở
   * cùng lúc trên CẢ 4 coin gộp lại, dạng phân số thập phân (0.5 == 50%, cùng convention
   * `riskPoolMaxPct`). Kiểm tra ĐỘC LẬP với Risk Pool (Risk Pool bound risk$-nếu-SL-chạm, cái này
   * bound margin$ thật đã dùng — 1 lệnh có thể qua được Risk Pool nhưng vẫn bị chặn ở đây nếu margin
   * quá lớn). `undefined` = không giới hạn (unreachable), khớp mọi ticket trước ticket này.
   */
  maxTotalMarginPct?: number;
  /**
   * TICKET-122 — opt-in, default-inert OOD (out-of-distribution) guard for the Bearish (SHORT)
   * MOMENTUM_DIRECT model. TICKET-121's forensic report found the Bearish model's highest-confidence
   * decile has an abnormally low real winrate, root-caused to emaRatioSlow being out-of-distribution
   * relative to training data when scoring a SHORT candidate. `undefined` (default) = guard fully
   * disabled, byte-identical to every ticket before this one — only backtest.ts's new
   * --ood-guard-mode= CLI flag (default NONE) ever sets this field; never wired into any production
   * default config (liveRunner.ts / the official backtest command never pass it).
   */
  oodGuardConfig?: {
    /** emaRatioSlow OOD threshold (P90/P95/P97.5 of the Bearish TRAIN split — computed offline, passed in as a plain number, never recomputed here). Candidate is OOD when emaRatioSlow > this value. */
    emaRatioSlowThreshold: number;
    mode: 'HARD_REJECT' | 'SCORE_CAP' | 'RISK_REDUCTION';
    /**
     * SCORE_CAP only — effective score ceiling applied to an OOD SHORT candidate's shortScore before
     * the detectMomentumDirect() pass/fail check. TODO_CONFIRM (PM chooses final value): a cap at or
     * below momentumDirectThreshold makes SCORE_CAP behave like HARD_REJECT for that candidate; a cap
     * above threshold still lets it pass, just scored more conservatively.
     */
    scoreCapValue: number;
    /**
     * RISK_REDUCTION only — multiplies into the SAME riskMultiplier field TICKET-071's
     * correlationRiskMultiplier already multiplies into (combinedRiskMultiplier before sizing) —
     * exact same mechanism/multiplication point, no new plumbing. TODO_CONFIRM (PM chooses final
     * value): e.g. 0.3 shrinks an OOD SHORT candidate's size to 30% instead of rejecting it outright,
     * mirroring why TICKET-071 chose Risk Reduction over Hard Reject (avoids path-dependent
     * trade-chain reshuffling).
     */
    riskReductionMultiplier: number;
  };
  /**
   * TICKET-130 — opt-in, default-inert Neutral 5m Direction Selector. `undefined` (default) or
   * `false` = fully disabled, byte-identical to every ticket before this one. Only meaningful while
   * regime===NEUTRAL_TRANSITION (see orchestrator.ts's tryMomentumDirect()) — computes a 5m
   * directional verdict (LONG/SHORT/NONE, neutral5mDirectionSelector.ts) from 3 unanimous
   * sub-confirmations (EMA9/EMA21 cross+slope, DI direction, recent sided structural break) plus an
   * anti-chase overextension override, and rejects ONLY the disagreeing side of
   * tryMomentumDirect()'s own LONG/SHORT candidates — never creates a candidate, never flips
   * LONG<->SHORT, never bypasses the AI gate/macro filter (both still apply independently), never
   * touches neutralTransitionGateConfig/the OB-FVG-Sweep-BoxBreakout cascade. Only backtest.ts's new
   * --neutral-5m-direction-selector-enabled= CLI flag (default false) ever sets this field; never
   * wired into any production default config.
   */
  neutral5mDirectionSelectorEnabled?: boolean;
  /**
   * TICKET-131 — opt-in, default-inert Neutral 5m Direction-Gated Setup Routing. `undefined` (default)
   * or `false` = fully disabled, byte-identical to every ticket before this one. Only meaningful while
   * regime===NEUTRAL_TRANSITION AND the candidate's setupType !== 'MOMENTUM_DIRECT' (see
   * orchestrator.ts's tryOpenNewPosition() NEUTRAL_TRANSITION gate block) — computes a RELAXED 5m
   * directional verdict (LONG/SHORT/NONE, neutral5mDirectionGatedRouting.ts, 2-of-2 EMA+DI agreement,
   * NOT TICKET-130's 3-of-3 rule) and provides an ALTERNATE way past that block's early-return, ONLY
   * when direction5m matches the OB/FVG/SWEEP/BOX_BREAKOUT candidate's own side. Never sets/reads
   * neutralTransitionGateConfig.neutralTransitionTradingEnabled itself (that field's value is always
   * whatever the caller configured, untouched by this flag) — this is a SEPARATE, additional way past
   * the same early-return, not a replacement for that config. A candidate let through still must clear
   * the EXACT SAME unmodified AI momentum gate (scoreMomentumForSide/gatePassed) that already exists in
   * that block. Never touches tryMomentumDirect() or any regime other than NEUTRAL_TRANSITION. Only
   * backtest.ts's new --neutral-5m-direction-gated-routing-enabled= CLI flag (default false) ever sets
   * this field; never wired into any production default config.
   */
  neutral5mDirectionGatedRoutingEnabled?: boolean;
  /**
   * TICKET-138 — opt-in, default-inert Neutral 5m Conditional Override for HTF (1D macro) conflict.
   * `'NONE'` (default, including when the field itself is undefined) = fully disabled, byte-identical
   * to every ticket before this one — tryMomentumDirect()'s mandatory macro-alignment early-return
   * ((side==='LONG' && macroDirection==='DOWN') || (side==='SHORT' && macroDirection==='UP')) fires
   * exactly as before. Only meaningful while regimeOutput.regime===MarketRegime.NEUTRAL_TRANSITION —
   * TREND_RIDER and every other regime that also calls tryMomentumDirect() always keeps the
   * unconditional hard block, regardless of this flag.
   *   'UNFILTERED' — the macro-conflict early-return is skipped unconditionally for NEUTRAL_TRANSITION
   *     candidates (V1, control-only per the ticket — never itself a basis for shipping to production).
   *   'CONDITIONAL_5M' — the early-return is skipped ONLY when neutralMacroConflictOverride.ts's
   *     is5mConfirmed() (a NEW, deliberately simpler 2-of-2 raw-EMA+raw-DI rule — NOT TICKET-130's
   *     computeDirection5m() 3-of-3, per the ticket's explicit "Không dùng computeDirection5m() 3/3
   *     cũ") agrees with the candidate's side; otherwise the hard block still fires, same as 'NONE'.
   * Whenever the override actually fires (either mode), the resulting DraftSetup's riskMultiplier is
   * additionally multiplied by 0.30 (TICKET-138 ticket-given constant, not tuned) via the SAME
   * multiplication chain correlationRiskMultiplier/oodRiskMultiplier already use — no new plumbing.
   * Never applies to setupType!=='MOMENTUM_DIRECT' candidates (routeEntry()'s OB/FVG/SWEEP/BOX_BREAKOUT
   * cascade is untouched). Only backtest.ts's new --neutral-macro-conflict-override-mode= CLI flag
   * (default 'NONE') ever sets this field; never wired into any production default config.
   */
  neutralMacroConflictOverrideMode?: 'NONE' | 'UNFILTERED' | 'CONDITIONAL_5M';
  /**
   * TICKET-139 — opt-in, default-inert HTFContext/SafetyState5m split diagnostic. `undefined`
   * (default) or `false` = fully disabled, byte-identical to every ticket before this one:
   * processCandle() does not even compute HTFContext/SafetyState5m in that case (gated at the
   * computation itself, not just at the decision layer). Does NOT change regimeOutput,
   * MarketRegime, entry routing, position sizing, or any existing decision path at ANY setting —
   * this ticket is diagnostic groundwork only (see TICKET-139 brief). When true, processCandle()
   * additionally computes regime/htfContext.ts's classifyHtfContextCandidate() and
   * regime/safetyState5m.ts's classifySafetyState5mCandidate()+applySafetyState5mHysteresis()
   * each call, tracks their own hysteresis state per symbol (SymbolState.htfSafetyDiagnostic),
   * and fires the new onHtfContextChange/onSafetyState5mChange callbacks ONLY on a confirmed
   * state change vs the previous candle (not every candle) — same "log only, never gate" contract
   * the ticket requires. Only backtest.ts's new --htf-safety-split-diagnostic-enabled= CLI flag
   * (default false) ever sets this field; never wired into any production default config.
   */
  htfSafetySplitDiagnosticEnabled?: boolean;
  /**
   * TICKET-140 — opt-in, default-inert SafetyState5m transition stabilization diagnostic. `undefined`
   * (default) or `false` = fully disabled, byte-identical to every ticket before this one:
   * processCandle() does not even compute the stabilized tracker in that case (gated at the
   * computation itself, same pattern as htfSafetySplitDiagnosticEnabled). Does NOT change
   * regimeOutput, MarketRegime, HTFContext, entry routing, position sizing, or any existing decision
   * path at ANY setting — diagnostic groundwork only (see TICKET-140 brief). When true, processCandle()
   * additionally runs regime/safetyState5mTracker.ts's applySafetyState5mStabilization() on top of
   * TICKET-139's unchanged classifySafetyState5mCandidate(), tracks its own state per symbol
   * (SymbolState.safetyState5mStabilizedDiagnostic), and fires the new onSafetyState5mStabilized
   * callback ONLY on a confirmed state change vs the previous candle — same "log only, never gate"
   * contract TICKET-139's flag uses. Only backtest.ts's new
   * --safety-state-5m-stabilization-enabled= CLI flag (default false) ever sets this field; never
   * wired into any production default config.
   */
  safetyState5mStabilizationEnabled?: boolean;
  /**
   * TICKET-140B — opt-in, default-inert FINAL SafetyState5m chattering-reduction diagnostic on top of
   * T140's. `undefined` (default) or `false` = fully disabled, byte-identical to every ticket before
   * this one: processCandle() does not even compute the final-stabilized tracker in that case (gated
   * at the computation itself, same pattern as safetyState5mStabilizationEnabled). Does NOT change
   * regimeOutput, MarketRegime, HTFContext, entry routing, position sizing, or any existing decision
   * path at ANY setting — diagnostic groundwork only (see TICKET-140B brief). When true,
   * processCandle() additionally runs regime/safetyState5mTrackerV2.ts's
   * applySafetyState5mFinalStabilization() on top of TICKET-139's unchanged
   * classifySafetyState5mCandidate(), independently of (and simultaneously with, when both flags are
   * on) T140's own tracker — tracks its own state per symbol
   * (SymbolState.safetyState5mFinalStabilizedDiagnostic, never sharing/colliding with T140's field),
   * and fires the new onSafetyState5mFinalStabilized callback ONLY on a confirmed state change vs the
   * previous candle — same "log only, never gate" contract T139/T140's flags use. Only backtest.ts's
   * new --safety-state-5m-final-stabilization-enabled= CLI flag (default false) ever sets this field;
   * never wired into any production default config.
   */
  safetyState5mFinalStabilizationEnabled?: boolean;
  /**
   * TICKET-141 — opt-in, default-inert 5m Local Trade Thesis Engine diagnostic. `undefined` (default)
   * or `false` = fully disabled, byte-identical to every ticket before this one: processCandle() does
   * not even compute the thesis in that case (gated at the computation itself, same pattern as every
   * other T139/T140/T140B flag). Does NOT change regimeOutput, MarketRegime, HTFContext, entry
   * routing, position sizing, or any existing decision path at ANY setting — diagnostic groundwork
   * only (see TICKET-141 brief §1/§11/§13: "chưa được dùng thesis để ALLOW hoặc BLOCK lệnh"). When
   * true, processCandle() additionally runs orchestrator/localTradeThesis5m.ts's
   * computeLocalTradeThesis5m() EVERY closed 5m candle (not just on change, unlike T139/T140/T140B —
   * §8's CSV wants one row per candle), independently re-classifying SafetyState5m via TICKET-139's
   * unchanged classifySafetyState5mCandidate() + its OWN final-stabilization tracker (SymbolState.
   * localTradeThesis5mDiagnostic, never sharing state with T140B's own field — see
   * LocalTradeThesis5mDiagnosticState doc comment for why), and fires the new onLocalTradeThesis5m
   * callback every candle. Only backtest.ts's new --local-trade-thesis-5m-enabled= CLI flag (default
   * false) ever sets this field; never wired into any production default config.
   */
  localTradeThesis5mEnabled?: boolean;
}

/** TICKET-081 — trạng thái cầu dao cho 1 chiều (LONG hoặc SHORT) của 1 symbol. */
export interface MomentumDirectCircuitBreakerSideState {
  consecutiveSlLosses: number;
  /** null = không đang trong thời gian nghỉ. */
  cooldownUntilTimestamp: number | null;
}
