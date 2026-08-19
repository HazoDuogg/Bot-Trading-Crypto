/**
 * TICKET-G6R-CP3H — Step 2 (ticket Sections E, G, H, I): forensic telemetry schema, classification,
 * and SL/timestamp causal-attribution logic. Research-only, read-only, pure module — never mutates
 * account/balance/risk-pool/open-position state, never calls back into a production decision.
 *
 * This module does NOT reimplement MSS/OB/FVG/Sweep pattern-matching. It only classifies/attributes
 * from ALREADY-COMPUTED real numbers (StageEvaluation/DecisionFeatureProvenance fields produced by
 * the real, unmodified `evaluateStage()`/`observeDecision()` in g6rShadowAnalyzer.ts, plus the real
 * `auditDecisionFeatureProvenance()` for the timestamp axis).
 */
import { auditDecisionFeatureProvenance, type FrozenShadowEvent, type DecisionFeatureProvenance } from './g6rShadowAnalyzer.js';
import { writeCsv, parseCsv, type ParsedCsv } from './g6rCsvParser.js';
import { candidateKey as canonicalCandidateKey } from './g6rFullPathFunnel.js';

// ============================== Setup-type model (ticket TICKET-G6R-CP3HR Task 2) ==============================

/**
 * CP3H diagnostic telemetry setup-type — scoped to THIS module only. Deliberately wider than the
 * canonical CP3 candidate type (`ShadowSetupType = 'FVG' | 'SWEEP'` in g6rShadowAnalyzer.ts, which
 * this file does NOT change) because CP3H also carries OB-primary diagnostic rows for forensic
 * visibility. Replaces the previous unsafe pattern of forcing an OB row through a type meant only
 * for FVG/Sweep via a double cast like `'OB' as unknown as 'FVG'` — that pattern must never appear
 * in this module or its tests again.
 */
export type ForensicSetupType = 'OB' | 'FVG' | 'SWEEP';

/** The canonical CP3 candidate population this ticket investigates: FVG/Sweep fallback candidates only. */
export type FallbackSetupType = 'FVG' | 'SWEEP';

/** Narrows a ForensicSetupType to the fallback-only subset. Never accepts 'OB'. */
export function isFallbackSetupType(setupType: ForensicSetupType): setupType is FallbackSetupType {
  return setupType === 'FVG' || setupType === 'SWEEP';
}

/**
 * A `ForensicTelemetryRow` whose `setupType` is compile-time narrowed to `FallbackSetupType`
 * ('FVG'|'SWEEP'). TICKET-G6R-CP3HR2 Task 4: this is a TYPE-LEVEL guarantee, not just a runtime
 * filter — a `FallbackForensicTelemetryRow.setupType` can never be assigned/compared as `'OB'`
 * without a TypeScript compile error, independent of what `filterFallbackRows()` actually did at
 * runtime.
 */
export type FallbackForensicTelemetryRow = ForensicTelemetryRow & { readonly setupType: FallbackSetupType };

/**
 * The single authoritative "fallback filter" for CP3H telemetry: keeps only FVG/Sweep rows and
 * structurally cannot leak an OB row into a fallback-denominator count. Any caller computing a
 * fallback total/count MUST derive it from this helper's output, never from the raw row array.
 * Uses a real type-predicate filter callback (`r is FallbackForensicTelemetryRow`) so the RETURN
 * TYPE itself is narrowed — the compiler, not just this function's runtime body, rejects an OB row
 * from ever reaching the fallback-typed population.
 */
export function filterFallbackRows(rows: readonly ForensicTelemetryRow[]): FallbackForensicTelemetryRow[] {
  return rows.filter((r): r is FallbackForensicTelemetryRow => isFallbackSetupType(r.setupType));
}

/**
 * Structural shadow-event shape accepted by this module's classification/assembly functions. Unlike
 * `FrozenShadowEvent` (g6rShadowAnalyzer.ts, canonical CP3, `setupType: ShadowSetupType` = FVG|SWEEP
 * only), `setupType` here is the wider `ForensicSetupType` so an OB-primary diagnostic row can be
 * classified/serialized WITHOUT the caller ever needing an unsafe `'OB' as unknown as 'FVG'` cast.
 * Every other field is identical in shape to FrozenShadowEvent — this is a pure widening of one
 * field, not a reimplementation.
 */
export interface ForensicShadowEventLike {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly regime: string;
  readonly setupType: ForensicSetupType;
  readonly sourceTimestamp: number;
  readonly evaluationTimestamp: number;
  readonly decisionTimestamp: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
  readonly provenance: DecisionFeatureProvenance;
}

/**
 * `auditDecisionFeatureProvenance()` (g6rShadowAnalyzer.ts, not modified by this ticket) reads only
 * `candidateKey`, `evaluationId`, `decisionTimestamp`, and `provenance` off each event — it never
 * reads `setupType` (verified by inspection of its source: PROVENANCE_AVAILABLE_AT_FIELDS/
 * PROVENANCE_RAW_FIELDS loops over `ev.provenance`, plus `ev.candidateKey`/`ev.evaluationId`/
 * `ev.decisionTimestamp` — nothing else — and by a regression test in this module's test file that
 * feeds it an OB-typed event and an otherwise-identical FVG-typed event and asserts byte-identical
 * violation output).
 *
 * TICKET-G6R-CP3HR2 Task 4: this used to be a single `event as unknown as FrozenShadowEvent` double
 * cast (unsafe: it would silently launder an 'OB' setupType through FrozenShadowEvent's FVG|SWEEP-only
 * type). Fixed by building a real FrozenShadowEvent-shaped object that copies every field the audit
 * function actually reads verbatim from `event`, and supplies a FIXED, always-valid literal ('FVG')
 * only for the one field (`setupType`) the audit function is proven never to read — never a value
 * derived from `event.setupType`, so an 'OB' row can never be laundered as 'FVG' data. No `as unknown
 * as` assertion of any kind is used here.
 */
function toAuditableEvent(event: ForensicShadowEventLike): FrozenShadowEvent {
  return { ...event, setupType: 'FVG' };
}

// ============================== Classification enums ==============================

export type TimestampClass = 'CLEAN' | 'READ_AFTER_DECISION_TIMESTAMP' | 'UNCLOSED_INPUT_READ' | 'TIMESTAMP_SCHEMA_INVALID';
export type GeometryClass = 'CLEAN' | 'RAW_ALREADY_WRONG_SIDE' | 'FINAL_WRONG_SIDE_AFTER_BUFFER' | 'NON_FINITE_GEOMETRY' | 'DISTANCE_MISMATCH';
export type CombinedClass = 'CLEAN' | 'TIMESTAMP_ONLY' | 'GEOMETRY_ONLY' | 'BOTH';
export type BufferEffect = 'IMPROVED' | 'INSUFFICIENT' | 'NO_EFFECT_ALREADY_VALID' | 'WORSENED' | 'NON_FINITE';
export type GeometryFailureStage = GeometryClass; // alias per ticket Section E wording (`geometryFailureStage` enum)

// ============================== Full per-candidate telemetry row (ticket Section E) ==============================

/** No field may be `undefined`. Use explicit typed nulls or well-defined enum values instead. */
export interface ForensicTelemetryRow {
  // ---- identity ----
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly regime: string;
  readonly setupType: ForensicSetupType;

  // ---- timestamps ----
  readonly sourceTimestamp: number;
  readonly evaluationTimestamp: number;
  readonly decisionTimestamp: number;
  /** Proposed field (CP3G §10 option T1) — NOT a registered/consumed value, diagnostic only. Equal to provenance.mssMaxAvailableAt. */
  readonly decisionAvailableAt: number;
  readonly candlesFromEnd: number;
  readonly mssMaxTimestampRead: number;
  readonly mssMaxAvailableAt: number;
  readonly stalenessReferenceTimestamp: number;
  readonly evaluationCutoffExclusive: number;
  readonly detector5mMaxTimestamp: number;
  readonly detector5mMaxAvailableAt: number;
  readonly atr5mMaxTimestamp: number;
  readonly atr5mMaxAvailableAt: number;
  readonly macroInputMaxTimestamp: number;
  readonly macroInputMaxAvailableAt: number;
  readonly maxRawFeatureTimestamp: number;
  readonly maxFeatureAvailableAt: number;

