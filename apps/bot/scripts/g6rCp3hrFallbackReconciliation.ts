/**
 * TICKET-G6R-CP3HR — Task 1: pure, OFFLINE reconciliation of the CP3H forensic ledger's fallback-only
 * (FVG/Sweep) population, separated from the OB-primary diagnostic rows the prior report wrongly
 * blended into a 209-row denominator.
 *
 * ABSOLUTE CONSTRAINT: this module NEVER imports, calls, or spawns any replay runner
 * (g6rCp3hForensicReplay.ts, g6rCheckpoint3Replay.ts, ticket150BacktestExecutionRealismAudit.ts's
 * runReplay(), or any Central/CP4/CP5/CP6 tooling). It only reads the two already-existing,
 * already-frozen CSV artifacts produced by a prior (separately authorized) replay:
 *   - data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv
 *   - data/g6r-runs/g6r-cp3h-classification.csv
 * Both files are read-only inputs here; this module never writes to either of them.
 *
 * All counts below are COMPUTED from the actual CSV contents, never hard-coded. The ticket author's
 * belief about the expected fallback-only numbers (total=105, CLEAN=10, TIMESTAMP_ONLY=64,
 * GEOMETRY_ONLY=3, BOTH=28, timestamp-invalid=92, geometry-invalid=31) is NOT encoded anywhere in
 * this file's logic — only compared against, after the fact, by the caller/report.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv } from './g6rCsvParser.js';
import {
  parseForensicLedgerCsv,
  filterFallbackRows,
  isFallbackSetupType,
  classifyTimestamp,
  classifyGeometryAndAttributeSl,
  combineClassification,
  buildEventLikeFromRow,
  type ForensicTelemetryRow,
  type ForensicSetupType,
  type CombinedClass,
} from './g6rCp3hForensicSchema.js';

const KNOWN_SETUP_TYPES: readonly ForensicSetupType[] = ['OB', 'FVG', 'SWEEP'];
function isKnownSetupType(v: string): v is ForensicSetupType {
  return (KNOWN_SETUP_TYPES as readonly string[]).includes(v);
}

// ============================== Pure computation ==============================

export interface ClassificationCsvRow {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly timestampClass: string;
  readonly geometryClass: string;
  readonly combinedClass: string;
}

/**
 * TICKET-G6R-CP3HR2 Task 5: same Option 1 strict-exact-schema contract as `parseForensicLedgerCsv()`
 * — missing column fails, unknown/extra column fails, duplicate header fails (via `parseCsv()`
 * itself), column order is not enforced (read by name).
 *
 * Parses the classification CSV into typed rows. No type coercion beyond string fields (matches the CSV's own schema).
 */
export function parseClassificationCsv(text: string): ClassificationCsvRow[] {
  const parsed = parseCsv(text);
  const required = ['candidateKey', 'evaluationId', 'timestampClass', 'geometryClass', 'combinedClass'];
  for (const h of required) {
    if (!parsed.header.includes(h)) throw new Error(`parseClassificationCsv: missing required column ${h}`);
  }
  for (const h of parsed.header) {
    if (!required.includes(h)) throw new Error(`parseClassificationCsv: unknown/unexpected column ${h}`);
  }
  return parsed.rows.map((r) => ({
    candidateKey: r.candidateKey,
    evaluationId: r.evaluationId,
    timestampClass: r.timestampClass,
    geometryClass: r.geometryClass,
    combinedClass: r.combinedClass,
  }));
}

