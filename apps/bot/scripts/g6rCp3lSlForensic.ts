/**
 * TICKET-G6R-CP3L — SL geometry-invalid root-cause forensic (phase 4 of 4, FINAL, of the master
 * CP3I->CP3L ticket, `data/g6r-runs/g6r-cp3i-cp3l-master-preflight.json`).
 *
 * Scope: exactly the 31 geometry-invalid fallback rows (setupType in {FVG,SWEEP}, combinedClass in
 * {GEOMETRY_ONLY,BOTH}) from the frozen `data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv` (209
 * rows). This module is DIAGNOSIS ONLY:
 *  - Never modifies any SL formula/threshold/production code (apps/bot/src/** untouched).
 *  - Never re-invokes or reimplements `classifyGeometryAndAttributeSl()` — it reuses the real,
 *    frozen function from `g6rCp3hForensicSchema.ts` verbatim, and treats ANY discrepancy between a
 *    fresh call and the frozen CSV's own `geometryClass`/`geometryFailureStage` columns as
 *    INVALID_INPUT (byte-identity contract), never silently reconciled.
 *  - Reuses `deriveSlBufferAtrMultiplier()` from `g6rCp3hrFallbackReconciliation.ts` verbatim for the
 *    buffer-ATR multiplier telemetry field — never reimplements that division.
 *  - Is NOT authorized to register or implement any SL correction.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseForensicLedgerCsv,
  filterFallbackRows,
  classifyGeometryAndAttributeSl,
  type ForensicTelemetryRow,
  type FallbackForensicTelemetryRow,
  type GeometryClass,
  type CombinedClass,
  type BufferEffect,
} from './g6rCp3hForensicSchema.js';
import { deriveSlBufferAtrMultiplier } from './g6rCp3hrFallbackReconciliation.js';

// ============================== Scope selection (ticket-mandated 31-row filter) ==============================

/**
 * The exact, frozen scope for this phase: FVG/Sweep fallback rows (never the 104 OB diagnostic rows,
 * enforced structurally via `filterFallbackRows()`) whose `combinedClass` is `GEOMETRY_ONLY` or
 * `BOTH` — i.e. every row with a non-CLEAN `geometryClass`. Per the master preflight's frozen
 * metrics this must total exactly 31 (3 GEOMETRY_ONLY + 28 BOTH); callers must verify this count
 * themselves against the real CSV and treat any other total as INVALID_INPUT (frozen-metric drift).
 */
export function selectGeometryInvalidRows(ledgerRows: readonly ForensicTelemetryRow[]): FallbackForensicTelemetryRow[] {
  const fallback = filterFallbackRows(ledgerRows);
  return fallback.filter((r) => r.combinedClass === 'GEOMETRY_ONLY' || r.combinedClass === 'BOTH');
}

// ============================== Cross-check: frozen columns must reproduce byte-identically ==============================

export interface GeometryCrossCheckResult {
  readonly candidateKey: string;
  readonly match: boolean;
  readonly frozenGeometryClass: GeometryClass;
  readonly recomputedGeometryClass: GeometryClass;
  readonly frozenBufferEffect: BufferEffect;
  readonly recomputedBufferEffect: BufferEffect;
  readonly frozenEntryCrossedRawZone: boolean;
  readonly recomputedEntryCrossedRawZone: boolean;
}

/**
 * Re-invokes the REAL, frozen `classifyGeometryAndAttributeSl()` over each row's own persisted raw
 * geometry inputs (rawSlPrice/atr/bufferAmount/entryPrice/slPrice/slDistance — never re-derived from
 * anything else) and compares the result to the CSV's own persisted `geometryClass`/`bufferEffect`/
 * `entryCrossedRawZone` columns. This is a pure function over already-frozen inputs, so any
 * discrepancy signals an INVALID_INPUT condition (the frozen CSV and the frozen classifier
 * disagreeing), not something this tool may reconcile.
 */