  // ---- SL attribution (ticket Section H) ----
  readonly rawSlPrice: number;
  readonly atr: number;
  readonly bufferAmount: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
  readonly rawSlToEntryDistance: number;
  readonly bufferSignCorrect: boolean;
  readonly bufferEffect: BufferEffect;
  readonly entryCrossedRawZone: boolean;
  readonly geometryFailureStage: GeometryFailureStage;

  // ---- decision state ----
  readonly mssConfirmed: boolean;
  readonly mssFailReason: 'NOT_FOUND' | 'NO_CANDIDATE' | 'STALE' | 'NO_ATR' | null;
  readonly primaryObFound: boolean;
  readonly blockedByMacroFilter: boolean;

  // ---- classification ----
  readonly timestampClass: TimestampClass;
  readonly geometryClass: GeometryClass;
  readonly combinedClass: CombinedClass;

  // ---- provenance / hashes ----
  readonly registrationDocumentSha256: string;
  readonly analyzerSourceHash: string;
  readonly evaluationIdSchemaValid: boolean;
  readonly candidateKeySchemaValid: boolean;
}

// ============================== Timestamp classification (ticket Section I) ==============================

/**
 * Reuses the REAL, already-frozen `auditDecisionFeatureProvenance()` (g6rShadowAnalyzer.ts) as the
 * sole source of "was an unclosed candle read" / "was data after decisionTimestamp read" facts —
 * never a reimplementation of that inequality logic. Adds only the schema-validity pre-check (Section
 * E's "no ambiguous/undefined field" requirement) and the CLEAN/READ_AFTER/UNCLOSED/SCHEMA_INVALID
 * enum mapping on top.
 */
export function classifyTimestamp(event: ForensicShadowEventLike): TimestampClass {
  const p = event.provenance;
  const allFields: number[] = [
    p.detector5mMaxTimestamp,
    p.detector5mMaxAvailableAt,
    p.mssMaxTimestampRead,
    p.mssMaxAvailableAt,
    p.mssConfirmationTimestamp,
    p.stalenessReferenceTimestamp,
    p.atr5mMaxTimestamp,
    p.atr5mMaxAvailableAt,
    p.macroInputMaxTimestamp,
    p.macroInputMaxAvailableAt,
    p.evaluationCutoffExclusive,
    p.maxRawFeatureTimestamp,
    p.maxFeatureAvailableAt,
    event.decisionTimestamp,
    event.sourceTimestamp,
    event.evaluationTimestamp,
  ];
  if (allFields.some((v) => !Number.isFinite(v))) return 'TIMESTAMP_SCHEMA_INVALID';

  const audit = auditDecisionFeatureProvenance([toAuditableEvent(event)]);
  if (audit.violationCount === 0) return 'CLEAN';
  const hasUnclosed = audit.violations.some((v) => v.kind === 'UNCLOSED_CANDLE_READ');
  // UNCLOSED_INPUT_READ is the more severe finding (a candle the evaluation had no right to read at
  // all, vs. one that was closed-but-later-than-decisionTimestamp) — reported first if both are present.
  if (hasUnclosed) return 'UNCLOSED_INPUT_READ';
  return 'READ_AFTER_DECISION_TIMESTAMP';
}

// ============================== Geometry classification + SL attribution (ticket Section H) ==============================

export interface SlAttributionInput {
  readonly side: 'LONG' | 'SHORT';
  readonly rawSlPrice: number;
  readonly atr: number;
  readonly bufferAmount: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
}

export interface SlAttributionResult {
  readonly geometryClass: GeometryClass;
  readonly rawSlToEntryDistance: number;
  readonly bufferSignCorrect: boolean;
  readonly bufferEffect: BufferEffect;
  readonly entryCrossedRawZone: boolean;
}

/**
 * Determines from REAL numbers (rawSlPrice/atr/bufferAmount/entryPrice/slPrice/slDistance) — never
 * assumed — whether the raw SL was already wrong-side before buffering, whether the registered
 * buffer sign is correct for `side`, and what effect the buffer actually had. Buffer sign convention
 * (production formula, unchanged, cited from g6rShadowAnalyzer.ts evaluateStage()):
 *   LONG:  slPrice = rawSlPrice - bufferAmount   (buffer moves the SL AWAY from entry, i.e. down)
 *   SHORT: slPrice = rawSlPrice + bufferAmount   (buffer moves the SL AWAY from entry, i.e. up)
 */
export function classifyGeometryAndAttributeSl(input: SlAttributionInput): SlAttributionResult {
  const { side, rawSlPrice, atr, bufferAmount, entryPrice, slPrice, slDistance } = input;
  const allFinite = [rawSlPrice, atr, bufferAmount, entryPrice, slPrice, slDistance].every((v) => Number.isFinite(v));
  if (!allFinite) {
    return { geometryClass: 'NON_FINITE_GEOMETRY', rawSlToEntryDistance: NaN, bufferSignCorrect: false, bufferEffect: 'NON_FINITE', entryCrossedRawZone: false };
  }

  const expectedSlDistance = Math.abs(entryPrice - slPrice);
  if (Math.abs(slDistance - expectedSlDistance) > 1e-9) {
    return {
      geometryClass: 'DISTANCE_MISMATCH',
      rawSlToEntryDistance: Math.abs(entryPrice - rawSlPrice),
      bufferSignCorrect: side === 'LONG' ? slPrice <= rawSlPrice : slPrice >= rawSlPrice,
      bufferEffect: 'NON_FINITE',
      entryCrossedRawZone: side === 'LONG' ? rawSlPrice >= entryPrice : rawSlPrice <= entryPrice,
    };
  }

  const rawSlToEntryDistance = Math.abs(entryPrice - rawSlPrice);
  // "Sign correct" = the buffer was applied in the direction that pushes AWAY from entry (protective),
  // per the registered formula above — a real per-row check, not a blanket code-inspection assumption.
  const bufferSignCorrect = side === 'LONG' ? slPrice <= rawSlPrice : slPrice >= rawSlPrice;
  const rawWrongSide = side === 'LONG' ? rawSlPrice >= entryPrice : rawSlPrice <= entryPrice;
  const finalWrongSide = side === 'LONG' ? slPrice >= entryPrice : slPrice <= entryPrice;

  let bufferEffect: BufferEffect;
  if (rawWrongSide && !finalWrongSide) bufferEffect = 'IMPROVED';
  else if (rawWrongSide && finalWrongSide) bufferEffect = 'INSUFFICIENT';
  else if (!rawWrongSide && !finalWrongSide) bufferEffect = 'NO_EFFECT_ALREADY_VALID';
  else bufferEffect = 'WORSENED'; // mathematically not expected under the registered formula/sign convention (bufferAmount>=0) — reported, not assumed impossible

  let geometryClass: GeometryClass;
  if (!finalWrongSide) geometryClass = 'CLEAN';
  else if (rawWrongSide) geometryClass = 'RAW_ALREADY_WRONG_SIDE';
  else geometryClass = 'FINAL_WRONG_SIDE_AFTER_BUFFER';

  return { geometryClass, rawSlToEntryDistance, bufferSignCorrect, bufferEffect, entryCrossedRawZone: rawWrongSide };
}

// ============================== Combined CLEAN/TIMESTAMP_ONLY/GEOMETRY_ONLY/BOTH (ticket Section G) ==============================

export function combineClassification(timestampClass: TimestampClass, geometryClass: GeometryClass): CombinedClass {
  const timestampClean = timestampClass === 'CLEAN';
  const geometryClean = geometryClass === 'CLEAN';
  if (timestampClean && geometryClean) return 'CLEAN';
  if (!timestampClean && geometryClean) return 'TIMESTAMP_ONLY';
  if (timestampClean && !geometryClean) return 'GEOMETRY_ONLY';
  return 'BOTH';
}

