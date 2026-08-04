/**
 * TICKET-124 Phần B — Shadow Tactical State 5m classifier. Rule-based (no ML), read-only,
 * SHADOW-ONLY: never called by production entry/regime code, never imported by orchestrator.ts's
 * real decision path. Feature-gated by TACTICAL_REGIME_5M_ENABLED (default false, must stay
 * unreachable in production) — this module itself has no knowledge of that flag, it's just a pure
 * function; the flag lives in the caller (ticket124TacticalShadowAudit.ts) that decides whether to
 * invoke it at all.
 *
 * Does NOT override apps/bot/src/regime/regimeDetector.ts's detectRegime() or replace the Regime
 * Engine — this is an ADDITIONAL, separate 5m-only classification layer, purely for audit purposes.
 *
 * Design note (per ticket spec): thresholds below were picked from first-principles/existing bot
 * conventions BEFORE running any Phần D/E analysis on real data, and are NOT tuned afterward to make
 * results look better. Every threshold not directly reused from regime/config.ts or entry/config.ts
 * is marked TODO_CONFIRM, same convention as those files.
 */
import type { CandleData, ComputedMetrics } from '../regime/types.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wickRatios, wilderATRSeries } from '../regime/indicators.js';

export enum TacticalState {
  NEUTRAL_COMPRESSION = 'NEUTRAL_COMPRESSION',
  NEUTRAL_EXPANSION = 'NEUTRAL_EXPANSION',
  MICRO_TREND = 'MICRO_TREND',
  MICRO_CHOP = 'MICRO_CHOP',
}

export type TacticalSide = 'LONG' | 'SHORT' | null;

/**
 * Subset of xgbFilter/featureBuilder.ts's computeMomentumCrossFeatures() output — reused verbatim,
 * never re-derived. TICKET-126: `volAdjReturn5m` itself is kept here ONLY for backward-compat with
 * callers that still populate it (e.g. scripts feeding featureBuilder.ts's raw output straight
 * through) — this module no longer READS it for classification (see `computeReturnInAtr5m` below).
 */
export interface TacticalCrossFeatures {
  volAdjReturn5m: number;
  emaRatioFast: number;
  emaRatioSlow: number;
}

export interface TacticalCandleInput {
  /** From RegimeOutput.computedMetrics (regimeDetector.ts's detectRegime(), read-only, never recomputed here). */
  computedMetrics: ComputedMetrics;
  /** xgbFilter/featureBuilder.ts's computeMomentumCrossFeatures() output — undefined until enough 1h EMA(200) history exists. */
  crossFeatures: TacticalCrossFeatures | undefined;
  /** Trailing 5m candles ending at "now" (last element = candle just closed), no look-ahead. Needs >= CHOP_LOOKBACK_CANDLES + 1 for the chop-flip check; fewer is fine, that check just can't fire. */
  candles5m: CandleData[];
  /**
   * Caller-supplied BOS/structural-break confirmation on this candle — reuse of entry/entryRouter.ts's
   * own detector cascade (e.g. detectMarketStructureShift/detectBoxBreakout/detectOrderBlock all
   * finding a confirmation here), NOT recomputed inside this module (this module stays decoupled from
   * entry/ detectors, same one-way-import discipline regime/ already follows toward entry/). Optional:
   * undefined/false never blocks NEUTRAL_COMPRESSION/MICRO_CHOP, and simply means MICRO_TREND/fast-enter
   * EXPANSION can't match this candle.
   *
   * TICKET-125 Việc B: backward-compatible union — a plain boolean keeps the OLD (TICKET-124,
   * direction-agnostic, unstaled) meaning for any caller that still only has a single flag. NEW
   * callers (the TICKET-125 shadow audit) pass the richer `{ LONG, SHORT }` form so this module can
   * pick the flag matching the SIDE it's actually scoring (LONG for NEUTRAL_EXPANSION/MICRO_TREND's
   * up-candidate, SHORT for the down-candidate) instead of a single caller-picked macro direction —
   * still computed entirely outside this module (entry/ detectors stay decoupled from tactical/).
   */
  hasStructuralBreak?: boolean | { LONG: boolean; SHORT: boolean };
}

