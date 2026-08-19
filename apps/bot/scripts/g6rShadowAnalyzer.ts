/**
 * G6R Checkpoint 3 — G6ShadowOpportunityAnalyzer (CORRECTED — supersedes the first attempt whose
 * result is archived at data/g6r-runs/g6r-cp3-attempt1-invalid-summary.json).
 *
 * Research-only, read-only, pure module. Freezes the G6-C1 (CASCADE_FALLTHROUGH_ON_MSS_FAIL)
 * shadow candidate population BEFORE any outcome labeling. Never admits a trade, never mutates
 * account/balance/risk-pool/open-position state, never writes files itself, never calls back into
 * anything that could change a production decision.
 *
 * Frozen rule (verbatim summary, see data/g6-root-cause-and-candidate-registration.md, section
 * "G6-C1 — CASCADE_FALLTHROUGH_ON_MSS_FAIL", item 4 "Exact rule (pseudocode...)"):
 *   1. Select primary: OB if found, else FVG if found, else Sweep if found, else no candidate.
 *   2. Apply the macro-trend filter ONCE, keyed on `side` (unchanged, side-based check) — if it
 *      fails, STOP: do not attempt MSS on the primary, do not evaluate FVG, do not evaluate Sweep,
 *      do not emit a candidate. (entryRouter.ts runTrendStyle() lines ~166-174.)
 *   3. Only if the macro filter passes (or is disabled): attempt MSS on the primary. If the
 *      primary's own MSS confirms, production takes it — shadow does nothing (this analyzer's
 *      candidate population is only ever the fallback path where the PRIMARY happens to be OB and
 *      OB's own MSS fails).
 *   4. Only if primary OB's MSS failed: evaluate FVG on the SAME decision state (same 5m/1m
 *      candles, no macro re-check — side didn't change). If FVG exists and its own unchanged MSS
 *      confirms: emit exactly one frozen FVG shadow candidate; do NOT evaluate Sweep.
 *   5. Else evaluate Sweep the same way; if Sweep's own MSS confirms, emit exactly one frozen
 *      Sweep shadow candidate.
 *   6. Otherwise emit no candidate. Maximum ONE actionable shadow candidate per evaluation.
 *
 * decisionTimestamp (data/g6-root-cause-and-candidate-registration.md item 6): "the close timestamp
 * of the confirming 1m/3m candle (`mssWindow[mssConfirmedIndex].timestamp`)" — NOT the evaluation's
 * own timestamp. EntryConfig.MSS_TIMEFRAME is '1m' in this repo (apps/bot/src/entry/config.ts), so
 * `candlesMss` here is always the 1m candle series (verified: the CP3 runner passes ctx.input.candles1m).
 * A future Checkpoint 4 outcome-labeling pass MUST anchor its outcome horizon to `decisionTimestamp`
 * (the actual MSS-confirming candle time), not `evaluationTimestamp` (the router-invocation time) —
 * they can legitimately differ by up to `MSS_STALENESS_TOLERANCE_CANDLES` 1m candles.
 *
 * DUPLICATION DEBT (Step 6, explicit, not minimized): `evaluateStage()` below re-implements the
 * MSS-confirm + staleness + ATR-buffer + entry-price assembly formula that also lives inline in
 * apps/bot/src/entry/entryRouter.ts's `runTrendStyle()` (no `attemptMss()` helper has been extracted
 * in production — the registration doc's pseudocode describes an aspirational extraction that does
 * NOT exist in apps/bot/src/entry/entryRouter.ts today). This IS formula duplication. Per the
 * ticket's explicit instruction, production is NOT touched to deduplicate this; instead
 * `g6rShadowAnalyzer.test.ts` carries direct parity tests (fixture-based AND a real replay-data
 * slice) comparing this replica's MSS index / entry / SL / fail-reason output against
 * production-observable `routeEntry()` output, so drift between the two formulas is caught by CI
 * rather than merely asserted away in a comment.
 *
 * All detector/MSS calls below go straight to the real production functions
 * (detectOrderBlock/detectFairValueGap/detectLiquiditySweep/detectMarketStructureShift) with the
 * SAME config constants production uses (EntryConfig.FRACTAL_N,
 * EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES, EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
 * EntryConfig.SL_BUFFER_ATR_MULTIPLIER, obSlBufferAtrMultiplier).
 */
import { EntryConfig } from '../dist/entry/config.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { detectMarketStructureShift } from '../dist/entry/detectors/marketStructureShift.js';
import { lastDefined, wilderATRSeries } from '../dist/regime/indicators.js';
import { RegimeConfig } from '../dist/regime/config.js';
import type { CandleData } from '../dist/regime/types.js';
import { candidateKey as makeCandidateKey } from './g6rFullPathFunnel.js';

export type ShadowSide = 'LONG' | 'SHORT';
export type ShadowSetupType = 'FVG' | 'SWEEP';
export type MacroDirection = 'UP' | 'DOWN' | 'FLAT' | undefined;