export interface CombinedClassificationBreakdown {
  readonly CLEAN: number;
  readonly TIMESTAMP_ONLY: number;
  readonly GEOMETRY_ONLY: number;
  readonly BOTH: number;
  readonly total: number;
  /** Hard invariant per ticket Section G: CLEAN + TIMESTAMP_ONLY + GEOMETRY_ONLY + BOTH === total. Violation is itself FORENSIC_INVALID. */
  readonly reconciles: boolean;
}

export function summarizeCombinedClassification(rows: readonly ForensicTelemetryRow[]): CombinedClassificationBreakdown {
  let CLEAN = 0,
    TIMESTAMP_ONLY = 0,
    GEOMETRY_ONLY = 0,
    BOTH = 0;
  for (const r of rows) {
    if (r.combinedClass === 'CLEAN') CLEAN++;
    else if (r.combinedClass === 'TIMESTAMP_ONLY') TIMESTAMP_ONLY++;
    else if (r.combinedClass === 'GEOMETRY_ONLY') GEOMETRY_ONLY++;
    else BOTH++;
  }
  const total = rows.length;
  return { CLEAN, TIMESTAMP_ONLY, GEOMETRY_ONLY, BOTH, total, reconciles: CLEAN + TIMESTAMP_ONLY + GEOMETRY_ONLY + BOTH === total };
}

// ============================== Row assembly ==============================

export interface AssembleForensicRowInput {
  readonly event: ForensicShadowEventLike;
  readonly rawSlPrice: number;
  readonly atr: number;
  readonly bufferAmount: number;
  readonly candlesFromEnd: number;
  readonly mssConfirmed: boolean;
  readonly mssFailReason: 'NOT_FOUND' | 'NO_CANDIDATE' | 'STALE' | 'NO_ATR' | null;
  readonly primaryObFound: boolean;
  readonly blockedByMacroFilter: boolean;
  readonly registrationDocumentSha256: string;
  readonly analyzerSourceHash: string;
  readonly evaluationIdSchemaValid: boolean;
  readonly candidateKeySchemaValid: boolean;
}

/** Builds one full ForensicTelemetryRow — never leaves a field `undefined`. */
export function assembleForensicRow(input: AssembleForensicRowInput): ForensicTelemetryRow {
  const { event: ev } = input;
  const timestampClass = classifyTimestamp(ev);
  const slAttribution = classifyGeometryAndAttributeSl({
    side: ev.side,
    rawSlPrice: input.rawSlPrice,
    atr: input.atr,
    bufferAmount: input.bufferAmount,
    entryPrice: ev.entryPrice,
    slPrice: ev.slPrice,
    slDistance: ev.slDistance,
  });
  const combinedClass = combineClassification(timestampClass, slAttribution.geometryClass);
  return {
    candidateKey: ev.candidateKey,
    evaluationId: ev.evaluationId,
    symbol: ev.symbol,
    side: ev.side,
    regime: ev.regime,
    setupType: ev.setupType,
    sourceTimestamp: ev.sourceTimestamp,
    evaluationTimestamp: ev.evaluationTimestamp,
    decisionTimestamp: ev.decisionTimestamp,
    decisionAvailableAt: ev.provenance.mssMaxAvailableAt,
    candlesFromEnd: input.candlesFromEnd,
    mssMaxTimestampRead: ev.provenance.mssMaxTimestampRead,
    mssMaxAvailableAt: ev.provenance.mssMaxAvailableAt,
    stalenessReferenceTimestamp: ev.provenance.stalenessReferenceTimestamp,
    evaluationCutoffExclusive: ev.provenance.evaluationCutoffExclusive,
    detector5mMaxTimestamp: ev.provenance.detector5mMaxTimestamp,
    detector5mMaxAvailableAt: ev.provenance.detector5mMaxAvailableAt,
    atr5mMaxTimestamp: ev.provenance.atr5mMaxTimestamp,
    atr5mMaxAvailableAt: ev.provenance.atr5mMaxAvailableAt,
    macroInputMaxTimestamp: ev.provenance.macroInputMaxTimestamp,
    macroInputMaxAvailableAt: ev.provenance.macroInputMaxAvailableAt,
    maxRawFeatureTimestamp: ev.provenance.maxRawFeatureTimestamp,
    maxFeatureAvailableAt: ev.provenance.maxFeatureAvailableAt,
    rawSlPrice: input.rawSlPrice,
    atr: input.atr,
    bufferAmount: input.bufferAmount,
    entryPrice: ev.entryPrice,
    slPrice: ev.slPrice,
    slDistance: ev.slDistance,
    rawSlToEntryDistance: slAttribution.rawSlToEntryDistance,
    bufferSignCorrect: slAttribution.bufferSignCorrect,
    bufferEffect: slAttribution.bufferEffect,
    entryCrossedRawZone: slAttribution.entryCrossedRawZone,
    geometryFailureStage: slAttribution.geometryClass,
    mssConfirmed: input.mssConfirmed,
    mssFailReason: input.mssFailReason,
    primaryObFound: input.primaryObFound,
    blockedByMacroFilter: input.blockedByMacroFilter,
    timestampClass,
    geometryClass: slAttribution.geometryClass,
    combinedClass,
    registrationDocumentSha256: input.registrationDocumentSha256,
    analyzerSourceHash: input.analyzerSourceHash,
    evaluationIdSchemaValid: input.evaluationIdSchemaValid,
    candidateKeySchemaValid: input.candidateKeySchemaValid,
  };
}

// ============================== CSV round-trip (ticket Section G) ==============================

export const FORENSIC_LEDGER_HEADER: readonly (keyof ForensicTelemetryRow)[] = [
  'candidateKey', 'evaluationId', 'symbol', 'side', 'regime', 'setupType',
  'sourceTimestamp', 'evaluationTimestamp', 'decisionTimestamp', 'decisionAvailableAt', 'candlesFromEnd',
  'mssMaxTimestampRead', 'mssMaxAvailableAt', 'stalenessReferenceTimestamp', 'evaluationCutoffExclusive',
  'detector5mMaxTimestamp', 'detector5mMaxAvailableAt', 'atr5mMaxTimestamp', 'atr5mMaxAvailableAt',
  'macroInputMaxTimestamp', 'macroInputMaxAvailableAt', 'maxRawFeatureTimestamp', 'maxFeatureAvailableAt',
  'rawSlPrice', 'atr', 'bufferAmount', 'entryPrice', 'slPrice', 'slDistance', 'rawSlToEntryDistance',
  'bufferSignCorrect', 'bufferEffect', 'entryCrossedRawZone', 'geometryFailureStage',
  'mssConfirmed', 'mssFailReason', 'primaryObFound', 'blockedByMacroFilter',
  'timestampClass', 'geometryClass', 'combinedClass',
  'registrationDocumentSha256', 'analyzerSourceHash', 'evaluationIdSchemaValid', 'candidateKeySchemaValid',
];

function cellToString(v: unknown): string {
  if (v === null) return 'null';
  return String(v);
}

export function writeForensicLedgerCsv(rows: readonly ForensicTelemetryRow[]): string {
  const stringRows = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const key of FORENSIC_LEDGER_HEADER) obj[key] = cellToString((r as unknown as Record<string, unknown>)[key]);
    return obj;
  });
  return writeCsv(FORENSIC_LEDGER_HEADER as string[], stringRows);
}

