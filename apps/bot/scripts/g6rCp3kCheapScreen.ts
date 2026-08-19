/**
 * TICKET-G6R-CP3K — the single authorized cheap-screen execution (phase 3 of 4 of the master
 * CP3I->CP3L ticket, `data/g6r-runs/g6r-cp3i-cp3l-master-preflight.json`).
 *
 * Applies CP3J's registered candidate (`T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE`,
 * `decisionAvailableAt := decisionTimestamp + ONE_MINUTE_MS`) to the frozen
 * `data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv` / `g6r-cp3h-classification.csv` and computes
 * every metric the master ticket's CP3K gate requires, then applies the gate verbatim.
 *
 * ABSOLUTE CONSTRAINTS (same as CP3I/CP3J):
 *  - Pure, offline, deterministic. Never imports/calls/spawns any replay runner
 *    (g6rCp3hForensicReplay.ts, g6rCheckpoint2Replay.ts, g6rCheckpoint3Replay.ts,
 *    ticket150BacktestExecutionRealismAudit.ts's runReplay()).
 *  - Reuses CP3J's own already-tested `recomputeRowUnderCandidate()` for the
 *    decisionAvailableAt/timestampClass recomputation — never reimplements that formula.
 *  - Reuses `g6rCp3hForensicSchema.ts`'s real `classifyGeometryAndAttributeSl()`/
 *    `combineClassification()` for the geometry/combined axes — never reimplements those either.
 *  - Reuses `g6rCp3hrFallbackReconciliation.ts`'s real `computeFallbackReconciliation()` for the
 *    join/duplicate/identity-mismatch counts — never reimplements that logic.
 *  - Never edits any existing frozen file. Never touches apps/bot/src/**.
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
  combineClassification,
  validateForensicLedgerStrict,
  type ForensicTelemetryRow,
  type FallbackForensicTelemetryRow,
  type TimestampClass,
  type GeometryClass,
  type CombinedClass,
} from './g6rCp3hForensicSchema.js';
import { parseClassificationCsv, computeFallbackReconciliation, type ClassificationCsvRow } from './g6rCp3hrFallbackReconciliation.js';
import { recomputeRowUnderCandidate, CP3J_CANDIDATE_ID } from './g6rCp3jCandidateRegistration.js';

export { CP3J_CANDIDATE_ID };

// ============================== Per-row before/after recomputation ==============================

export interface Cp3kPerRowResult {
  readonly candidateKey: string;
  readonly evaluationId: string;
  readonly setupType: 'FVG' | 'SWEEP';
  readonly originalTimestampClass: TimestampClass;
  readonly recomputedTimestampClass: TimestampClass;
  readonly originalGeometryClass: GeometryClass;
  readonly recomputedGeometryClass: GeometryClass;
  readonly originalCombinedClass: CombinedClass;
  readonly recomputedCombinedClass: CombinedClass;
  readonly originalDecisionAvailableAt: number;
  readonly correctedDecisionAvailableAt: number;
  readonly candidateKeyUnchanged: boolean;
  readonly evaluationIdUnchanged: boolean;
}

/**
 * Applies the T3 candidate to one fallback row. Reuses CP3J's own `recomputeRowUnderCandidate()`
 * for the decisionAvailableAt/timestampClass axis (never reimplemented). Geometry is independently
 * recomputed via the real, frozen `classifyGeometryAndAttributeSl()` from the row's own raw geometry
 * fields — the candidate does not touch any geometry input, so this is expected to reproduce the
 * row's existing geometryClass, verified rather than assumed.
 */
export function recomputeFallbackRowUnderScreen(row: FallbackForensicTelemetryRow): Cp3kPerRowResult {
  const cp3j = recomputeRowUnderCandidate(row);
  const geometry = classifyGeometryAndAttributeSl({
    side: row.side,
    rawSlPrice: row.rawSlPrice,
    atr: row.atr,
    bufferAmount: row.bufferAmount,
    entryPrice: row.entryPrice,
    slPrice: row.slPrice,
    slDistance: row.slDistance,
  });
  const recomputedCombinedClass = combineClassification(cp3j.recomputedTimestampClass, geometry.geometryClass);
  return {
    candidateKey: row.candidateKey,
    evaluationId: row.evaluationId,
    setupType: row.setupType,
    originalTimestampClass: row.timestampClass,
    recomputedTimestampClass: cp3j.recomputedTimestampClass,
    originalGeometryClass: row.geometryClass,
    recomputedGeometryClass: geometry.geometryClass,
    originalCombinedClass: row.combinedClass,
    recomputedCombinedClass,
    originalDecisionAvailableAt: row.decisionAvailableAt,
    correctedDecisionAvailableAt: cp3j.correctedDecisionAvailableAt,
    candidateKeyUnchanged: cp3j.candidateKey === row.candidateKey,
    evaluationIdUnchanged: cp3j.evaluationId === row.evaluationId,
  };
}