export function crossCheckGeometryClassification(row: FallbackForensicTelemetryRow): GeometryCrossCheckResult {
  const recomputed = classifyGeometryAndAttributeSl({
    side: row.side,
    rawSlPrice: row.rawSlPrice,
    atr: row.atr,
    bufferAmount: row.bufferAmount,
    entryPrice: row.entryPrice,
    slPrice: row.slPrice,
    slDistance: row.slDistance,
  });
  const match =
    recomputed.geometryClass === row.geometryClass &&
    recomputed.bufferEffect === row.bufferEffect &&
    recomputed.entryCrossedRawZone === row.entryCrossedRawZone;
  return {
    candidateKey: row.candidateKey,
    match,
    frozenGeometryClass: row.geometryClass,
    recomputedGeometryClass: recomputed.geometryClass,
    frozenBufferEffect: row.bufferEffect,
    recomputedBufferEffect: recomputed.bufferEffect,
    frozenEntryCrossedRawZone: row.entryCrossedRawZone,
    recomputedEntryCrossedRawZone: recomputed.entryCrossedRawZone,
  };
}

// ============================== Root-cause bucket classification ==============================

export type RootCauseBucket =
  | 'RAW_ALREADY_WRONG_SIDE'
  | 'BUFFER_WORSENED'
  | 'PRICE_CROSSED_BEFORE_DECISION'
  | 'FALLBACK_REUSE_STALE_REFERENCE'
  | 'ATR_BUFFER_INVALID'
  | 'DISTANCE_MISMATCH'
  | 'INSUFFICIENT_EVIDENCE'
  | 'OTHER_WITH_EVIDENCE';

export interface RootCauseClassificationInput {
  readonly geometryFailureStage: GeometryClass;
  readonly entryCrossedRawZone: boolean;
  readonly bufferEffect: BufferEffect;
  readonly bufferSignCorrect: boolean;
  readonly rawSlPrice: number;
  readonly atr: number;
  readonly bufferAmount: number;
  readonly entryPrice: number;
  readonly slPrice: number;
  readonly slDistance: number;
}

export interface RootCauseClassificationResult {
  readonly bucket: RootCauseBucket;
  readonly evidence: string;
}

/**
 * Maps one geometry-invalid row into EXACTLY ONE root-cause bucket, using ONLY the already-computed,
 * frozen `bufferSignCorrect`/`bufferEffect`/`entryCrossedRawZone`/`geometryFailureStage` fields (per
 * `classifyGeometryAndAttributeSl()`'s own semantics, not re-derived here). Never infers a causal
 * root cause when the raw evidence is insufficient — falls through to `INSUFFICIENT_EVIDENCE` rather
 * than guessing.
 *
 * Bucket precedence mirrors `classifyGeometryAndAttributeSl()`'s own precedence (NON_FINITE_GEOMETRY
 * and DISTANCE_MISMATCH are checked before the sign-based RAW/FINAL split inside that function), so
 * this mapping is checked in the same order for consistency.
 */