function parseCell(header: string, raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const numericColumns = new Set([
    'sourceTimestamp', 'evaluationTimestamp', 'decisionTimestamp', 'decisionAvailableAt', 'candlesFromEnd',
    'mssMaxTimestampRead', 'mssMaxAvailableAt', 'stalenessReferenceTimestamp', 'evaluationCutoffExclusive',
    'detector5mMaxTimestamp', 'detector5mMaxAvailableAt', 'atr5mMaxTimestamp', 'atr5mMaxAvailableAt',
    'macroInputMaxTimestamp', 'macroInputMaxAvailableAt', 'maxRawFeatureTimestamp', 'maxFeatureAvailableAt',
    'rawSlPrice', 'atr', 'bufferAmount', 'entryPrice', 'slPrice', 'slDistance', 'rawSlToEntryDistance',
  ]);
  if (numericColumns.has(header)) return Number(raw);
  return raw;
}

/**
 * TICKET-G6R-CP3HR2 Task 5: CSV fail-closed contract — Option 1 (strict exact schema), because these
 * are evidence artifacts: a missing column fails, an unknown/extra column fails, and (via the shared
 * `parseCsv()`'s own existing duplicate-header check) a duplicate header column fails. Column ORDER is
 * not enforced (rows are read by name, not position), so a reordered-but-complete header still parses.
 *
 * Parses a forensic ledger CSV back into typed rows.
 */
export function parseForensicLedgerCsv(text: string): ForensicTelemetryRow[] {
  const parsed: ParsedCsv = parseCsv(text);
  for (const h of FORENSIC_LEDGER_HEADER) {
    if (!parsed.header.includes(h)) throw new Error(`parseForensicLedgerCsv: missing required column ${h}`);
  }
  for (const h of parsed.header) {
    if (!(FORENSIC_LEDGER_HEADER as readonly string[]).includes(h)) throw new Error(`parseForensicLedgerCsv: unknown/unexpected column ${h}`);
  }
  return parsed.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const h of FORENSIC_LEDGER_HEADER) obj[h] = parseCell(h, row[h]);
    return obj as unknown as ForensicTelemetryRow;
  });
}

// ============================== Classification CSV (separate, per ticket Section G) ==============================

export interface ClassificationRow {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly timestampClass: TimestampClass;
  readonly geometryClass: GeometryClass;
  readonly combinedClass: CombinedClass;
}

export const CLASSIFICATION_HEADER: readonly (keyof ClassificationRow)[] = ['candidateKey', 'evaluationId', 'timestampClass', 'geometryClass', 'combinedClass'];

export function writeClassificationCsv(rows: readonly ClassificationRow[]): string {
  const stringRows = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const key of CLASSIFICATION_HEADER) obj[key] = String((r as unknown as Record<string, unknown>)[key]);
    return obj;
  });
  return writeCsv(CLASSIFICATION_HEADER as string[], stringRows);
}

// ============================== Duplicate/join fail-closed checks (ticket Section J) ==============================

export interface ForensicPopulationValidationResult {
  readonly totalRows: number;
  readonly duplicateCandidateKeys: number;
  readonly missingJoins: number;
  readonly combinedBreakdown: CombinedClassificationBreakdown;
  readonly valid: boolean;
}

export function validateForensicPopulation(rows: readonly ForensicTelemetryRow[], knownEvaluationIds: ReadonlySet<string>): ForensicPopulationValidationResult {
  const keyCounts = new Map<string, number>();
  let missingJoins = 0;
  for (const r of rows) {
    keyCounts.set(r.candidateKey, (keyCounts.get(r.candidateKey) ?? 0) + 1);
    if (!knownEvaluationIds.has(r.evaluationId)) missingJoins++;
  }
  const duplicateCandidateKeys = [...keyCounts.values()].filter((n) => n > 1).length;
  const combinedBreakdown = summarizeCombinedClassification(rows);
  return {
    totalRows: rows.length,
    duplicateCandidateKeys,
    missingJoins,
    combinedBreakdown,
    valid: duplicateCandidateKeys === 0 && missingJoins === 0 && combinedBreakdown.reconciles,
  };
}

// ============================== Hardened validator for FUTURE research passes (ticket TICKET-G6R-CP3HR Task 3) ==============================
//
// This section is deliberately NOT wired into any read of the existing (already-generated, immutable)
// CP3H artifacts by this ticket. It exists so a FUTURE authorized research pass can fail closed on a
// wider set of defects than `validateForensicPopulation()` above already checks. Running it against
// today's frozen ledger/classification CSVs (as this ticket's own tests and reconciliation tool do)
// is read-only inspection, not a relabeling of those artifacts as "more complete" than they are.

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
/** A git commit SHA (full, 40 hex chars) — the shape `executionHead` is expected to take when present. */
const EXECUTION_HEAD_PATTERN = /^[0-9a-f]{40}$/i;
const EVALUATION_ID_PATTERN = /^[^|]+\|-?\d+\|[^|]+\|\d+$/;

export function isValidSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}
export function isValidExecutionHead(value: string): boolean {
  return EXECUTION_HEAD_PATTERN.test(value);
}
export function isValidEvaluationIdFormat(value: string): boolean {
  return EVALUATION_ID_PATTERN.test(value);
}

// ============================== Shared provenance/event-like adapter (TICKET-G6R-CP3HR3 Task 5) ==============================
//
// Previously duplicated in two places: `g6rCp3hrFallbackReconciliation.ts`'s `reconstructProvenance()`/
// `reconstructEventLike()`, and an inline object-literal build inside
// `validateFutureForensicTelemetryRowV2()` below. Both reconstruct the exact same
// `DecisionFeatureProvenance` + `ForensicShadowEventLike` shape from a persisted row's own raw fields,
// so future changes to that shape could silently diverge between the two validators. Consolidated here
// (the lower-level schema module both already depend on) as the ONE shared, pure, exported adapter both
// call sites now use.
//
// One field, `mssConfirmationTimestamp`, is not its own persisted column (only `decisionTimestamp` is),
// because by construction in `g6rCp3hForensicReplay.ts` the persisted `decisionTimestamp` IS always the
// MSS confirmation timestamp for the row it belongs to — so `row.decisionTimestamp` is substituted here,
// not invented.
export function buildProvenanceFromRow(
  r: Pick<
    ForensicTelemetryRow,
    | 'detector5mMaxTimestamp'
    | 'detector5mMaxAvailableAt'
    | 'mssMaxTimestampRead'
    | 'mssMaxAvailableAt'
    | 'decisionTimestamp'
    | 'stalenessReferenceTimestamp'
    | 'atr5mMaxTimestamp'
    | 'atr5mMaxAvailableAt'
    | 'macroInputMaxTimestamp'
    | 'macroInputMaxAvailableAt'
    | 'evaluationCutoffExclusive'
    | 'maxRawFeatureTimestamp'
    | 'maxFeatureAvailableAt'
  >,
): DecisionFeatureProvenance {
  return {
    detector5mMaxTimestamp: r.detector5mMaxTimestamp,
    detector5mMaxAvailableAt: r.detector5mMaxAvailableAt,
    mssMaxTimestampRead: r.mssMaxTimestampRead,
    mssMaxAvailableAt: r.mssMaxAvailableAt,
    mssConfirmationTimestamp: r.decisionTimestamp,
    stalenessReferenceTimestamp: r.stalenessReferenceTimestamp,
    atr5mMaxTimestamp: r.atr5mMaxTimestamp,
    atr5mMaxAvailableAt: r.atr5mMaxAvailableAt,
    macroInputMaxTimestamp: r.macroInputMaxTimestamp,
    macroInputMaxAvailableAt: r.macroInputMaxAvailableAt,
    evaluationCutoffExclusive: r.evaluationCutoffExclusive,
    maxRawFeatureTimestamp: r.maxRawFeatureTimestamp,
    maxFeatureAvailableAt: r.maxFeatureAvailableAt,
  };
}