export interface JoinResult {
  readonly joined: ReadonlyArray<{ ledger: ForensicTelemetryRow; classification: ClassificationCsvRow }>;
  /** Ledger rows with no matching classification row by candidateKey. */
  readonly ledgerRowsMissingClassification: readonly ForensicTelemetryRow[];
  /** Classification rows with no matching ledger row by candidateKey (orphan classification rows). */
  readonly classificationRowsMissingLedger: readonly ClassificationCsvRow[];
  /** Rows where the join succeeded but combinedClass disagrees between the two files (stored-vs-stored). */
  readonly combinedClassMismatches: ReadonlyArray<{ candidateKey: string; ledgerCombinedClass: string; classificationCombinedClass: string }>;
  /**
   * TICKET-G6R-CP3HR3 Task 3: SEPARATE, component-level mismatch categories — distinct from
   * `combinedClassMismatches`. A `timestampClass`/`geometryClass` disagreement must fail the gate even
   * when `combinedClass` happens to still agree (possible because `combinedClass` only encodes
   * clean/dirty PER AXIS, not which specific sub-class — e.g. UNCLOSED_INPUT_READ and
   * READ_AFTER_DECISION_TIMESTAMP both roll up to a non-CLEAN timestamp axis, so swapping one for the
   * other leaves combinedClass unchanged while timestampClass itself is wrong).
   */
  readonly timestampClassMismatches: ReadonlyArray<{ candidateKey: string; ledgerTimestampClass: string; classificationTimestampClass: string }>;
  readonly geometryClassMismatches: ReadonlyArray<{ candidateKey: string; ledgerGeometryClass: string; classificationGeometryClass: string }>;
  /** TICKET-G6R-CP3HR2 Task 1: evaluationId disagrees between a ledger row and its classification counterpart. */
  readonly identityMismatches: ReadonlyArray<{ candidateKey: string; ledgerEvaluationId: string; classificationEvaluationId: string }>;
}

/**
 * TICKET-G6R-CP3HR2 Task 1: pure join by candidateKey. Never mutates inputs. Reports every join
 * defect rather than silently dropping rows. FIXED from the prior CP3HR pass: `classificationByKey`
 * used to be built with a plain `map.set(key, row)` loop with no duplicate check, so a duplicate
 * classification candidateKey would silently overwrite its predecessor and the join would proceed as
 * if nothing were wrong. Duplicate classification candidateKeys are now detected SEPARATELY (see
 * `computeFallbackReconciliation`'s `duplicateClassificationCandidateKeys`) and the join here still
 * uses "last write wins" internally only for the purpose of producing a best-effort joined view for
 * mismatch reporting — the duplicate itself is a hard gate failure regardless of what this join does.
 */
export function joinLedgerAndClassification(ledgerRows: readonly ForensicTelemetryRow[], classificationRows: readonly ClassificationCsvRow[]): JoinResult {
  const classificationByKey = new Map<string, ClassificationCsvRow>();
  for (const c of classificationRows) classificationByKey.set(c.candidateKey, c);
  const ledgerKeys = new Set(ledgerRows.map((r) => r.candidateKey));

  const joined: Array<{ ledger: ForensicTelemetryRow; classification: ClassificationCsvRow }> = [];
  const ledgerRowsMissingClassification: ForensicTelemetryRow[] = [];
  const combinedClassMismatches: Array<{ candidateKey: string; ledgerCombinedClass: string; classificationCombinedClass: string }> = [];
  const timestampClassMismatches: Array<{ candidateKey: string; ledgerTimestampClass: string; classificationTimestampClass: string }> = [];
  const geometryClassMismatches: Array<{ candidateKey: string; ledgerGeometryClass: string; classificationGeometryClass: string }> = [];
  const identityMismatches: Array<{ candidateKey: string; ledgerEvaluationId: string; classificationEvaluationId: string }> = [];

  for (const l of ledgerRows) {
    const c = classificationByKey.get(l.candidateKey);
    if (!c) {
      ledgerRowsMissingClassification.push(l);
      continue;
    }
    joined.push({ ledger: l, classification: c });
    // TICKET-G6R-CP3HR3 Task 3: SEPARATE checks per component — never merged into one undifferentiated
    // bucket. Each fires independently of the others, so any one of the three alone (even while the
    // other two/combinedClass still agree) is its own reported defect category.
    if (l.combinedClass !== c.combinedClass) {
      combinedClassMismatches.push({ candidateKey: l.candidateKey, ledgerCombinedClass: l.combinedClass, classificationCombinedClass: c.combinedClass });
    }
    if (l.timestampClass !== c.timestampClass) {
      timestampClassMismatches.push({ candidateKey: l.candidateKey, ledgerTimestampClass: l.timestampClass, classificationTimestampClass: c.timestampClass });
    }
    if (l.geometryClass !== c.geometryClass) {
      geometryClassMismatches.push({ candidateKey: l.candidateKey, ledgerGeometryClass: l.geometryClass, classificationGeometryClass: c.geometryClass });
    }
    if (l.evaluationId !== c.evaluationId) {
      identityMismatches.push({ candidateKey: l.candidateKey, ledgerEvaluationId: l.evaluationId, classificationEvaluationId: c.evaluationId });
    }
  }

  const classificationRowsMissingLedger = classificationRows.filter((c) => !ledgerKeys.has(c.candidateKey));

  return { joined, ledgerRowsMissingClassification, classificationRowsMissingLedger, combinedClassMismatches, timestampClassMismatches, geometryClassMismatches, identityMismatches };
}