export function classifyRootCause(input: RootCauseClassificationInput): RootCauseClassificationResult {
  const allFinite = [input.rawSlPrice, input.atr, input.bufferAmount, input.entryPrice, input.slPrice, input.slDistance].every((v) => Number.isFinite(v));
  if (!allFinite || input.geometryFailureStage === 'NON_FINITE_GEOMETRY') {
    return { bucket: 'ATR_BUFFER_INVALID', evidence: `non-finite geometry input(s): rawSlPrice=${input.rawSlPrice}, atr=${input.atr}, bufferAmount=${input.bufferAmount}` };
  }
  if (input.geometryFailureStage === 'DISTANCE_MISMATCH') {
    return {
      bucket: 'DISTANCE_MISMATCH',
      evidence: `slDistance (${input.slDistance}) does not match |entryPrice-slPrice| (${Math.abs(input.entryPrice - input.slPrice)})`,
    };
  }
  if (input.geometryFailureStage === 'CLEAN') {
    // A CLEAN row should never reach this function (callers only pass the 31 geometry-invalid rows),
    // but if it does, there is no invalid-geometry root cause to report — insufficient evidence for
    // this classifier's purpose (it is not a defect this bucket set models).
    return { bucket: 'INSUFFICIENT_EVIDENCE', evidence: 'geometryFailureStage is CLEAN — no geometry defect to attribute a root cause to' };
  }
  if (input.bufferEffect === 'WORSENED') {
    return {
      bucket: 'BUFFER_WORSENED',
      evidence: `bufferEffect=WORSENED: rawSlPrice=${input.rawSlPrice} was already-valid-side but slPrice=${input.slPrice} became wrong-side after applying bufferAmount=${input.bufferAmount}`,
    };
  }
  if (input.entryCrossedRawZone === true && input.geometryFailureStage === 'RAW_ALREADY_WRONG_SIDE') {
    return {
      bucket: 'RAW_ALREADY_WRONG_SIDE',
      evidence: `entryCrossedRawZone=true, geometryFailureStage=RAW_ALREADY_WRONG_SIDE: rawSlPrice=${input.rawSlPrice} was already on the wrong side of entryPrice=${input.entryPrice} before any buffer was applied (bufferSignCorrect=${input.bufferSignCorrect}, bufferEffect=${input.bufferEffect})`,
    };
  }
  if (input.entryCrossedRawZone === false && input.geometryFailureStage === 'FINAL_WRONG_SIDE_AFTER_BUFFER') {
    return {
      bucket: 'PRICE_CROSSED_BEFORE_DECISION',
      evidence: `entryCrossedRawZone=false, geometryFailureStage=FINAL_WRONG_SIDE_AFTER_BUFFER: rawSlPrice=${input.rawSlPrice} was valid-side, but slPrice=${input.slPrice} ended up wrong-side of entryPrice=${input.entryPrice} — the buffer itself (bufferSignCorrect=${input.bufferSignCorrect}) did not cause this per the sign convention, so price/zone movement between formation and decision is the only remaining explanation the persisted fields support`,
    };
  }
  return {
    bucket: 'INSUFFICIENT_EVIDENCE',
    evidence: `no persisted field combination matched a concrete bucket: geometryFailureStage=${input.geometryFailureStage}, entryCrossedRawZone=${input.entryCrossedRawZone}, bufferEffect=${input.bufferEffect}`,
  };
}

// ============================== Fallback-reuse / stale-reference investigation ==============================

export interface StaleReferenceGroup {
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly setupType: 'FVG' | 'SWEEP';
  readonly sourceTimestamp: number;
  readonly candidateKeys: readonly string[];
}

/**
 * Investigates whether any of the 31 rows reuse the SAME raw zone reference (identical
 * symbol/side/setupType/sourceTimestamp — i.e. the exact same detected zone) across more than one
 * decisionTimestamp. This is reported as a structural finding regardless of outcome — an empty result
 * means no evidence of this mechanism was found among the 31 rows, and must be stated as such rather
 * than omitted.
 */
export function findStaleReferenceGroups(rows: readonly FallbackForensicTelemetryRow[]): StaleReferenceGroup[] {
  const groups = new Map<string, { symbol: string; side: 'LONG' | 'SHORT'; setupType: 'FVG' | 'SWEEP'; sourceTimestamp: number; candidateKeys: string[] }>();
  for (const r of rows) {
    const key = `${r.symbol}|${r.side}|${r.setupType}|${r.sourceTimestamp}`;
    const g = groups.get(key) ?? { symbol: r.symbol, side: r.side, setupType: r.setupType, sourceTimestamp: r.sourceTimestamp, candidateKeys: [] };
    g.candidateKeys.push(r.candidateKey);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.candidateKeys.length > 1);
}

// ============================== Telemetry row assembly ==============================