export function buildEventLikeFromRow(
  r: Pick<
    ForensicTelemetryRow,
    | 'candidateKey'
    | 'evaluationId'
    | 'symbol'
    | 'side'
    | 'regime'
    | 'setupType'
    | 'sourceTimestamp'
    | 'evaluationTimestamp'
    | 'decisionTimestamp'
    | 'entryPrice'
    | 'slPrice'
    | 'slDistance'
    | 'detector5mMaxTimestamp'
    | 'detector5mMaxAvailableAt'
    | 'mssMaxTimestampRead'
    | 'mssMaxAvailableAt'
    | 'stalenessReferenceTimestamp'
    | 'atr5mMaxTimestamp'
    | 'atr5mMaxAvailableAt'
    | 'macroInputMaxTimestamp'
    | 'macroInputMaxAvailableAt'
    | 'evaluationCutoffExclusive'
    | 'maxRawFeatureTimestamp'
    | 'maxFeatureAvailableAt'
  >,
): ForensicShadowEventLike {
  return {
    candidateKey: r.candidateKey,
    evaluationId: r.evaluationId,
    symbol: r.symbol,
    side: r.side,
    regime: r.regime,
    setupType: r.setupType,
    sourceTimestamp: r.sourceTimestamp,
    evaluationTimestamp: r.evaluationTimestamp,
    decisionTimestamp: r.decisionTimestamp,
    entryPrice: r.entryPrice,
    slPrice: r.slPrice,
    slDistance: r.slDistance,
    provenance: buildProvenanceFromRow(r),
  };
}

/** candidateKey formula per the CP2/CP3 ledger model: symbol|side|setupType|decisionTimestamp|sourceTimestamp. */
export function expectedCandidateKey(row: Pick<ForensicTelemetryRow, 'symbol' | 'side' | 'setupType' | 'decisionTimestamp' | 'sourceTimestamp'>): string {
  return canonicalCandidateKey(row.symbol, row.side, row.setupType, row.decisionTimestamp, row.sourceTimestamp);
}

/** Fields that may legitimately be null (e.g. mssFailReason when MSS confirmed). Every other field must not be null/undefined/NaN-as-string. */
const NULLABLE_FIELDS = new Set<keyof ForensicTelemetryRow>(['mssFailReason']);
const NUMERIC_FIELDS: readonly (keyof ForensicTelemetryRow)[] = [
  'sourceTimestamp', 'evaluationTimestamp', 'decisionTimestamp', 'decisionAvailableAt', 'candlesFromEnd',
  'mssMaxTimestampRead', 'mssMaxAvailableAt', 'stalenessReferenceTimestamp', 'evaluationCutoffExclusive',
  'detector5mMaxTimestamp', 'detector5mMaxAvailableAt', 'atr5mMaxTimestamp', 'atr5mMaxAvailableAt',
  'macroInputMaxTimestamp', 'macroInputMaxAvailableAt', 'maxRawFeatureTimestamp', 'maxFeatureAvailableAt',
  'rawSlPrice', 'atr', 'bufferAmount', 'entryPrice', 'slPrice', 'slDistance', 'rawSlToEntryDistance',
];

export interface HardenedClassificationRow {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly timestampClass: string;
  readonly geometryClass: string;
  readonly combinedClass: string;
}

export interface HardenedValidationViolation {
  readonly category: string;
  readonly candidateKey: string | null;
  readonly detail: string;
}

export interface HardenedValidationResult {
  readonly valid: boolean;
  readonly violations: readonly HardenedValidationViolation[];
  readonly violationCountByCategory: Record<string, number>;
}

/**
 * Fails closed on the wide defect list from ticket Section (Task 3), scoped correctly so that an
 * OB-primary row co-occurring at the same evaluation as a fallback candidate is NOT itself a
 * violation (that is expected/normal — production evaluates OB first, then falls through to
 * FVG/Sweep on the SAME evaluation), while OB rows are NEVER counted into fallback uniqueness or
 * correction totals (enforced by deriving the fallback population exclusively via
 * `filterFallbackRows()`, never by reading the raw `rows` array directly for that purpose).
 */
export function validateForensicLedgerStrict(rows: readonly ForensicTelemetryRow[], classificationRows: readonly HardenedClassificationRow[]): HardenedValidationResult {
  const violations: HardenedValidationViolation[] = [];
  const push = (category: string, candidateKey: string | null, detail: string) => violations.push({ category, candidateKey, detail });

  // ---- missing required fields / non-finite numerics ----
  for (const r of rows) {
    for (const field of FORENSIC_LEDGER_HEADER) {
      const value = (r as unknown as Record<string, unknown>)[field];
      if (value === undefined) push('MISSING_REQUIRED_FIELD', r.candidateKey, `field ${field} is undefined`);
      else if (value === null && !NULLABLE_FIELDS.has(field)) push('MISSING_REQUIRED_FIELD', r.candidateKey, `field ${field} is null but is not a nullable field`);
    }
    for (const field of NUMERIC_FIELDS) {
      const value = (r as unknown as Record<string, unknown>)[field];
      if (typeof value === 'number' && !Number.isFinite(value)) push('NON_FINITE_VALUE', r.candidateKey, `field ${field} is non-finite (${value})`);
    }
  }

  // ---- invalid setupType enum ----
  for (const r of rows) {
    if (r.setupType !== 'OB' && r.setupType !== 'FVG' && r.setupType !== 'SWEEP') {
      push('INVALID_SETUP_TYPE', r.candidateKey, `setupType ${String(r.setupType)} is not one of OB|FVG|SWEEP`);
    }
  }

  // ---- setup-type totals consistency ----
  const obCount = rows.filter((r) => r.setupType === 'OB').length;
  const fvgCount = rows.filter((r) => r.setupType === 'FVG').length;
  const sweepCount = rows.filter((r) => r.setupType === 'SWEEP').length;
  if (obCount + fvgCount + sweepCount !== rows.length) {
    push('SETUP_TYPE_TOTALS_INCONSISTENT', null, `OB(${obCount})+FVG(${fvgCount})+SWEEP(${sweepCount}) !== totalRows(${rows.length})`);
  }

  // ---- candidateKey / evaluationId formula checks ----
  for (const r of rows) {
    if (expectedCandidateKey(r) !== r.candidateKey) {
      push('CANDIDATE_KEY_FORMULA_MISMATCH', r.candidateKey, `expected ${expectedCandidateKey(r)}, got ${r.candidateKey}`);
    }
    if (!isValidEvaluationIdFormat(r.evaluationId)) {
      push('EVALUATION_ID_FORMULA_MISMATCH', r.candidateKey, `evaluationId ${r.evaluationId} does not match symbol|evaluationTimestamp|regime|routeInvocationOrdinal`);
    }
  }

  // ---- duplicate candidateKey (whole population) ----
  const keyCounts = new Map<string, number>();
  for (const r of rows) keyCounts.set(r.candidateKey, (keyCounts.get(r.candidateKey) ?? 0) + 1);
  for (const [key, count] of keyCounts) {
    if (count > 1) push('DUPLICATE_CANDIDATE_KEY', key, `candidateKey appears ${count} times`);
  }

  // ---- duplicate evaluationId AMONG FALLBACK rows specifically (>1 fallback candidate per evaluation) ----
  const fallbackRows = filterFallbackRows(rows);
  const fallbackEvalCounts = new Map<string, number>();
  for (const r of fallbackRows) fallbackEvalCounts.set(r.evaluationId, (fallbackEvalCounts.get(r.evaluationId) ?? 0) + 1);
  for (const [evaluationId, count] of fallbackEvalCounts) {
    if (count > 1) push('MULTIPLE_FALLBACK_CANDIDATES_PER_EVALUATION', null, `evaluationId ${evaluationId} has ${count} fallback (FVG/SWEEP) candidates — an OB row at the same evaluation does not count toward this`);
  }
  // Plain duplicate evaluationId across ALL rows (OB + fallback) is expected/normal (OB and its
  // fallback share one evaluation) and is intentionally NOT flagged here — only the fallback-scoped
  // multiplicity above is a real defect, per the ticket's explicit scoping instruction.

  // ---- ledger<->classification join + orphan classification rows ----
  const classificationByKey = new Map<string, HardenedClassificationRow>();
  for (const c of classificationRows) classificationByKey.set(c.candidateKey, c);
  const ledgerKeys = new Set(rows.map((r) => r.candidateKey));
  for (const r of rows) {
    const c = classificationByKey.get(r.candidateKey);
    if (!c) push('MISSING_LEDGER_CLASSIFICATION_JOIN', r.candidateKey, 'no classification row for this ledger candidateKey');
    else if (c.combinedClass !== r.combinedClass || c.timestampClass !== r.timestampClass || c.geometryClass !== r.geometryClass) {
      push('CLASSIFICATION_MISMATCH', r.candidateKey, `classification row disagrees with ledger row (timestampClass/geometryClass/combinedClass)`);
    }
  }
  for (const c of classificationRows) {
    if (!ledgerKeys.has(c.candidateKey)) push('ORPHAN_CLASSIFICATION_ROW', c.candidateKey, 'classification row has no matching ledger candidateKey');
  }

  // ---- timestamp ordering violations ----
  for (const r of rows) {
    if (r.sourceTimestamp > r.decisionTimestamp) push('TIMESTAMP_ORDERING_VIOLATION', r.candidateKey, `sourceTimestamp (${r.sourceTimestamp}) > decisionTimestamp (${r.decisionTimestamp})`);
    if (r.evaluationTimestamp > r.decisionTimestamp) push('TIMESTAMP_ORDERING_VIOLATION', r.candidateKey, `evaluationTimestamp (${r.evaluationTimestamp}) > decisionTimestamp (${r.decisionTimestamp})`);
  }

  // ---- malformed hash strings ----
  for (const r of rows) {
    if (!isValidSha256Hex(r.registrationDocumentSha256)) push('MALFORMED_HASH', r.candidateKey, `registrationDocumentSha256 is not a valid sha256 hex string`);
    if (!isValidSha256Hex(r.analyzerSourceHash)) push('MALFORMED_HASH', r.candidateKey, `analyzerSourceHash is not a valid sha256 hex string`);
  }

  // ---- setup-type totals inconsistency against classification total ----
  if (classificationRows.length !== rows.length) {
    push('CLASSIFICATION_TOTAL_INCONSISTENT', null, `classificationRows.length (${classificationRows.length}) !== ledger rows.length (${rows.length})`);
  }

  const violationCountByCategory: Record<string, number> = {};
  for (const v of violations) violationCountByCategory[v.category] = (violationCountByCategory[v.category] ?? 0) + 1;

  return { valid: violations.length === 0, violations, violationCountByCategory };
}