// ============================== Aggregate cheap-screen metrics ==============================

export type SetupTypeCombinedBreakdown = Record<'FVG' | 'SWEEP', Record<CombinedClass, number>>;

function emptyBreakdown(): SetupTypeCombinedBreakdown {
  return {
    FVG: { CLEAN: 0, TIMESTAMP_ONLY: 0, GEOMETRY_ONLY: 0, BOTH: 0 },
    SWEEP: { CLEAN: 0, TIMESTAMP_ONLY: 0, GEOMETRY_ONLY: 0, BOTH: 0 },
  };
}

export interface Cp3kMetrics {
  readonly population: number;
  readonly timestampInvalidBefore: number;
  readonly timestampInvalidAfter: number;
  readonly geometryInvalidBefore: number;
  readonly geometryInvalidAfter: number;
  readonly unclosedBefore: number;
  readonly unclosedAfter: number;
  readonly identityChangedCount: number;
  readonly missingJoins: number;
  readonly duplicateJoins: number;
  readonly ambiguousJoins: number;
  readonly requiredDataFailures: number;
  readonly schemaRuntimeErrors: number;
  readonly outcomeBySetupTypeBefore: SetupTypeCombinedBreakdown;
  readonly outcomeBySetupTypeAfter: SetupTypeCombinedBreakdown;
  readonly perRow: readonly Cp3kPerRowResult[];
}

export function computeCp3kMetrics(ledgerRows: readonly ForensicTelemetryRow[], classificationRows: readonly ClassificationCsvRow[]): Cp3kMetrics {
  const reconciliation = computeFallbackReconciliation(ledgerRows, classificationRows);
  const fallback = filterFallbackRows(ledgerRows);

  let schemaRuntimeErrors = 0;
  const perRow: Cp3kPerRowResult[] = [];
  for (const row of fallback) {
    try {
      perRow.push(recomputeFallbackRowUnderScreen(row));
    } catch {
      schemaRuntimeErrors++;
    }
  }

  const timestampInvalidBefore = fallback.filter((r) => r.timestampClass !== 'CLEAN').length;
  const timestampInvalidAfter = perRow.filter((r) => r.recomputedTimestampClass !== 'CLEAN').length;
  const geometryInvalidBefore = fallback.filter((r) => r.geometryClass !== 'CLEAN').length;
  const geometryInvalidAfter = perRow.filter((r) => r.recomputedGeometryClass !== 'CLEAN').length;
  const unclosedBefore = fallback.filter((r) => r.timestampClass === 'UNCLOSED_INPUT_READ').length;
  const unclosedAfter = perRow.filter((r) => r.recomputedTimestampClass === 'UNCLOSED_INPUT_READ').length;
  const identityChangedCount = perRow.filter((r) => !r.candidateKeyUnchanged || !r.evaluationIdUnchanged).length;

  const strict = validateForensicLedgerStrict(ledgerRows, classificationRows);
  const requiredDataFailures = (strict.violationCountByCategory['MISSING_REQUIRED_FIELD'] ?? 0) + (strict.violationCountByCategory['NON_FINITE_VALUE'] ?? 0);

  // "Missing/duplicate/ambiguous joins" per the master ticket's CP3K gate text, computed exclusively
  // via the real, frozen computeFallbackReconciliation() — never reimplemented here:
  //   missing   = ledger fallback rows with no matching classification row (+ orphan classification rows)
  //   duplicate = duplicate candidateKey within the fallback ledger subset, or within the classification CSV
  //   ambiguous = a joined pair whose identity (evaluationId) disagrees between the two files
  const missingJoins = reconciliation.ledgerRowsMissingClassificationCount + reconciliation.classificationRowsMissingLedgerCount;
  const duplicateJoins = reconciliation.duplicateFallbackCandidateKeys + reconciliation.duplicateClassificationCandidateKeys;
  const ambiguousJoins = reconciliation.identityMismatches;

  const outcomeBySetupTypeBefore = emptyBreakdown();
  const outcomeBySetupTypeAfter = emptyBreakdown();
  for (const r of fallback) outcomeBySetupTypeBefore[r.setupType][r.combinedClass]++;
  for (const r of perRow) outcomeBySetupTypeAfter[r.setupType][r.recomputedCombinedClass]++;

  return {
    population: fallback.length,
    timestampInvalidBefore,
    timestampInvalidAfter,
    geometryInvalidBefore,
    geometryInvalidAfter,
    unclosedBefore,
    unclosedAfter,
    identityChangedCount,
    missingJoins,
    duplicateJoins,
    ambiguousJoins,
    requiredDataFailures,
    schemaRuntimeErrors,
    outcomeBySetupTypeBefore,
    outcomeBySetupTypeAfter,
    perRow,
  };
}