/** TICKET-125: resolve the boolean|{LONG,SHORT} union for a specific candidate side. undefined side (no side determined yet) -> false (never blocks the null-side states, which don't check this anyway). */
function structuralBreakFor(hasStructuralBreak: TacticalCandleInput['hasStructuralBreak'], side: 'LONG' | 'SHORT' | null): boolean {
  if (hasStructuralBreak === undefined || side === null) return false;
  if (typeof hasStructuralBreak === 'boolean') return hasStructuralBreak;
  return hasStructuralBreak[side];
}

/** TICKET-125: "no structural break" reason codes (NEUTRAL_COMPRESSION's NO_STRUCTURAL_BREAK check) must hold for BOTH sides when the richer form is used — a break on either side is still a break. */
function noStructuralBreakEitherSide(hasStructuralBreak: TacticalCandleInput['hasStructuralBreak']): boolean {
  if (hasStructuralBreak === undefined) return true;
  if (typeof hasStructuralBreak === 'boolean') return hasStructuralBreak !== true;
  return hasStructuralBreak.LONG !== true && hasStructuralBreak.SHORT !== true;
}

/**
 * All tactical thresholds — same "no inline magic number" convention as regime/config.ts.
 * Reused-from-bot values are cited explicitly; new ones are marked TODO_CONFIRM with the
 * first-principles reasoning that produced them.
 */
export const TacticalConfig = {
  // ---- NEUTRAL_COMPRESSION ----
  /** Reused verbatim: RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter — same "extreme-low bandwidth" bar the Regime Engine's own COMPRESSION uses. */
  COMPRESSION_BBW_PCT_MAX: RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter,
  /** TODO_CONFIRM: no existing "low ATR percentile" bot threshold to reuse (regime/config.ts only has HIGH-side ATR bars: DANGER 95, TREND 65, CHOP 70). 30 = bottom third of the rolling percentile distribution, a first-principles "quiet" cutoff, symmetric-ish counterpart to those high bars. */
  ATR_PCT_LOW_MAX: 30,
  /** Reused verbatim: RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter — already means "volume NOT elevated" in this codebase; reused here with the identical meaning (not a coincidence of value). */
  VOLUME_NOT_EXPANDING_ZSCORE_MAX: RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter,

  // ---- NEUTRAL_EXPANSION ----
  /** TODO_CONFIRM: deliberately BELOW RegimeConfig.TREND_ENTER_ATR_PCT.enter (65) — this is a 5m micro-burst signal, not the 1h-driven full Regime Engine trend, so the bar should be easier to clear. 55 = just above the median (50th pct). */
  ATR_PCT_EXPANSION_MIN: 55,
  /** Same numeric value as VOLUME_NOT_EXPANDING_ZSCORE_MAX by construction — the line volume must CROSS to count as "expanding" instead of staying under. */
  VOLUME_EXPANSION_ZSCORE_MIN: 1.5,
  /** Reused verbatim: RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter — the bot's own existing "big volume spike" bar, reused as the fast-enter (1-candle) volume trigger. */
  VOLUME_EXPANSION_FAST_ENTER_ZSCORE: 2.5,
  /**
   * @deprecated TICKET-126: no longer read by classifyTacticalCandidate() — DIRECTIONAL_RETURN_OK
   * now checks `returnInAtr5m` against TACTICAL_EXPANSION_RETURN_ATR_MIN instead. Kept (unused) only
   * as a documented historical record of the old (unit-mismatched) threshold.
   */
  DIRECTIONAL_RETURN_MIN: 1.0,
  /**
   * TICKET-126: given directly by the ticket spec, NOT derived/tuned by this implementation.
   * Replaces DIRECTIONAL_RETURN_MIN's role in NEUTRAL_EXPANSION's DIRECTIONAL_RETURN_OK check, now
   * measured against `computeReturnInAtr5m()` (unit-free, price-scale-independent) instead of the
   * unit-mismatched `volAdjReturn5m`. 0.8 = candle-to-candle close move of at least 0.8x ATR.
   */
  TACTICAL_EXPANSION_RETURN_ATR_MIN: 0.8,
  /** Reused verbatim (same value/meaning): entry/config.ts's EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO — "a real push, not a wick" bar the bot already uses for its own breakout confirmation. Not imported directly (tactical/ stays decoupled from entry/, same one-way-import discipline regime/ follows) — value copied, not re-derived. */
  BODY_RATIO_STRONG: 0.5,
  /** TODO_CONFIRM: an extreme (top-decile) ATR percentile alone counts as a "strong enough" fast-enter trigger even without a volume spike. */
  ATR_PCT_FAST_ENTER: 90,

  // ---- MICRO_TREND ----
  /** TODO_CONFIRM: emaRatioFast/emaRatioSlow must clear 1 ± this tolerance to count as "aligned" rather than noise sitting right at 1.0000 (5m EMA9/21 and 1h EMA50/200 ratios are usually within a fraction of a percent of 1 in quiet markets). 0.05%, a small first-principles guard band. */
  EMA_ALIGNMENT_TOLERANCE: 0.0005,
  /**
   * @deprecated TICKET-126: no longer read by classifyTacticalCandidate() — RETURN_HELD now checks
   * `returnInAtr5m` against TACTICAL_MICRO_TREND_RETURN_ATR_MIN instead. Kept (unused) only as a
   * documented historical record of the old (unit-mismatched) threshold.
   */
  MICRO_TREND_RETURN_MIN: 0.3,
  /**
   * TICKET-126: given directly by the ticket spec, NOT derived/tuned by this implementation.
   * Replaces MICRO_TREND_RETURN_MIN's role in MICRO_TREND's RETURN_HELD check, now measured against
   * `computeReturnInAtr5m()` instead of the unit-mismatched `volAdjReturn5m`. Weaker than
   * TACTICAL_EXPANSION_RETURN_ATR_MIN (0.8) — MICRO_TREND is about sustained smaller pushes holding
   * direction, not one big burst candle (that's NEUTRAL_EXPANSION's job).
   */
  TACTICAL_MICRO_TREND_RETURN_ATR_MIN: 0.3,

  // ---- MICRO_CHOP ----
  /** TODO_CONFIRM: trailing window of 5m candles checked for direction flips — short enough to catch immediate noise, PM-style short lookback (cf. RegimeConfig.ATR_TREND_LOOKBACK_N=3, MANIPULATED_LOOKBACK_CANDLES=10; 4 sits between). */
  CHOP_LOOKBACK_CANDLES: 4,
  /** TODO_CONFIRM: >=2 sign flips of (close-open) within the lookback window = no directional persistence. */
  CHOP_MIN_FLIPS: 2,
  /** TODO_CONFIRM: deliberately looser than RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD (0.65, a genuine-sweep bar) — this only needs "half the candle is wick", a plain false-breakout proxy, not a confirmed liquidity sweep. */
  CHOP_WICK_RATIO_MIN: 0.5,

  // ---- Hysteresis ----
  /** Ticket spec: normal transition needs 2 of the last 3 candidate readings (this one included) to agree. */
  HYSTERESIS_WINDOW: 3,
  HYSTERESIS_MIN_AGREE: 2,
} as const;