/** Counts duplicate occurrences of a key-extraction function over a row set. Never overwrites — only counts. */
function findDuplicateKeys<T>(rows: readonly T[], keyOf: (row: T) => string): { readonly duplicateCount: number; readonly duplicateKeys: readonly string[] } {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const duplicateKeys = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return { duplicateCount: duplicateKeys.length, duplicateKeys };
}

/**
 * TICKET-G6R-CP3HR3 Task 5: this module used to have its own local `reconstructProvenance()`/
 * `reconstructEventLike()` duplicating the exact same reconstruction logic as
 * `g6rCp3hForensicSchema.ts`'s inline build inside `validateFutureForensicTelemetryRowV2()`. Both are
 * now consolidated into the ONE shared, exported `buildEventLikeFromRow()` (+ `buildProvenanceFromRow()`)
 * adapter in `g6rCp3hForensicSchema.ts` — imported and used directly below — so future changes to the
 * provenance/event-like shape can no longer silently diverge between the two validators.
 */
export interface RecomputedClassMismatch {
  readonly candidateKey: string;
  readonly field: 'timestampClass' | 'geometryClass' | 'combinedClass';
  readonly storedOnLedger: string;
  readonly recomputedFromRawData: string;
}

/**
 * TICKET-G6R-CP3HR2 Task 1 (item 8): recomputes timestampClass/geometryClass/combinedClass for every
 * ledger row from its OWN raw persisted fields (via the real, unmodified `classifyTimestamp()` /
 * `classifyGeometryAndAttributeSl()` / `combineClassification()`), and compares against what the row
 * itself claims. This never trusts the stored label as ground truth.
 */
export function recomputeAndCompareClassification(rows: readonly ForensicTelemetryRow[]): readonly RecomputedClassMismatch[] {
  const mismatches: RecomputedClassMismatch[] = [];
  for (const r of rows) {
    const recomputedTimestampClass = classifyTimestamp(buildEventLikeFromRow(r));
    const recomputedGeometry = classifyGeometryAndAttributeSl({
      side: r.side,
      rawSlPrice: r.rawSlPrice,
      atr: r.atr,
      bufferAmount: r.bufferAmount,
      entryPrice: r.entryPrice,
      slPrice: r.slPrice,
      slDistance: r.slDistance,
    });
    const recomputedCombinedClass = combineClassification(recomputedTimestampClass, recomputedGeometry.geometryClass);

    if (recomputedTimestampClass !== r.timestampClass) {
      mismatches.push({ candidateKey: r.candidateKey, field: 'timestampClass', storedOnLedger: r.timestampClass, recomputedFromRawData: recomputedTimestampClass });
    }
    if (recomputedGeometry.geometryClass !== r.geometryClass) {
      mismatches.push({ candidateKey: r.candidateKey, field: 'geometryClass', storedOnLedger: r.geometryClass, recomputedFromRawData: recomputedGeometry.geometryClass });
    }
    if (recomputedCombinedClass !== r.combinedClass) {
      mismatches.push({ candidateKey: r.candidateKey, field: 'combinedClass', storedOnLedger: r.combinedClass, recomputedFromRawData: recomputedCombinedClass });
    }
  }
  return mismatches;
}

export interface FallbackReconciliationResult {
  readonly totalLedgerRows: number;
  readonly obDiagnosticRowCount: number;
  readonly fallbackRowCount: number;
  readonly fvgCount: number;
  readonly sweepCount: number;
  readonly setupTypeCounts: Record<ForensicSetupType, number>;
  readonly fallbackCombinedBreakdown: Record<CombinedClass, number>;
  readonly fallbackCombinedSum: number;
  readonly fallbackTimestampInvalidCount: number;
  readonly fallbackGeometryInvalidCount: number;

