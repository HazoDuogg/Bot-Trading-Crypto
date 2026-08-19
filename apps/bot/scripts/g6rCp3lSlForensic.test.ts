process.env.T153_LIBRARY_MODE = 'true';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  selectGeometryInvalidRows,
  crossCheckGeometryClassification,
  classifyRootCause,
  findStaleReferenceGroups,
  assembleCp3lTelemetryRow,
  summarizeBucketTotals,
  assembleCp3lGateDecision,
} from './g6rCp3lSlForensic.js';
import { parseForensicLedgerCsv, classifyGeometryAndAttributeSl, type ForensicTelemetryRow, type FallbackForensicTelemetryRow } from './g6rCp3hForensicSchema.js';

/**
 * G6R CP3L tests. Every test below calls the REAL, already-frozen `classifyGeometryAndAttributeSl()`
 * and `parseForensicLedgerCsv()` (via `g6rCp3hForensicSchema.ts`) — read-only dependencies, never
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
    timestampClass: 'CLEAN',
    geometryClass: 'CLEAN',
    combinedClass: 'CLEAN',
    registrationDocumentSha256: 'a'.repeat(64),
    analyzerSourceHash: 'b'.repeat(64),
    evaluationIdSchemaValid: true,
    candidateKeySchemaValid: true,
  };
  return { ...base, ...overrides } as FallbackForensicTelemetryRow;
}

/** Runs the row through the real classifyGeometryAndAttributeSl() and copies its result onto the row, so fixtures are internally consistent (never hand-typed guesses of what the classifier would say). */
function withRealGeometry(row: FallbackForensicTelemetryRow): FallbackForensicTelemetryRow {
  const g = classifyGeometryAndAttributeSl({
    side: row.side,
    rawSlPrice: row.rawSlPrice,
    atr: row.atr,
    bufferAmount: row.bufferAmount,
    entryPrice: row.entryPrice,
    slPrice: row.slPrice,
    slDistance: row.slDistance,
  });
  const combinedClass = row.timestampClass === 'CLEAN' ? (g.geometryClass === 'CLEAN' ? 'CLEAN' : 'GEOMETRY_ONLY') : g.geometryClass === 'CLEAN' ? 'TIMESTAMP_ONLY' : 'BOTH';
  return {
    ...row,
    geometryClass: g.geometryClass,
    geometryFailureStage: g.geometryClass,
    bufferSignCorrect: g.bufferSignCorrect,
    bufferEffect: g.bufferEffect,
    entryCrossedRawZone: g.entryCrossedRawZone,
    rawSlToEntryDistance: g.rawSlToEntryDistance,
    combinedClass,
  };
}

// ============================== LONG/SHORT mirror ==============================