// ============================== TICKET-G6R-CP3HR2 Task 3: Legacy vs Future-V2 schema split ==============================
//
// `LegacyCp3hTelemetryRow` is EXACTLY the column set of the real, immutable
// `data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv` header row (inspected directly — not assumed —
// on 2026-08-18: `candidateKey,evaluationId,symbol,side,regime,setupType,sourceTimestamp,
// evaluationTimestamp,decisionTimestamp,decisionAvailableAt,candlesFromEnd,mssMaxTimestampRead,
// mssMaxAvailableAt,stalenessReferenceTimestamp,evaluationCutoffExclusive,detector5mMaxTimestamp,
// detector5mMaxAvailableAt,atr5mMaxTimestamp,atr5mMaxAvailableAt,macroInputMaxTimestamp,
// macroInputMaxAvailableAt,maxRawFeatureTimestamp,maxFeatureAvailableAt,rawSlPrice,atr,bufferAmount,
// entryPrice,slPrice,slDistance,rawSlToEntryDistance,bufferSignCorrect,bufferEffect,
// entryCrossedRawZone,geometryFailureStage,mssConfirmed,mssFailReason,primaryObFound,
// blockedByMacroFilter,timestampClass,geometryClass,combinedClass,registrationDocumentSha256,
// analyzerSourceHash,evaluationIdSchemaValid,candidateKeySchemaValid` — a byte-for-byte match of
// `FORENSIC_LEDGER_HEADER` above, confirming `ForensicTelemetryRow` already models exactly what was
// captured). This type is a documentation-only alias making that scope explicit for reconciliation
// code that reads the FROZEN, already-existing evidence — it deliberately does NOT gain any field the
// real CSV doesn't have. Fields the ticket's full V2 spec wants but this legacy artifact never
// captured (executionHead, datasetFingerprint, analyzerSourceSha256, forensicToolSha256,
// confirmingCandleAvailableAt, mssDecisionAvailableAt, fullDecisionAvailableAt,
// slBufferAtrMultiplier) are NOT_PERSISTED for this evidence and MUST be reported as such — never
// silently backfilled onto this type as if they had been captured.
export type LegacyCp3hTelemetryRow = ForensicTelemetryRow;

/** Sentinel used only in REPORT TEXT (never in typed data) to mark a V2-spec field the legacy artifact never captured. */
export const NOT_PERSISTED = 'NOT_PERSISTED' as const;

/**
 * The full schema an AUTHORIZED FUTURE replay SHOULD populate — covers every field ticket
 * TICKET-G6R-CP3HR2 Task 3 lists that `LegacyCp3hTelemetryRow` does not have. This type is never
 * populated by this ticket (zero replay authorization here) — it exists purely so a future run has a
 * hardened target schema and validator ready, and so this ticket's own report can say precisely what
 * remains uncaptured rather than leaving it implicit.
 */
export interface FutureForensicTelemetryRowV2 extends ForensicTelemetryRow {
  // ---- identity / provenance (new vs legacy) ----
  /** Full 40-hex-char git commit SHA the authorized future replay ran at. */
  readonly executionHead: string;
  /** sha256 fingerprint identifying the exact historical dataset/candle-source used. */
  readonly datasetFingerprint: string;
  /** sha256 of the analyzer source file, using the FULL "sha256" naming convention (legacy field was named analyzerSourceHash). */
  readonly analyzerSourceSha256: string;
  /** sha256 of this forensic tool's own source file at the time of the run. */
  readonly forensicToolSha256: string;

  // ---- full timestamp / availability set (new vs legacy) ----
  /** Timestamp at which the confirming (MSS-breakout) candle itself became available (closed + read-eligible). */
  readonly confirmingCandleAvailableAt: number;
  /** Timestamp at which every input the MSS decision depended on was simultaneously available. */
  readonly mssDecisionAvailableAt: number;
  /** Timestamp at which every input the FULL decision (MSS + geometry + macro filter) depended on was simultaneously available. */
  readonly fullDecisionAvailableAt: number;

  // ---- full SL set (new vs legacy) ----
  /** bufferAmount / atr — persisted directly in V2 rather than left derive-only as in the legacy artifact. */
  readonly slBufferAtrMultiplier: number;

  // ---- fallback (FVG/SWEEP) detector/MSS outcome + coverage (new vs legacy — TICKET-G6R-CP3HR3 Task 2) ----
  /** Whether the fallback (FVG/SWEEP) pattern detector found a candidate setup at all at decision time. Enum (not free text) so callers can exhaustively switch. */
  readonly fallbackDetectorResult: 'FOUND' | 'NOT_FOUND';
  /** Outcome of the MSS confirmation check specifically for the fallback candidate path. Mirrors ForensicTelemetryRow.mssFailReason's non-null values, plus a CONFIRMED case (mssFailReason itself is null-on-success, which V2 avoids for a field this ticket wants always-populated). */
  readonly fallbackMssResult: 'CONFIRMED' | 'NOT_FOUND' | 'NO_CANDIDATE' | 'STALE' | 'NO_ATR';
  /** Coverage descriptor: whether every raw feature input this decision depended on was actually captured on this V2 row (vs. the legacy artifact's known-partial capture). */
  readonly requiredDataCoverage: 'FULL' | 'PARTIAL' | 'UNKNOWN';
}

const V2_SHA256_FIELDS: readonly (keyof FutureForensicTelemetryRowV2)[] = ['datasetFingerprint', 'analyzerSourceSha256', 'forensicToolSha256', 'registrationDocumentSha256'];

