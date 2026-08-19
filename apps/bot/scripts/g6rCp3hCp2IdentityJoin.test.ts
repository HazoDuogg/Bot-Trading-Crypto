process.env.T153_LIBRARY_MODE = 'true';
/**
 * TICKET-G6R-CP3HR3 — Task 1: tests for CP2 evaluation-level identity join validation.
 *
 * These tests NEVER import a replay runner. They exercise pure functions from
 * g6rCp3hCp2IdentityJoin.ts, and separately read (never write) the real, frozen
 * g6r-cp3h-shadow-forensic-ledger.csv + g6r-cp2-evaluations.csv to prove the tool's real output
 * against real data (positive control).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCp2EvaluationsCsv, computeCp2IdentityValidation, type Cp2EvaluationRow } from './g6rCp3hCp2IdentityJoin.js';
import { parseForensicLedgerCsv, assembleForensicRow, type ForensicTelemetryRow, type ForensicShadowEventLike } from './g6rCp3hForensicSchema.js';
import type { DecisionFeatureProvenance } from './g6rShadowAnalyzer.js';

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

function ledgerRow(overrides: Partial<ForensicShadowEventLike> = {}): ForensicTelemetryRow {
  const event: ForensicShadowEventLike = {
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
  return assembleForensicRow({
    event,
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

function cp2Row(overrides: Partial<Cp2EvaluationRow> = {}): Cp2EvaluationRow {
  return {
    evaluationId: 'BTCUSDT|95|TREND_RIDER|0',
    symbol: 'BTCUSDT',
    regime: 'TREND_RIDER',
    evaluationTimestamp: 95,
    routeInvocationOrdinal: 0,
    terminalOutcome: 'DETECTOR_NOT_FOUND',
    terminalReason: 'NO_EDGE_TOUCH',
    dataQuality: 'DQ-B — COMPARABLE_WITH_LIMITATIONS',
    ...overrides,
  };
}

describe('parseCp2EvaluationsCsv', () => {
  it('parses required columns and fails closed on a missing column', () => {
    const text = 'evaluationId,symbol,regime,evaluationTimestamp,routeInvocationOrdinal,terminalOutcome,terminalReason,dataQuality\r\n"BTCUSDT|95|TREND_RIDER|0",BTCUSDT,TREND_RIDER,95,0,DETECTOR_NOT_FOUND,NO_EDGE_TOUCH,"DQ-B"\r\n';
    const rows = parseCp2EvaluationsCsv(text);
    expect(rows).toEqual([{ evaluationId: 'BTCUSDT|95|TREND_RIDER|0', symbol: 'BTCUSDT', regime: 'TREND_RIDER', evaluationTimestamp: 95, routeInvocationOrdinal: 0, terminalOutcome: 'DETECTOR_NOT_FOUND', terminalReason: 'NO_EDGE_TOUCH', dataQuality: 'DQ-B' }]);
    expect(() => parseCp2EvaluationsCsv('evaluationId,symbol\r\nx,y\r\n')).toThrow(/missing required column/);
  });

  it('fails closed when CP2 identity components are non-numeric or non-integer', () => {
    const header = 'evaluationId,symbol,regime,evaluationTimestamp,routeInvocationOrdinal,terminalOutcome,terminalReason,dataQuality\r\n';
    expect(() => parseCp2EvaluationsCsv(header + '"BTCUSDT|95|TREND_RIDER|0",BTCUSDT,TREND_RIDER,not-a-number,0,DETECTOR_NOT_FOUND,NO_EDGE_TOUCH,DQ-B\r\n')).toThrow(/evaluationTimestamp/);
    expect(() => parseCp2EvaluationsCsv(header + '"BTCUSDT|95|TREND_RIDER|0",BTCUSDT,TREND_RIDER,95,0.5,DETECTOR_NOT_FOUND,NO_EDGE_TOUCH,DQ-B\r\n')).toThrow(/routeInvocationOrdinal/);
  });
});

describe('computeCp2IdentityValidation — fail-closed defect categories (Task 1 required tests 1-5)', () => {
  it('1) CP2 evaluation missing (evaluationId not in g6r-cp2-evaluations.csv) -> identity check fails', () => {
    const rows = [ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0' })];
    const result = computeCp2IdentityValidation(rows, []); // no CP2 rows at all
    expect(result.missingCp2EvaluationJoins).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'MISSING_CP2_EVALUATION_JOIN')).toBe(true);
  });

  it('2) evaluationId malformed (wrong formula shape) -> fails', () => {
    const rows = [ledgerRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', evaluationId: 'not-a-valid-evaluation-id' })];
    const result = computeCp2IdentityValidation(rows, [cp2Row({ evaluationId: 'not-a-valid-evaluation-id' })]);
    expect(result.malformedEvaluationIdCount).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'MALFORMED_EVALUATION_ID_FORMAT')).toBe(true);
  });

  it('3) candidateKey malformed (wrong formula shape) -> fails', () => {
    const built = ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0' });
    const corrupted: ForensicTelemetryRow = { ...built, candidateKey: 'TOTALLY|WRONG|KEY' };
    const result = computeCp2IdentityValidation([corrupted], [cp2Row()]);
    expect(result.malformedCandidateKeyCount).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'MALFORMED_CANDIDATE_KEY_FORMAT')).toBe(true);
  });

  it('4) one identity component (symbol) differs from the matched CP2 evaluation row -> fails', () => {
    const rows = [ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0', symbol: 'BTCUSDT' })];
    const result = computeCp2IdentityValidation(rows, [cp2Row({ symbol: 'ETHUSDT' })]);
    expect(result.symbolMismatchCount).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'IDENTITY_COMPONENT_MISMATCH' && v.detail.includes('symbol'))).toBe(true);
  });

  it('4b) one identity component (regime) differs from the matched CP2 evaluation row -> fails', () => {
    const rows = [ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0', regime: 'TREND_RIDER' })];
    const result = computeCp2IdentityValidation(rows, [cp2Row({ regime: 'SIDEWAY_SCALPER' })]);
    expect(result.regimeMismatchCount).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'IDENTITY_COMPONENT_MISMATCH' && v.detail.includes('regime'))).toBe(true);
  });

  it('4c) CP2 evaluationId must equal the canonical ID rebuilt from its own component columns', () => {
    const result = computeCp2IdentityValidation(
      [ledgerRow()],
      [cp2Row({ evaluationTimestamp: 96 })],
    );
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'CP2_EVALUATION_ID_FORMULA_MISMATCH')).toBe(true);
  });

  it('4d) ledger evaluationTimestamp must equal the uniquely joined CP2 evaluation timestamp', () => {
    const result = computeCp2IdentityValidation(
      [ledgerRow({ evaluationTimestamp: 96 })],
      [cp2Row()],
    );
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'IDENTITY_COMPONENT_MISMATCH' && v.detail.includes('evaluationTimestamp'))).toBe(true);
  });

  it('5) ambiguous/duplicate CP2 evaluationId (synthetic duplicate in fixture data, not the real frozen CSV) -> fails', () => {
    const rows = [ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0' })];
    const cp2Rows = [cp2Row(), cp2Row()]; // two CP2 rows claiming the same evaluationId
    const result = computeCp2IdentityValidation(rows, cp2Rows);
    expect(result.ambiguousCp2EvaluationIds).toBe(1);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.category === 'AMBIGUOUS_CP2_JOIN_TARGET')).toBe(true);
    // The ledger row referencing the now-ambiguous evaluationId cannot be treated as joined either.
    expect(result.missingCp2EvaluationJoins).toBe(1);
  });

  it('passes cleanly on a well-formed, uniquely-joined, identity-matching row', () => {
    const rows = [ledgerRow({ evaluationId: 'BTCUSDT|95|TREND_RIDER|0' })];
    const result = computeCp2IdentityValidation(rows, [cp2Row()]);
    expect(result.pass).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('discloses the candidateKey-vs-CP2-candidates.csv scope decision explicitly (never silently omitted)', () => {
    const result = computeCp2IdentityValidation([], []);
    expect(result.candidateKeyVsCp2CandidatesCsvScopeNote).toMatch(/g6r-cp2-candidates\.csv/);
    expect(result.candidateKeyVsCp2CandidatesCsvScopeNote).toMatch(/FVG\/SWEEP/);
  });
});

describe('computeCp2IdentityValidation — positive control on real, frozen CP3H + CP2 evidence', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const cp2EvaluationsPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp2-evaluations.csv');

  it('every one of the 209 real CP3H ledger evaluationIds is found (uniquely) in the real g6r-cp2-evaluations.csv, with matching canonical identity components', () => {
    const ledgerRows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));
    const cp2Rows = parseCp2EvaluationsCsv(readFileSync(cp2EvaluationsPath, 'utf8'));
    expect(ledgerRows).toHaveLength(209);

    const result = computeCp2IdentityValidation(ledgerRows, cp2Rows);

    expect(result.totalLedgerRows).toBe(209);
    expect(result.missingCp2EvaluationJoins).toBe(0);
    expect(result.malformedEvaluationIdCount).toBe(0);
    expect(result.malformedCandidateKeyCount).toBe(0);
    expect(result.symbolMismatchCount).toBe(0);
    expect(result.regimeMismatchCount).toBe(0);
    expect(result.ambiguousCp2EvaluationIds).toBe(0);
    expect(result.pass).toBe(true);
  }, 15_000);
});