export interface TacticalCandidateResult {
  state: TacticalState;
  side: TacticalSide;
  reasonCodes: string[];
  /** Fraction (0-1) of the matched (or, on fallback, the closest) state's own hard conditions that were true. */
  confidence: number;
  /** Strong-signal 1-candle confirmation eligibility, per ticket spec ("volume expansion lớn, breakout body mạnh, ATR/BB Width mở rộng đột biến, BOS rõ"). Always false for NEUTRAL_COMPRESSION/MICRO_CHOP (never specified as fast-enter states, and MICRO_CHOP is shadow-log-only regardless). */
  isFastEnter: boolean;
  /** False when computedMetrics lacks a required field for classification (should not happen once warm-up is complete, but never fabricates a classification if it does). */
  dataSufficient: boolean;
}

/** TICKET-125: exported (was private) so audit scripts (e.g. Việc A's feature-distribution audit) can reuse the exact same formula instead of duplicating it. */
export function candleDirection(candle: CandleData): 'UP' | 'DOWN' | 'FLAT' {
  if (candle.close > candle.open) return 'UP';
  if (candle.close < candle.open) return 'DOWN';
  return 'FLAT';
}

/** TICKET-125: exported (was private), same reason as candleDirection above. */
export function bodyRatioOf(candle: CandleData): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