/**
 * Every field `FutureForensicTelemetryRowV2` requires, from a FIXED spec list — deliberately NOT
 * derived from `Object.keys(row)` at validation time, because a field the caller deleted/omitted from
 * the actual object would then simply be absent from `Object.keys()` too and silently skip the
 * missing-field check. Iterating the fixed spec list instead means a deleted/omitted key is still
 * checked (and correctly read back as `undefined`).
 */
const ALL_V2_FIELDS: readonly (keyof FutureForensicTelemetryRowV2)[] = [
  ...FORENSIC_LEDGER_HEADER,
  'executionHead',
  'datasetFingerprint',
  'analyzerSourceSha256',
  'forensicToolSha256',
  'confirmingCandleAvailableAt',
  'mssDecisionAvailableAt',
  'fullDecisionAvailableAt',
  'slBufferAtrMultiplier',
  'fallbackDetectorResult',
  'fallbackMssResult',
  'requiredDataCoverage',
];

/**
 * TICKET-G6R-CP3HR3 Task 2: expected RUNTIME type (`typeof`) for every field in `ALL_V2_FIELDS`. This
 * is the piece the pre-CP3HR3 validator was missing: the old loop only checked undefined/null/
 * empty-string/non-finite-number, which silently PASSES a `number`-typed field holding the runtime
 * STRING `"123"` (typeof is 'string', so the NaN/Infinity check for actual numbers is never reached)
 * and silently PASSES a `boolean`-typed field holding the runtime STRING `"false"` (truthy as a JS
 * string, so a naive `if (!value)` check would also wrongly treat it as valid AND as boolean-false in
 * downstream logic). Every field here is checked via `typeof value === expectedType`.
 */
const V2_FIELD_RUNTIME_TYPES: Readonly<Record<keyof FutureForensicTelemetryRowV2, 'string' | 'number' | 'boolean'>> = {
  candidateKey: 'string',
  evaluationId: 'string',
  symbol: 'string',
  side: 'string',
  regime: 'string',
  setupType: 'string',
  sourceTimestamp: 'number',
  evaluationTimestamp: 'number',
  decisionTimestamp: 'number',
  decisionAvailableAt: 'number',
  candlesFromEnd: 'number',
  mssMaxTimestampRead: 'number',
  mssMaxAvailableAt: 'number',
  stalenessReferenceTimestamp: 'number',
  evaluationCutoffExclusive: 'number',
  detector5mMaxTimestamp: 'number',
  detector5mMaxAvailableAt: 'number',
  atr5mMaxTimestamp: 'number',
  atr5mMaxAvailableAt: 'number',
  macroInputMaxTimestamp: 'number',
  macroInputMaxAvailableAt: 'number',
  maxRawFeatureTimestamp: 'number',
  maxFeatureAvailableAt: 'number',
  rawSlPrice: 'number',
  atr: 'number',
  bufferAmount: 'number',
  entryPrice: 'number',
  slPrice: 'number',
  slDistance: 'number',
  rawSlToEntryDistance: 'number',
  bufferSignCorrect: 'boolean',
  bufferEffect: 'string',
  entryCrossedRawZone: 'boolean',
  geometryFailureStage: 'string',
  mssConfirmed: 'boolean',
  // mssFailReason is nullable (string | null) — a null value short-circuits before this table is
  // consulted (see the loop below); when NON-null it must be a string.
  mssFailReason: 'string',
  primaryObFound: 'boolean',
  blockedByMacroFilter: 'boolean',
  timestampClass: 'string',
  geometryClass: 'string',
  combinedClass: 'string',
  registrationDocumentSha256: 'string',
  analyzerSourceHash: 'string',
  evaluationIdSchemaValid: 'boolean',
  candidateKeySchemaValid: 'boolean',
  executionHead: 'string',
  datasetFingerprint: 'string',
  analyzerSourceSha256: 'string',
  forensicToolSha256: 'string',
  confirmingCandleAvailableAt: 'number',
  mssDecisionAvailableAt: 'number',
  fullDecisionAvailableAt: 'number',
  slBufferAtrMultiplier: 'number',
  fallbackDetectorResult: 'string',
  fallbackMssResult: 'string',
  requiredDataCoverage: 'string',
};

export interface V2ValidationViolation {
  readonly category: string;
  readonly field: string | null;
  readonly detail: string;
}
export interface V2ValidationResult {
  readonly valid: boolean;
  readonly violations: readonly V2ValidationViolation[];
}

/**
 * Fails closed on every defect category ticket Task 3 lists. NEVER used by this ticket to relabel
 * `LegacyCp3hTelemetryRow`/the frozen CP3H artifact as "complete" — it validates the FutureForensicTelemetryRowV2
 * shape only, and this ticket does not construct/populate any real row of that shape (zero replay).
 */