export const ONE_MINUTE_MS = 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Defect 2 fix: the analyzer no longer trusts the caller's candle arrays. Thrown BEFORE any
 * detector/MSS logic runs whenever any input candle (5m, MSS/1m, or the macro 1d source) is not
 * fully closed strictly before `evaluationCutoffExclusive`. Never silently trimmed.
 */
export class FutureCandleViolationError extends Error {
  constructor(
    readonly array: 'candles5m' | 'candlesMss' | 'macroInputCandles1d',
    readonly candleIndex: number,
    readonly candleTimestamp: number,
    readonly candleIntervalMs: number,
    readonly evaluationCutoffExclusive: number,
  ) {
    super(
      `FutureCandleViolationError: ${array}[${candleIndex}] timestamp=${candleTimestamp} + interval=${candleIntervalMs} = ` +
        `${candleTimestamp + candleIntervalMs} is not <= evaluationCutoffExclusive=${evaluationCutoffExclusive} (candle not yet closed at cutoff)`,
    );
    this.name = 'FutureCandleViolationError';
  }
}

/** Fails closed: throws FutureCandleViolationError on the first candle that is not fully closed before cutoff. */
function assertCandlesClosed(array: 'candles5m' | 'candlesMss' | 'macroInputCandles1d', candles: readonly CandleData[], intervalMs: number, evaluationCutoffExclusive: number): void {
  for (let i = 0; i < candles.length; i++) {
    const closesAt = candles[i].timestamp + intervalMs;
    if (!(closesAt <= evaluationCutoffExclusive)) {
      throw new FutureCandleViolationError(array, i, candles[i].timestamp, intervalMs, evaluationCutoffExclusive);
    }
  }
}

/**
 * Per-candidate provenance of every decision feature genuinely read (Defect 1 fix). Threaded
 * through from wherever OB/FVG/Sweep detection and MSS confirmation actually read candle arrays —
 * these are the REAL max timestamps observed by the code, never a placeholder derived from
 * decisionTimestamp itself.
 */
export interface DecisionFeatureProvenance {
  readonly detector5mMaxTimestamp: number;
  readonly detector5mMaxAvailableAt: number;
  readonly mssMaxTimestampRead: number;
  readonly mssMaxAvailableAt: number;
  readonly mssConfirmationTimestamp: number;
  readonly stalenessReferenceTimestamp: number;
  readonly atr5mMaxTimestamp: number;
  readonly atr5mMaxAvailableAt: number;
  readonly macroInputMaxTimestamp: number;
  readonly macroInputMaxAvailableAt: number;
  readonly evaluationCutoffExclusive: number;
  readonly maxRawFeatureTimestamp: number;
  readonly maxFeatureAvailableAt: number;
}

/** Minimal read-only decision-time input the analyzer needs — a subset of EntryRouterInput. */
export interface ShadowAnalyzerInput {
  readonly symbol: string;
  /** Closed 5m candles ending at "now" (decision time). Never a future candle. */
  readonly candles5m: readonly CandleData[];
  /** Closed 1m candles ending at "now" (EntryConfig.MSS_TIMEFRAME === '1m'), used for MSS confirmation search. */
  readonly candlesMss: readonly CandleData[];
  /** Closed 1d candles used to derive macroDirection (production: wilderDIDirectionSeries over candles1d). Validated for closure even though the analyzer does not recompute macroDirection itself. */
  readonly macroInputCandles1d: readonly CandleData[];
  readonly adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  readonly obEnabled: boolean;
  readonly obDisabledSymbols: readonly string[];
  readonly obBosLookforwardK: number;
  readonly obSlBufferAtrMultiplier: number;
  /** entry/config.ts EntryRouterConfig.macroTrendFilterEnabled — same flag production reads. */
  readonly macroTrendFilterEnabled: boolean;
  /** entry/entryRouter.ts EntryRouterInput.macroDirection — the 1D direction production reads. */
  readonly macroDirection: MacroDirection;
  /** Explicit decision-time boundary. Every candle in every array above must be closed strictly before this. */
  readonly evaluationCutoffExclusive: number;
}

export interface ShadowDecisionContext {
  readonly evaluationId: string;
  readonly regime: string;
  readonly evaluationTimestamp: number;
}

export interface StageEvaluation {
  readonly setupType: 'OB' | ShadowSetupType;
  readonly found: boolean;
  readonly sourceTimestamp: number | null;
  readonly mssConfirmed: boolean;
  readonly mssFailReason: 'NOT_FOUND' | 'NO_CANDIDATE' | 'STALE' | 'NO_ATR' | null;
  /** Index into the (source-filtered) MSS window of the candle that confirmed MSS. null if not confirmed. */
  readonly mssConfirmedIndex: number | null;
  /** Timestamp of mssWindow[mssConfirmedIndex] — the decisionTimestamp per the frozen rule. null if not confirmed. */
  readonly mssConfirmationTimestamp: number | null;
  readonly entryPrice: number | null;
  readonly slPrice: number | null;
  /** Provenance of every feature this stage's evaluation actually read (null until an entry/sl-bearing result is possible, i.e. mssIndex found). */
  readonly provenancePartial: { readonly mssMaxTimestampRead: number; readonly mssMaxAvailableAt: number; readonly stalenessReferenceTimestamp: number; readonly atr5mMaxTimestamp: number | null; readonly atr5mMaxAvailableAt: number | null } | null;
}