// ============================== Preflight fail-closed checks ==============================

export interface Cp3kHashSet {
  readonly ledgerCsvSha256: string;
  readonly analyzerSourceSha256: string;
  readonly forensicSchemaSourceSha256: string;
  readonly toolSourceSha256: string;
}

export interface Cp3kPreflightOptions {
  readonly branch: string;
  readonly head: string;
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly registeredHashes: Cp3kHashSet;
  readonly currentHashes: Cp3kHashSet;
  readonly outputDirExists: boolean;
}

export interface Cp3kPreflightResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * Every one of these checks must fail CLOSED (report a failure, never silently proceed) when given a
 * bad input — this is the exact function the CP3K test suite exercises with fixture flags per the
 * master ticket's required-tests list.
 */
export function runCp3kPreflightChecks(opts: Cp3kPreflightOptions): Cp3kPreflightResult {
  const failures: string[] = [];
  if (opts.branch !== opts.expectedBranch) failures.push('BRANCH_MISMATCH');
  if (opts.head !== opts.expectedHead) failures.push('HEAD_MISMATCH');
  if (opts.registeredHashes.ledgerCsvSha256 !== opts.currentHashes.ledgerCsvSha256) failures.push('DATASET_HASH_MISMATCH');
  if (opts.registeredHashes.analyzerSourceSha256 !== opts.currentHashes.analyzerSourceSha256) failures.push('REGISTRATION_DRIFT_ANALYZER_SOURCE');
  if (opts.registeredHashes.forensicSchemaSourceSha256 !== opts.currentHashes.forensicSchemaSourceSha256) failures.push('REGISTRATION_DRIFT_FORENSIC_SCHEMA_SOURCE');
  if (opts.registeredHashes.toolSourceSha256 !== opts.currentHashes.toolSourceSha256) failures.push('REGISTRATION_DRIFT_TOOL_SOURCE');
  if (opts.outputDirExists) failures.push('OUTPUT_PATH_ALREADY_EXISTS');
  return { ok: failures.length === 0, failures };
}

// ============================== PASS-gate assembly ==============================

export interface Cp3kGateInputs {
  readonly populationAfter: number;
  readonly baselineParityMatches211: boolean;
  readonly unclosedAfter: number;
  readonly missingDuplicateAmbiguousJoins: number;
  readonly schemaRuntimeErrors: number;
  readonly timestampInvalidBefore: number;
  readonly timestampInvalidAfter: number;
  readonly geometryInvalidBefore: number;
  readonly geometryInvalidAfter: number;
  readonly appsBotSrcDiffEmpty: boolean;
  readonly hashesUnchangedFromCp3jFreeze: boolean;
}

export interface Cp3kGateResult {
  readonly decision: 'SCREEN_PASS' | 'SCREEN_REJECTED';
  readonly failedCriteria: readonly string[];
}

/**
 * Applies the master preflight's `checkpointsAndGates.CP3K.gate` verbatim. Per the master ticket's
 * explicit instruction, "timestamp-invalid decreases" is a REAL requirement — 92 before / 92 after
 * (no decrease) FAILS this criterion, and this function must not treat "no decrease" as trivially
 * satisfying ">= 0". No rescue tuning of this function's own logic is permitted to avoid that result.
 */