  // ---- TICKET-G6R-CP3HR2 Task 1: duplicate/conflict/identity defect categories ----
  /** Duplicate candidateKey anywhere in the FULL ledger population (OB + fallback), not just the fallback subset. */
  readonly duplicateLedgerCandidateKeys: number;
  readonly duplicateLedgerCandidateKeyValues: readonly string[];
  /** Duplicate candidateKey within the fallback-only (FVG/SWEEP) subset. */
  readonly duplicateFallbackCandidateKeys: number;
  readonly duplicateFallbackCandidateKeyValues: readonly string[];
  /** Duplicate candidateKey within the classification CSV (regardless of whether the duplicated values agree). */
  readonly duplicateClassificationCandidateKeys: number;
  readonly duplicateClassificationCandidateKeyValues: readonly string[];
  /** Duplicate evaluationId within the fallback population specifically (== ">1 FVG/SWEEP actionable candidate for one evaluation", expected to be 0). */
  readonly duplicateFallbackEvaluationIds: number;
  readonly duplicateFallbackEvaluationIdValues: readonly string[];
  /** evaluationId mismatch between a ledger row and its classification counterpart (joined by candidateKey). */
  readonly identityMismatches: number;
  readonly identityMismatchDetails: ReadonlyArray<{ candidateKey: string; ledgerEvaluationId: string; classificationEvaluationId: string }>;
  /**
   * timestampClass/geometryClass/combinedClass mismatches: stored-vs-stored (ledger vs classification
   * CSV, now split into 3 separate component categories per TICKET-G6R-CP3HR3 Task 3) PLUS
   * stored-vs-independently-recomputed-from-raw-data.
   */
  readonly classificationMismatches: number;
  readonly classificationMismatchDetails: {
    readonly storedVsStored: ReadonlyArray<{ candidateKey: string; ledgerCombinedClass: string; classificationCombinedClass: string }>;
    readonly storedVsRecomputed: readonly RecomputedClassMismatch[];
  };
  /** TICKET-G6R-CP3HR3 Task 3: component-level stored-vs-stored mismatch counts/details, distinct from combinedClassMismatch(es) — each fails the gate on its own even if combinedClass still agrees. */
  readonly timestampClassMismatches: number;
  readonly timestampClassMismatchDetails: ReadonlyArray<{ candidateKey: string; ledgerTimestampClass: string; classificationTimestampClass: string }>;
  readonly geometryClassMismatches: number;
  readonly geometryClassMismatchDetails: ReadonlyArray<{ candidateKey: string; ledgerGeometryClass: string; classificationGeometryClass: string }>;
  /** Invalid/unrecognized setupType values (not one of OB|FVG|SWEEP). */
  readonly invalidSetupTypeCount: number;
  readonly invalidSetupTypeValues: readonly string[];

  readonly duplicateCandidateKeys: readonly string[]; // kept for backward output-shape compatibility: alias of duplicateFallbackCandidateKeyValues
  readonly fallbackDuplicateCandidateKeyCount: number; // kept for backward output-shape compatibility: alias of duplicateFallbackCandidateKeys
  readonly missingJoinsCount: number;
  readonly ledgerRowsMissingClassificationCount: number;
  readonly classificationRowsMissingLedgerCount: number;
  readonly combinedClassMismatchCount: number;
  readonly combinedClassMismatches: ReadonlyArray<{ candidateKey: string; ledgerCombinedClass: string; classificationCombinedClass: string }>;

  readonly countsReconcile: boolean;
  readonly reconciles: boolean; // alias of countsReconcile, kept for backward output-shape compatibility
  readonly joinsClean: boolean;
  readonly reconciliationPass: boolean;
}