export interface FrozenShadowEvent {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly symbol: string;
  readonly side: ShadowSide;
  readonly regime: string;
  readonly setupType: ShadowSetupType;
  readonly sourceTimestamp: number;
  /** The full-path evaluation's OWN timestamp (router-invocation time) — unchanged meaning. */
  readonly evaluationTimestamp: number;
  /** mssWindow[mssConfirmedIndex].timestamp of the candidate that actually confirmed MSS — CAN differ from evaluationTimestamp. */
  readonly decisionTimestamp: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
  /** Defect 1 fix: real, non-tautological per-candidate decision-feature provenance. */
  readonly provenance: DecisionFeatureProvenance;
}

export interface G6ShadowObservation {
  readonly evaluationId: string;
  readonly symbol: string;
  readonly regime: string;
  readonly evaluationTimestamp: number;
  readonly primaryObFound: boolean;
  readonly primary: StageEvaluation | null;
  readonly fvgFallback: StageEvaluation | null;
  readonly sweepFallback: StageEvaluation | null;
  /** true iff an OB primary existed but the macro-trend filter blocked evaluation before any MSS attempt. */
  readonly blockedByMacroFilter: boolean;
  readonly actionableShadowEvent: FrozenShadowEvent | null;
}

export interface G6ShadowOpportunityAnalyzer {
  observeDecision(input: Readonly<ShadowAnalyzerInput>, context: Readonly<ShadowDecisionContext>): G6ShadowObservation;
}

function directionOf(side: ShadowSide): 'BULLISH' | 'BEARISH' {
  return side === 'LONG' ? 'BULLISH' : 'BEARISH';
}

/**
 * Reproduces the SAME MSS-confirm + staleness + ATR-buffer + entry-price logic production uses
 * (see entryRouter.ts runTrendStyle(), lines ~176-217). Only closed candles at or after the zone's
 * own timestamp are considered, and the MSS window is never extended beyond `candlesMss` (which the
 * caller must already have truncated to closed, decision-time-safe candles) — no future candle is
 * ever read here. See the module-level DUPLICATION DEBT note: this formula is a research-side
 * replica of entryRouter.ts's inline logic, not a shared production helper.
 */
/**
 * TICKET-G6R-CP3H (Step 1): exported unchanged (pure extraction, no formula/return-value edit) so
 * research-side fixture tests can exercise the ACTUAL MSS evaluation code path with real candle
 * windows, instead of hand-building StageEvaluation/DecisionFeatureProvenance objects as CP3G's
 * g6rCp3RootCauseRepro.test.ts did. Parity between the pre- and post-extraction behavior is proven
 * in g6rShadowAnalyzer.test.ts (calling this exported function directly reproduces byte-identical
 * StageEvaluation results as the private-logic-driven public observeDecision() API on the same
 * fixtures). This file remains a research module (apps/bot/scripts/**), not production
 * (apps/bot/src/**) — the carve-out this extraction relies on.
 */