export function assembleCp3kGateDecision(g: Cp3kGateInputs): Cp3kGateResult {
  const failed: string[] = [];
  if (g.populationAfter !== 105) failed.push('POPULATION_NOT_105');
  if (!g.baselineParityMatches211) failed.push('BASELINE_PARITY_NOT_211');
  if (g.unclosedAfter !== 0) failed.push('UNCLOSED_FUTURE_READS_NONZERO');
  if (g.missingDuplicateAmbiguousJoins !== 0) failed.push('JOIN_DEFECTS_NONZERO');
  if (g.schemaRuntimeErrors !== 0) failed.push('SCHEMA_RUNTIME_ERRORS_NONZERO');
  if (!(g.timestampInvalidAfter < g.timestampInvalidBefore)) failed.push('TIMESTAMP_INVALID_DID_NOT_DECREASE');
  if (g.geometryInvalidAfter > g.geometryInvalidBefore) failed.push('GEOMETRY_WORSENED');
  if (!g.appsBotSrcDiffEmpty) failed.push('PRODUCTION_BEHAVIOR_CHANGED');
  if (!g.hashesUnchangedFromCp3jFreeze) failed.push('HASH_DRIFT_FROM_CP3J_FREEZE');
  return { decision: failed.length === 0 ? 'SCREEN_PASS' : 'SCREEN_REJECTED', failedCriteria: failed };
}