/**
 * TICKET-126 — Tactical-only, unit-normalized replacement for `volAdjReturn5m` in the two return
 * checks below. `volAdjReturn5m` (xgbFilter/featureBuilder.ts) mixes a PERCENT numerator
 * (candleReturnPct, e.g. 0.05 = 0.05%) with an ABSOLUTE-PRICE-UNIT ATR denominator
 * (wilderATRSeries() is never normalized to %) — this makes its magnitude scale with 1/price
 * (BTC ~100k -> near-zero; XRP ~0.5 -> tens), which is THE reason NEUTRAL_EXPANSION/MICRO_TREND
 * had 0 candles on BTCUSDT/ETHUSDT even after TICKET-125's Structural Break fix (see
 * data/ticket125-classifier-sanity-audit-report.md). `volAdjReturn5m` itself is NOT touched — it
 * still feeds the real V1 XGBoost model unchanged (xgbFilter/featureBuilder.ts). This function is a
 * SEPARATE, tactical-only feature: `returnInAtr5m = (close - previousClose) / atr5mRaw` — candle-to-
 * candle close delta (NOT candleReturnPct's open-to-close-of-same-candle definition) divided by the
 * SAME already-computed ATR value computeMomentumCrossFeatures() uses (reused via the exact same
 * wilderATRSeries()/lastDefined() helpers, formula never re-derived). 1.0 = moved a full ATR,
 * 0.5 = half an ATR, -1.0 = dropped a full ATR — a genuinely unit-free, price-scale-independent ratio.
 * Returns undefined when there's no previous candle or ATR can't be computed yet (insufficient
 * history) — same "undefined means not enough data" convention as computeMomentumCrossFeatures().
 */
export function computeReturnInAtr5m(candles5m: CandleData[]): number | undefined {
  if (candles5m.length < 2) return undefined;
  const currentCandle = candles5m[candles5m.length - 1];
  const previousCandle = candles5m[candles5m.length - 2];
  const atr5mRaw = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr5mRaw === undefined || atr5mRaw === 0) return undefined;
  return (currentCandle.close - previousCandle.close) / atr5mRaw;
}