export function evaluateStage(
  setupType: 'OB' | ShadowSetupType,
  side: ShadowSide,
  sourceTimestamp: number,
  rawSlPrice: number,
  candles5m: readonly CandleData[],
  candlesMss: readonly CandleData[],
  slBufferAtrMultiplier: number,
): StageEvaluation {
  const direction = directionOf(side);
  const mssWindow = candlesMss.filter((c) => c.timestamp >= sourceTimestamp);
  const mssMaxTimestampRead = mssWindow.length > 0 ? mssWindow[mssWindow.length - 1].timestamp : sourceTimestamp;
  const mssMaxAvailableAt = mssMaxTimestampRead + ONE_MINUTE_MS;
  const stalenessReferenceTimestamp = mssMaxTimestampRead; // the "now" edge of the MSS window is what staleness (candlesFromEnd) is measured against
  const mssIndex = detectMarketStructureShift(mssWindow as CandleData[], direction, { fractalN: EntryConfig.FRACTAL_N });
  if (mssIndex === null) {
    return { setupType, found: true, sourceTimestamp, mssConfirmed: false, mssFailReason: 'NOT_FOUND', mssConfirmedIndex: null, mssConfirmationTimestamp: null, entryPrice: null, slPrice: null, provenancePartial: { mssMaxTimestampRead, mssMaxAvailableAt, stalenessReferenceTimestamp, atr5mMaxTimestamp: null, atr5mMaxAvailableAt: null } };
  }
  const candlesFromEnd = mssWindow.length - 1 - mssIndex;
  if (candlesFromEnd >= EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES) {
    return { setupType, found: true, sourceTimestamp, mssConfirmed: false, mssFailReason: 'STALE', mssConfirmedIndex: mssIndex, mssConfirmationTimestamp: mssWindow[mssIndex].timestamp, entryPrice: null, slPrice: null, provenancePartial: { mssMaxTimestampRead, mssMaxAvailableAt, stalenessReferenceTimestamp, atr5mMaxTimestamp: null, atr5mMaxAvailableAt: null } };
  }
  const atr5mMaxTimestamp = candles5m.length > 0 ? candles5m[candles5m.length - 1].timestamp : sourceTimestamp;
  const atr5mMaxAvailableAt = atr5mMaxTimestamp + FIVE_MINUTES_MS;
  const atr = lastDefined(wilderATRSeries(candles5m as CandleData[], RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) {
    return { setupType, found: true, sourceTimestamp, mssConfirmed: false, mssFailReason: 'NO_ATR', mssConfirmedIndex: mssIndex, mssConfirmationTimestamp: mssWindow[mssIndex].timestamp, entryPrice: null, slPrice: null, provenancePartial: { mssMaxTimestampRead, mssMaxAvailableAt, stalenessReferenceTimestamp, atr5mMaxTimestamp, atr5mMaxAvailableAt } };
  }
  const buffer = atr * slBufferAtrMultiplier;
  const entryPrice = mssWindow[mssIndex].close;
  const slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  return {
    setupType,
    found: true,
    sourceTimestamp,
    mssConfirmed: true,
    mssFailReason: null,
    mssConfirmedIndex: mssIndex,
    mssConfirmationTimestamp: mssWindow[mssIndex].timestamp,
    entryPrice,
    slPrice,
    provenancePartial: { mssMaxTimestampRead, mssMaxAvailableAt, stalenessReferenceTimestamp, atr5mMaxTimestamp, atr5mMaxAvailableAt },
  };
}

export interface ShadowLedgerValidationResult {
  readonly duplicateCandidateKeys: number;
  readonly evaluationsWithMultipleActionable: number;
  readonly missingCp2Joins: number;
  readonly invalidGeometryCount: number;
  readonly valid: boolean;
}

/**
 * Pure fail-fast validator for a frozen shadow event population. Used both by the Checkpoint 3
 * runner (to gate CHECKPOINT_3_INVALID) and directly by tests — never silently passes a duplicate,
 * missing join, multi-candidate evaluation, or invalid risk geometry.
 */
export function validateShadowLedger(events: readonly FrozenShadowEvent[], knownEvaluationIds: ReadonlySet<string>): ShadowLedgerValidationResult {
  const keyCounts = new Map<string, number>();
  const evalCounts = new Map<string, number>();
  let missingCp2Joins = 0;
  let invalidGeometryCount = 0;
  for (const ev of events) {
    keyCounts.set(ev.candidateKey, (keyCounts.get(ev.candidateKey) ?? 0) + 1);
    evalCounts.set(ev.evaluationId, (evalCounts.get(ev.evaluationId) ?? 0) + 1);
    if (!knownEvaluationIds.has(ev.evaluationId)) missingCp2Joins++;
    const finiteOk = Number.isFinite(ev.entryPrice) && Number.isFinite(ev.slPrice) && Number.isFinite(ev.slDistance) && ev.slDistance > 0;
    const directionOk = ev.side === 'LONG' ? ev.slPrice < ev.entryPrice : ev.slPrice > ev.entryPrice;
    if (!finiteOk || !directionOk) invalidGeometryCount++;
  }
  const duplicateCandidateKeys = [...keyCounts.values()].filter((n) => n > 1).length;
  const evaluationsWithMultipleActionable = [...evalCounts.values()].filter((n) => n > 1).length;
  return {
    duplicateCandidateKeys,
    evaluationsWithMultipleActionable,
    missingCp2Joins,
    invalidGeometryCount,
    valid: duplicateCandidateKeys === 0 && evaluationsWithMultipleActionable === 0 && missingCp2Joins === 0 && invalidGeometryCount === 0,
  };
}

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface AuditBViolation {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly kind: 'UNCLOSED_CANDLE_READ' | 'FEATURE_AFTER_DECISION_TIMESTAMP';
  readonly provenanceField: keyof DecisionFeatureProvenance;
  readonly observedValue: number;
  readonly comparedAgainst: number;
}

export interface AuditBResult {
  readonly candidatesAudited: number;
  readonly violations: readonly AuditBViolation[];
  readonly violationCount: number;
  readonly byProvenanceField: Readonly<Record<string, number>>;
  readonly pass: boolean;
}

const PROVENANCE_RAW_FIELDS: ReadonlyArray<keyof DecisionFeatureProvenance> = [
  'detector5mMaxTimestamp',
  'mssMaxTimestampRead',
  'mssConfirmationTimestamp',
  'stalenessReferenceTimestamp',
  'atr5mMaxTimestamp',
  'macroInputMaxTimestamp',
];
const PROVENANCE_AVAILABLE_AT_FIELDS: ReadonlyArray<keyof DecisionFeatureProvenance> = [
  'detector5mMaxAvailableAt',
  'mssMaxAvailableAt',
  'atr5mMaxAvailableAt',
  'macroInputMaxAvailableAt',
];

/**
 * Defect 1 fix — real (non-tautological) Audit B. Answers two SEPARATE questions per candidate,
 * both real inequality checks against genuinely-tracked provenance, never against a value derived
 * from decisionTimestamp itself:
 *   (1) was any feature read from a candle not yet closed at the evaluation cutoff?
 *   (2) was any feature read timestamped after the candidate's own recorded decisionTimestamp?
 * Structurally cannot pass via `x = decisionTimestamp`: every compared value is an independently
 * computed field on DecisionFeatureProvenance (detector/MSS/ATR/macro), never decisionTimestamp
 * itself reflected back.
 */
export function auditDecisionFeatureProvenance(events: readonly FrozenShadowEvent[]): AuditBResult {
  const violations: AuditBViolation[] = [];
  const byProvenanceField: Record<string, number> = {};
  const bump = (f: string) => {
    byProvenanceField[f] = (byProvenanceField[f] ?? 0) + 1;
  };
  for (const ev of events) {
    const p = ev.provenance;
    // Question (1): any feature read from a candle not yet closed at the evaluation cutoff?
    for (const field of PROVENANCE_AVAILABLE_AT_FIELDS) {
      const value = p[field] as number;
      if (value > p.evaluationCutoffExclusive) {
        violations.push({ candidateKey: ev.candidateKey, evaluationId: ev.evaluationId, kind: 'UNCLOSED_CANDLE_READ', provenanceField: field, observedValue: value, comparedAgainst: p.evaluationCutoffExclusive });
        bump(field);
      }
    }
    // Question (2): any feature timestamped after the candidate's own recorded decisionTimestamp?
    for (const field of PROVENANCE_RAW_FIELDS) {
      const value = p[field] as number;
      if (value > ev.decisionTimestamp) {
        violations.push({ candidateKey: ev.candidateKey, evaluationId: ev.evaluationId, kind: 'FEATURE_AFTER_DECISION_TIMESTAMP', provenanceField: field, observedValue: value, comparedAgainst: ev.decisionTimestamp });
        bump(field);
      }
    }
  }
  return { candidatesAudited: events.length, violations, violationCount: violations.length, byProvenanceField, pass: violations.length === 0 };
}

/** The final serialized shape written to data/g6r-runs/g6r-cp3-shadow-candidates.csv — one row per emitted candidate. */
export interface ShadowCandidateRow {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly symbol: string;
  readonly side: ShadowSide;
  readonly regime: string;
  readonly setupType: ShadowSetupType;
  readonly evaluationTimestamp: number;
  readonly sourceTimestamp: number;
  readonly decisionTimestamp: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
  readonly requiredDataCoverage: string;
  readonly primaryObFound: boolean;
  readonly primaryObMssPassed: boolean;
  readonly primaryObMssFailReason: string | null;
  readonly fallbackDetectorResult: string;
  readonly fallbackMssResult: string;
  readonly registrationDocumentSha256: string;
  readonly analyzerSourceHash: string;
  readonly dataQuality: string;
  readonly decisionFeatureProvenance: DecisionFeatureProvenance;
}

export interface ShadowSchemaValidationContext {
  readonly expectedRegistrationDocumentSha256: string;
  readonly expectedAnalyzerSourceHash: string;
  readonly knownEvaluationIds: ReadonlySet<string>;
  readonly evaluationIdFormula: (row: ShadowCandidateRow) => string;
  readonly candidateKeyFormula: (row: ShadowCandidateRow) => string;
}

export interface ShadowSchemaValidationResult {
  readonly valid: boolean;
  /** rowIndex -> list of failure reasons for that row. Empty map means every row passed. */
  readonly rowErrors: ReadonlyMap<number, readonly string[]>;
  readonly duplicateCandidateKeys: number;
  readonly evaluationsWithMultipleCandidates: number;
}

/**
 * Full schema validator (Step 8): checks every field-level and cross-field invariant the frozen
 * ledger CSV must satisfy. Fails closed — a single violated invariant on a single row fails that
 * row (and the overall result), it never silently drops or "fixes" a row.
 */
export function validateShadowCandidateRows(rows: readonly ShadowCandidateRow[], ctx: ShadowSchemaValidationContext): ShadowSchemaValidationResult {
  const rowErrors = new Map<number, string[]>();
  const push = (i: number, msg: string) => {
    const arr = rowErrors.get(i) ?? [];
    arr.push(msg);
    rowErrors.set(i, arr);
  };
  const keyCounts = new Map<string, number>();
  const evalCounts = new Map<string, number>();
  for (const r of rows) {
    keyCounts.set(r.candidateKey, (keyCounts.get(r.candidateKey) ?? 0) + 1);
    evalCounts.set(r.evaluationId, (evalCounts.get(r.evaluationId) ?? 0) + 1);
  }
  rows.forEach((r, i) => {
    if (r.setupType !== 'FVG' && r.setupType !== 'SWEEP') push(i, `setupType must be FVG or SWEEP, got ${String(r.setupType)}`);
    const financeFinite = Number.isFinite(r.entryPrice) && Number.isFinite(r.slPrice) && Number.isFinite(r.slDistance);
    if (!financeFinite) push(i, 'entryPrice/slPrice/slDistance must all be finite');
    else {
      if (Math.abs(r.slDistance - Math.abs(r.entryPrice - r.slPrice)) > 1e-9) push(i, 'slDistance !== abs(entryPrice - slPrice)');
      if (r.side === 'LONG' && !(r.slPrice < r.entryPrice)) push(i, 'LONG requires slPrice < entryPrice');
      if (r.side === 'SHORT' && !(r.slPrice > r.entryPrice)) push(i, 'SHORT requires slPrice > entryPrice');
    }
    if (!Number.isFinite(r.sourceTimestamp)) push(i, 'sourceTimestamp must be finite');
    if (!Number.isFinite(r.decisionTimestamp)) push(i, 'decisionTimestamp must be finite');
    if (!Number.isFinite(r.evaluationTimestamp)) push(i, 'evaluationTimestamp must be finite');
    if (Number.isFinite(r.sourceTimestamp) && Number.isFinite(r.decisionTimestamp) && !(r.sourceTimestamp <= r.decisionTimestamp)) {
      push(i, 'sourceTimestamp must be <= decisionTimestamp');
    }
    // decisionTimestamp must not exceed the evaluation's own decision boundary: the CLOSE of the
    // current 5m candle (evaluationTimestamp + 5min), since candlesMss is truncated to candles
    // strictly closed before that boundary. A decisionTimestamp at/after that boundary would mean
    // an MSS confirmation from a candle that had not yet closed at decision time — leakage.
    if (Number.isFinite(r.decisionTimestamp) && Number.isFinite(r.evaluationTimestamp) && !(r.decisionTimestamp < r.evaluationTimestamp + FIVE_MINUTES_MS)) {
      push(i, 'decisionTimestamp must be < evaluationTimestamp + 5min (the evaluations own closed-candle boundary)');
    }
    if (!r.requiredDataCoverage) push(i, 'requiredDataCoverage flag missing');
    if (r.primaryObFound !== true) push(i, 'primaryObFound must be true (this ledger is OB-primary-only by construction)');
    if (r.primaryObMssPassed !== false) push(i, 'primaryObMssPassed must be false (candidate only exists because primary OB MSS failed)');
    if (!r.primaryObMssFailReason) push(i, 'primaryObMssFailReason must be present');
    if (!r.fallbackDetectorResult) push(i, 'fallbackDetectorResult (fallback detector present/found) must be present');
    if (!r.fallbackMssResult) push(i, 'fallbackMssResult must be present');
    if (r.registrationDocumentSha256 !== ctx.expectedRegistrationDocumentSha256) push(i, 'registrationDocumentSha256 mismatch');
    if (r.analyzerSourceHash !== ctx.expectedAnalyzerSourceHash) push(i, 'analyzerSourceHash mismatch');
    if (!ctx.knownEvaluationIds.has(r.evaluationId)) push(i, 'evaluationId missing CP2 join');
    if (r.evaluationId !== ctx.evaluationIdFormula(r)) push(i, 'evaluationId does not match its formula from field values');
    if (r.candidateKey !== ctx.candidateKeyFormula(r)) push(i, 'candidateKey does not match its formula from field values');
    if ((keyCounts.get(r.candidateKey) ?? 0) > 1) push(i, 'duplicate candidateKey');
    if ((evalCounts.get(r.evaluationId) ?? 0) > 1) push(i, 'more than one candidate for this evaluationId');
  });
  const duplicateCandidateKeys = [...keyCounts.values()].filter((n) => n > 1).length;
  const evaluationsWithMultipleCandidates = [...evalCounts.values()].filter((n) => n > 1).length;
  return { valid: rowErrors.size === 0, rowErrors, duplicateCandidateKeys, evaluationsWithMultipleCandidates };
}

export function createG6ShadowOpportunityAnalyzer(): G6ShadowOpportunityAnalyzer {
  return {
    observeDecision(input, context): G6ShadowObservation {
      // Defect 2 fix: validate closure of every candle array BEFORE any detector/MSS logic runs.
      // Throws FutureCandleViolationError on the first offending candle; never silently trims.
      assertCandlesClosed('candles5m', input.candles5m, FIVE_MINUTES_MS, input.evaluationCutoffExclusive);
      assertCandlesClosed('candlesMss', input.candlesMss, ONE_MINUTE_MS, input.evaluationCutoffExclusive);
      assertCandlesClosed('macroInputCandles1d', input.macroInputCandles1d, ONE_DAY_MS, input.evaluationCutoffExclusive);

      const macroInputMaxTimestamp = input.macroInputCandles1d.length > 0 ? input.macroInputCandles1d[input.macroInputCandles1d.length - 1].timestamp : context.evaluationTimestamp;
      const macroInputMaxAvailableAt = macroInputMaxTimestamp + ONE_DAY_MS;

      const base: G6ShadowObservation = {
        evaluationId: context.evaluationId,
        symbol: input.symbol,
        regime: context.regime,
        evaluationTimestamp: context.evaluationTimestamp,
        primaryObFound: false,
        primary: null,
        fvgFallback: null,
        sweepFallback: null,
        blockedByMacroFilter: false,
        actionableShadowEvent: null,
      };

      if (input.adxDirection1h === undefined || input.adxDirection1h === 'FLAT') return base;
      const direction = input.adxDirection1h === 'UP' ? 'BULLISH' : 'BEARISH';
      const side: ShadowSide = direction === 'BULLISH' ? 'LONG' : 'SHORT';

      const obDisabled = input.obEnabled === false || input.obDisabledSymbols.includes(input.symbol);
      const ob = obDisabled ? null : detectOrderBlock(input.candles5m as CandleData[], direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: input.obBosLookforwardK });
      if (!ob) {
        return { ...base, primaryObFound: false };
      }

      // Frozen rule step 2 (entryRouter.ts runTrendStyle() lines 166-174): macro-trend filter is
      // checked ONCE, keyed on `side`, BEFORE any MSS attempt on the primary. If it fails: stop —
      // no MSS attempt on OB, no FVG evaluation, no Sweep evaluation, no candidate at all.
      const macroBlocked = input.macroTrendFilterEnabled && ((side === 'LONG' && input.macroDirection === 'DOWN') || (side === 'SHORT' && input.macroDirection === 'UP'));
      if (macroBlocked) {
        return { ...base, primaryObFound: true, blockedByMacroFilter: true };
      }

      const obRawSl = direction === 'BULLISH' ? ob.low : ob.high;
      const obSourceTimestamp = input.candles5m[ob.candleIndex].timestamp;
      const primary = evaluateStage('OB', side, obSourceTimestamp, obRawSl, input.candles5m, input.candlesMss, input.obSlBufferAtrMultiplier);

      if (primary.mssConfirmed) {
        // OB confirms its own MSS: production decision wins, shadow does nothing.
        return { ...base, primaryObFound: true, primary };
      }

      // OB exists but its own MSS failed — evaluate FVG on the SAME decision state (macro already
      // checked above and does not change per-candidate — side is unchanged).
      const fvg = detectFairValueGap(input.candles5m as CandleData[], direction);
      let fvgFallback: StageEvaluation | null = null;
      if (fvg) {
        const fvgRawSl = direction === 'BULLISH' ? fvg.bottom : fvg.top;
        const fvgSourceTimestamp = input.candles5m[fvg.candleIndex].timestamp;
        fvgFallback = evaluateStage('FVG', side, fvgSourceTimestamp, fvgRawSl, input.candles5m, input.candlesMss, EntryConfig.SL_BUFFER_ATR_MULTIPLIER);
        if (fvgFallback.mssConfirmed && fvgFallback.entryPrice !== null && fvgFallback.slPrice !== null && fvgFallback.sourceTimestamp !== null && fvgFallback.mssConfirmationTimestamp !== null && fvgFallback.provenancePartial) {
          const slDistance = Math.abs(fvgFallback.entryPrice - fvgFallback.slPrice);
          const detector5mMaxTimestamp = input.candles5m.length > 0 ? input.candles5m[input.candles5m.length - 1].timestamp : fvgFallback.sourceTimestamp;
          const detector5mMaxAvailableAt = detector5mMaxTimestamp + FIVE_MINUTES_MS;
          const p = fvgFallback.provenancePartial;
          const atr5mMaxTimestamp = p.atr5mMaxTimestamp ?? detector5mMaxTimestamp;
          const atr5mMaxAvailableAt = p.atr5mMaxAvailableAt ?? detector5mMaxAvailableAt;
          const maxRawFeatureTimestamp = Math.max(detector5mMaxTimestamp, p.mssMaxTimestampRead, atr5mMaxTimestamp, macroInputMaxTimestamp);
          const maxFeatureAvailableAt = Math.max(detector5mMaxAvailableAt, p.mssMaxAvailableAt, atr5mMaxAvailableAt, macroInputMaxAvailableAt);
          const provenance: DecisionFeatureProvenance = {
            detector5mMaxTimestamp,
            detector5mMaxAvailableAt,
            mssMaxTimestampRead: p.mssMaxTimestampRead,
            mssMaxAvailableAt: p.mssMaxAvailableAt,
            mssConfirmationTimestamp: fvgFallback.mssConfirmationTimestamp,
            stalenessReferenceTimestamp: p.stalenessReferenceTimestamp,
            atr5mMaxTimestamp,
            atr5mMaxAvailableAt,
            macroInputMaxTimestamp,
            macroInputMaxAvailableAt,
            evaluationCutoffExclusive: input.evaluationCutoffExclusive,
            maxRawFeatureTimestamp,
            maxFeatureAvailableAt,
          };
          const event: FrozenShadowEvent = {
            candidateKey: makeCandidateKey(input.symbol, side, 'FVG', fvgFallback.mssConfirmationTimestamp, fvgFallback.sourceTimestamp),
            evaluationId: context.evaluationId,
            symbol: input.symbol,
            side,
            regime: context.regime,
            setupType: 'FVG',
            sourceTimestamp: fvgFallback.sourceTimestamp,
            evaluationTimestamp: context.evaluationTimestamp,
            decisionTimestamp: fvgFallback.mssConfirmationTimestamp,
            entryPrice: fvgFallback.entryPrice,
            slPrice: fvgFallback.slPrice,
            slDistance,
            provenance,
          };
          // FVG actionable: do NOT evaluate Sweep for candidate selection (frozen rule step 4).
          return { ...base, primaryObFound: true, primary, fvgFallback, sweepFallback: null, actionableShadowEvent: event };
        }
      }

      // FVG absent/non-actionable — evaluate Sweep the same way.
      const sweep = detectLiquiditySweep(input.candles5m as CandleData[], direction, {
        fractalN: EntryConfig.FRACTAL_N,
        wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
      });
      let sweepFallback: StageEvaluation | null = null;
      if (sweep) {
        const sweepCandle = input.candles5m[sweep.candleIndex];
        const sweepRawSl = direction === 'BULLISH' ? sweepCandle.low : sweepCandle.high;
        const sweepSourceTimestamp = sweepCandle.timestamp;
        sweepFallback = evaluateStage('SWEEP', side, sweepSourceTimestamp, sweepRawSl, input.candles5m, input.candlesMss, EntryConfig.SL_BUFFER_ATR_MULTIPLIER);
        if (sweepFallback.mssConfirmed && sweepFallback.entryPrice !== null && sweepFallback.slPrice !== null && sweepFallback.sourceTimestamp !== null && sweepFallback.mssConfirmationTimestamp !== null && sweepFallback.provenancePartial) {
          const slDistance = Math.abs(sweepFallback.entryPrice - sweepFallback.slPrice);
          const detector5mMaxTimestamp = input.candles5m.length > 0 ? input.candles5m[input.candles5m.length - 1].timestamp : sweepFallback.sourceTimestamp;
          const detector5mMaxAvailableAt = detector5mMaxTimestamp + FIVE_MINUTES_MS;
          const p = sweepFallback.provenancePartial;
          const atr5mMaxTimestamp = p.atr5mMaxTimestamp ?? detector5mMaxTimestamp;
          const atr5mMaxAvailableAt = p.atr5mMaxAvailableAt ?? detector5mMaxAvailableAt;
          const maxRawFeatureTimestamp = Math.max(detector5mMaxTimestamp, p.mssMaxTimestampRead, atr5mMaxTimestamp, macroInputMaxTimestamp);
          const maxFeatureAvailableAt = Math.max(detector5mMaxAvailableAt, p.mssMaxAvailableAt, atr5mMaxAvailableAt, macroInputMaxAvailableAt);
          const provenance: DecisionFeatureProvenance = {
            detector5mMaxTimestamp,
            detector5mMaxAvailableAt,
            mssMaxTimestampRead: p.mssMaxTimestampRead,
            mssMaxAvailableAt: p.mssMaxAvailableAt,
            mssConfirmationTimestamp: sweepFallback.mssConfirmationTimestamp,
            stalenessReferenceTimestamp: p.stalenessReferenceTimestamp,
            atr5mMaxTimestamp,
            atr5mMaxAvailableAt,
            macroInputMaxTimestamp,
            macroInputMaxAvailableAt,
            evaluationCutoffExclusive: input.evaluationCutoffExclusive,
            maxRawFeatureTimestamp,
            maxFeatureAvailableAt,
          };
          const event: FrozenShadowEvent = {
            candidateKey: makeCandidateKey(input.symbol, side, 'SWEEP', sweepFallback.mssConfirmationTimestamp, sweepFallback.sourceTimestamp),
            evaluationId: context.evaluationId,
            symbol: input.symbol,
            side,
            regime: context.regime,
            setupType: 'SWEEP',
            sourceTimestamp: sweepFallback.sourceTimestamp,
            evaluationTimestamp: context.evaluationTimestamp,
            decisionTimestamp: sweepFallback.mssConfirmationTimestamp,
            entryPrice: sweepFallback.entryPrice,
            slPrice: sweepFallback.slPrice,
            slDistance,
            provenance,
          };
          return { ...base, primaryObFound: true, primary, fvgFallback, sweepFallback, actionableShadowEvent: event };
        }
      }

      return { ...base, primaryObFound: true, primary, fvgFallback, sweepFallback };
    },
  };
}
