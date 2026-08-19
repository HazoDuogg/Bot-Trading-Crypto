process.env.T153_LIBRARY_MODE = 'true';
/**
 * TICKET-G6R-CP3HR — Task 9: tests for the pure offline fallback reconciliation tool.
 *
 * These tests NEVER import a replay runner (g6rCp3hForensicReplay.ts / g6rCheckpoint3Replay.ts /
 * ticket150BacktestExecutionRealismAudit.ts's runReplay / any Central/CP4/CP5/CP6 tooling). They
 * exercise pure functions from g6rCp3hrFallbackReconciliation.ts, and separately read (never write)
 * the two already-frozen CP3H CSV artifacts to prove the tool's real output against real data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseClassificationCsv,
  joinLedgerAndClassification,
  computeFallbackReconciliation,
  deriveSlBufferAtrMultiplier,
  buildReconciliationArtifact,
  recomputeAndCompareClassification,
  type ClassificationCsvRow,
} from './g6rCp3hrFallbackReconciliation.js';
import { parseForensicLedgerCsv, filterFallbackRows, assembleForensicRow, type ForensicTelemetryRow, type ForensicShadowEventLike, type ForensicSetupType } from './g6rCp3hForensicSchema.js';
import type { FrozenShadowEvent, DecisionFeatureProvenance } from './g6rShadowAnalyzer.js';

function provenance(overrides: Partial<DecisionFeatureProvenance> = {}): DecisionFeatureProvenance {
  return {
    detector5mMaxTimestamp: 90,
    detector5mMaxAvailableAt: 90 + 300000,
    mssMaxTimestampRead: 100,
    mssMaxAvailableAt: 100 + 60000,
    mssConfirmationTimestamp: 100,
    stalenessReferenceTimestamp: 100,
    atr5mMaxTimestamp: 90,
    atr5mMaxAvailableAt: 90 + 300000,
    macroInputMaxTimestamp: 0,
    macroInputMaxAvailableAt: 86400000,
    evaluationCutoffExclusive: 86400000 + 300000,
    maxRawFeatureTimestamp: 100,
    maxFeatureAvailableAt: 100 + 60000,
    ...overrides,
  };
}

function event(overrides: Partial<FrozenShadowEvent> = {}): FrozenShadowEvent {
  return {
    candidateKey: 'BTCUSDT|LONG|FVG|100|90',
    evaluationId: 'BTCUSDT|95|TREND_RIDER|0',
    symbol: 'BTCUSDT',
    side: 'LONG',
    regime: 'TREND_RIDER',
    setupType: 'FVG',
    sourceTimestamp: 90,
    evaluationTimestamp: 95,
    decisionTimestamp: 100,
    entryPrice: 50,
    slPrice: 45,
    slDistance: 5,
    provenance: provenance(),
    ...overrides,
  };
}

function fallbackRow(overrides: Partial<ForensicTelemetryRow> = {}): ForensicTelemetryRow {
  return assembleForensicRow({
    event: event({
      candidateKey: overrides.candidateKey,
      evaluationId: overrides.evaluationId,
      setupType: (overrides.setupType as 'FVG' | 'SWEEP' | undefined) ?? 'FVG',
    } as Partial<FrozenShadowEvent>),
    rawSlPrice: 44,
    atr: 20,
    bufferAmount: 1,
    candlesFromEnd: 0,
    mssConfirmed: true,
    mssFailReason: null,
    primaryObFound: true,
    blockedByMacroFilter: false,
    registrationDocumentSha256: 'REG',
    analyzerSourceHash: 'SRC',
    evaluationIdSchemaValid: true,
    candidateKeySchemaValid: true,
  });
}

function classificationOf(row: ForensicTelemetryRow): ClassificationCsvRow {
  return { candidateKey: row.candidateKey, evaluationId: row.evaluationId, timestampClass: row.timestampClass, geometryClass: row.geometryClass, combinedClass: row.combinedClass };
}

describe('parseClassificationCsv', () => {
  it('parses required columns and fails closed on a missing column', () => {
    const text = 'candidateKey,evaluationId,timestampClass,geometryClass,combinedClass\r\nk1,e1,CLEAN,CLEAN,CLEAN\r\n';
    const rows = parseClassificationCsv(text);
    expect(rows).toEqual([{ candidateKey: 'k1', evaluationId: 'e1', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' }]);
    expect(() => parseClassificationCsv('candidateKey,evaluationId\r\nk1,e1\r\n')).toThrow(/missing required column/);
  });

  // ============================== TICKET-G6R-CP3HR2 Task 5: strict exact schema (Option 1) ==============================

  it('fails closed on an extra/unknown column', () => {
    const text = 'candidateKey,evaluationId,timestampClass,geometryClass,combinedClass,extraColumn\r\nk1,e1,CLEAN,CLEAN,CLEAN,bogus\r\n';
    expect(() => parseClassificationCsv(text)).toThrow(/unknown\/unexpected column/);
  });

  it('a reordered but complete header still parses', () => {
    const text = 'combinedClass,candidateKey,geometryClass,evaluationId,timestampClass\r\nCLEAN,k1,CLEAN,e1,CLEAN\r\n';
    const rows = parseClassificationCsv(text);
    expect(rows).toEqual([{ candidateKey: 'k1', evaluationId: 'e1', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' }]);
  });
});

describe('joinLedgerAndClassification', () => {
  it('joins clean data with zero missing joins/mismatches', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const classification = rows.map(classificationOf);
    const result = joinLedgerAndClassification(rows, classification);
    expect(result.joined).toHaveLength(1);
    expect(result.ledgerRowsMissingClassification).toHaveLength(0);
    expect(result.classificationRowsMissingLedger).toHaveLength(0);
    expect(result.combinedClassMismatches).toHaveLength(0);
  });

  it('reports a ledger row with no matching classification row', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const result = joinLedgerAndClassification(rows, []);
    expect(result.ledgerRowsMissingClassification).toHaveLength(1);
  });

  it('reports an orphan classification row', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const orphan: ClassificationCsvRow = { candidateKey: 'orphan', evaluationId: 'e', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' };
    const result = joinLedgerAndClassification(rows, [...rows.map(classificationOf), orphan]);
    expect(result.classificationRowsMissingLedger).toEqual([orphan]);
  });

  it('reports a combinedClass mismatch between ledger and classification', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const badClassification: ClassificationCsvRow = { ...classificationOf(rows[0]), combinedClass: 'BOTH' };
    const result = joinLedgerAndClassification(rows, [badClassification]);
    expect(result.combinedClassMismatches).toHaveLength(1);
  });
});

describe('computeFallbackReconciliation', () => {
  it('separates OB rows from the fallback denominator entirely — OB rows never appear in any fallback count', () => {
    // Built as a plain ForensicShadowEventLike literal with setupType: 'OB' directly — NO cast of any
    // kind, proving assembleForensicRow() accepts an OB row without the unsafe double-cast pattern.
    const obEvent: ForensicShadowEventLike = {
      candidateKey: 'BTCUSDT|LONG|OB|100|90',
      evaluationId: 'BTCUSDT|95|TREND_RIDER|0',
      symbol: 'BTCUSDT',
      side: 'LONG',
      regime: 'TREND_RIDER',
      setupType: 'OB',
      sourceTimestamp: 90,
      evaluationTimestamp: 95,
      decisionTimestamp: 100,
      entryPrice: 50,
      slPrice: 45,
      slDistance: 5,
      provenance: provenance(),
    };
    const realObRow = assembleForensicRow({
      event: obEvent,
      rawSlPrice: 44,
      atr: 20,
      bufferAmount: 1,
      candlesFromEnd: 0,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'REG',
      analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    const fvgRow = fallbackRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|91', evaluationId: 'BTCUSDT|96|TREND_RIDER|0' });
    const rows = [realObRow, fvgRow];
    const classification = rows.map(classificationOf);
    const result = computeFallbackReconciliation(rows, classification);

    expect(result.totalLedgerRows).toBe(2);
    expect(result.obDiagnosticRowCount).toBe(1);
    expect(result.fallbackRowCount).toBe(1);
    expect(result.setupTypeCounts.OB).toBe(1);
    expect(result.fallbackCombinedSum).toBe(1);
    // The OB row's own combinedClass must not have been folded into the fallback breakdown.
    const totalInBreakdown = Object.values(result.fallbackCombinedBreakdown).reduce((a, b) => a + b, 0);
    expect(totalInBreakdown).toBe(1);
  });

  it('reconciles: CLEAN+TIMESTAMP_ONLY+GEOMETRY_ONLY+BOTH === fallbackRowCount on a clean synthetic set', () => {
    const rows = [
      fallbackRow({ candidateKey: 'k1' }),
      fallbackRow({ candidateKey: 'k2', evaluationId: 'BTCUSDT|96|TREND_RIDER|0' }),
      fallbackRow({ candidateKey: 'k3', evaluationId: 'BTCUSDT|97|TREND_RIDER|0', setupType: 'SWEEP' }),
    ];
    const classification = rows.map(classificationOf);
    const result = computeFallbackReconciliation(rows, classification);
    expect(result.reconciles).toBe(true);
    expect(result.joinsClean).toBe(true);
    expect(result.reconciliationPass).toBe(true);
    expect(result.fallbackCombinedSum).toBe(result.fallbackRowCount);
  });

  it('detects a duplicate candidateKey within the fallback population', () => {
    const rows = [fallbackRow({ candidateKey: 'dup' }), fallbackRow({ candidateKey: 'dup' })];
    const classification = rows.map(classificationOf);
    const result = computeFallbackReconciliation(rows, classification);
    expect(result.fallbackDuplicateCandidateKeyCount).toBe(1);
    expect(result.duplicateCandidateKeys).toEqual(['dup']);
  });

  it('fails reconciliationPass when joins are dirty even if the sum reconciles', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const result = computeFallbackReconciliation(rows, []); // no classification rows -> missing join
    expect(result.reconciles).toBe(true); // sum still matches (1 fallback row, 1 in its own combinedClass bucket)
    expect(result.joinsClean).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });
});

describe('deriveSlBufferAtrMultiplier', () => {
  it('computes bufferAmount/atr and labels the formula explicitly, never writing back to the row', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })]; // atr=20, bufferAmount=1 in the fixture builder above
    const derived = deriveSlBufferAtrMultiplier(rows);
    expect(derived).toHaveLength(1);
    expect(derived[0].formula).toBe('bufferAmount / atr');
    expect(derived[0].slBufferAtrMultiplierDerived).toBeCloseTo(1 / 20, 10);
    expect((rows[0] as unknown as Record<string, unknown>).slBufferAtrMultiplierDerived).toBeUndefined();
  });

  it('returns null when atr is zero (division undefined), never NaN/Infinity', () => {
    const row = assembleForensicRow({
      event: event({ candidateKey: 'k-zero-atr' }),
      rawSlPrice: 44,
      atr: 0,
      bufferAmount: 1,
      candlesFromEnd: 0,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'REG',
      analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    const derived = deriveSlBufferAtrMultiplier([row]);
    expect(derived[0].slBufferAtrMultiplierDerived).toBeNull();
  });
});

describe('buildReconciliationArtifact — real frozen CP3H data (read-only, no replay)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const classificationPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv');

  it('produces the documented population split from the real, already-frozen CSV artifacts', () => {
    const ledgerCsvText = readFileSync(ledgerPath, 'utf8');
    const classificationCsvText = readFileSync(classificationPath, 'utf8');
    const artifact = buildReconciliationArtifact({
      ledgerCsvPath: 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv',
      classificationCsvPath: 'data/g6r-runs/g6r-cp3h-classification.csv',
      ledgerCsvText,
      classificationCsvText,
      toolSourceSha256: 'TEST_PLACEHOLDER',
      nowUtcIso: '2026-01-01T00:00:00.000Z',
    });

    // Real, computed numbers — asserted from what the tool actually produces, not hard-coded
    // independently of the tool. This test's purpose is regression-locking the tool's own output
    // against the real frozen CSVs, not re-deriving the numbers by a second method.
    expect(artifact.result.totalLedgerRows).toBe(209);
    expect(artifact.result.obDiagnosticRowCount + artifact.result.fallbackRowCount).toBe(209);
    expect(artifact.result.fallbackRowCount).toBe(artifact.result.fvgCount + artifact.result.sweepCount);
    expect(artifact.result.fallbackCombinedSum).toBe(artifact.result.fallbackRowCount);
    expect(artifact.result.reconciles).toBe(true);
    expect(artifact.result.joinsClean).toBe(true);
    expect(artifact.status).toBe('CORRECTION_VALID');
  });

  it('parses the real ledger through parseForensicLedgerCsv/filterFallbackRows consistently with the tool', () => {
    const ledgerCsvText = readFileSync(ledgerPath, 'utf8');
    const rows = parseForensicLedgerCsv(ledgerCsvText);
    expect(rows).toHaveLength(209);
    const fallback = filterFallbackRows(rows);
    const ob = rows.filter((r) => r.setupType === 'OB');
    expect(fallback.length + ob.length).toBe(209);
    for (const r of fallback) expect(['FVG', 'SWEEP']).toContain(r.setupType);
  });
});

// ============================== TICKET-G6R-CP3HR2 Task 1/2: fail-closed reconciliation hardening ==============================
//
// Every test below proves `reconciliationPass` itself flips to `false` (not merely that some counter
// increments), except test #13 (expected-normal co-occurrence) and #16 (positive control on the real,
// unmodified evidence).

function obRow(overrides: Partial<ForensicTelemetryRow> = {}): ForensicTelemetryRow {
  const ev: ForensicShadowEventLike = {
    candidateKey: overrides.candidateKey ?? 'BTCUSDT|LONG|OB|100|90',
    evaluationId: overrides.evaluationId ?? 'BTCUSDT|95|TREND_RIDER|0',
    symbol: 'BTCUSDT',
    side: 'LONG',
    regime: 'TREND_RIDER',
    setupType: 'OB',
    sourceTimestamp: 90,
    evaluationTimestamp: 95,
    decisionTimestamp: 100,
    entryPrice: 50,
    slPrice: 45,
    slDistance: 5,
    provenance: provenance(),
  };
  return assembleForensicRow({
    event: ev,
    rawSlPrice: 44,
    atr: 20,
    bufferAmount: 1,
    candlesFromEnd: 0,
    mssConfirmed: true,
    mssFailReason: null,
    primaryObFound: true,
    blockedByMacroFilter: false,
    registrationDocumentSha256: 'REG',
    analyzerSourceHash: 'SRC',
    evaluationIdSchemaValid: true,
    candidateKeySchemaValid: true,
  });
}

describe('computeFallbackReconciliation — TICKET-G6R-CP3HR2 Task 1/2 fail-closed hardening (16 cases)', () => {
  it('1) duplicate ledger candidateKey (two OB rows, same key) flips reconciliationPass to false', () => {
    const rows = [obRow({ candidateKey: 'dup-ob', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' }), obRow({ candidateKey: 'dup-ob', evaluationId: 'BTCUSDT|96|TREND_RIDER|0' })];
    const classification = rows.map(classificationOf);
    const result = computeFallbackReconciliation(rows, classification);
    expect(result.duplicateLedgerCandidateKeys).toBe(1);
    expect(result.duplicateFallbackCandidateKeys).toBe(0); // OB rows never enter the fallback subset
    expect(result.reconciliationPass).toBe(false);
  });

  it('2) duplicate fallback candidateKey flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'dup-fb', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' }), fallbackRow({ candidateKey: 'dup-fb', evaluationId: 'BTCUSDT|96|TREND_RIDER|0' })];
    const classification = rows.map(classificationOf);
    const result = computeFallbackReconciliation(rows, classification);
    expect(result.duplicateFallbackCandidateKeys).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('3) duplicate classification candidateKey with IDENTICAL class values still flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const c = classificationOf(rows[0]);
    const result = computeFallbackReconciliation(rows, [c, { ...c }]); // exact duplicate row
    expect(result.duplicateClassificationCandidateKeys).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('4) duplicate classification candidateKey with CONFLICTING class values flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const c = classificationOf(rows[0]);
    const conflicting: ClassificationCsvRow = { ...c, combinedClass: c.combinedClass === 'CLEAN' ? 'BOTH' : 'CLEAN' };
    const result = computeFallbackReconciliation(rows, [c, conflicting]);
    expect(result.duplicateClassificationCandidateKeys).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('5) orphan classification row (candidateKey not in ledger) flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const orphan: ClassificationCsvRow = { candidateKey: 'orphan', evaluationId: 'e', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' };
    const result = computeFallbackReconciliation(rows, [...rows.map(classificationOf), orphan]);
    expect(result.classificationRowsMissingLedgerCount).toBe(1);
    expect(result.joinsClean).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });

  it('6) ledger row missing its classification counterpart flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const result = computeFallbackReconciliation(rows, []);
    expect(result.ledgerRowsMissingClassificationCount).toBe(1);
    expect(result.joinsClean).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });

  it('7) evaluationId mismatch between ledger row and its classification counterpart flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1' })];
    const c = { ...classificationOf(rows[0]), evaluationId: 'SOMETHING|1|OTHER|0' };
    const result = computeFallbackReconciliation(rows, [c]);
    expect(result.identityMismatches).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('8) timestampClass recomputed from raw ledger data disagrees with the stored label -> flips reconciliationPass to false', () => {
    const base = fallbackRow({ candidateKey: 'k1' }); // stored timestampClass is CLEAN, recomputes to CLEAN too
    expect(base.timestampClass).toBe('CLEAN');
    const corrupted: ForensicTelemetryRow = { ...base, timestampClass: 'UNCLOSED_INPUT_READ' };
    const result = computeFallbackReconciliation([corrupted], [classificationOf(corrupted)]);
    expect(result.classificationMismatchDetails.storedVsRecomputed.some((m) => m.field === 'timestampClass')).toBe(true);
    expect(result.classificationMismatches).toBeGreaterThan(0);
    expect(result.reconciliationPass).toBe(false);
  });

  it('9) geometryClass recomputed from raw ledger data disagrees with the stored label -> flips reconciliationPass to false', () => {
    const base = fallbackRow({ candidateKey: 'k1' });
    expect(base.geometryClass).toBe('CLEAN');
    const corrupted: ForensicTelemetryRow = { ...base, geometryClass: 'RAW_ALREADY_WRONG_SIDE' };
    const result = computeFallbackReconciliation([corrupted], [classificationOf(corrupted)]);
    expect(result.classificationMismatchDetails.storedVsRecomputed.some((m) => m.field === 'geometryClass')).toBe(true);
    expect(result.reconciliationPass).toBe(false);
  });

  it('10) combinedClass recomputed from raw ledger data disagrees with the stored label (raw data implies CLEAN, row claims TIMESTAMP_ONLY) -> flips reconciliationPass to false', () => {
    const base = fallbackRow({ candidateKey: 'k1' }); // raw data is genuinely CLEAN/CLEAN -> recomputed combinedClass = CLEAN
    const corrupted: ForensicTelemetryRow = { ...base, combinedClass: 'TIMESTAMP_ONLY' }; // timestampClass/geometryClass sub-labels left CLEAN/CLEAN (individually still "correct"), only the combined roll-up is wrong
    const result = computeFallbackReconciliation([corrupted], [classificationOf(corrupted)]);
    expect(result.classificationMismatchDetails.storedVsRecomputed.some((m) => m.field === 'combinedClass')).toBe(true);
    expect(result.classificationMismatchDetails.storedVsRecomputed.some((m) => m.field === 'timestampClass')).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });

  it('11) duplicate fallback evaluationId (two different fallback rows claiming the same evaluationId) flips reconciliationPass to false', () => {
    const rows = [fallbackRow({ candidateKey: 'k1', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' }), fallbackRow({ candidateKey: 'k2', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' })];
    const result = computeFallbackReconciliation(rows, rows.map(classificationOf));
    expect(result.duplicateFallbackEvaluationIds).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('12) FVG and SWEEP candidates sharing the same evaluationId (should never happen) flips reconciliationPass to false', () => {
    const rows = [
      fallbackRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', evaluationId: 'BTCUSDT|95|TREND_RIDER|0', setupType: 'FVG' }),
      fallbackRow({ candidateKey: 'BTCUSDT|LONG|SWEEP|100|91', evaluationId: 'BTCUSDT|95|TREND_RIDER|0', setupType: 'SWEEP' }),
    ];
    const result = computeFallbackReconciliation(rows, rows.map(classificationOf));
    expect(result.duplicateFallbackEvaluationIds).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('13) an OB row and a FVG row sharing the same evaluationId is EXPECTED/NORMAL and must NOT fail the gate', () => {
    const ob = obRow({ candidateKey: 'BTCUSDT|LONG|OB|100|90', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' });
    const fvg = fallbackRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|91', evaluationId: 'BTCUSDT|95|TREND_RIDER|0' });
    const rows = [ob, fvg];
    const result = computeFallbackReconciliation(rows, rows.map(classificationOf));
    expect(result.duplicateFallbackEvaluationIds).toBe(0);
    expect(result.reconciliationPass).toBe(true);
  });

  it('14) invalid/unrecognized setupType value flips reconciliationPass to false', () => {
    const bogus: ForensicTelemetryRow = { ...fallbackRow({ candidateKey: 'k1' }), setupType: 'BOGUS' as unknown as ForensicSetupType };
    const result = computeFallbackReconciliation([bogus], [classificationOf(bogus)]);
    expect(result.invalidSetupTypeCount).toBe(1);
    expect(result.countsReconcile).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });

  it('15) classification breakdown sum not reconciling against the fallback total flips reconciliationPass to false', () => {
    // A row whose own combinedClass is not one of CLEAN/TIMESTAMP_ONLY/GEOMETRY_ONLY/BOTH: it is
    // still counted in `fallbackRowCount` (it IS a real FVG/SWEEP row) but cannot land in any of the
    // four named breakdown buckets, so `fallbackCombinedSum` structurally falls short of
    // `fallbackRowCount` — proving the sum-reconciliation check is real, not tautological.
    const base = fallbackRow({ candidateKey: 'k1' });
    const bogus: ForensicTelemetryRow = { ...base, combinedClass: 'NOT_A_REAL_BUCKET' as unknown as ForensicTelemetryRow['combinedClass'] };
    const result = computeFallbackReconciliation([bogus], [classificationOf(bogus)]);
    expect(result.fallbackCombinedSum).toBeLessThan(result.fallbackRowCount);
    expect(result.countsReconcile).toBe(false);
    expect(result.reconciliationPass).toBe(false);
  });

  // ============================== TICKET-G6R-CP3HR3 Task 3 / required tests 10-11 ==============================
  //
  // combinedClass only encodes clean/dirty PER AXIS, not which specific sub-class — so it is possible
  // to construct two rows where combinedClass agrees "by coincidence" while the underlying
  // timestampClass (or geometryClass) sub-label genuinely differs. Before TICKET-G6R-CP3HR3 this could
  // slip past `joinLedgerAndClassification()`'s combinedClass-only check entirely.

  it('10) timestampClass mismatch between ledger and classification while combinedClass still agrees -> fails via the new component-level check', () => {
    // Ledger: timestampClass=UNCLOSED_INPUT_READ (dirty), geometryClass=CLEAN -> combinedClass=TIMESTAMP_ONLY.
    const ledger = fallbackRow({ candidateKey: 'k1' });
    const dirtyLedger: ForensicTelemetryRow = { ...ledger, timestampClass: 'UNCLOSED_INPUT_READ', geometryClass: 'CLEAN', combinedClass: 'TIMESTAMP_ONLY' };
    // Classification: a DIFFERENT dirty timestamp sub-class (READ_AFTER_DECISION_TIMESTAMP), geometryClass=CLEAN -> combinedClass ALSO TIMESTAMP_ONLY (agrees "by coincidence").
    const classification: ClassificationCsvRow = { ...classificationOf(ledger), timestampClass: 'READ_AFTER_DECISION_TIMESTAMP', geometryClass: 'CLEAN', combinedClass: 'TIMESTAMP_ONLY' };

    const join = joinLedgerAndClassification([dirtyLedger], [classification]);
    expect(join.combinedClassMismatches).toHaveLength(0); // combinedClass genuinely agrees
    expect(join.timestampClassMismatches).toHaveLength(1); // but the component-level check catches the real disagreement
    expect(join.geometryClassMismatches).toHaveLength(0);

    const result = computeFallbackReconciliation([dirtyLedger], [classification]);
    expect(result.timestampClassMismatches).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('11) geometryClass mismatch between ledger and classification while combinedClass still agrees -> fails via the new component-level check', () => {
    // Ledger: geometryClass=RAW_ALREADY_WRONG_SIDE (dirty), timestampClass=CLEAN -> combinedClass=GEOMETRY_ONLY.
    const ledger = fallbackRow({ candidateKey: 'k1' });
    const dirtyLedger: ForensicTelemetryRow = { ...ledger, timestampClass: 'CLEAN', geometryClass: 'RAW_ALREADY_WRONG_SIDE', combinedClass: 'GEOMETRY_ONLY' };
    // Classification: a DIFFERENT dirty geometry sub-class (FINAL_WRONG_SIDE_AFTER_BUFFER), timestampClass=CLEAN -> combinedClass ALSO GEOMETRY_ONLY.
    const classification: ClassificationCsvRow = { ...classificationOf(ledger), timestampClass: 'CLEAN', geometryClass: 'FINAL_WRONG_SIDE_AFTER_BUFFER', combinedClass: 'GEOMETRY_ONLY' };

    const join = joinLedgerAndClassification([dirtyLedger], [classification]);
    expect(join.combinedClassMismatches).toHaveLength(0);
    expect(join.geometryClassMismatches).toHaveLength(1);
    expect(join.timestampClassMismatches).toHaveLength(0);

    const result = computeFallbackReconciliation([dirtyLedger], [classification]);
    expect(result.geometryClassMismatches).toBe(1);
    expect(result.reconciliationPass).toBe(false);
  });

  it('16) the current REAL, unmodified files revalidate cleanly: all defect counts zero, reconciliationPass = true (positive control)', () => {
    const REPO_ROOT = path.resolve(__dirname, '../../..');
    const ledgerCsvText = readFileSync(path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv'), 'utf8');
    const classificationCsvText = readFileSync(path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-classification.csv'), 'utf8');
    const ledgerRows = parseForensicLedgerCsv(ledgerCsvText);
    const classificationRows = parseClassificationCsv(classificationCsvText);
    const result = computeFallbackReconciliation(ledgerRows, classificationRows);

    expect(result.totalLedgerRows).toBe(209);
    expect(result.obDiagnosticRowCount).toBe(104);
    expect(result.fallbackRowCount).toBe(105);
    expect(result.fvgCount).toBe(93);
    expect(result.sweepCount).toBe(12);
    expect(result.fallbackCombinedBreakdown).toEqual({ CLEAN: 10, TIMESTAMP_ONLY: 64, GEOMETRY_ONLY: 3, BOTH: 28 });
    expect(result.fallbackTimestampInvalidCount).toBe(92);
    expect(result.fallbackGeometryInvalidCount).toBe(31);

    expect(result.duplicateLedgerCandidateKeys).toBe(0);
    expect(result.duplicateFallbackCandidateKeys).toBe(0);
    expect(result.duplicateClassificationCandidateKeys).toBe(0);
    expect(result.duplicateFallbackEvaluationIds).toBe(0);
    expect(result.identityMismatches).toBe(0);
    expect(result.classificationMismatches).toBe(0);
    expect(result.timestampClassMismatches).toBe(0);
    expect(result.geometryClassMismatches).toBe(0);
    expect(result.invalidSetupTypeCount).toBe(0);
    expect(result.countsReconcile).toBe(true);
    expect(result.joinsClean).toBe(true);
    expect(result.reconciliationPass).toBe(true);

    // Independent, standalone confirmation of the recompute step (Task 1 item 8/9/10) on all 209 rows.
    const recomputed = recomputeAndCompareClassification(ledgerRows);
    expect(recomputed).toHaveLength(0);
  });
});