/**
 * Computes ALL Task-1 required numbers from already-parsed rows. Pure — no I/O. The fallback
 * population is derived exclusively via `filterFallbackRows()` (FVG|SWEEP only), so an OB row can
 * never leak into any fallback-scoped count here — that guarantee is also independently proven by
 * a dedicated test asserting OB never appears in `fallbackCombinedBreakdown`'s row source.
 *
 * TICKET-G6R-CP3HR2 Task 1 (fail-closed hardening): every duplicate/conflict/identity/recompute
 * defect category the ticket lists is computed and reported here, and NONE of them silently overwrite
 * a prior value on a key collision — every lookup map used below is built ONLY after a dedicated
 * duplicate-detection pass over the same key, so a duplicate can never be masked by "last write wins".
 */
export function computeFallbackReconciliation(ledgerRows: readonly ForensicTelemetryRow[], classificationRows: readonly ClassificationCsvRow[]): FallbackReconciliationResult {
  const totalLedgerRows = ledgerRows.length;
  const fallbackRows = filterFallbackRows(ledgerRows);
  const fvgCount = fallbackRows.filter((r) => r.setupType === 'FVG').length;
  const sweepCount = fallbackRows.filter((r) => r.setupType === 'SWEEP').length;

  // ---- invalid/unknown setupType values (rows that are neither OB, nor FVG/SWEEP-fallback) ----
  const invalidSetupTypeRows = ledgerRows.filter((r) => !isKnownSetupType(r.setupType as string));
  const invalidSetupTypeValues = invalidSetupTypeRows.map((r) => String(r.setupType));
  const invalidSetupTypeCount = invalidSetupTypeRows.length;
  // Strict OB count — deliberately excludes invalid/unknown setupType rows (those are reported
  // separately above), so `setupTypeCounts.OB` never silently absorbs a defect into a "normal" bucket.
  const obRows = ledgerRows.filter((r) => r.setupType === 'OB');

  const setupTypeCounts: Record<ForensicSetupType, number> = { OB: obRows.length, FVG: fvgCount, SWEEP: sweepCount };

  const fallbackCombinedBreakdown: Record<CombinedClass, number> = { CLEAN: 0, TIMESTAMP_ONLY: 0, GEOMETRY_ONLY: 0, BOTH: 0 };
  let fallbackTimestampInvalidCount = 0;
  let fallbackGeometryInvalidCount = 0;
  for (const r of fallbackRows) {
    fallbackCombinedBreakdown[r.combinedClass]++;
    if (r.timestampClass !== 'CLEAN') fallbackTimestampInvalidCount++;
    if (r.geometryClass !== 'CLEAN') fallbackGeometryInvalidCount++;
  }
  const fallbackCombinedSum = fallbackCombinedBreakdown.CLEAN + fallbackCombinedBreakdown.TIMESTAMP_ONLY + fallbackCombinedBreakdown.GEOMETRY_ONLY + fallbackCombinedBreakdown.BOTH;

  // ---- duplicate candidateKey: FULL ledger population ----
  const ledgerDup = findDuplicateKeys(ledgerRows, (r) => r.candidateKey);
  // ---- duplicate candidateKey: fallback-only subset ----
  const fallbackDup = findDuplicateKeys(fallbackRows, (r) => r.candidateKey);
  // ---- duplicate candidateKey: classification CSV (regardless of value agreement — a duplicate KEY is
  //      always an evidence-integrity defect, per ticket Task 2 test #3) ----
  const classificationDup = findDuplicateKeys(classificationRows, (c) => c.candidateKey);
  // ---- duplicate evaluationId within the fallback population specifically (">1 actionable FVG/SWEEP
  //      candidate for one evaluation" — should be 0 in valid data) ----
  const fallbackEvalDup = findDuplicateKeys(fallbackRows, (r) => r.evaluationId);

  // Joins are computed over the FULL ledger (OB + fallback) against the full classification file,
  // since the classification CSV itself covers all 209 rows, not just the fallback population — the
  // ticket's "missing ledger<->classification joins" count is a whole-file data-integrity check.
  const join = joinLedgerAndClassification(ledgerRows, classificationRows);
  const missingJoinsCount = join.ledgerRowsMissingClassification.length + join.classificationRowsMissingLedger.length;
  const joinsClean = missingJoinsCount === 0;

  const recomputedMismatches = recomputeAndCompareClassification(ledgerRows);
  // TICKET-G6R-CP3HR3 Task 3: timestampClassMismatches/geometryClassMismatches are now folded into the
  // classificationMismatches total ALONGSIDE combinedClassMismatches (not instead of it) — any one of
  // the three component/combined mismatch categories alone fails the gate.
  const classificationMismatches = join.combinedClassMismatches.length + join.timestampClassMismatches.length + join.geometryClassMismatches.length + recomputedMismatches.length;

  // countsReconcile: (a) the fallback combined-class breakdown sums back to the fallback total, (b)
  // OB + fallback rows account for the WHOLE ledger population, and (c) zero invalid/unknown
  // setupType values exist (an invalid setupType would otherwise be neither OB nor fallback and would
  // silently NOT show up in (b) as a defect, since (b) only proves OB+fallback don't double count —
  // it does not by itself prove there's no third, unclassified bucket of rows).
  const countsReconcile = fallbackCombinedSum === fallbackRows.length && obRows.length + fallbackRows.length === totalLedgerRows - invalidSetupTypeCount && invalidSetupTypeCount === 0;

  const reconciliationPass =
    countsReconcile &&
    joinsClean &&
    ledgerDup.duplicateCount === 0 &&
    fallbackDup.duplicateCount === 0 &&
    classificationDup.duplicateCount === 0 &&
    fallbackEvalDup.duplicateCount === 0 &&
    join.identityMismatches.length === 0 &&
    classificationMismatches === 0 &&
    // TICKET-G6R-CP3HR3 Task 3: explicit, redundant-with-classificationMismatches AND-terms for the two
    // new component categories — so the gate's failure reason is legible on its own (not only reachable
    // by inspecting the aggregate classificationMismatches sum), and so this AND-chain remains correct
    // even if a future edit changes how classificationMismatches is aggregated.
    join.timestampClassMismatches.length === 0 &&
    join.geometryClassMismatches.length === 0;

  return {
    totalLedgerRows,
    obDiagnosticRowCount: obRows.length,
    fallbackRowCount: fallbackRows.length,
    fvgCount,
    sweepCount,
    setupTypeCounts,
    fallbackCombinedBreakdown,
    fallbackCombinedSum,
    fallbackTimestampInvalidCount,
    fallbackGeometryInvalidCount,

    duplicateLedgerCandidateKeys: ledgerDup.duplicateCount,
    duplicateLedgerCandidateKeyValues: ledgerDup.duplicateKeys,
    duplicateFallbackCandidateKeys: fallbackDup.duplicateCount,
    duplicateFallbackCandidateKeyValues: fallbackDup.duplicateKeys,
    duplicateClassificationCandidateKeys: classificationDup.duplicateCount,
    duplicateClassificationCandidateKeyValues: classificationDup.duplicateKeys,
    duplicateFallbackEvaluationIds: fallbackEvalDup.duplicateCount,
    duplicateFallbackEvaluationIdValues: fallbackEvalDup.duplicateKeys,
    identityMismatches: join.identityMismatches.length,
    identityMismatchDetails: join.identityMismatches,
    classificationMismatches,
    classificationMismatchDetails: { storedVsStored: join.combinedClassMismatches, storedVsRecomputed: recomputedMismatches },
    timestampClassMismatches: join.timestampClassMismatches.length,
    timestampClassMismatchDetails: join.timestampClassMismatches,
    geometryClassMismatches: join.geometryClassMismatches.length,
    geometryClassMismatchDetails: join.geometryClassMismatches,
    invalidSetupTypeCount,
    invalidSetupTypeValues,

    duplicateCandidateKeys: fallbackDup.duplicateKeys,
    fallbackDuplicateCandidateKeyCount: fallbackDup.duplicateCount,
    missingJoinsCount,
    ledgerRowsMissingClassificationCount: join.ledgerRowsMissingClassification.length,
    classificationRowsMissingLedgerCount: join.classificationRowsMissingLedger.length,
    combinedClassMismatchCount: join.combinedClassMismatches.length,
    combinedClassMismatches: join.combinedClassMismatches,

    countsReconcile,
    reconciles: countsReconcile,
    joinsClean,
    reconciliationPass,
  };
}