// ============================== CLI entry point (I/O; not exercised by tests importing the pure functions above) ==============================

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function main(): Promise<void> {
  const REPO_ROOT = process.cwd();
  const EXPECTED_BRANCH = 'cai-tien';
  const EXPECTED_HEAD = '2233af10f3cf2f1ee6f4859203389e7cfb7dd3e2';
  const RUN_ID = '001';
  const OUT_DIR = path.resolve(REPO_ROOT, `data/g6r-runs/g6r-cp3k-run-${RUN_ID}`);

  const utcStart = new Date().toISOString();

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const appsBotSrcDiffStat = execFileSync('git', ['diff', '--stat', '--', 'apps/bot/src'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const registrationArtifactPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3j-registration.json');
  const registrationArtifact = JSON.parse(readFileSync(registrationArtifactPath, 'utf8')) as {
    ledgerCsvSha256: string;
    analyzerSourceSha256: string;
    forensicSchemaSourceSha256: string;
    toolSourceSha256: string;
  };

  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const analyzerSourcePath = path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rShadowAnalyzer.ts');
  const forensicSchemaSourcePath = path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3hForensicSchema.ts');
  const cp3jToolSourcePath = path.resolve(REPO_ROOT, 'apps/bot/scripts/g6rCp3jCandidateRegistration.ts');

  const currentHashes: Cp3kHashSet = {
    ledgerCsvSha256: sha256File(ledgerCsvPath),
    analyzerSourceSha256: sha256File(analyzerSourcePath),
    forensicSchemaSourceSha256: sha256File(forensicSchemaSourcePath),
    toolSourceSha256: sha256File(cp3jToolSourcePath),
  };
  const registeredHashes: Cp3kHashSet = {
    ledgerCsvSha256: registrationArtifact.ledgerCsvSha256,
    analyzerSourceSha256: registrationArtifact.analyzerSourceSha256,
    forensicSchemaSourceSha256: registrationArtifact.forensicSchemaSourceSha256,
    toolSourceSha256: registrationArtifact.toolSourceSha256,
  };

  const preflight = runCp3kPreflightChecks({
    branch,
    head,
    expectedBranch: EXPECTED_BRANCH,
    expectedHead: EXPECTED_HEAD,
    registeredHashes,
    currentHashes,
    outputDirExists: existsSync(OUT_DIR),
  });

  if (!preflight.ok) {
    console.error(`CP3K preflight FAILED: ${preflight.failures.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const ledgerCsvText = readFileSync(ledgerCsvPath, 'utf8');
  const classificationCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');
  const classificationCsvText = readFileSync(classificationCsvPath, 'utf8');
  const ledgerRows = parseForensicLedgerCsv(ledgerCsvText);
  const classificationRows = parseClassificationCsv(classificationCsvText);

  const metrics = computeCp3kMetrics(ledgerRows, classificationRows);

  // Baseline observer trade parity vs 211: a STATIC re-read of the already-frozen
  // checkpoint2.admissionParity block, never re-derived from a new execution.
  const manifestPath = path.resolve(REPO_ROOT, 'data/g6r-run-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    checkpoint2: { admissionParity: { freshClosedBaseline: number; closedMatched: number } };
  };
  const admissionParity = manifest.checkpoint2.admissionParity;
  const baselineParityMatches211 = admissionParity.freshClosedBaseline === 211 && admissionParity.closedMatched === 211;

  const hashesUnchangedFromCp3jFreeze =
    currentHashes.ledgerCsvSha256 === registeredHashes.ledgerCsvSha256 &&
    currentHashes.analyzerSourceSha256 === registeredHashes.analyzerSourceSha256 &&
    currentHashes.forensicSchemaSourceSha256 === registeredHashes.forensicSchemaSourceSha256 &&
    currentHashes.toolSourceSha256 === registeredHashes.toolSourceSha256;

  const gate = assembleCp3kGateDecision({
    populationAfter: metrics.population,
    baselineParityMatches211,
    unclosedAfter: metrics.unclosedAfter,
    missingDuplicateAmbiguousJoins: metrics.missingJoins + metrics.duplicateJoins + metrics.ambiguousJoins,
    schemaRuntimeErrors: metrics.schemaRuntimeErrors,
    timestampInvalidBefore: metrics.timestampInvalidBefore,
    timestampInvalidAfter: metrics.timestampInvalidAfter,
    geometryInvalidBefore: metrics.geometryInvalidBefore,
    geometryInvalidAfter: metrics.geometryInvalidAfter,
    appsBotSrcDiffEmpty: appsBotSrcDiffStat === '',
    hashesUnchangedFromCp3jFreeze,
  });

  const utcEnd = new Date().toISOString();

  mkdirSync(OUT_DIR, { recursive: true });

  const { perRow, ...metricsWithoutPerRow } = metrics;
  const summary = {
    ticket: 'TICKET-G6R-CP3K',
    candidateId: CP3J_CANDIDATE_ID,
    runId: RUN_ID,
    utcStart,
    utcEnd,
    fixedPoint: { branch, head, expectedBranch: EXPECTED_BRANCH, expectedHead: EXPECTED_HEAD },
    preflight,
    inputs: {
      ledgerCsvPath: 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv',
      classificationCsvPath: 'data/g6r-runs/g6r-cp3h-classification.csv',
      registrationArtifactPath: 'data/g6r-runs/g6r-cp3j-registration.json',
    },
    hashes: { current: currentHashes, registered: registeredHashes, hashesUnchangedFromCp3jFreeze },
    admissionParity,
    appsBotSrcDiffStat,
    metrics: metricsWithoutPerRow,
    gate,
    replayCount: 0,
    commitPushMergeDeployPerformed: false,
  };

  writeFileSync(path.join(OUT_DIR, 'g6r-cp3k-summary.json'), JSON.stringify(summary, null, 2) + '\n');

  const csvHeader = [
    'candidateKey', 'evaluationId', 'setupType',
    'originalTimestampClass', 'recomputedTimestampClass',
    'originalGeometryClass', 'recomputedGeometryClass',
    'originalCombinedClass', 'recomputedCombinedClass',
    'originalDecisionAvailableAt', 'correctedDecisionAvailableAt',
    'candidateKeyUnchanged', 'evaluationIdUnchanged',
  ];
  const csvLines = [csvHeader.join(',')];
  for (const r of perRow) {
    csvLines.push(
      [
        r.candidateKey, r.evaluationId, r.setupType,
        r.originalTimestampClass, r.recomputedTimestampClass,
        r.originalGeometryClass, r.recomputedGeometryClass,
        r.originalCombinedClass, r.recomputedCombinedClass,
        String(r.originalDecisionAvailableAt), String(r.correctedDecisionAvailableAt),
        String(r.candidateKeyUnchanged), String(r.evaluationIdUnchanged),
      ].join(','),
    );
  }
  writeFileSync(path.join(OUT_DIR, 'g6r-cp3k-screened-ledger.csv'), csvLines.join('\n') + '\n');

  const stdoutLog = [
    `CP3K cheap screen — candidate ${CP3J_CANDIDATE_ID}`,
    `utcStart=${utcStart} utcEnd=${utcEnd}`,
    `population=${metrics.population}`,
    `timestampInvalid before=${metrics.timestampInvalidBefore} after=${metrics.timestampInvalidAfter}`,
    `geometryInvalid before=${metrics.geometryInvalidBefore} after=${metrics.geometryInvalidAfter}`,
    `unclosed before=${metrics.unclosedBefore} after=${metrics.unclosedAfter}`,
    `identityChangedCount=${metrics.identityChangedCount}`,
    `missingJoins=${metrics.missingJoins} duplicateJoins=${metrics.duplicateJoins} ambiguousJoins=${metrics.ambiguousJoins}`,
    `requiredDataFailures=${metrics.requiredDataFailures} schemaRuntimeErrors=${metrics.schemaRuntimeErrors}`,
    `gateDecision=${gate.decision} failedCriteria=${JSON.stringify(gate.failedCriteria)}`,
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'stdout.log'), stdoutLog + '\n');
  writeFileSync(path.join(OUT_DIR, 'stderr.log'), '');

  console.log(stdoutLog);
  console.log(`Wrote ${OUT_DIR}`);
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
