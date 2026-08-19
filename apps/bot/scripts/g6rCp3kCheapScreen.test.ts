process.env.T153_LIBRARY_MODE = 'true';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CP3J_CANDIDATE_ID,
  recomputeFallbackRowUnderScreen,
  computeCp3kMetrics,
  runCp3kPreflightChecks,
  assembleCp3kGateDecision,
  type Cp3kHashSet,
} from './g6rCp3kCheapScreen.js';
import { parseForensicLedgerCsv, filterFallbackRows, type ForensicTelemetryRow, type FallbackForensicTelemetryRow } from './g6rCp3hForensicSchema.js';
import { parseClassificationCsv } from './g6rCp3hrFallbackReconciliation.js';

/**
 * G6R CP3K tests. Every test below calls the REAL, already-frozen `classifyGeometryAndAttributeSl()`,
 * `combineClassification()`, `filterFallbackRows()`, `parseForensicLedgerCsv()` (via
 * `g6rCp3hForensicSchema.ts`), CP3J's real `recomputeRowUnderCandidate()` (via
 * `g6rCp3jCandidateRegistration.ts`), and CP3HR's real `computeFallbackReconciliation()`/
 * `parseClassificationCsv()` (via `g6rCp3hrFallbackReconciliation.ts`) — read-only dependencies, none
 * reimplemented in this test file or in the module under test.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const T0 = 1_770_000_000_000;

function makeRow(overrides: Partial<ForensicTelemetryRow>): FallbackForensicTelemetryRow {
  const base: ForensicTelemetryRow = {
    candidateKey: `BTCUSDT|LONG|FVG|${T0 + 100_000}|${T0}`,
    evaluationId: `BTCUSDT|${T0}|TREND_RIDER|0`,
    symbol: 'BTCUSDT',
    side: 'LONG',
    regime: 'TREND_RIDER',
    setupType: 'FVG',
    sourceTimestamp: T0,
    evaluationTimestamp: T0,
    decisionTimestamp: T0 + 100_000,
    decisionAvailableAt: T0 + 280_000,
    candlesFromEnd: 3,
    mssMaxTimestampRead: T0 + 220_000,
    mssMaxAvailableAt: T0 + 280_000,
    stalenessReferenceTimestamp: T0 + 220_000,
    evaluationCutoffExclusive: T0 + 5 * 60_000,
    detector5mMaxTimestamp: T0,
    detector5mMaxAvailableAt: T0 + 5 * 60_000,
    atr5mMaxTimestamp: T0,
    atr5mMaxAvailableAt: T0 + 5 * 60_000,
    macroInputMaxTimestamp: T0 - 86_400_000,
    macroInputMaxAvailableAt: T0,
    maxRawFeatureTimestamp: T0 + 220_000,
    maxFeatureAvailableAt: T0 + 280_000,
    rawSlPrice: 90,
    atr: 1,
    bufferAmount: 1,
    entryPrice: 100,
    slPrice: 89,
    slDistance: 11,
    rawSlToEntryDistance: 10,
    bufferSignCorrect: true,
    bufferEffect: 'NO_EFFECT_ALREADY_VALID',
    entryCrossedRawZone: false,
    geometryFailureStage: 'CLEAN',
    mssConfirmed: true,
    mssFailReason: null,
    primaryObFound: true,
    blockedByMacroFilter: false,
    timestampClass: 'READ_AFTER_DECISION_TIMESTAMP',
    geometryClass: 'CLEAN',
    combinedClass: 'TIMESTAMP_ONLY',
    registrationDocumentSha256: 'a'.repeat(64),
    analyzerSourceHash: 'b'.repeat(64),
    evaluationIdSchemaValid: true,
    candidateKeySchemaValid: true,
  };
  return { ...base, ...overrides } as FallbackForensicTelemetryRow;
}

// ============================== Per-row recomputation ==============================

describe('CP3K per-row recomputation — synthetic fixture', () => {
  it('reuses CP3J formula for decisionAvailableAt and leaves geometry/combined class unaffected for a geometry-CLEAN row', () => {
    const row = makeRow({});
    const result = recomputeFallbackRowUnderScreen(row);
    expect(result.correctedDecisionAvailableAt).toBe(row.decisionTimestamp + 60_000);
    expect(result.originalDecisionAvailableAt).toBe(row.decisionAvailableAt);
    expect(result.recomputedTimestampClass).toBe('READ_AFTER_DECISION_TIMESTAMP');
    expect(result.recomputedGeometryClass).toBe('CLEAN');
    expect(result.recomputedCombinedClass).toBe('TIMESTAMP_ONLY');
    expect(result.candidateKeyUnchanged).toBe(true);
    expect(result.evaluationIdUnchanged).toBe(true);
  });

  it('a row with a wrong-side raw SL stays GEOMETRY-invalid after the candidate too (candidate never touches geometry)', () => {
    const row = makeRow({
      side: 'LONG',
      rawSlPrice: 110, // >= entryPrice(100) -> raw already wrong side for LONG
      slPrice: 108, // still >= entryPrice -> final wrong side too
      slDistance: 8,
      geometryClass: 'RAW_ALREADY_WRONG_SIDE',
      combinedClass: 'BOTH',
    });
    const result = recomputeFallbackRowUnderScreen(row);
    expect(result.recomputedGeometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    expect(result.recomputedCombinedClass).toBe('BOTH');
  });

  it('a CLEAN-timestamp row stays CLEAN under the candidate', () => {
    const row = makeRow({
      mssMaxTimestampRead: T0 + 100_000,
      mssMaxAvailableAt: T0 + 160_000,
      stalenessReferenceTimestamp: T0 + 100_000,
      candlesFromEnd: 0,
      timestampClass: 'CLEAN',
      combinedClass: 'CLEAN',
    });
    const result = recomputeFallbackRowUnderScreen(row);
    expect(result.recomputedTimestampClass).toBe('CLEAN');
    expect(result.recomputedCombinedClass).toBe('CLEAN');
  });
});

// ============================== Aggregate metrics — synthetic fixture ==============================

describe('CP3K computeCp3kMetrics — synthetic fixture', () => {
  it('computes population/timestampInvalid/geometryInvalid before+after and identity-unchanged over a small hand-built population', () => {
    const clean = makeRow({
      candidateKey: 'K1',
      evaluationId: 'E1',
      mssMaxTimestampRead: T0 + 100_000,
      mssMaxAvailableAt: T0 + 160_000,
      stalenessReferenceTimestamp: T0 + 100_000,
      candlesFromEnd: 0,
      timestampClass: 'CLEAN',
      geometryClass: 'CLEAN',
      combinedClass: 'CLEAN',
    });
    const nonCleanTimestamp = makeRow({
      candidateKey: 'K2',
      evaluationId: 'E2',
      timestampClass: 'READ_AFTER_DECISION_TIMESTAMP',
      combinedClass: 'TIMESTAMP_ONLY',
    });
    const geometryBad = makeRow({
      candidateKey: 'K3',
      evaluationId: 'E3',
      setupType: 'SWEEP',
      rawSlPrice: 110,
      slPrice: 108,
      slDistance: 8,
      mssMaxTimestampRead: T0 + 100_000,
      mssMaxAvailableAt: T0 + 160_000,
      stalenessReferenceTimestamp: T0 + 100_000,
      candlesFromEnd: 0,
      timestampClass: 'CLEAN',
      geometryClass: 'RAW_ALREADY_WRONG_SIDE',
      combinedClass: 'GEOMETRY_ONLY',
    });
    const rows = [clean, nonCleanTimestamp, geometryBad];
    const classificationRows = rows.map((r) => ({
      candidateKey: r.candidateKey,
      evaluationId: r.evaluationId,
      timestampClass: r.timestampClass,
      geometryClass: r.geometryClass,
      combinedClass: r.combinedClass,
    }));
    const metrics = computeCp3kMetrics(rows, classificationRows);
    expect(metrics.population).toBe(3);
    expect(metrics.timestampInvalidBefore).toBe(1);
    expect(metrics.timestampInvalidAfter).toBe(1); // candidate never flips timestampClass
    expect(metrics.geometryInvalidBefore).toBe(1);
    expect(metrics.geometryInvalidAfter).toBe(1);
    expect(metrics.unclosedBefore).toBe(0);
    expect(metrics.unclosedAfter).toBe(0);
    expect(metrics.identityChangedCount).toBe(0);
    expect(metrics.missingJoins).toBe(0);
    expect(metrics.duplicateJoins).toBe(0);
    expect(metrics.ambiguousJoins).toBe(0);
    expect(metrics.requiredDataFailures).toBe(0);
    expect(metrics.schemaRuntimeErrors).toBe(0);
    expect(metrics.outcomeBySetupTypeBefore.FVG.TIMESTAMP_ONLY).toBe(1);
    expect(metrics.outcomeBySetupTypeBefore.FVG.CLEAN).toBe(1);
    expect(metrics.outcomeBySetupTypeBefore.SWEEP.GEOMETRY_ONLY).toBe(1);
  });

  it('flags a missing join when a fallback row has no matching classification row', () => {
    const row = makeRow({ candidateKey: 'K1', evaluationId: 'E1' });
    const metrics = computeCp3kMetrics([row], []);
    expect(metrics.missingJoins).toBeGreaterThan(0);
  });

  it('flags a duplicate join when the classification CSV has a duplicate candidateKey', () => {
    const row = makeRow({ candidateKey: 'K1', evaluationId: 'E1' });
    const classificationRows = [
      { candidateKey: 'K1', evaluationId: 'E1', timestampClass: row.timestampClass, geometryClass: row.geometryClass, combinedClass: row.combinedClass },
      { candidateKey: 'K1', evaluationId: 'E1', timestampClass: row.timestampClass, geometryClass: row.geometryClass, combinedClass: row.combinedClass },
    ];
    const metrics = computeCp3kMetrics([row], classificationRows);
    expect(metrics.duplicateJoins).toBeGreaterThan(0);
  });

  it('flags an ambiguous join when the joined pair disagrees on evaluationId', () => {
    const row = makeRow({ candidateKey: 'K1', evaluationId: 'E1' });
    const classificationRows = [{ candidateKey: 'K1', evaluationId: 'E-DIFFERENT', timestampClass: row.timestampClass, geometryClass: row.geometryClass, combinedClass: row.combinedClass }];
    const metrics = computeCp3kMetrics([row], classificationRows);
    expect(metrics.ambiguousJoins).toBeGreaterThan(0);
  });
});

// ============================== Positive control — real frozen ledger ==============================

describe('CP3K positive control — real frozen ledger, reproduces CP3J numbers', () => {
  const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const classificationPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');
  const ledgerRows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));
  const classificationRows = parseClassificationCsv(readFileSync(classificationPath, 'utf8'));

  it('fallback population is 105', () => {
    expect(filterFallbackRows(ledgerRows)).toHaveLength(105);
  });

  it('reproduces the exact CP3J causal-effect numbers: 92 non-CLEAN before, 92 after, 0 flipped, 31 geometry-invalid unchanged', () => {
    const metrics = computeCp3kMetrics(ledgerRows, classificationRows);
    expect(metrics.population).toBe(105);
    expect(metrics.timestampInvalidBefore).toBe(92);
    expect(metrics.timestampInvalidAfter).toBe(92); // matches CP3J's flippedToCleanCount === 0 finding
    expect(metrics.geometryInvalidBefore).toBe(31);
    expect(metrics.geometryInvalidAfter).toBe(31); // candidate never touches geometry
    expect(metrics.unclosedBefore).toBe(0);
    expect(metrics.unclosedAfter).toBe(0);
    expect(metrics.identityChangedCount).toBe(0);
    expect(metrics.missingJoins).toBe(0);
    expect(metrics.duplicateJoins).toBe(0);
    expect(metrics.ambiguousJoins).toBe(0);
    expect(metrics.requiredDataFailures).toBe(0);
    expect(metrics.schemaRuntimeErrors).toBe(0);
  });

  it('outcome breakdown by setup type sums to the real FVG=93/SWEEP=12 fallback split', () => {
    const metrics = computeCp3kMetrics(ledgerRows, classificationRows);
    const fvgTotal = Object.values(metrics.outcomeBySetupTypeBefore.FVG).reduce((a, b) => a + b, 0);
    const sweepTotal = Object.values(metrics.outcomeBySetupTypeBefore.SWEEP).reduce((a, b) => a + b, 0);
    expect(fvgTotal).toBe(93);
    expect(sweepTotal).toBe(12);
    expect(fvgTotal + sweepTotal).toBe(105);
  });
});

// ============================== Preflight fail-closed checks ==============================

describe('CP3K preflight fail-closed checks', () => {
  const goodHashes: Cp3kHashSet = {
    ledgerCsvSha256: 'a'.repeat(64),
    analyzerSourceSha256: 'b'.repeat(64),
    forensicSchemaSourceSha256: 'c'.repeat(64),
    toolSourceSha256: 'd'.repeat(64),
  };
  const baseOpts = {
    branch: 'cai-tien',
    head: '2233af10f3cf2f1ee6f4859203389e7cfb7dd3e2',
    expectedBranch: 'cai-tien',
    expectedHead: '2233af10f3cf2f1ee6f4859203389e7cfb7dd3e2',
    registeredHashes: goodHashes,
    currentHashes: goodHashes,
    outputDirExists: false,
  };

  it('passes when everything matches', () => {
    expect(runCp3kPreflightChecks(baseOpts).ok).toBe(true);
  });

  it('fails closed on a branch mismatch', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, branch: 'some-other-branch' });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('BRANCH_MISMATCH');
  });

  it('fails closed on a HEAD mismatch (simulated fixture flag)', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, head: 'deadbeef'.repeat(5) });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('HEAD_MISMATCH');
  });

  it('fails closed on a registration-hash mismatch (analyzer source drifted since CP3J froze)', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, currentHashes: { ...goodHashes, analyzerSourceSha256: 'z'.repeat(64) } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('REGISTRATION_DRIFT_ANALYZER_SOURCE');
  });

  it('fails closed on a registration-hash mismatch (forensic schema source drifted)', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, currentHashes: { ...goodHashes, forensicSchemaSourceSha256: 'z'.repeat(64) } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('REGISTRATION_DRIFT_FORENSIC_SCHEMA_SOURCE');
  });

  it('fails closed on a registration-hash mismatch (CP3J tool source drifted)', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, currentHashes: { ...goodHashes, toolSourceSha256: 'z'.repeat(64) } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('REGISTRATION_DRIFT_TOOL_SOURCE');
  });

  it('fails closed on a dataset-hash mismatch (frozen ledger CSV drifted since CP3J freeze)', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, currentHashes: { ...goodHashes, ledgerCsvSha256: 'z'.repeat(64) } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('DATASET_HASH_MISMATCH');
  });

  it('fails closed when the immutable output-path directory already exists', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, outputDirExists: true });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('OUTPUT_PATH_ALREADY_EXISTS');
  });

  it('accumulates multiple simultaneous failures rather than short-circuiting on the first one', () => {
    const result = runCp3kPreflightChecks({ ...baseOpts, branch: 'wrong', head: 'wrong', outputDirExists: true });
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================== PASS-gate assembly ==============================

describe('CP3K PASS-gate assembly', () => {
  const passingInputs = {
    populationAfter: 105,
    baselineParityMatches211: true,
    unclosedAfter: 0,
    missingDuplicateAmbiguousJoins: 0,
    schemaRuntimeErrors: 0,
    timestampInvalidBefore: 92,
    timestampInvalidAfter: 50, // hypothetical decrease
    geometryInvalidBefore: 31,
    geometryInvalidAfter: 31,
    appsBotSrcDiffEmpty: true,
    hashesUnchangedFromCp3jFreeze: true,
  };

  it('returns SCREEN_PASS when every criterion is satisfied, including a genuine timestamp-invalid decrease', () => {
    const result = assembleCp3kGateDecision(passingInputs);
    expect(result.decision).toBe('SCREEN_PASS');
    expect(result.failedCriteria).toEqual([]);
  });

  it('returns SCREEN_REJECTED (not SCREEN_PASS) when timestamp-invalid does NOT decrease — the exact real-world situation this candidate produces (92 before, 92 after)', () => {
    const realWorldInputs = { ...passingInputs, timestampInvalidAfter: 92 };
    const result = assembleCp3kGateDecision(realWorldInputs);
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('TIMESTAMP_INVALID_DID_NOT_DECREASE');
  });

  it('does not treat "no decrease" as trivially satisfying ">= 0" — an increase is also rejected, not just flagged differently', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, timestampInvalidAfter: 93 });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('TIMESTAMP_INVALID_DID_NOT_DECREASE');
  });

  it('rejects when population drifts from 105', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, populationAfter: 104 });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('POPULATION_NOT_105');
  });

  it('rejects when baseline parity is not 211/211', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, baselineParityMatches211: false });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('BASELINE_PARITY_NOT_211');
  });

  it('rejects when there is a future/unclosed candle read', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, unclosedAfter: 1 });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('UNCLOSED_FUTURE_READS_NONZERO');
  });

  it('rejects when there are missing/duplicate/ambiguous joins', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, missingDuplicateAmbiguousJoins: 2 });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('JOIN_DEFECTS_NONZERO');
  });

  it('rejects when geometry worsens', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, geometryInvalidAfter: 32 });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('GEOMETRY_WORSENED');
  });

  it('rejects when apps/bot/src was touched', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, appsBotSrcDiffEmpty: false });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('PRODUCTION_BEHAVIOR_CHANGED');
  });

  it('rejects when hashes drifted from the CP3J freeze', () => {
    const result = assembleCp3kGateDecision({ ...passingInputs, hashesUnchangedFromCp3jFreeze: false });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toContain('HASH_DRIFT_FROM_CP3J_FREEZE');
  });

  it('reports the REAL outcome for this ticket: SCREEN_REJECTED via the real computed metrics over the frozen ledger', () => {
    const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
    const classificationPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');
    const ledgerRows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));
    const classificationRows = parseClassificationCsv(readFileSync(classificationPath, 'utf8'));
    const metrics = computeCp3kMetrics(ledgerRows, classificationRows);
    const result = assembleCp3kGateDecision({
      populationAfter: metrics.population,
      baselineParityMatches211: true,
      unclosedAfter: metrics.unclosedAfter,
      missingDuplicateAmbiguousJoins: metrics.missingJoins + metrics.duplicateJoins + metrics.ambiguousJoins,
      schemaRuntimeErrors: metrics.schemaRuntimeErrors,
      timestampInvalidBefore: metrics.timestampInvalidBefore,
      timestampInvalidAfter: metrics.timestampInvalidAfter,
      geometryInvalidBefore: metrics.geometryInvalidBefore,
      geometryInvalidAfter: metrics.geometryInvalidAfter,
      appsBotSrcDiffEmpty: true,
      hashesUnchangedFromCp3jFreeze: true,
    });
    expect(result.decision).toBe('SCREEN_REJECTED');
    expect(result.failedCriteria).toEqual(['TIMESTAMP_INVALID_DID_NOT_DECREASE']);
  });
});

describe('CP3K candidate ID re-export', () => {
  it('matches CP3J’s registered candidate ID', () => {
    expect(CP3J_CANDIDATE_ID).toBe('T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE');
  });
});