// ============================== Derived-only telemetry (Task 4) ==============================

export interface DerivedSlBufferAtrMultiplierResult {
  readonly candidateKey: string;
  /** bufferAmount / atr, per the derivation formula documented in the ticket. null when atr is 0 or non-finite (division undefined). */
  readonly slBufferAtrMultiplierDerived: number | null;
  readonly formula: 'bufferAmount / atr';
}

/**
 * Task 4: `slBufferAtrMultiplier` is NOT a persisted ledger column, but IS deterministically
 * derivable offline from `bufferAmount` and `atr`, both of which ARE persisted. Computed here only
 * — never written back into the immutable ledger CSV.
 */
export function deriveSlBufferAtrMultiplier(rows: readonly ForensicTelemetryRow[]): DerivedSlBufferAtrMultiplierResult[] {
  return rows.map((r) => {
    const value = Number.isFinite(r.atr) && r.atr !== 0 && Number.isFinite(r.bufferAmount) ? r.bufferAmount / r.atr : null;
    return { candidateKey: r.candidateKey, slBufferAtrMultiplierDerived: value, formula: 'bufferAmount / atr' as const };
  });
}

// ============================== CLI entry point (I/O; not exercised by tests importing the pure functions above) ==============================

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export interface ReconciliationArtifact {
  readonly ticket: string;
  readonly createdAtUtc: string;
  readonly sourceCsvPaths: { readonly ledger: string; readonly classification: string };
  readonly sourceCsvSha256: { readonly ledger: string; readonly classification: string };
  readonly joinKey: 'candidateKey';
  readonly result: FallbackReconciliationResult;
  readonly derivedSlBufferAtrMultiplierSampleCount: number;
  readonly status: 'CORRECTION_VALID' | 'CORRECTION_INVALID';
  readonly toolSourceSha256: string;
}