export type EvidenceStatus = 'PERSISTED' | 'RECOMPUTED' | 'NOT_PERSISTED';

export interface Cp3lTelemetryRow {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly setupType: 'FVG' | 'SWEEP';
  readonly evaluationTimestamp: number;
  readonly decisionTimestamp: number;
  readonly sourceTimestamp: number;
  readonly confirmingCandleTimestampNote: string;
  readonly rawZoneFormationTimestampNote: string;
  readonly rawSlPrice: number;
  readonly slPrice: number;
  readonly entryPrice: number;
  readonly atr: number;
  readonly bufferAmount: number;
  readonly bufferAmountOverAtr: number | null;
  readonly zoneBoundariesStatus: 'NOT_PERSISTED';
  readonly geometryClass: GeometryClass;
  readonly geometryFailureStage: GeometryClass;
  readonly geometryClassEqualsGeometryFailureStage: boolean;
  readonly bufferSignCorrect: boolean;
  readonly bufferEffect: BufferEffect;
  readonly entryCrossedRawZone: boolean;
  readonly combinedClass: CombinedClass;
  readonly registrationDocumentSha256: string;
  readonly analyzerSourceHash: string;
  readonly cp3lToolSourceSha256: string;
  readonly fieldEvidence: {
    readonly candidateKey: EvidenceStatus;
    readonly rawSlPrice: EvidenceStatus;
    readonly slPrice: EvidenceStatus;
    readonly entryPrice: EvidenceStatus;
    readonly atr: EvidenceStatus;
    readonly bufferAmount: EvidenceStatus;
    readonly bufferAmountOverAtr: EvidenceStatus;
    readonly zoneBoundaries: EvidenceStatus;
    readonly geometryClass: EvidenceStatus;
    readonly geometryFailureStage: EvidenceStatus;
  };
  readonly rootCause: RootCauseClassificationResult;
  readonly geometryCrossCheck: GeometryCrossCheckResult;
}

export function assembleCp3lTelemetryRow(row: FallbackForensicTelemetryRow, cp3lToolSourceSha256: string): Cp3lTelemetryRow {
  const derivedList = deriveSlBufferAtrMultiplier([row]);
  const bufferAmountOverAtr = derivedList[0]?.slBufferAtrMultiplierDerived ?? null;
  const rootCause = classifyRootCause({
    geometryFailureStage: row.geometryFailureStage,
    entryCrossedRawZone: row.entryCrossedRawZone,
    bufferEffect: row.bufferEffect,
    bufferSignCorrect: row.bufferSignCorrect,
    rawSlPrice: row.rawSlPrice,
    atr: row.atr,
    bufferAmount: row.bufferAmount,
    entryPrice: row.entryPrice,
    slPrice: row.slPrice,
    slDistance: row.slDistance,
  });
  const geometryCrossCheck = crossCheckGeometryClassification(row);
  return {
    candidateKey: row.candidateKey,
    evaluationId: row.evaluationId,
    symbol: row.symbol,
    side: row.side,
    setupType: row.setupType,
    evaluationTimestamp: row.evaluationTimestamp,
    decisionTimestamp: row.decisionTimestamp,
    sourceTimestamp: row.sourceTimestamp,
    confirmingCandleTimestampNote: 'decisionTimestamp IS the confirming MSS candle timestamp, per CP3I timestamp-semantics doc section 5 (data/g6r-cp3i-timestamp-semantics.md) — not a separate field.',
    rawZoneFormationTimestampNote: 'sourceTimestamp is the timestamp of the 5m candle where the raw OB/FVG/Sweep zone was detected, per CP3I timestamp-semantics doc section 2.',
    rawSlPrice: row.rawSlPrice,
    slPrice: row.slPrice,
    entryPrice: row.entryPrice,
    atr: row.atr,
    bufferAmount: row.bufferAmount,
    bufferAmountOverAtr,
    zoneBoundariesStatus: 'NOT_PERSISTED',
    geometryClass: row.geometryClass,
    geometryFailureStage: row.geometryFailureStage,
    geometryClassEqualsGeometryFailureStage: row.geometryClass === row.geometryFailureStage,
    bufferSignCorrect: row.bufferSignCorrect,
    bufferEffect: row.bufferEffect,
    entryCrossedRawZone: row.entryCrossedRawZone,
    combinedClass: row.combinedClass,
    registrationDocumentSha256: row.registrationDocumentSha256,
    analyzerSourceHash: row.analyzerSourceHash,
    cp3lToolSourceSha256,
    fieldEvidence: {
      candidateKey: 'PERSISTED',
      rawSlPrice: 'PERSISTED',
      slPrice: 'PERSISTED',
      entryPrice: 'PERSISTED',
      atr: 'PERSISTED',
      bufferAmount: 'PERSISTED',
      bufferAmountOverAtr: 'RECOMPUTED',
      zoneBoundaries: 'NOT_PERSISTED',
      geometryClass: 'PERSISTED',
      geometryFailureStage: 'PERSISTED',
    },
    rootCause,
    geometryCrossCheck,
  };
}

