/**
 * TICKET-142 — MomentumThesis (MOMENTUM_DIRECT). Reuses production's real momentum-scoring pipeline
 * (same building blocks orchestrator.ts's private scoreMomentumForSide() uses, replicated here from
 * exported primitives only — same technique ticket136Neutral5mOpportunityFunnelAudit.ts already
 * proved). No OB/FVG retest required. Each qualifying candle is its own candidate — no zone/dedup
 * concept applies to a per-candle AI score check.
 */
import type { CandleData, RegimeOutput } from '../../regime/types.js';
import { MarketRegime } from '../../regime/types.js';
import { RegimeConfig } from '../../regime/config.js';
import { lastDefined, wilderATRSeries } from '../../regime/indicators.js';
import { EntryConfig } from '../../entry/config.js';
import { detectMomentumDirect } from '../../entry/momentumDirect.js';
import { detectSwingPoints, latestSwingPointBefore } from '../../entry/detectors/swingPoints.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../../xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../../xgbFilter/momentumScorer.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH, MOMENTUM_BEARISH_MODEL_PATH, MOMENTUM_BEARISH_SCHEMA_PATH } from '../../xgbFilter/config.js';
import { SafetyState5m } from '../../regime/htfSafetyTypes.js';
import { computeDirection5m, type Direction5m } from '../neutral5mDirectionSelector.js';
import { is5mConfirmed } from '../neutralMacroConflictOverride.js';
import { priceAtR } from '../../risk/slTpManager.js';
import type { MomentumDirectCircuitBreakerSideState } from '../types.js';
import type { SetupThesisCommonInput, SetupThesisResult } from './types.js';

export interface MomentumThesisInput extends SetupThesisCommonInput {
  candles5m: CandleData[];
  candles1hMomentum: CandleData[];
  regimeOutput: RegimeOutput;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  correlatedRiskRatio: number | undefined;
  momentumDirectThreshold: number;
  momentumDirectMinSlPercent: number;
  momentumDirectTpRMultiple: number;
  momentumModelPath?: string;
  momentumSchemaPath?: string;
  momentumBearishModelPath?: string;
  momentumBearishSchemaPath?: string;
}

// Verbatim replica of orchestrator.ts's private computeDistanceToNearestSwingAtr() — same formula,
// built only from exported primitives (see TICKET-136 script, lines ~161-176).
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

const schemaCache = new Map<string, FeatureSchema>();
function getSchemaCached(schemaPath: string): FeatureSchema {
  let cached = schemaCache.get(schemaPath);
  if (cached === undefined) {
    cached = loadFeatureSchema(schemaPath);
    schemaCache.set(schemaPath, cached);
  }
  return cached;
}