/** Count of sign-flips of (close-open) across consecutive candles in the trailing lookback window. TICKET-125: exported, same reason as above. */
export function countDirectionFlips(candles5m: CandleData[], lookback: number): number {
  const window = candles5m.slice(-lookback);
  if (window.length < 2) return 0;
  let flips = 0;
  let prevSign = Math.sign(window[0].close - window[0].open);
  for (let i = 1; i < window.length; i++) {
    const sign = Math.sign(window[i].close - window[i].open);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  return flips;
}

interface HardCheck {
  code: string;
  value: boolean;
}

function scoreOf(checks: HardCheck[]): { matched: boolean; confidence: number; reasonCodes: string[] } {
  const trueCodes = checks.filter((c) => c.value).map((c) => c.code);
  return { matched: checks.every((c) => c.value), confidence: checks.length === 0 ? 0 : trueCodes.length / checks.length, reasonCodes: trueCodes };
}

/**
 * Priority-order candidate classification (mirrors regimeDetector.ts's classifyCandidate() style) —
 * pure function, no hysteresis. Evaluates NEUTRAL_EXPANSION first (ticket: "State ưu tiên phân tích
 * nhất"), then MICRO_TREND, then NEUTRAL_COMPRESSION, then MICRO_CHOP; falls back to whichever of
 * NEUTRAL_COMPRESSION/MICRO_CHOP scores higher if nothing strictly matches (every 5m candle across
 * every existing Regime gets a tactical label — there is no 5th "none" state per ticket spec).
 */
export function classifyTacticalCandidate(input: TacticalCandleInput): TacticalCandidateResult {
  const { computedMetrics: m, crossFeatures: cf, candles5m, hasStructuralBreak } = input;
  const atrP = m.atrPercentile5m;
  const bbwP = m.bbWidthPercentile15m;
  const volZ = m.volumeZScore5m;
  const atrTrend = m.atrTrend5m;

  if (atrP === undefined || bbwP === undefined || volZ === undefined || atrTrend === undefined || candles5m.length === 0) {
    return { state: TacticalState.NEUTRAL_COMPRESSION, side: null, reasonCodes: ['INSUFFICIENT_METRICS'], confidence: 0, isFastEnter: false, dataSufficient: false };
  }

  const candle = candles5m[candles5m.length - 1];
  const dir = candleDirection(candle);
  const bodyRatio = bodyRatioOf(candle);
  const { upperWickRatio, lowerWickRatio } = wickRatios(candle);
  const flips = countDirectionFlips(candles5m, TacticalConfig.CHOP_LOOKBACK_CANDLES);
  // TICKET-126: unit-normalized replacement for volAdjReturn5m in the two return checks below —
  // computed straight from candles5m/ATR, independent of crossFeatures availability.
  const returnInAtr5m = computeReturnInAtr5m(candles5m);

  const sideFromCandleOrEma = (): TacticalSide => {
    if (dir === 'UP') return 'LONG';
    if (dir === 'DOWN') return 'SHORT';
    if (cf !== undefined) return cf.emaRatioFast >= 1 ? 'LONG' : 'SHORT';
    return null;
  };
  // TICKET-125: sides determined BEFORE the checks that need them, so STRUCTURAL_BREAK can be
  // resolved per-side (structuralBreakFor) instead of reading one caller-picked macro direction.
  const expansionSide = sideFromCandleOrEma();

  // ---- NEUTRAL_EXPANSION ----
  // TICKET-126: returnInAtr5m (unit-free) replaces volAdjReturn5m (unit-mismatched) here; same
  // "undefined -> permissive true" fallback convention as before (insufficient history never blocks).
  const directionalReturnOk = returnInAtr5m === undefined ? true : Math.abs(returnInAtr5m) >= TacticalConfig.TACTICAL_EXPANSION_RETURN_ATR_MIN;
  const expansionChecks: HardCheck[] = [
    { code: 'ATR_TREND_INCREASING', value: atrTrend === 'increasing' },
    { code: 'VOL_EXPANDING', value: volZ >= TacticalConfig.VOLUME_EXPANSION_ZSCORE_MIN },
    { code: 'BODY_STRONG', value: bodyRatio >= TacticalConfig.BODY_RATIO_STRONG },
    { code: 'ATR_PCT_HIGH', value: atrP >= TacticalConfig.ATR_PCT_EXPANSION_MIN },
    { code: 'DIRECTIONAL_RETURN_OK', value: directionalReturnOk },
  ];
  const expansionScore = scoreOf(expansionChecks);

  // ---- MICRO_TREND ----
  let emaAlignedUp = false;
  let emaAlignedDown = false;
  if (cf !== undefined) {
    emaAlignedUp = cf.emaRatioFast > 1 + TacticalConfig.EMA_ALIGNMENT_TOLERANCE && cf.emaRatioSlow > 1;
    emaAlignedDown = cf.emaRatioFast < 1 - TacticalConfig.EMA_ALIGNMENT_TOLERANCE && cf.emaRatioSlow < 1;
  }
  const trendSide: TacticalSide = emaAlignedUp ? 'LONG' : emaAlignedDown ? 'SHORT' : null;
  const trendChecks: HardCheck[] = [
    { code: 'CROSS_FEATURES_AVAILABLE', value: cf !== undefined },
    { code: 'EMA_ALIGNED', value: emaAlignedUp || emaAlignedDown },
    { code: 'STRUCTURAL_BREAK', value: structuralBreakFor(hasStructuralBreak, trendSide) },
    { code: 'NOT_CHOPPY', value: flips < TacticalConfig.CHOP_MIN_FLIPS },
    { code: 'RETURN_HELD', value: returnInAtr5m !== undefined && Math.abs(returnInAtr5m) >= TacticalConfig.TACTICAL_MICRO_TREND_RETURN_ATR_MIN },
  ];
  const trendScore = scoreOf(trendChecks);

  // ---- NEUTRAL_COMPRESSION ----
  const compressionChecks: HardCheck[] = [
    { code: 'ATR_PCT_LOW', value: atrP <= TacticalConfig.ATR_PCT_LOW_MAX },
    { code: 'BBW_LOW', value: bbwP <= TacticalConfig.COMPRESSION_BBW_PCT_MAX },
    { code: 'ATR_TREND_DECREASING', value: atrTrend === 'decreasing' },
    { code: 'VOL_NOT_EXPANDING', value: volZ < TacticalConfig.VOLUME_NOT_EXPANDING_ZSCORE_MAX },
    { code: 'NO_STRUCTURAL_BREAK', value: noStructuralBreakEitherSide(hasStructuralBreak) },
  ];
  const compressionScore = scoreOf(compressionChecks);

  // ---- MICRO_CHOP ----
  const chopChecks: HardCheck[] = [
    { code: 'DIRECTION_FLIPPING', value: flips >= TacticalConfig.CHOP_MIN_FLIPS },
    { code: 'WICK_HEAVY', value: Math.max(upperWickRatio, lowerWickRatio) >= TacticalConfig.CHOP_WICK_RATIO_MIN },
    { code: 'BODY_WEAK', value: bodyRatio < TacticalConfig.BODY_RATIO_STRONG },
  ];
  const chopScore = scoreOf(chopChecks);

  // Priority order per ticket spec ("Expansion ưu tiên phân tích nhất"), then Trend, Compression, Chop.
  if (expansionScore.matched) {
    const isFastEnter =
      volZ >= TacticalConfig.VOLUME_EXPANSION_FAST_ENTER_ZSCORE ||
      structuralBreakFor(hasStructuralBreak, expansionSide) ||
      atrP >= TacticalConfig.ATR_PCT_FAST_ENTER;
    return {
      state: TacticalState.NEUTRAL_EXPANSION,
      side: expansionSide,
      reasonCodes: expansionScore.reasonCodes,
      confidence: expansionScore.confidence,
      isFastEnter,
      dataSufficient: true,
    };
  }
  if (trendScore.matched) {
    return {
      state: TacticalState.MICRO_TREND,
      side: trendSide,
      reasonCodes: trendScore.reasonCodes,
      confidence: trendScore.confidence,
      // MICRO_TREND already hard-requires STRUCTURAL_BREAK to match at all — ticket lists "BOS rõ" on
      // its own as a valid fast-enter trigger, so matching here is always fast-enter eligible.
      isFastEnter: true,
      dataSufficient: true,
    };
  }
  if (compressionScore.matched) {
    return {
      state: TacticalState.NEUTRAL_COMPRESSION,
      side: null,
      reasonCodes: compressionScore.reasonCodes,
      confidence: compressionScore.confidence,
      isFastEnter: false,
      dataSufficient: true,
    };
  }
  if (chopScore.matched) {
    return {
      state: TacticalState.MICRO_CHOP,
      side: null,
      reasonCodes: chopScore.reasonCodes,
      confidence: chopScore.confidence,
      isFastEnter: false,
      dataSufficient: true,
    };
  }

  // Fallback: nothing strictly matched (mixed/ambiguous candle) — pick whichever of the two "no clear
  // opportunity" states (Compression vs Chop) scores higher; ties favor Compression (the more
  // conservative "assume no edge" default, same spirit as regimeDetector.ts's own NEUTRAL_TRANSITION
  // catch-all). Never falls back to EXPANSION/TREND — those must strictly match, never be a default guess.
  if (chopScore.confidence > compressionScore.confidence) {
    return {
      state: TacticalState.MICRO_CHOP,
      side: null,
      reasonCodes: [...chopScore.reasonCodes, 'FALLBACK_NO_STRICT_MATCH'],
      confidence: chopScore.confidence,
      isFastEnter: false,
      dataSufficient: true,
    };
  }
  return {
    state: TacticalState.NEUTRAL_COMPRESSION,
    side: null,
    reasonCodes: [...compressionScore.reasonCodes, 'FALLBACK_NO_STRICT_MATCH'],
    confidence: compressionScore.confidence,
    isFastEnter: false,
    dataSufficient: true,
  };
}

export interface TacticalHysteresisState {
  state: TacticalState;
  /**
   * Side/confidence/reasonCodes of the classification that's CURRENTLY CONFIRMED as `state` — i.e.
   * refreshed only on the candle that (re)confirms this exact state, never left stale from a
   * different, no-longer-matching candidate. Consumers reading side/confidence/reasonCodes for a
   * HELD state (hysteresis hasn't confirmed a change yet) get the last candle where `state` itself
   * was the matching candidate, not today's possibly-unrelated raw reading — avoids the
   * inconsistency of e.g. state=MICRO_TREND but side=null from an off-state candidate.
   */
  side: TacticalSide;
  confidence: number;
  reasonCodes: string[];
  /** Most recent candidate readings, oldest first, capped at TacticalConfig.HYSTERESIS_WINDOW. */
  recentCandidates: TacticalState[];
}

/**
 * Hysteresis bookkeeping, isolated from candidate classification (same separation as
 * regimeDetector.ts's applyHysteresis()). `previous: null` = first call ever.
 *
 * Normal transition: needs TacticalConfig.HYSTERESIS_MIN_AGREE (2) of the last
 * TacticalConfig.HYSTERESIS_WINDOW (3) candidate readings — this one included — to agree on the new
 * state before it's confirmed. Fast-enter (isFastEnter=true from classifyTacticalCandidate) confirms
 * on a single candle instead, per ticket spec, ONLY for a genuinely strong signal.
 * "Thoát state cần >= 2 nến mất điều kiện": since leaving the current state requires the SAME 2-of-3
 * majority rule for the new candidate to win, at least 2 of the last 3 candles must already have
 * stopped matching the old state before a (non-fast) transition can happen — the exit condition is
 * structurally the same mechanism as the entry condition, not separate bookkeeping.
 */
export function applyTacticalHysteresis(candidate: TacticalCandidateResult, previous: TacticalHysteresisState | null): TacticalHysteresisState {
  if (previous === null) {
    return { state: candidate.state, side: candidate.side, confidence: candidate.confidence, reasonCodes: candidate.reasonCodes, recentCandidates: [candidate.state] };
  }
  if (candidate.state === previous.state) {
    // Same as the currently-confirmed state — refresh side/confidence/reasonCodes to this candle's
    // own (matching) reading, since it's current information about the SAME state, not a different one.
    const recentCandidates = [...previous.recentCandidates, candidate.state].slice(-TacticalConfig.HYSTERESIS_WINDOW);
    return { state: previous.state, side: candidate.side, confidence: candidate.confidence, reasonCodes: candidate.reasonCodes, recentCandidates };
  }
  if (candidate.isFastEnter) {
    return { state: candidate.state, side: candidate.side, confidence: candidate.confidence, reasonCodes: candidate.reasonCodes, recentCandidates: [candidate.state] };
  }
  const recentCandidates = [...previous.recentCandidates, candidate.state].slice(-TacticalConfig.HYSTERESIS_WINDOW);
  const agreeCount = recentCandidates.filter((s) => s === candidate.state).length;
  if (recentCandidates.length === TacticalConfig.HYSTERESIS_WINDOW && agreeCount >= TacticalConfig.HYSTERESIS_MIN_AGREE) {
    return { state: candidate.state, side: candidate.side, confidence: candidate.confidence, reasonCodes: candidate.reasonCodes, recentCandidates };
  }
  // Hold: state NOT changing — side/confidence/reasonCodes stay whatever they were the last time
  // `previous.state` was itself the matching candidate (NOT this candle's off-state candidate).
  return { state: previous.state, side: previous.side, confidence: previous.confidence, reasonCodes: previous.reasonCodes, recentCandidates };
}

export interface TacticalOutput {
  /** Confirmed state after hysteresis. */
  state: TacticalState;
  /** side/confidence/reasonCodes belonging to the CONFIRMED `state` (see TacticalHysteresisState doc) — always self-consistent with `state`, never from a different off-state candidate. */
  side: TacticalSide;
  confidence: number;
  reasonCodes: string[];
  /** Raw candidate this candle, before hysteresis confirmation — for diagnostics only (e.g. seeing a flip about to happen); NOT necessarily consistent with `state`/`side` above. */
  candidateState: TacticalState;
  candidateSide: TacticalSide;
  dataSufficient: boolean;
  hysteresisState: TacticalHysteresisState;
}

/**
 * Pure function, caller persists `hysteresisState` and feeds it back as `previous` on the next 5m
 * candle close for the SAME symbol (same pattern as regimeDetector.ts's detectRegime()). Never
 * called by production code — only by shadow audit scripts (TICKET-124 Phần C) gated behind
 * TACTICAL_REGIME_5M_SHADOW.
 */
export function classifyTactical(input: TacticalCandleInput, previous: TacticalHysteresisState | null): TacticalOutput {
  const candidate = classifyTacticalCandidate(input);
  const hysteresisState = applyTacticalHysteresis(candidate, previous);
  return {
    state: hysteresisState.state,
    side: hysteresisState.side,
    confidence: hysteresisState.confidence,
    reasonCodes: hysteresisState.reasonCodes,
    candidateState: candidate.state,
    candidateSide: candidate.side,
    dataSufficient: candidate.dataSufficient,
    hysteresisState,
  };
}