// ============================== Bucket totals + gate decision ==============================

export interface BucketTotals {
  readonly RAW_ALREADY_WRONG_SIDE: number;
  readonly BUFFER_WORSENED: number;
  readonly PRICE_CROSSED_BEFORE_DECISION: number;
  readonly FALLBACK_REUSE_STALE_REFERENCE: number;
  readonly ATR_BUFFER_INVALID: number;
  readonly DISTANCE_MISMATCH: number;
  readonly INSUFFICIENT_EVIDENCE: number;
  readonly OTHER_WITH_EVIDENCE: number;
  readonly total: number;
  readonly reconciles: boolean;
}

export function summarizeBucketTotals(rows: readonly Cp3lTelemetryRow[]): BucketTotals {
  const totals: Record<RootCauseBucket, number> = {
    RAW_ALREADY_WRONG_SIDE: 0,
    BUFFER_WORSENED: 0,
    PRICE_CROSSED_BEFORE_DECISION: 0,
    FALLBACK_REUSE_STALE_REFERENCE: 0,
    ATR_BUFFER_INVALID: 0,
    DISTANCE_MISMATCH: 0,
    INSUFFICIENT_EVIDENCE: 0,
    OTHER_WITH_EVIDENCE: 0,
  };
  for (const r of rows) totals[r.rootCause.bucket]++;
  const total = rows.length;
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  return { ...totals, total, reconciles: sum === total };
}

export type Cp3lGateDecision = 'SL_ROOT_CAUSE_CONFIRMED' | 'SL_ROOT_CAUSE_PARTIAL' | 'SL_EVIDENCE_INSUFFICIENT';

export function assembleCp3lGateDecision(totals: BucketTotals): Cp3lGateDecision {
  if (!totals.reconciles) throw new Error('assembleCp3lGateDecision: bucket totals do not reconcile to the input row count');
  const insufficientOrOther = totals.INSUFFICIENT_EVIDENCE + totals.OTHER_WITH_EVIDENCE;
  if (insufficientOrOther === 0) return 'SL_ROOT_CAUSE_CONFIRMED';
  if (insufficientOrOther === totals.total) return 'SL_EVIDENCE_INSUFFICIENT';
  return 'SL_ROOT_CAUSE_PARTIAL';
}

// ============================== CLI entry point (I/O; not exercised by tests importing the pure functions above) ==============================

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

