process.env.T153_LIBRARY_MODE = 'true';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CP3J_CANDIDATE_ID,
  recomputeRowUnderCandidate,
  computeCausalEffect,
  buildRegistrationArtifact,
  ONE_MINUTE_MS,
} from './g6rCp3jCandidateRegistration.js';
import { parseForensicLedgerCsv, filterFallbackRows, type ForensicTelemetryRow } from './g6rCp3hForensicSchema.js';

/**
 * G6R CP3J tests. Every test below calls the REAL, already-frozen `classifyTimestamp()`,
 * `buildEventLikeFromRow()`, `filterFallbackRows()`, `parseForensicLedgerCsv()` (via
 * `g6rCp3hForensicSchema.ts`, read-only dependency) and CP3I's real `confirmingCandleAvailableAt()`
 * (via `g6rCp3iTimestampSemantics.ts`, read-only dependency). No detector/MSS/staleness/ATR/SL/
 * classification formula is reimplemented in this test file or in the module under test.
 */

// Realistic epoch-ms magnitudes (same order as the real frozen ledger's timestamps) so a 1-day macro
// availability window doesn't dwarf evaluationCutoffExclusive the way small synthetic ms values would.
const T0 = 1_770_000_000_000;

function makeRow(overrides: Partial<ForensicTelemetryRow>): ForensicTelemetryRow {
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
    decisionAvailableAt: T0 + 280_000, // synthetic legacy (mssMaxAvailableAt-style) value, intentionally NOT decisionTimestamp+ONE_MINUTE_MS
    candlesFromEnd: 3,
    mssMaxTimestampRead: T0 + 220_000, // > decisionTimestamp -> drives READ_AFTER_DECISION_TIMESTAMP
    mssMaxAvailableAt: T0 + 280_000,
    stalenessReferenceTimestamp: T0 + 220_000,
    evaluationCutoffExclusive: T0 + 5 * 60_000, // evaluationTimestamp + 5min, per the real formula
    detector5mMaxTimestamp: T0,
    detector5mMaxAvailableAt: T0 + 5 * 60_000,
    atr5mMaxTimestamp: T0,
    atr5mMaxAvailableAt: T0 + 5 * 60_000,
    macroInputMaxTimestamp: T0 - 86_400_000, // a full day BEFORE T0, so +1 day availability lands well before the cutoff
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
  return { ...base, ...overrides };
}

describe('CP3J candidate ID', () => {
  it('is the exact, disambiguated identifier used throughout the registration doc', () => {
    expect(CP3J_CANDIDATE_ID).toBe('T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE');
  });
});

describe('CP3J formula correctness — synthetic fixture (hand-crafted, known before/after)', () => {
  it('correctedDecisionAvailableAt = decisionTimestamp + ONE_MINUTE_MS, differing from the synthetic legacy value', () => {
    const row = makeRow({});
    const result = recomputeRowUnderCandidate(row);
    expect(result.correctedDecisionAvailableAt).toBe(row.decisionTimestamp + ONE_MINUTE_MS);
    expect(result.correctedDecisionAvailableAt).toBe(T0 + 100_000 + 60_000);
    expect(result.originalDecisionAvailableAt).toBe(T0 + 280_000);
    expect(result.decisionAvailableAtChanged).toBe(true);
  });

  it('timestampClass is UNCHANGED before/after for a row whose classification is driven by mssMaxTimestampRead (not decisionAvailableAt) — known expected value: stays READ_AFTER_DECISION_TIMESTAMP', () => {
    const row = makeRow({}); // mssMaxTimestampRead (T0+220_000) > decisionTimestamp (T0+100_000) -> READ_AFTER_DECISION_TIMESTAMP
    const result = recomputeRowUnderCandidate(row);
    expect(result.originalTimestampClass).toBe('READ_AFTER_DECISION_TIMESTAMP');
    expect(result.recomputedTimestampClass).toBe('READ_AFTER_DECISION_TIMESTAMP');
    expect(result.timestampClassChanged).toBe(false);
    expect(result.flippedToClean).toBe(false);
  });

  it('a CLEAN row (mssMaxTimestampRead === decisionTimestamp) stays CLEAN under the candidate too, even though decisionAvailableAt still changes', () => {
    const row = makeRow({
      mssMaxTimestampRead: T0 + 100_000, // === decisionTimestamp -> CLEAN
      mssMaxAvailableAt: T0 + 160_000,
      stalenessReferenceTimestamp: T0 + 100_000,
      decisionAvailableAt: T0 + 160_000, // happens to already equal the corrected value in this specific synthetic case (candlesFromEnd=0)
      candlesFromEnd: 0,
      timestampClass: 'CLEAN',
      combinedClass: 'CLEAN',
    });
    const result = recomputeRowUnderCandidate(row);
    expect(result.originalTimestampClass).toBe('CLEAN');
    expect(result.recomputedTimestampClass).toBe('CLEAN');
    expect(result.timestampClassChanged).toBe(false);
    expect(result.decisionAvailableAtChanged).toBe(false); // candlesFromEnd=0 case: legacy and corrected values coincide
  });
});