describe('CP3L classifyRootCause — LONG/SHORT mirror', () => {
  it('classifies a LONG raw-wrong-side row (rawSlPrice above entry) as RAW_ALREADY_WRONG_SIDE', () => {
    const row = withRealGeometry(makeRow({ side: 'LONG', rawSlPrice: 110, slPrice: 108, slDistance: 8 }));
    expect(row.geometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('RAW_ALREADY_WRONG_SIDE');
  });

  it('classifies a SHORT raw-wrong-side row (rawSlPrice below entry) as RAW_ALREADY_WRONG_SIDE, symmetric to the LONG case', () => {
    const row = withRealGeometry(makeRow({ side: 'SHORT', rawSlPrice: 90, slPrice: 92, slDistance: 8, entryPrice: 100 }));
    expect(row.geometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('RAW_ALREADY_WRONG_SIDE');
    // Symmetric to the LONG case above: same bucket, same evidence shape, only the sign direction differs.
    expect(result.evidence).toContain('RAW_ALREADY_WRONG_SIDE');
  });
});

// ============================== Raw valid -> final valid (CLEAN contrast) ==============================

describe('CP3L classifyRootCause — CLEAN row contrast', () => {
  it('does not misclassify a geometry-CLEAN row into a concrete invalid bucket', () => {
    const row = makeRow({}); // default fixture is CLEAN
    expect(row.geometryClass).toBe('CLEAN');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.evidence).toContain('CLEAN');
  });
});

// ============================== Raw invalid -> buffer sửa được (IMPROVED) ==============================

describe('CP3L classifyRootCause — buffer improves geometry', () => {
  it('a row where rawSlPrice is wrong-side but the buffer pushes slPrice back to valid-side (bufferEffect=IMPROVED) is geometry-CLEAN, not a root-cause bucket', () => {
    // LONG: rawSlPrice(101) >= entryPrice(100) -> raw wrong side; buffer of 5 pushes slPrice to 96, valid side.
    const row = withRealGeometry(makeRow({ side: 'LONG', rawSlPrice: 101, bufferAmount: 5, slPrice: 96, slDistance: 4, entryPrice: 100 }));
    expect(row.bufferEffect).toBe('IMPROVED');
    expect(row.geometryClass).toBe('CLEAN');
  });
});

// ============================== Raw invalid -> buffer không đủ (INSUFFICIENT) ==============================

describe('CP3L classifyRootCause — buffer insufficient to fix raw-wrong-side geometry', () => {
  it('a row where rawSlPrice is wrong-side and the buffer does not push slPrice back to valid-side (bufferEffect=INSUFFICIENT) classifies as RAW_ALREADY_WRONG_SIDE', () => {
    const row = withRealGeometry(makeRow({ side: 'LONG', rawSlPrice: 110, bufferAmount: 1, slPrice: 109, slDistance: 9, entryPrice: 100 }));
    expect(row.bufferEffect).toBe('INSUFFICIENT');
    expect(row.geometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('RAW_ALREADY_WRONG_SIDE');
  });
});

// ============================== Non-finite / zero ATR ==============================

describe('CP3L classifyRootCause — non-finite geometry', () => {
  it('classifies a row with non-finite ATR as ATR_BUFFER_INVALID', () => {
    const row = withRealGeometry(makeRow({ atr: NaN }));
    expect(row.geometryClass).toBe('NON_FINITE_GEOMETRY');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('ATR_BUFFER_INVALID');
  });

  it('classifies a row with zero bufferAmount combined with non-finite slDistance as ATR_BUFFER_INVALID', () => {
    const row = withRealGeometry(makeRow({ bufferAmount: 0, slDistance: Infinity }));
    expect(row.geometryClass).toBe('NON_FINITE_GEOMETRY');
    const result = classifyRootCause({
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
    expect(result.bucket).toBe('ATR_BUFFER_INVALID');
  });
});

// ============================== Price crosses zone before availability ==============================

describe('CP3L classifyRootCause — price crosses before decision availability', () => {
  it('classifies FINAL_WRONG_SIDE_AFTER_BUFFER with entryCrossedRawZone=false as PRICE_CROSSED_BEFORE_DECISION, distinct from RAW_ALREADY_WRONG_SIDE', () => {
    // LONG: rawSlPrice(95) < entryPrice(100) -> raw was valid side. Buffer(6) pushes slPrice to 89... but to
    // force FINAL_WRONG_SIDE_AFTER_BUFFER we need slPrice to end up >= entryPrice while rawSlPrice was < entryPrice,
    // which the registered sign convention (slPrice = rawSlPrice - bufferAmount for LONG) cannot produce with a
    // non-negative buffer — this is exactly the ticket's disclosed "mathematically not expected" case for WORSENED,
    // so FINAL_WRONG_SIDE_AFTER_BUFFER with entryCrossedRawZone=false is constructed directly at the classifier-input
    // level (as the real 31-row population never contains it either, confirmed by the positive-control test below).
    const result = classifyRootCause({
      geometryFailureStage: 'FINAL_WRONG_SIDE_AFTER_BUFFER',
      entryCrossedRawZone: false,
      bufferEffect: 'WORSENED',
      bufferSignCorrect: true,
      rawSlPrice: 95,
      atr: 5,
      bufferAmount: 6,
      entryPrice: 100,
      slPrice: 101,
      slDistance: 1,
    });
    // bufferEffect=WORSENED takes precedence per this classifier's own bucket-precedence ordering (mirrors the
    // ticket's explicit instruction to flag WORSENED as its own bucket first, before RAW/FINAL sign buckets).
    expect(result.bucket).toBe('BUFFER_WORSENED');

    const distinctResult = classifyRootCause({
      geometryFailureStage: 'FINAL_WRONG_SIDE_AFTER_BUFFER',
      entryCrossedRawZone: false,
      bufferEffect: 'INSUFFICIENT',
      bufferSignCorrect: true,
      rawSlPrice: 95,
      atr: 5,
      bufferAmount: 6,
      entryPrice: 100,
      slPrice: 101,
      slDistance: 1,
    });
    expect(distinctResult.bucket).toBe('PRICE_CROSSED_BEFORE_DECISION');
    // Distinct mechanism from RAW_ALREADY_WRONG_SIDE: this bucket requires entryCrossedRawZone=false (raw was
    // valid-side at formation), whereas RAW_ALREADY_WRONG_SIDE requires entryCrossedRawZone=true.
    expect(distinctResult.bucket).not.toBe('RAW_ALREADY_WRONG_SIDE');
  });
});

// ============================== Missing evidence -> INSUFFICIENT_EVIDENCE, never guessed ==============================

describe('CP3L classifyRootCause — missing/unmatched evidence forces INSUFFICIENT_EVIDENCE', () => {
  it('a field combination that matches no concrete bucket (e.g. a stray geometryFailureStage not modeled by any bucket) forces INSUFFICIENT_EVIDENCE rather than a guess', () => {
    const result = classifyRootCause({
      // entryCrossedRawZone=true paired with FINAL_WRONG_SIDE_AFTER_BUFFER never occurs under the real
      // classifyGeometryAndAttributeSl() (entryCrossedRawZone=true always pairs with RAW_ALREADY_WRONG_SIDE),
      // so this combination has no concrete bucket to map to — must fall through to INSUFFICIENT_EVIDENCE.
      geometryFailureStage: 'FINAL_WRONG_SIDE_AFTER_BUFFER',
      entryCrossedRawZone: true,
      bufferEffect: 'INSUFFICIENT',
      bufferSignCorrect: true,
      rawSlPrice: 95,
      atr: 5,
      bufferAmount: 6,
      entryPrice: 100,
      slPrice: 101,
      slDistance: 1,
    });
    expect(result.bucket).toBe('INSUFFICIENT_EVIDENCE');
  });
});

// ============================== Geometry cross-check ==============================

describe('CP3L crossCheckGeometryClassification', () => {
  it('matches when the row was built from the real classifyGeometryAndAttributeSl() output', () => {
    const row = withRealGeometry(makeRow({ side: 'LONG', rawSlPrice: 110, slPrice: 108, slDistance: 8 }));
    const cross = crossCheckGeometryClassification(row);
    expect(cross.match).toBe(true);
  });

  it('flags a mismatch when the persisted geometryClass disagrees with a fresh call over the same raw inputs', () => {
    const row = withRealGeometry(makeRow({ side: 'LONG', rawSlPrice: 110, slPrice: 108, slDistance: 8 }));
    const tampered = { ...row, geometryClass: 'CLEAN' as const };
    const cross = crossCheckGeometryClassification(tampered);
    expect(cross.match).toBe(false);
  });
});

// ============================== Stale reference investigation ==============================

describe('CP3L findStaleReferenceGroups', () => {
  it('finds no groups when every row has a unique symbol/side/setupType/sourceTimestamp', () => {
    const rows = [
      withRealGeometry(makeRow({ candidateKey: 'K1', sourceTimestamp: T0, rawSlPrice: 110, slPrice: 108, slDistance: 8 })),
      withRealGeometry(makeRow({ candidateKey: 'K2', sourceTimestamp: T0 + 1000, rawSlPrice: 110, slPrice: 108, slDistance: 8 })),
    ];
    expect(findStaleReferenceGroups(rows)).toHaveLength(0);
  });

  it('finds a group when two rows share symbol/side/setupType/sourceTimestamp but differ in decisionTimestamp', () => {
    const rows = [
      withRealGeometry(makeRow({ candidateKey: 'K1', sourceTimestamp: T0, decisionTimestamp: T0 + 100_000, rawSlPrice: 110, slPrice: 108, slDistance: 8 })),
      withRealGeometry(makeRow({ candidateKey: 'K2', sourceTimestamp: T0, decisionTimestamp: T0 + 200_000, rawSlPrice: 110, slPrice: 108, slDistance: 8 })),
    ];
    const groups = findStaleReferenceGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidateKeys).toEqual(['K1', 'K2']);
  });
});

// ============================== Classification totals reconcile to 31 (positive control) ==============================

describe('CP3L positive control — real frozen 31-row population', () => {
  const ledgerCsvPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
  const ledgerRows = parseForensicLedgerCsv(readFileSync(ledgerCsvPath, 'utf8'));
  const geometryInvalidRows = selectGeometryInvalidRows(ledgerRows);

  it('selects exactly 31 geometry-invalid fallback rows from the real frozen ledger', () => {
    expect(geometryInvalidRows.length).toBe(31);
    expect(geometryInvalidRows.every((r) => r.setupType === 'FVG' || r.setupType === 'SWEEP')).toBe(true);
    expect(geometryInvalidRows.every((r) => r.combinedClass === 'GEOMETRY_ONLY' || r.combinedClass === 'BOTH')).toBe(true);
  });

  it('every real row passes the frozen-classifier cross-check (byte-identical to the frozen CSV columns)', () => {
    for (const row of geometryInvalidRows) {
      const cross = crossCheckGeometryClassification(row);
      expect(cross.match).toBe(true);
    }
  });

  it('bucket totals over the real 31 rows reconcile exactly to 31', () => {
    const telemetryRows = geometryInvalidRows.map((r) => assembleCp3lTelemetryRow(r, 'c'.repeat(64)));
    const totals = summarizeBucketTotals(telemetryRows);
    expect(totals.total).toBe(31);
    expect(totals.reconciles).toBe(true);
    const sum =
      totals.RAW_ALREADY_WRONG_SIDE +
      totals.BUFFER_WORSENED +
      totals.PRICE_CROSSED_BEFORE_DECISION +
      totals.FALLBACK_REUSE_STALE_REFERENCE +
      totals.ATR_BUFFER_INVALID +
      totals.DISTANCE_MISMATCH +
      totals.INSUFFICIENT_EVIDENCE +
      totals.OTHER_WITH_EVIDENCE;
    expect(sum).toBe(31);
  });

  it('assembles a gate decision consistent with the real bucket totals (no forced CONFIRMED if insufficient/other rows exist)', () => {
    const telemetryRows = geometryInvalidRows.map((r) => assembleCp3lTelemetryRow(r, 'c'.repeat(64)));
    const totals = summarizeBucketTotals(telemetryRows);
    const decision = assembleCp3lGateDecision(totals);
    if (totals.INSUFFICIENT_EVIDENCE + totals.OTHER_WITH_EVIDENCE === 0) {
      expect(decision).toBe('SL_ROOT_CAUSE_CONFIRMED');
    } else if (totals.INSUFFICIENT_EVIDENCE + totals.OTHER_WITH_EVIDENCE === totals.total) {
      expect(decision).toBe('SL_EVIDENCE_INSUFFICIENT');
    } else {
      expect(decision).toBe('SL_ROOT_CAUSE_PARTIAL');
    }
  });
});

// ============================== Missing evidence -> INSUFFICIENT_EVIDENCE fixture (null field) ==============================

describe('CP3L classifyRootCause — genuinely missing/null evidence', () => {
  it('a synthetic row with a non-finite (missing) atr and a geometryFailureStage the classifier never actually produces for that condition still resolves through the non-finite branch, never guessed', () => {
    // Simulates "missing" evidence: atr is NaN (as if never persisted/collected), independent of whatever
    // geometryFailureStage label happens to be attached — the non-finite check must win regardless.
    const result = classifyRootCause({
      geometryFailureStage: 'RAW_ALREADY_WRONG_SIDE',
      entryCrossedRawZone: true,
      bufferEffect: 'INSUFFICIENT',
      bufferSignCorrect: true,
      rawSlPrice: 110,
      atr: NaN,
      bufferAmount: 1,
      entryPrice: 100,
      slPrice: 108,
      slDistance: 8,
    });
    expect(result.bucket).toBe('ATR_BUFFER_INVALID');
  });
});