export function validateFutureForensicTelemetryRowV2(row: FutureForensicTelemetryRowV2): V2ValidationResult {
  const violations: V2ValidationViolation[] = [];
  const push = (category: string, field: string | null, detail: string) => violations.push({ category, field, detail });
  const r = row as unknown as Record<string, unknown>;

  // ---- missing required field / WRONG RUNTIME TYPE / empty string / NaN / Infinity ----
  for (const field of ALL_V2_FIELDS) {
    const value = r[field as string];
    if (value === undefined) {
      push('MISSING_REQUIRED_FIELD', field, `field ${field} is undefined`);
      continue;
    }
    if (value === null) {
      if (!NULLABLE_FIELDS.has(field as keyof ForensicTelemetryRow)) {
        push('MISSING_REQUIRED_FIELD', field, `field ${field} is null but is not a nullable field`);
      }
      // A valid null on a nullable field has no runtime "type" to check further — skip.
      continue;
    }
    // TICKET-G6R-CP3HR3 Task 2: the previously-missing runtime-type check. Catches a `number` field
    // holding the STRING "123" and a `boolean` field holding the STRING "false" — both would silently
    // pass every check below (typeof "123" === 'string' skips the NaN/Infinity check; "false" is a
    // non-empty, non-NaN string) without this explicit `typeof` comparison.
    const expectedType = V2_FIELD_RUNTIME_TYPES[field];
    if (expectedType && typeof value !== expectedType) {
      push('WRONG_RUNTIME_TYPE', field, `field ${field} expected runtime type '${expectedType}', got '${typeof value}' (value: ${JSON.stringify(value)})`);
      continue; // downstream string/number-specific checks assume the declared type; skip to avoid cascading noise from one root defect.
    }
    if (typeof value === 'string' && value.length === 0) push('EMPTY_STRING', field, `field ${field} is an empty string`);
    if (typeof value === 'number' && !Number.isFinite(value)) push('NON_FINITE_VALUE', field, `field ${field} is non-finite (${value})`);
  }

  // ---- malformed SHA-256 (exactly 64 lowercase hex) — checked exactly ONCE per field via this single
  // loop (TICKET-G6R-CP3HR3 Task 5: a prior redundant standalone `analyzerSourceSha256`-only block
  // that duplicated this exact check has been removed; `analyzerSourceSha256` is already covered here
  // via `V2_SHA256_FIELDS`, so a single malformed hash now produces exactly one MALFORMED_HASH violation) ----
  for (const field of V2_SHA256_FIELDS) {
    const value = r[field as string];
    if (typeof value === 'string' && !/^[0-9a-f]{64}$/.test(value)) push('MALFORMED_HASH', field, `field ${field} is not a lowercase 64-hex-char sha256 string`);
  }

  // ---- malformed execution HEAD (exactly 40 lowercase hex, git commit SHA format) ----
  if (typeof row.executionHead === 'string' && !/^[0-9a-f]{40}$/.test(row.executionHead)) {
    push('MALFORMED_EXECUTION_HEAD', 'executionHead', 'executionHead is not a lowercase 40-hex-char git commit SHA');
  }

  // ---- invalid enum values ----
  if (row.side !== 'LONG' && row.side !== 'SHORT') push('INVALID_ENUM', 'side', `side ${String(row.side)} is not LONG|SHORT`);
  if (row.setupType !== 'OB' && row.setupType !== 'FVG' && row.setupType !== 'SWEEP') push('INVALID_ENUM', 'setupType', `setupType ${String(row.setupType)} is not OB|FVG|SWEEP`);
  if (!['CLEAN', 'READ_AFTER_DECISION_TIMESTAMP', 'UNCLOSED_INPUT_READ', 'TIMESTAMP_SCHEMA_INVALID'].includes(row.timestampClass)) push('INVALID_ENUM', 'timestampClass', `timestampClass ${row.timestampClass} invalid`);
  if (!['CLEAN', 'RAW_ALREADY_WRONG_SIDE', 'FINAL_WRONG_SIDE_AFTER_BUFFER', 'NON_FINITE_GEOMETRY', 'DISTANCE_MISMATCH'].includes(row.geometryClass)) push('INVALID_ENUM', 'geometryClass', `geometryClass ${row.geometryClass} invalid`);
  if (!['CLEAN', 'TIMESTAMP_ONLY', 'GEOMETRY_ONLY', 'BOTH'].includes(row.combinedClass)) push('INVALID_ENUM', 'combinedClass', `combinedClass ${row.combinedClass} invalid`);
  // TICKET-G6R-CP3HR3 Task 2: enum checks for the 3 new V2-only fields. Guarded by typeof===string so a
  // field already reported MISSING_REQUIRED_FIELD/WRONG_RUNTIME_TYPE above doesn't also cascade a
  // confusing second INVALID_ENUM violation for the same root cause.
  if (typeof row.fallbackDetectorResult === 'string' && !['FOUND', 'NOT_FOUND'].includes(row.fallbackDetectorResult)) {
    push('INVALID_ENUM', 'fallbackDetectorResult', `fallbackDetectorResult ${row.fallbackDetectorResult} is not FOUND|NOT_FOUND`);
  }
  if (typeof row.fallbackMssResult === 'string' && !['CONFIRMED', 'NOT_FOUND', 'NO_CANDIDATE', 'STALE', 'NO_ATR'].includes(row.fallbackMssResult)) {
    push('INVALID_ENUM', 'fallbackMssResult', `fallbackMssResult ${row.fallbackMssResult} is not CONFIRMED|NOT_FOUND|NO_CANDIDATE|STALE|NO_ATR`);
  }
  if (typeof row.requiredDataCoverage === 'string' && !['FULL', 'PARTIAL', 'UNKNOWN'].includes(row.requiredDataCoverage)) {
    push('INVALID_ENUM', 'requiredDataCoverage', `requiredDataCoverage ${row.requiredDataCoverage} is not FULL|PARTIAL|UNKNOWN`);
  }

  // ---- timestamp ordering violations ----
  if (row.sourceTimestamp > row.decisionTimestamp) push('TIMESTAMP_ORDERING_VIOLATION', 'sourceTimestamp', `sourceTimestamp (${row.sourceTimestamp}) > decisionTimestamp (${row.decisionTimestamp})`);
  if (row.evaluationTimestamp > row.decisionTimestamp) push('TIMESTAMP_ORDERING_VIOLATION', 'evaluationTimestamp', `evaluationTimestamp (${row.evaluationTimestamp}) > decisionTimestamp (${row.decisionTimestamp})`);
  if (row.confirmingCandleAvailableAt > row.mssDecisionAvailableAt) push('TIMESTAMP_ORDERING_VIOLATION', 'confirmingCandleAvailableAt', `confirmingCandleAvailableAt (${row.confirmingCandleAvailableAt}) > mssDecisionAvailableAt (${row.mssDecisionAvailableAt})`);
  if (row.mssDecisionAvailableAt > row.fullDecisionAvailableAt) push('TIMESTAMP_ORDERING_VIOLATION', 'mssDecisionAvailableAt', `mssDecisionAvailableAt (${row.mssDecisionAvailableAt}) > fullDecisionAvailableAt (${row.fullDecisionAvailableAt})`);

  // ---- availability timestamps must cover all feature reads (every raw *MaxTimestamp <= its own *AvailableAt, and every raw feature timestamp <= fullDecisionAvailableAt) ----
  const rawToAvailablePairs: ReadonlyArray<readonly [number, number, string]> = [
    [row.detector5mMaxTimestamp, row.detector5mMaxAvailableAt, 'detector5m'],
    [row.mssMaxTimestampRead, row.mssMaxAvailableAt, 'mss'],
    [row.atr5mMaxTimestamp, row.atr5mMaxAvailableAt, 'atr5m'],
    [row.macroInputMaxTimestamp, row.macroInputMaxAvailableAt, 'macroInput'],
  ];
  for (const [raw, available, label] of rawToAvailablePairs) {
    if (raw > available) push('AVAILABILITY_COVERAGE_VIOLATION', label, `${label} raw timestamp (${raw}) > its own availableAt (${available})`);
    if (available > row.fullDecisionAvailableAt) push('AVAILABILITY_COVERAGE_VIOLATION', label, `${label} availableAt (${available}) is not covered by fullDecisionAvailableAt (${row.fullDecisionAvailableAt})`);
  }

  // ---- SL / distance internal inconsistency ----
  const expectedSlDistance = Math.abs(row.entryPrice - row.slPrice);
  if (Number.isFinite(row.entryPrice) && Number.isFinite(row.slPrice) && Number.isFinite(row.slDistance) && Math.abs(row.slDistance - expectedSlDistance) > 1e-9) {
    push('SL_DISTANCE_INCONSISTENT', 'slDistance', `slDistance (${row.slDistance}) !== |entryPrice - slPrice| (${expectedSlDistance})`);
  }
  if (Number.isFinite(row.atr) && row.atr !== 0 && Number.isFinite(row.bufferAmount) && Number.isFinite(row.slBufferAtrMultiplier)) {
    const expectedMultiplier = row.bufferAmount / row.atr;
    if (Math.abs(row.slBufferAtrMultiplier - expectedMultiplier) > 1e-9) {
      push('SL_DISTANCE_INCONSISTENT', 'slBufferAtrMultiplier', `slBufferAtrMultiplier (${row.slBufferAtrMultiplier}) !== bufferAmount/atr (${expectedMultiplier})`);
    }
  }

  // ---- classification must match underlying data (reuses the same real classification functions, never a re-derivation) ----
  if (row.setupType === 'OB' || row.setupType === 'FVG' || row.setupType === 'SWEEP') {
    // TICKET-G6R-CP3HR3 Task 5: uses the ONE shared adapter (`buildEventLikeFromRow`, also used by
    // g6rCp3hrFallbackReconciliation.ts) instead of an inline duplicate object-literal build.
    const eventLike: ForensicShadowEventLike = buildEventLikeFromRow(row);
    const recomputedTimestampClass = classifyTimestamp(eventLike);
    const recomputedGeometry = classifyGeometryAndAttributeSl({ side: row.side, rawSlPrice: row.rawSlPrice, atr: row.atr, bufferAmount: row.bufferAmount, entryPrice: row.entryPrice, slPrice: row.slPrice, slDistance: row.slDistance });
    const recomputedCombined = combineClassification(recomputedTimestampClass, recomputedGeometry.geometryClass);
    if (recomputedTimestampClass !== row.timestampClass) push('CLASSIFICATION_MISMATCH', 'timestampClass', `recomputed ${recomputedTimestampClass} !== stored ${row.timestampClass}`);
    if (recomputedGeometry.geometryClass !== row.geometryClass) push('CLASSIFICATION_MISMATCH', 'geometryClass', `recomputed ${recomputedGeometry.geometryClass} !== stored ${row.geometryClass}`);
    if (recomputedCombined !== row.combinedClass) push('CLASSIFICATION_MISMATCH', 'combinedClass', `recomputed ${recomputedCombined} !== stored ${row.combinedClass}`);
  }

  return { valid: violations.length === 0, violations };
}