describe('CP3J positive control — real frozen ledger, exact causal-effect number reproduced', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const rows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));

  it('fallback population is 105, matching the frozen master-preflight metric', () => {
    const fallback = filterFallbackRows(rows);
    expect(fallback).toHaveLength(105);
  });

  it('reproduces the EXACT registered causal-effect numbers from data/g6r-cp3j-candidate-registration.md §6', () => {
    const summary = computeCausalEffect(rows);
    expect(summary.fallbackPopulation).toBe(105);
    expect(summary.nonCleanBefore).toBe(92);
    expect(summary.decisionAvailableAtChangedCount).toBe(92);
    expect(summary.timestampClassChangedCount).toBe(0);
    expect(summary.flippedToCleanCount).toBe(0);
  });

  it('every row whose decisionAvailableAt changes is exactly the set of non-CLEAN rows (candlesFromEnd > 0 <=> the 92)', () => {
    const summary = computeCausalEffect(rows);
    const changed = summary.perRow.filter((r) => r.decisionAvailableAtChanged);
    const nonClean = summary.perRow.filter((r) => r.originalTimestampClass !== 'CLEAN');
    expect(changed).toHaveLength(92);
    expect(nonClean).toHaveLength(92);
    const changedKeys = new Set(changed.map((r) => r.candidateKey));
    const nonCleanKeys = new Set(nonClean.map((r) => r.candidateKey));
    expect(changedKeys).toEqual(nonCleanKeys);
  });
});

describe('CP3J identity fields provably untouched by the recomputation', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const rows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));

  it('candidateKey/evaluationId are byte-identical, per row, before vs. after recomputation (real ledger)', () => {
    const fallback = filterFallbackRows(rows);
    const summary = computeCausalEffect(rows);
    expect(summary.perRow).toHaveLength(fallback.length);
    fallback.forEach((row, i) => {
      expect(summary.perRow[i].candidateKey).toBe(row.candidateKey);
      expect(summary.perRow[i].evaluationId).toBe(row.evaluationId);
    });
  });

  it('the aggregate candidateKey/evaluationId SET is unchanged (no addition, removal, or rename)', () => {
    const summary = computeCausalEffect(rows);
    expect(summary.candidateKeySetUnchanged).toBe(true);
    expect(summary.evaluationIdSetUnchanged).toBe(true);
  });

  it('synthetic fixture: identity fields pass through recomputeRowUnderCandidate() unchanged', () => {
    const row = makeRow({});
    const result = recomputeRowUnderCandidate(row);
    expect(result.candidateKey).toBe(row.candidateKey);
    expect(result.evaluationId).toBe(row.evaluationId);
  });
});

describe('CP3J registration artifact builder', () => {
  it('buildRegistrationArtifact() produces a frozen artifact whose causal-effect numbers match computeCausalEffect() over the real ledger, and whose hashes are valid sha256 hex', () => {
    const REPO_ROOT = path.resolve(__dirname, '../../..');
    const artifact = buildRegistrationArtifact({ repoRoot: REPO_ROOT, nowUtcIso: '2026-08-19T00:00:00.000Z', appsBotSrcDiffStat: '' });
    expect(artifact.candidateId).toBe('T3-DECISION-AVAILABLE-AT-CONFIRMING-CANDLE');
    expect(artifact.causalEffect.flippedToCleanCount).toBe(0);
    expect(artifact.causalEffect.timestampClassChangedCount).toBe(0);
    expect(artifact.causalEffect.fallbackPopulation).toBe(105);
    expect(artifact.commitPushMergeDeployPerformed).toBe(false);
    expect(/^[0-9a-f]{64}$/.test(artifact.registrationDocumentSha256)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(artifact.analyzerSourceSha256)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(artifact.toolSourceSha256)).toBe(true);
    expect(artifact.baselineProtection.g6rShadowAnalyzerUnchanged).toBe(true);
    expect(artifact.baselineProtection.g6rCp3hForensicSchemaUnchanged).toBe(true);
  });
});