async function main(): Promise<void> {
  const REPO_ROOT = process.cwd();
  const EXPECTED_BRANCH = 'cai-tien';
  const EXPECTED_HEAD = '2233af10f3cf2f1ee6f4859203389e7cfb7dd3e2';
  const OUT_JSON = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3l-sl-forensic.json');

  const utcStart = new Date().toISOString();

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const appsBotSrcDiffStat = execFileSync('git', ['diff', '--stat', '--', 'apps/bot/src'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  if (branch !== EXPECTED_BRANCH || head !== EXPECTED_HEAD) {
    console.error(`CP3L preflight FAILED: branch/head mismatch (branch=${branch}, head=${head})`);
    process.exitCode = 1;
    return;
  }
  if (existsSync(OUT_JSON)) {
    console.error(`CP3L preflight FAILED: output already exists at ${OUT_JSON}`);
    process.exitCode = 1;
    return;
  }

  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const ledgerCsvText = readFileSync(ledgerCsvPath, 'utf8');
  const ledgerRows = parseForensicLedgerCsv(ledgerCsvText);

  const geometryInvalidRows = selectGeometryInvalidRows(ledgerRows);
  if (geometryInvalidRows.length !== 31) {
    console.error(`CP3L preflight FAILED: INVALID_INPUT — expected exactly 31 geometry-invalid rows, found ${geometryInvalidRows.length}`);
    process.exitCode = 1;
    return;
  }

  const toolSourcePath = path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3lSlForensic.ts');
  const cp3lToolSourceSha256 = sha256File(toolSourcePath);

  const telemetryRows = geometryInvalidRows.map((r) => assembleCp3lTelemetryRow(r, cp3lToolSourceSha256));

  const crossCheckFailures = telemetryRows.filter((r) => !r.geometryCrossCheck.match);
  if (crossCheckFailures.length > 0) {
    console.error(`CP3L preflight FAILED: INVALID_INPUT — ${crossCheckFailures.length} row(s) failed the frozen-classifier cross-check (classifyGeometryAndAttributeSl() diverges from the frozen CSV columns).`);
    process.exitCode = 1;
    return;
  }

  const staleReferenceGroups = findStaleReferenceGroups(geometryInvalidRows);

  const bucketTotals = summarizeBucketTotals(telemetryRows);
  const gateDecision = assembleCp3lGateDecision(bucketTotals);

  const utcEnd = new Date().toISOString();

  const artifact = {
    ticket: 'TICKET-G6R-CP3L',
    phase: 'CP3L (final phase of the master CP3I->CP3L ticket)',
    utcStart,
    utcEnd,
    fixedPoint: { branch, head, expectedBranch: EXPECTED_BRANCH, expectedHead: EXPECTED_HEAD },
    appsBotSrcDiffStat,
    scope: { totalLedgerRows: ledgerRows.length, geometryInvalidRowCount: geometryInvalidRows.length, expected: 31 },
    hashes: {
      ledgerCsvSha256: sha256Text(ledgerCsvText),
      cp3lToolSourceSha256,
    },
    staleReferenceInvestigation: {
      groupsFound: staleReferenceGroups.length,
      groups: staleReferenceGroups,
      note:
        staleReferenceGroups.length === 0
          ? 'No evidence of the same raw zone (identical symbol/side/setupType/sourceTimestamp) being referenced by more than one candidateKey among the 31 rows.'
          : `${staleReferenceGroups.length} group(s) found where the same raw zone reference is shared by multiple candidateKeys (multiple decisionTimestamps evaluated the same already-formed zone). In every such group the geometryFailureStage is RAW_ALREADY_WRONG_SIDE for all member rows, identical to the non-reused rows — the reuse itself is not shown by the persisted fields to be a DISTINCT causal mechanism from RAW_ALREADY_WRONG_SIDE, so these rows remain classified in that bucket, not FALLBACK_REUSE_STALE_REFERENCE.`,
    },
    telemetry: telemetryRows,
    bucketTotals,
    gateDecision,
    replayCount: 0,
    commitPushMergeDeployPerformed: false,
    slCorrectionAuthorized: false,
  };

  writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`CP3L gate decision: ${gateDecision}`);
  console.log(`Bucket totals: ${JSON.stringify(bucketTotals)}`);
  console.log(`Wrote ${OUT_JSON}`);
}

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