// Verbatim replica of orchestrator.ts's private scoreMomentumForSide() — identical formula/model
// paths/schema, built only from exported primitives.
async function scoreMomentumForSideReplica(input: MomentumThesisInput, side: 'LONG' | 'SHORT'): Promise<number | undefined> {
  const crossFeatures = computeMomentumCrossFeatures(input.candles5m, input.candles1hMomentum);
  if (crossFeatures === undefined) return undefined;
  const isLong = side === 'LONG';
  const modelPath = isLong ? (input.momentumModelPath ?? MOMENTUM_MODEL_PATH) : (input.momentumBearishModelPath ?? MOMENTUM_BEARISH_MODEL_PATH);
  const schemaPath = isLong ? (input.momentumSchemaPath ?? MOMENTUM_SCHEMA_PATH) : (input.momentumBearishSchemaPath ?? MOMENTUM_BEARISH_SCHEMA_PATH);
  const schema = getSchemaCached(schemaPath);
  const featureVector = buildFeatureVector(
    {
      symbol: input.symbol,
      adx1h: input.regimeOutput.computedMetrics.adx1h as number,
      atrPercentile5m: input.regimeOutput.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: input.regimeOutput.computedMetrics.bbWidthPercentile15m as number,
      volumeZScore5m: input.regimeOutput.computedMetrics.volumeZScore5m as number,
      atrTrend5m: input.regimeOutput.computedMetrics.atrTrend5m as string,
      adxDirection1h: input.regimeOutput.adxDirection1h as string,
      macroDirection: input.macroDirection,
      correlatedRiskRatio: input.correlatedRiskRatio,
      distanceToNearestSwingAtr: computeDistanceToNearestSwingAtr(input.candles5m),
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

// Same SL formula as orchestrator.ts's private computeMomentumDirectSlPrice() — sweep-style SL
// (candle's own extreme) + ATR buffer, floored by momentumDirectMinSlPercent.
function computeMomentumSlPrice(side: 'LONG' | 'SHORT', entryPrice: number, currentCandle: CandleData, atr: number, minSlPercent: number): number {
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < minSlPercent) {
    const flooredDistance = (minSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  return slPrice;
}

async function evaluateSide(input: MomentumThesisInput, side: 'LONG' | 'SHORT'): Promise<SetupThesisResult> {
  const currentCandle = input.candles5m[input.candles5m.length - 1];
  const reasons: string[] = [];
  const score = await scoreMomentumForSideReplica(input, side);

  if (score === undefined) {
    reasons.push('Model/AI score không tính được (thiếu dữ liệu cross-feature EMA1h/ATR5m)');
    return {
      symbol: input.symbol,
      timestamp: input.timestamp,
      setupType: 'MOMENTUM_DIRECT',
      side,
      candidateId: `${input.symbol}:MOMENTUM_DIRECT:${side}:${input.timestamp}`,
      thesisState: 'NONE',
      qualityScore: null,
      reasons,
      entryPrice: null,
      stopLoss: null,
      riskReward: null,
      htfContext: input.htfContext,
      safetyState5m: input.safetyState5m,
    };
  }

  const momentumSideAgrees = detectMomentumDirect(score, side, input.momentumDirectThreshold);
  reasons.push(momentumSideAgrees ? `Momentum cùng side: score=${score.toFixed(4)} >= ${input.momentumDirectThreshold}` : `Momentum không cùng side: score=${score.toFixed(4)} < ${input.momentumDirectThreshold}`);

  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  const entryPrice = currentCandle.close;
  let stopLoss: number | null = null;
  let riskReward: number | null = null;
  let entryTimingValid = false;
  if (atr === undefined) {
    reasons.push('Entry timing không hợp lệ: thiếu ATR5m để định SL');
  } else {
    entryTimingValid = true;
    stopLoss = computeMomentumSlPrice(side, entryPrice, currentCandle, atr, input.momentumDirectMinSlPercent);
    if (stopLoss !== entryPrice) {
      riskReward = input.momentumDirectTpRMultiple; // TP = priceAtR(entry, r, tpRMultiple) by construction — real production number, not invented.
      reasons.push(`SL/R hợp lệ: SL=${stopLoss.toFixed(6)}, R:R=${riskReward}R (momentumDirectTpRMultiple)`);
    } else {
      reasons.push('SL/R không hợp lệ: SL trùng entry');
    }
  }

  const safetyBlocked = input.safetyState5m === SafetyState5m.SHOCK || input.safetyState5m === SafetyState5m.MANIPULATED;
  if (safetyBlocked) reasons.push(`SafetyState5m=${input.safetyState5m} (hard block)`);

  const valid = momentumSideAgrees && entryTimingValid && riskReward !== null && !safetyBlocked;
  const thesisState = valid ? 'VALID' : momentumSideAgrees || entryTimingValid ? 'WEAK' : 'NONE';

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    setupType: 'MOMENTUM_DIRECT',
    side,
    candidateId: `${input.symbol}:MOMENTUM_DIRECT:${side}:${input.timestamp}`,
    thesisState,
    qualityScore: score,
    reasons,
    entryPrice,
    stopLoss,
    riskReward,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
  };
}

export async function computeMomentumThesis(input: MomentumThesisInput): Promise<SetupThesisResult[]> {
  return [await evaluateSide(input, 'LONG'), await evaluateSide(input, 'SHORT')];
}

/**
 * TICKET-142A — replicates orchestrator.ts's REAL tryMomentumDirect() gate sequence, in the same
 * order, so a candidate only ever exists when production would actually fire it. Verbatim replicas
 * (not imports — orchestrator.ts imports this file, importing back would be circular) of its two
 * inline helpers below.
 */
const MOMENTUM_DIRECT_BLOCKED_REGIMES_REPLICA: readonly MarketRegime[] = [
  MarketRegime.DANGER_ZONE,
  MarketRegime.MANIPULATED,
  MarketRegime.LOW_LIQUIDITY,
  MarketRegime.VOLATILE_CHOP,
  MarketRegime.CORRELATED_RISK,
];

function evaluateMacroConflictOverrideReplica(
  side: 'LONG' | 'SHORT',
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
  regime: MarketRegime,
  candles5m: CandleData[],
  mode: 'NONE' | 'UNFILTERED' | 'CONDITIONAL_5M',
): { macroConflict: boolean; overridden: boolean } {
  const macroConflict = (side === 'LONG' && macroDirection === 'DOWN') || (side === 'SHORT' && macroDirection === 'UP');
  if (!macroConflict || regime !== MarketRegime.NEUTRAL_TRANSITION) return { macroConflict, overridden: false };
  const confirmed = is5mConfirmed(candles5m, side);
  const overridden = mode === 'UNFILTERED' ? true : mode === 'CONDITIONAL_5M' ? confirmed : false;
  return { macroConflict, overridden };
}

export type MomentumCandidateSide = 'LONG' | 'SHORT' | 'NONE';

export interface MomentumCandidateIntegrityResult {
  candidateId: string | null;
  symbol: string;
  timestamp: number;
  side: MomentumCandidateSide;
  /** Effective score used in the pass/fail decision (post-OOD-cap for SHORT). Ticket §3 "momentumScore". */
  momentumScore: number | null;
  /** Raw ONNX score for the chosen side, before any OOD adjustment. Ticket §3 "modelScore". */
  modelScore: number | null;
  triggerReason: string;
  invalidReason: string | null;
  thesisState: 'VALID' | 'WEAK' | 'NONE';
  /** false = same consecutive-run continuation as the prior candle (duplicate), not a new event. */
  isNewEvent: boolean;
  htfContext: SetupThesisCommonInput['htfContext'];
  safetyState5m: SafetyState5m;
  regime: MarketRegime;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  /** Real entry/SL/TP, populated only when thesisState==='VALID' — same formula as computeMomentumSlPrice/priceAtR above. Used by Mode A's offline outcome simulation. */
  entryPrice: number | null;
  stopLoss: number | null;
  tpPriceOverride: number | null;
  /** Per-side breakdown for §4 bias analysis — never used to pick `side` above, informational only. */
  sideDiagnostics: {
    LONG: { score: number | undefined; passes: boolean; blockedBy: string | null };
    SHORT: { score: number | undefined; passes: boolean; blockedBy: string | null };
  };
}

export interface MomentumCandidateIntegrityInput extends MomentumThesisInput {
  candles1m: CandleData[];
  circuitBreakerState: { LONG: MomentumDirectCircuitBreakerSideState; SHORT: MomentumDirectCircuitBreakerSideState };
  oodGuardConfig?: { emaRatioSlowThreshold: number; mode: 'HARD_REJECT' | 'SCORE_CAP' | 'RISK_REDUCTION'; scoreCapValue: number; riskReductionMultiplier: number };
  neutral5mDirectionSelectorEnabled?: boolean;
  macroOverrideMode: 'NONE' | 'UNFILTERED' | 'CONDITIONAL_5M';
  momentumDirectMaxAtrPercentile: number;
  /** momentumDirectOpenPositionsTotal gate (production line 541) — judgment call: this stateless
   * per-candle diagnostic assumes capacity is always available (documented in TICKET-142A report),
   * since it cannot know real concurrent-position state without running the full backtest engine. */
}

/**
 * Stateless per-candle gate evaluation — no dedup/run-tracking here (see computeMomentumCandidateIntegrity
 * below for the consecutive-run wrapper). Mirrors tryMomentumDirect() gate order exactly.
 */
async function evaluateMomentumCandidateIntegrityGates(
  input: MomentumCandidateIntegrityInput,
): Promise<Omit<MomentumCandidateIntegrityResult, 'candidateId' | 'isNewEvent'>> {
  const currentCandle = input.candles5m[input.candles5m.length - 1];
  const base = {
    symbol: input.symbol,
    timestamp: input.timestamp,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
    regime: input.regimeOutput.regime,
    macroDirection: input.macroDirection,
  };

  // Gate 1 — blocked regimes.
  if (MOMENTUM_DIRECT_BLOCKED_REGIMES_REPLICA.includes(input.regimeOutput.regime)) {
    return { ...base, side: 'NONE', momentumScore: null, modelScore: null, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'blocked_regime', invalidReason: 'blocked_regime', thesisState: 'NONE', sideDiagnostics: { LONG: { score: undefined, passes: false, blockedBy: 'blocked_regime' }, SHORT: { score: undefined, passes: false, blockedBy: 'blocked_regime' } } };
  }

  // Gate 2 — system-wide concurrency cap: treated as always-satisfied (judgment call, see doc comment above).

  // Gate 3 — ATR percentile volatility cap.
  const atrPercentile5m = input.regimeOutput.computedMetrics.atrPercentile5m as number | undefined;
  const maxAtrPercentile = input.momentumDirectMaxAtrPercentile ?? 100;
  if (atrPercentile5m === undefined || atrPercentile5m > maxAtrPercentile) {
    return { ...base, side: 'NONE', momentumScore: null, modelScore: null, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'atr_percentile_cap', invalidReason: 'atr_percentile_cap', thesisState: 'NONE', sideDiagnostics: { LONG: { score: undefined, passes: false, blockedBy: 'atr_percentile_cap' }, SHORT: { score: undefined, passes: false, blockedBy: 'atr_percentile_cap' } } };
  }

  // Score computation + OOD guard + TICKET-130 direction5m veto — exact production formula.
  const longScore = await scoreMomentumForSideReplica(input, 'LONG');
  const shortScore = await scoreMomentumForSideReplica(input, 'SHORT');

  const oodGuardConfig = input.oodGuardConfig;
  const oodCrossFeatures = oodGuardConfig ? computeMomentumCrossFeatures(input.candles5m, input.candles1hMomentum) : undefined;
  const isShortOod = oodGuardConfig !== undefined && oodCrossFeatures !== undefined && oodCrossFeatures.emaRatioSlow > oodGuardConfig.emaRatioSlowThreshold;
  const shortScoreEffective = isShortOod && oodGuardConfig!.mode === 'SCORE_CAP' && shortScore !== undefined ? Math.min(shortScore, oodGuardConfig!.scoreCapValue) : shortScore;

  const direction5m: Direction5m | undefined =
    input.neutral5mDirectionSelectorEnabled === true && input.regimeOutput.regime === MarketRegime.NEUTRAL_TRANSITION
      ? computeDirection5m(input.candles5m, input.candles1m)
      : undefined;
  const longRejectedByDirection5m = direction5m === 'SHORT';
  const shortRejectedByDirection5m = direction5m === 'LONG';

  const longPassesAiOnly = longScore !== undefined && detectMomentumDirect(longScore, 'LONG', input.momentumDirectThreshold);
  const shortPassesAiOnly =
    !(isShortOod && oodGuardConfig!.mode === 'HARD_REJECT') && shortScoreEffective !== undefined && detectMomentumDirect(shortScoreEffective, 'SHORT', input.momentumDirectThreshold);

  const longPasses = longPassesAiOnly && !longRejectedByDirection5m;
  const shortPasses = shortPassesAiOnly && !shortRejectedByDirection5m;

  const longBlockedBy = longPasses ? null : !longPassesAiOnly ? (isShortOod ? 'ai_score_below_threshold' : 'ai_score_below_threshold') : 'direction5m_veto';
  const shortBlockedBy = shortPasses
    ? null
    : isShortOod && oodGuardConfig!.mode === 'HARD_REJECT'
      ? 'ood_hard_reject'
      : !shortPassesAiOnly
        ? 'ai_score_below_threshold'
        : 'direction5m_veto';

  const sideDiagnostics = {
    LONG: { score: longScore, passes: longPasses, blockedBy: longBlockedBy },
    SHORT: { score: shortScoreEffective, passes: shortPasses, blockedBy: shortBlockedBy },
  };

  if (!longPasses && !shortPasses) {
    return { ...base, side: 'NONE', momentumScore: null, modelScore: null, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'ai_score_below_threshold', invalidReason: 'ai_score_below_threshold', thesisState: 'NONE', sideDiagnostics };
  }

  // Side selection — mutual exclusion tie-break, THE fix this ticket is about.
  const side: 'LONG' | 'SHORT' = longPasses && shortPasses ? ((longScore as number) >= (shortScore as number) ? 'LONG' : 'SHORT') : longPasses ? 'LONG' : 'SHORT';
  const modelScore = side === 'LONG' ? (longScore ?? null) : (shortScore ?? null);
  const momentumScore = side === 'LONG' ? (longScore ?? null) : (shortScoreEffective ?? null);
  if (side === 'SHORT') sideDiagnostics.SHORT.blockedBy = null;
  else sideDiagnostics.LONG.blockedBy = null;
  if (longPasses && shortPasses) {
    // Loser of the tie-break gets a specific reason distinct from a real gate rejection.
    if (side === 'LONG') sideDiagnostics.SHORT.blockedBy = 'other_side_higher_score';
    else sideDiagnostics.LONG.blockedBy = 'other_side_higher_score';
  }

  // Circuit breaker (per symbol+side, TICKET-081) — checked AFTER side is chosen.
  const cooldownUntil = input.circuitBreakerState[side].cooldownUntilTimestamp;
  if (cooldownUntil !== null && currentCandle.timestamp < cooldownUntil) {
    return { ...base, side, momentumScore, modelScore, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'passed_ai_gate', invalidReason: 'circuit_breaker_cooldown', thesisState: 'WEAK', sideDiagnostics };
  }

  // Correlation risk (TICKET-071) / OOD RISK_REDUCTION (TICKET-122) — informational multipliers only, no block.

  // Mandatory macro-1D-alignment check (TICKET-138).
  const macroOverride = evaluateMacroConflictOverrideReplica(side, input.macroDirection, input.regimeOutput.regime, input.candles5m, input.macroOverrideMode);
  if (macroOverride.macroConflict && !macroOverride.overridden) {
    return { ...base, side, momentumScore, modelScore, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'passed_ai_gate', invalidReason: 'macro_conflict', thesisState: 'WEAK', sideDiagnostics };
  }

  // Final ATR-undefined check (needed for SL sizing).
  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) {
    return { ...base, side, momentumScore, modelScore, entryPrice: null, stopLoss: null, tpPriceOverride: null, triggerReason: 'passed_ai_gate', invalidReason: 'atr_undefined', thesisState: 'WEAK', sideDiagnostics };
  }

  const entryPrice = currentCandle.close;
  const slPrice = computeMomentumSlPrice(side, entryPrice, currentCandle, atr, input.momentumDirectMinSlPercent);
  const r = Math.abs(entryPrice - slPrice);
  const tpPriceOverride = priceAtR(entryPrice, r, input.momentumDirectTpRMultiple, side);

  return { ...base, side, momentumScore, modelScore, entryPrice, stopLoss: slPrice, tpPriceOverride, triggerReason: 'passed', invalidReason: null, thesisState: 'VALID', sideDiagnostics };
}

/**
 * TICKET-142A — per-symbol consecutive-run dedup wrapper (judgment call, see report's "Judgment
 * calls" section): a real position occupies the concurrency slot from open to close, so the SAME
 * side re-triggering every candle while still "valid" is one event, not N. Since this diagnostic
 * can't know the real close time without simulating, "run ends when the side stops passing" is the
 * best available proxy — Mode A only, flagged as an approximation.
 */
export async function computeMomentumCandidateIntegrity(
  input: MomentumCandidateIntegrityInput,
  activeRun: { side: 'LONG' | 'SHORT'; candidateId: string } | null,
): Promise<{ result: MomentumCandidateIntegrityResult; nextActiveRun: { side: 'LONG' | 'SHORT'; candidateId: string } | null }> {
  const gateResult = await evaluateMomentumCandidateIntegrityGates(input);
  const passedSide = gateResult.side !== 'NONE' ? gateResult.side : null;

  const continuesRun = passedSide !== null && activeRun !== null && activeRun.side === passedSide;
  const candidateId = passedSide === null ? null : continuesRun ? (activeRun as { side: 'LONG' | 'SHORT'; candidateId: string }).candidateId : `${input.symbol}:MOMENTUM_DIRECT:${passedSide}:${input.timestamp}`;
  const nextActiveRun = passedSide === null ? null : { side: passedSide, candidateId: candidateId as string };

  return {
    result: { ...gateResult, candidateId, isNewEvent: passedSide !== null && !continuesRun },
    nextActiveRun,
  };
}