export function buildReconciliationArtifact(opts: {
  readonly ledgerCsvPath: string;
  readonly classificationCsvPath: string;
  readonly ledgerCsvText: string;
  readonly classificationCsvText: string;
  readonly toolSourceSha256: string;
  readonly nowUtcIso: string;
}): ReconciliationArtifact {
  const ledgerRows = parseForensicLedgerCsv(opts.ledgerCsvText);
  const classificationRows = parseClassificationCsv(opts.classificationCsvText);
  const result = computeFallbackReconciliation(ledgerRows, classificationRows);
  const derived = deriveSlBufferAtrMultiplier(filterFallbackRows(ledgerRows));

  return {
    ticket: 'TICKET-G6R-CP3HR',
    createdAtUtc: opts.nowUtcIso,
    sourceCsvPaths: { ledger: opts.ledgerCsvPath, classification: opts.classificationCsvPath },
    sourceCsvSha256: { ledger: sha256Text(opts.ledgerCsvText), classification: sha256Text(opts.classificationCsvText) },
    joinKey: 'candidateKey',
    result,
    derivedSlBufferAtrMultiplierSampleCount: derived.length,
    status: result.reconciliationPass ? 'CORRECTION_VALID' : 'CORRECTION_INVALID',
    toolSourceSha256: opts.toolSourceSha256,
  };
}

async function main(): Promise<void> {
  const REPO_ROOT = process.cwd();
  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const classificationCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');
  const outPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3hr-fallback-reconciliation.json');
  const thisFilePath = path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3hrFallbackReconciliation.ts');

  const ledgerCsvText = readFileSync(ledgerCsvPath, 'utf8');
  const classificationCsvText = readFileSync(classificationCsvPath, 'utf8');
  const toolSourceSha256 = sha256File(thisFilePath);
  const nowUtcIso = new Date().toISOString();

  const artifact = buildReconciliationArtifact({
    ledgerCsvPath: 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv',
    classificationCsvPath: 'data/g6r-runs/g6r-cp3h-classification.csv',
    ledgerCsvText,
    classificationCsvText,
    toolSourceSha256,
    nowUtcIso,
  });

  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({ status: artifact.status, result: artifact.result }, null, 2));
}

// Guarded so importing this module (e.g. from a test) NEVER triggers file I/O or process.exit —
// only running it directly (`node g6rCp3hrFallbackReconciliation.js`) does.
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
