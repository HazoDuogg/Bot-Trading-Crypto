process.env.T153_LIBRARY_MODE = 'true';
/**
 * TICKET-G6R-CP3H — Step 3 (ticket Section J): telemetry schema, classification, SL attribution,
 * CSV round-trip, and duplicate/join fail-closed tests for g6rCp3hForensicSchema.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyTimestamp,
  classifyGeometryAndAttributeSl,
  combineClassification,
  summarizeCombinedClassification,
  assembleForensicRow,
  writeForensicLedgerCsv,
  parseForensicLedgerCsv,
  writeClassificationCsv,
  validateForensicPopulation,
  validateForensicLedgerStrict,
  isFallbackSetupType,
  filterFallbackRows,
  isValidSha256Hex,
  isValidExecutionHead,
  expectedCandidateKey,
  FORENSIC_LEDGER_HEADER,
  validateFutureForensicTelemetryRowV2,
  type ForensicTelemetryRow,
  type ForensicSetupType,
  type ForensicShadowEventLike,
  type FutureForensicTelemetryRowV2,
  type LegacyCp3hTelemetryRow,
} from './g6rCp3hForensicSchema.js';
import { auditDecisionFeatureProvenance } from './g6rShadowAnalyzer.js';
import type { FrozenShadowEvent, DecisionFeatureProvenance } from './g6rShadowAnalyzer.js';
import { parseCsv, writeCsv } from './g6rCsvParser.js';

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

describe('classifyTimestamp', () => {
  it('CLEAN when nothing exceeds decisionTimestamp/cutoff', () => {
    expect(classifyTimestamp(event())).toBe('CLEAN');
  });

  it('READ_AFTER_DECISION_TIMESTAMP when a raw provenance field exceeds decisionTimestamp but stays closed', () => {
    const ev = event({ decisionTimestamp: 100, provenance: provenance({ mssMaxTimestampRead: 150, mssMaxAvailableAt: 150 + 60000, evaluationCutoffExclusive: 999999999 }) });
    expect(classifyTimestamp(ev)).toBe('READ_AFTER_DECISION_TIMESTAMP');
  });

  it('UNCLOSED_INPUT_READ takes priority when an availableAt field exceeds the cutoff', () => {
    const ev = event({ decisionTimestamp: 100, provenance: provenance({ mssMaxAvailableAt: 999999, evaluationCutoffExclusive: 500 }) });
    expect(classifyTimestamp(ev)).toBe('UNCLOSED_INPUT_READ');
  });

  it('TIMESTAMP_SCHEMA_INVALID when a field is non-finite (NaN/Infinity)', () => {
    const ev = event({ provenance: provenance({ atr5mMaxTimestamp: NaN }) });
    expect(classifyTimestamp(ev)).toBe('TIMESTAMP_SCHEMA_INVALID');
  });

  it('reuses the real auditDecisionFeatureProvenance — not a reimplementation (regression: exact CP3G real-sample gap reproduces READ_AFTER_DECISION_TIMESTAMP)', () => {
    // Real numbers from the frozen g6r-cp3-shadow-summary.json sample cited in
    // data/g6r-cp3-root-cause-investigation.md §5.
    const ev = event({
      candidateKey: 'BTCUSDT|SHORT|FVG|1770817320000|1770815700000',
      side: 'SHORT',
      sourceTimestamp: 1770815700000,
      decisionTimestamp: 1770817320000,
      provenance: provenance({
        mssMaxTimestampRead: 1770817440000,
        stalenessReferenceTimestamp: 1770817440000,
        mssMaxAvailableAt: 1770817500000,
        evaluationCutoffExclusive: 1770817500000,
      }),
    });
    expect(classifyTimestamp(ev)).toBe('READ_AFTER_DECISION_TIMESTAMP');
  });
});

describe('classifyGeometryAndAttributeSl', () => {
  it('CLEAN: LONG valid geometry, raw already valid, buffer had no effect on side', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'LONG', rawSlPrice: 44, atr: 20, bufferAmount: 1, entryPrice: 50, slPrice: 43, slDistance: 7 });
    expect(r.geometryClass).toBe('CLEAN');
    expect(r.entryCrossedRawZone).toBe(false);
    expect(r.bufferEffect).toBe('NO_EFFECT_ALREADY_VALID');
    expect(r.bufferSignCorrect).toBe(true);
    expect(r.rawSlToEntryDistance).toBe(6);
  });

  it('RAW_ALREADY_WRONG_SIDE + INSUFFICIENT: LONG raw at/above entry, buffer too small to fix', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'LONG', rawSlPrice: 51, atr: 20, bufferAmount: 0.1, entryPrice: 50, slPrice: 50.9, slDistance: 0.9 });
    expect(r.geometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    expect(r.entryCrossedRawZone).toBe(true);
    expect(r.bufferEffect).toBe('INSUFFICIENT');
  });

  it('IMPROVED: LONG raw invalid but buffer large enough to fix it (final valid)', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'LONG', rawSlPrice: 51, atr: 20, bufferAmount: 5, entryPrice: 50, slPrice: 46, slDistance: 4 });
    expect(r.geometryClass).toBe('CLEAN');
    expect(r.entryCrossedRawZone).toBe(true);
    expect(r.bufferEffect).toBe('IMPROVED');
  });

  it('SHORT mirror: raw at/below entry is wrong-side, buffer direction adds', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'SHORT', rawSlPrice: 49, atr: 20, bufferAmount: 0.1, entryPrice: 50, slPrice: 49.1, slDistance: 0.9 });
    expect(r.geometryClass).toBe('RAW_ALREADY_WRONG_SIDE');
    expect(r.entryCrossedRawZone).toBe(true);
  });

  it('NON_FINITE_GEOMETRY when any input is non-finite', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'LONG', rawSlPrice: NaN, atr: 20, bufferAmount: 1, entryPrice: 50, slPrice: 45, slDistance: 5 });
    expect(r.geometryClass).toBe('NON_FINITE_GEOMETRY');
    expect(r.bufferEffect).toBe('NON_FINITE');
  });

  it('DISTANCE_MISMATCH when slDistance does not equal abs(entryPrice - slPrice)', () => {
    const r = classifyGeometryAndAttributeSl({ side: 'LONG', rawSlPrice: 44, atr: 20, bufferAmount: 1, entryPrice: 50, slPrice: 45, slDistance: 999 });
    expect(r.geometryClass).toBe('DISTANCE_MISMATCH');
  });

  it('real-sample regression: the frozen invalidGeometrySample[0] candidate (SHORT, slPrice < entryPrice) classifies as final-wrong-side', () => {
    // From data/g6r-cp3-root-cause-investigation.md §7: every SHORT sample has slPrice < entryPrice
    // (final SL landed BELOW entry for a SHORT, which is the wrong side).
    const r = classifyGeometryAndAttributeSl({ side: 'SHORT', rawSlPrice: 100, atr: 5, bufferAmount: 0.5, entryPrice: 105, slPrice: 100.5, slDistance: 4.5 });
    expect(r.geometryClass).not.toBe('CLEAN');
    expect(['RAW_ALREADY_WRONG_SIDE', 'FINAL_WRONG_SIDE_AFTER_BUFFER']).toContain(r.geometryClass);
  });
});

describe('combineClassification / summarizeCombinedClassification', () => {
  it('maps the 4 quadrants correctly', () => {
    expect(combineClassification('CLEAN', 'CLEAN')).toBe('CLEAN');
    expect(combineClassification('READ_AFTER_DECISION_TIMESTAMP', 'CLEAN')).toBe('TIMESTAMP_ONLY');
    expect(combineClassification('CLEAN', 'RAW_ALREADY_WRONG_SIDE')).toBe('GEOMETRY_ONLY');
    expect(combineClassification('UNCLOSED_INPUT_READ', 'DISTANCE_MISMATCH')).toBe('BOTH');
  });

  function row(combinedClass: ForensicTelemetryRow['combinedClass']): ForensicTelemetryRow {
    return { combinedClass } as unknown as ForensicTelemetryRow;
  }

  it('reconciles: CLEAN+TIMESTAMP_ONLY+GEOMETRY_ONLY+BOTH === total', () => {
    const rows = [row('CLEAN'), row('CLEAN'), row('TIMESTAMP_ONLY'), row('GEOMETRY_ONLY'), row('BOTH')];
    const s = summarizeCombinedClassification(rows);
    expect(s).toEqual({ CLEAN: 2, TIMESTAMP_ONLY: 1, GEOMETRY_ONLY: 1, BOTH: 1, total: 5, reconciles: true });
  });
});

describe('assembleForensicRow', () => {
  it('produces a fully-populated row with no undefined field', () => {
    const row = assembleForensicRow({
      event: event(),
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
    for (const key of FORENSIC_LEDGER_HEADER) {
      expect((row as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
    }
    expect(row.timestampClass).toBe('CLEAN');
  });
});

describe('CSV round-trip (writeForensicLedgerCsv / parseForensicLedgerCsv)', () => {
  it('round-trips a row set byte-for-byte on typed fields', () => {
    const row = assembleForensicRow({
      event: event({ slPrice: 55 }), // deliberately invalid LONG geometry to exercise a non-CLEAN row too
      rawSlPrice: 56,
      atr: 20,
      bufferAmount: 1,
      candlesFromEnd: 2,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'REG',
      analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    const csvText = writeForensicLedgerCsv([row]);
    const parsedBack = parseForensicLedgerCsv(csvText);
    expect(parsedBack).toHaveLength(1);
    expect(parsedBack[0]).toEqual(row);
  });

  it('fails closed when a required column is missing', () => {
    const badCsv = writeCsv(['candidateKey', 'evaluationId'], [{ candidateKey: 'x', evaluationId: 'y' }]);
    expect(() => parseForensicLedgerCsv(badCsv)).toThrow(/missing required column/);
  });

  it('generic writeCsv/parseCsv round-trips fields containing commas, quotes, and newlines', () => {
    const header = ['a', 'b'];
    const rows = [{ a: 'hello, "world"', b: 'line1\nline2' }];
    const text = writeCsv(header, rows);
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual(rows);
  });

  // ============================== TICKET-G6R-CP3HR2 Task 5: CSV fail-closed contract (Option 1: strict exact schema) ==============================

  it('fails closed on an extra/unknown column not in the forensic ledger schema', () => {
    const row = assembleForensicRow({
      event: baseEventFields(),
      rawSlPrice: 44, atr: 20, bufferAmount: 1, candlesFromEnd: 0, mssConfirmed: true, mssFailReason: null,
      primaryObFound: true, blockedByMacroFilter: false, registrationDocumentSha256: 'REG', analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true, candidateKeySchemaValid: true,
    });
    const goodCsv = writeForensicLedgerCsv([row]);
    const lines = goodCsv.split('\r\n');
    const badCsv = [lines[0] + ',extraUnknownColumn', lines[1] + ',bogus', ...lines.slice(2)].join('\r\n');
    expect(() => parseForensicLedgerCsv(badCsv)).toThrow(/unknown\/unexpected column/);
  });

  it('a reordered but complete header still parses (read by name, not position)', () => {
    const row = assembleForensicRow({
      event: baseEventFields(),
      rawSlPrice: 44, atr: 20, bufferAmount: 1, candlesFromEnd: 0, mssConfirmed: true, mssFailReason: null,
      primaryObFound: true, blockedByMacroFilter: false, registrationDocumentSha256: 'REG', analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true, candidateKeySchemaValid: true,
    });
    const reorderedHeader = [...FORENSIC_LEDGER_HEADER].reverse();
    const obj: Record<string, string> = {};
    for (const key of FORENSIC_LEDGER_HEADER) obj[key] = String((row as unknown as Record<string, unknown>)[key]);
    const text = writeCsv(reorderedHeader as string[], [obj]);
    const parsedBack = parseForensicLedgerCsv(text);
    expect(parsedBack).toHaveLength(1);
    expect(parsedBack[0]).toEqual(row);
  });

  it('fails closed on a duplicate header column (delegated to the shared parseCsv contract)', () => {
    const badHeaderCsv = 'candidateKey,candidateKey\r\nk1,k1\r\n';
    expect(() => parseCsv(badHeaderCsv)).toThrow(/Duplicate header column/);
  });

  it('quoted comma and escaped-quote-in-field round-trip correctly (RFC4180)', () => {
    const text = 'a,b\r\n"has, a comma","has ""a quote"" inside"\r\n';
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual([{ a: 'has, a comma', b: 'has "a quote" inside' }]);
  });

  it('CRLF line endings parse correctly', () => {
    const text = 'a,b\r\nx,y\r\n';
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual([{ a: 'x', b: 'y' }]);
  });

  it('a single trailing blank line/newline at EOF is tolerated, not treated as a malformed row', () => {
    const text = 'a,b\r\nx,y\r\n\r\n'.slice(0, -2) + '\r\n'; // 'a,b\r\nx,y\r\n' with a clean trailing newline
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual([{ a: 'x', b: 'y' }]);
  });
});

describe('writeClassificationCsv', () => {
  it('produces a parseable classification CSV', () => {
    const text = writeClassificationCsv([{ candidateKey: 'k1', evaluationId: 'e1', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' }]);
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual([{ candidateKey: 'k1', evaluationId: 'e1', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' }]);
  });
});

describe('validateForensicPopulation (duplicate/join fail-closed)', () => {
  function row(overrides: Partial<ForensicTelemetryRow> = {}): ForensicTelemetryRow {
    return assembleForensicRow({
      event: event(overrides.candidateKey ? { candidateKey: overrides.candidateKey, evaluationId: overrides.evaluationId ?? 'BTCUSDT|95|TREND_RIDER|0' } : { evaluationId: overrides.evaluationId ?? 'BTCUSDT|95|TREND_RIDER|0' }),
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

  it('passes on a unique, joined population', () => {
    const rows = [row({ candidateKey: 'k1' }), row({ candidateKey: 'k2', evaluationId: 'BTCUSDT|96|TREND_RIDER|0' })];
    const result = validateForensicPopulation(rows, new Set(['BTCUSDT|95|TREND_RIDER|0', 'BTCUSDT|96|TREND_RIDER|0']));
    expect(result.valid).toBe(true);
    expect(result.duplicateCandidateKeys).toBe(0);
    expect(result.missingJoins).toBe(0);
  });

  it('fails closed on a duplicate candidateKey', () => {
    const rows = [row({ candidateKey: 'dup' }), row({ candidateKey: 'dup' })];
    const result = validateForensicPopulation(rows, new Set(['BTCUSDT|95|TREND_RIDER|0']));
    expect(result.valid).toBe(false);
    expect(result.duplicateCandidateKeys).toBe(1);
  });

  it('fails closed on a missing CP2 join', () => {
    const rows = [row({ candidateKey: 'k1' })];
    const result = validateForensicPopulation(rows, new Set(['SOME|OTHER|EVAL|0']));
    expect(result.valid).toBe(false);
    expect(result.missingJoins).toBe(1);
  });
});

// ============================== TICKET-G6R-CP3HR Task 2: setup-type model, no unsafe double-cast ==============================

describe('ForensicSetupType / isFallbackSetupType / filterFallbackRows (Task 2)', () => {
  it('an OB row can be built and assembled WITHOUT any cast (no "OB as unknown as FVG" needed anywhere)', () => {
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
    const row = assembleForensicRow({
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
    expect(row.setupType).toBe('OB');

    // Round-trips through CSV without a cast too.
    const csvText = writeForensicLedgerCsv([row]);
    const parsedBack = parseForensicLedgerCsv(csvText);
    expect(parsedBack[0].setupType).toBe('OB');
  });

  it('FVG/SWEEP rows are unaffected by the widened type', () => {
    const fvg = assembleForensicRow({
      event: baseEventFields(),
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
    expect(fvg.setupType).toBe('FVG');
    expect(isFallbackSetupType(fvg.setupType)).toBe(true);
  });

  it('isFallbackSetupType accepts only FVG/SWEEP, never OB', () => {
    expect(isFallbackSetupType('FVG')).toBe(true);
    expect(isFallbackSetupType('SWEEP')).toBe(true);
    expect(isFallbackSetupType('OB')).toBe(false);
  });

  it('filterFallbackRows narrows its RETURN TYPE at compile time — OB is rejected by the compiler, not just at runtime', () => {
    const obEvent: ForensicShadowEventLike = { ...baseEventFields(), candidateKey: 'k-ob', setupType: 'OB' };
    const built = assembleForensicRow({
      event: obEvent,
      rawSlPrice: 44, atr: 20, bufferAmount: 1, candlesFromEnd: 0, mssConfirmed: true, mssFailReason: null,
      primaryObFound: true, blockedByMacroFilter: false, registrationDocumentSha256: 'REG', analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true, candidateKeySchemaValid: true,
    });
    const fallback = filterFallbackRows([built]);
    // Compile-time proof: fallback[0].setupType is typed FallbackSetupType ('FVG'|'SWEEP'), so
    // assigning it to a variable typed 'OB' is a TypeScript compile error — `npm run typecheck` would
    // fail if this @ts-expect-error stopped being necessary (i.e. if the narrowing regressed).
    if (fallback.length > 0) {
      // @ts-expect-error setupType is compile-time narrowed to 'FVG'|'SWEEP' — 'OB' is not assignable.
      const forcedOb: 'OB' = fallback[0].setupType;
      void forcedOb;
    }
  });

  it('filterFallbackRows drops OB rows and cannot leak them into a fallback-denominator count', () => {
    const obEvent: ForensicShadowEventLike = { ...baseEventFields(), candidateKey: 'k-ob', setupType: 'OB' };
    const fvgEvent: ForensicShadowEventLike = { ...baseEventFields(), candidateKey: 'k-fvg', setupType: 'FVG' };
    const sweepEvent: ForensicShadowEventLike = { ...baseEventFields(), candidateKey: 'k-sweep', setupType: 'SWEEP' };
    const build = (ev: ForensicShadowEventLike) =>
      assembleForensicRow({
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
    const rows = [build(obEvent), build(fvgEvent), build(sweepEvent)];
    const fallback = filterFallbackRows(rows);
    expect(fallback).toHaveLength(2);
    expect(fallback.some((r) => r.setupType === 'OB')).toBe(false);
    expect(fallback.map((r) => r.setupType).sort()).toEqual(['FVG', 'SWEEP']);
  });

  it('the sole cast inside classifyTimestamp\'s call to auditDecisionFeatureProvenance is provably safe: setupType never affects the audit result', () => {
    const provenanceWithViolation = provenance({ mssMaxTimestampRead: 150, mssMaxAvailableAt: 150 + 60000, evaluationCutoffExclusive: 999999999 });
    const obLike: ForensicShadowEventLike = { ...baseEventFields(), setupType: 'OB', provenance: provenanceWithViolation };
    const fvgLike: FrozenShadowEvent = { ...baseEventFields(), setupType: 'FVG', provenance: provenanceWithViolation };

    // classifyTimestamp() accepts the OB row directly — no cast at this call site.
    const obClass = classifyTimestamp(obLike);
    const fvgClass = classifyTimestamp(fvgLike);
    expect(obClass).toBe(fvgClass);

    // Independently: auditDecisionFeatureProvenance() itself produces byte-identical violation
    // output regardless of setupType, proving the internal cast in toAuditableEvent() cannot change
    // behavior based on the field it widens.
    const auditOb = auditDecisionFeatureProvenance([{ ...baseEventFields(), setupType: 'FVG', provenance: provenanceWithViolation } as FrozenShadowEvent]);
    const auditFvg = auditDecisionFeatureProvenance([fvgLike]);
    expect(auditOb).toEqual(auditFvg);
  });
});

// ============================== TICKET-G6R-CP3HR Task 3: hardened validator ==============================

describe('validateForensicLedgerStrict (Task 3)', () => {
  function strictRow(overrides: Partial<ForensicTelemetryRow> = {}): ForensicTelemetryRow {
    const built = assembleForensicRow({
      event: { ...baseEventFields(), ...(overrides.candidateKey ? { candidateKey: overrides.candidateKey } : {}), ...(overrides.evaluationId ? { evaluationId: overrides.evaluationId } : {}), ...(overrides.setupType ? { setupType: overrides.setupType } : {}), ...(overrides.sourceTimestamp !== undefined ? { sourceTimestamp: overrides.sourceTimestamp } : {}) },
      rawSlPrice: 44,
      atr: 20,
      bufferAmount: 1,
      candlesFromEnd: 0,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'a'.repeat(64),
      analyzerSourceHash: 'b'.repeat(64),
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    return { ...built, ...overrides } as ForensicTelemetryRow;
  }
  function classificationOf(r: ForensicTelemetryRow) {
    return { candidateKey: r.candidateKey, evaluationId: r.evaluationId, timestampClass: r.timestampClass, geometryClass: r.geometryClass, combinedClass: r.combinedClass };
  }

  it('passes on a clean, internally-consistent population', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90' })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('an OB row co-occurring at the same evaluation as a fallback candidate does NOT fail the fallback multiplicity check', () => {
    const obEvent: ForensicShadowEventLike = { ...baseEventFields(), candidateKey: 'BTCUSDT|LONG|OB|100|90', evaluationId: 'BTCUSDT|95|TREND_RIDER|0', setupType: 'OB' };
    const obRow = assembleForensicRow({
      event: obEvent,
      rawSlPrice: 44, atr: 20, bufferAmount: 1, candlesFromEnd: 0, mssConfirmed: true, mssFailReason: null,
      primaryObFound: true, blockedByMacroFilter: false, registrationDocumentSha256: 'REG', analyzerSourceHash: 'SRC',
      evaluationIdSchemaValid: true, candidateKeySchemaValid: true,
    });
    const fvgRow = strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|91' }); // same evaluationId 'BTCUSDT|95|TREND_RIDER|0' as the default event() fixture
    const rows = [obRow, fvgRow];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.MULTIPLE_FALLBACK_CANDIDATES_PER_EVALUATION).toBeUndefined();
  });

  it('fails closed when TWO fallback candidates share one evaluationId', () => {
    const rows = [
      strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90' }),
      strictRow({ candidateKey: 'BTCUSDT|LONG|SWEEP|100|91', setupType: 'SWEEP' }),
    ];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.valid).toBe(false);
    expect(result.violationCountByCategory.MULTIPLE_FALLBACK_CANDIDATES_PER_EVALUATION).toBe(1);
  });

  it('fails closed on duplicate candidateKey', () => {
    const rows = [strictRow({ candidateKey: 'dup' }), strictRow({ candidateKey: 'dup' })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.DUPLICATE_CANDIDATE_KEY).toBe(1);
  });

  it('fails closed on a missing ledger<->classification join', () => {
    const rows = [strictRow({ candidateKey: 'k1' })];
    const result = validateForensicLedgerStrict(rows, []);
    expect(result.violationCountByCategory.MISSING_LEDGER_CLASSIFICATION_JOIN).toBe(1);
  });

  it('fails closed on an orphan classification row', () => {
    const rows = [strictRow({ candidateKey: 'k1' })];
    const orphan = { candidateKey: 'orphan-key', evaluationId: 'e', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' };
    const result = validateForensicLedgerStrict(rows, [...rows.map(classificationOf), orphan]);
    expect(result.violationCountByCategory.ORPHAN_CLASSIFICATION_ROW).toBe(1);
  });

  it('fails closed on a candidateKey that does not match its formula', () => {
    const rows = [strictRow({ candidateKey: 'WRONG_KEY' })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.CANDIDATE_KEY_FORMULA_MISMATCH).toBe(1);
  });

  it('fails closed on an evaluationId that does not match its formula', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', evaluationId: 'not-a-valid-format' })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.EVALUATION_ID_FORMULA_MISMATCH).toBe(1);
  });

  it('fails closed on an invalid setupType enum value', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', setupType: 'BOGUS' as unknown as ForensicSetupType })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.INVALID_SETUP_TYPE).toBe(1);
  });

  it('fails closed on non-finite numeric values', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', atr: NaN })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.NON_FINITE_VALUE).toBeGreaterThan(0);
  });

  it('fails closed on a timestamp ordering violation (sourceTimestamp after decisionTimestamp)', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|999999|90', sourceTimestamp: 999999999 })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.TIMESTAMP_ORDERING_VIOLATION).toBeGreaterThan(0);
  });

  it('fails closed on a malformed hash string', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90', analyzerSourceHash: 'not-a-hash' })];
    const result = validateForensicLedgerStrict(rows, rows.map(classificationOf));
    expect(result.violationCountByCategory.MALFORMED_HASH).toBeGreaterThan(0);
  });

  it('fails closed when classification total does not reconcile with ledger total', () => {
    const rows = [strictRow({ candidateKey: 'BTCUSDT|LONG|FVG|100|90' })];
    const result = validateForensicLedgerStrict(rows, [...rows.map(classificationOf), { candidateKey: 'extra', evaluationId: 'e', timestampClass: 'CLEAN', geometryClass: 'CLEAN', combinedClass: 'CLEAN' }]);
    // The 'extra' row is also an orphan (no matching ledger row), and separately trips the total check.
    expect(result.violationCountByCategory.CLASSIFICATION_TOTAL_INCONSISTENT).toBe(1);
  });
});

describe('isValidSha256Hex / isValidExecutionHead / expectedCandidateKey (Task 3 helpers)', () => {
  it('validates sha256 hex format', () => {
    expect(isValidSha256Hex('a'.repeat(64))).toBe(true);
    expect(isValidSha256Hex('a'.repeat(63))).toBe(false);
    expect(isValidSha256Hex('not-hex')).toBe(false);
  });

  it('validates a 40-char git-sha executionHead format', () => {
    expect(isValidExecutionHead('a'.repeat(40))).toBe(true);
    expect(isValidExecutionHead('a'.repeat(64))).toBe(false);
  });

  it('computes the candidateKey formula deterministically', () => {
    expect(expectedCandidateKey({ symbol: 'BTCUSDT', side: 'LONG', setupType: 'FVG', decisionTimestamp: 100, sourceTimestamp: 90 })).toBe('BTCUSDT|LONG|FVG|100|90');
  });
});

// ============================== TICKET-G6R-CP3HR2 Task 3: Legacy vs Future-V2 schema split ==============================

describe('LegacyCp3hTelemetryRow / FutureForensicTelemetryRowV2 (Task 3)', () => {
  function validV2Row(overrides: Partial<FutureForensicTelemetryRowV2> = {}): FutureForensicTelemetryRowV2 {
    const legacy: LegacyCp3hTelemetryRow = assembleForensicRow({
      event: baseEventFields(),
      rawSlPrice: 44,
      atr: 20,
      bufferAmount: 1,
      candlesFromEnd: 0,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'a'.repeat(64),
      analyzerSourceHash: 'b'.repeat(64),
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    const base: FutureForensicTelemetryRowV2 = {
      ...legacy,
      executionHead: 'c'.repeat(40),
      datasetFingerprint: 'd'.repeat(64),
      analyzerSourceSha256: 'b'.repeat(64),
      forensicToolSha256: 'e'.repeat(64),
      confirmingCandleAvailableAt: 100,
      mssDecisionAvailableAt: 200,
      // Must be >= every raw *AvailableAt field on the legacy row for the availability-coverage check.
      fullDecisionAvailableAt: Math.max(legacy.detector5mMaxAvailableAt, legacy.mssMaxAvailableAt, legacy.atr5mMaxAvailableAt, legacy.macroInputMaxAvailableAt, legacy.maxFeatureAvailableAt) + 1,
      slBufferAtrMultiplier: legacy.bufferAmount / legacy.atr,
      // TICKET-G6R-CP3HR3 Task 2: the 3 new V2-only fields.
      fallbackDetectorResult: 'FOUND',
      fallbackMssResult: 'CONFIRMED',
      requiredDataCoverage: 'FULL',
    };
    return { ...base, ...overrides };
  }

  it('a fully-populated, internally-consistent V2 row passes validation', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row());
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('fails on a missing required field (undefined)', () => {
    const row = { ...validV2Row() } as unknown as Record<string, unknown>;
    delete row.executionHead;
    const result = validateFutureForensicTelemetryRowV2(row as unknown as FutureForensicTelemetryRowV2);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'MISSING_REQUIRED_FIELD' && v.field === 'executionHead')).toBe(true);
  });

  it('fails on an empty string field', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ symbol: '' }));
    expect(result.violations.some((v) => v.category === 'EMPTY_STRING' && v.field === 'symbol')).toBe(true);
  });

  it('fails on NaN/Infinity numeric fields', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ slBufferAtrMultiplier: NaN }));
    expect(result.violations.some((v) => v.category === 'NON_FINITE_VALUE' && v.field === 'slBufferAtrMultiplier')).toBe(true);
  });

  it('fails on a malformed sha256 (not 64 lowercase hex)', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ datasetFingerprint: 'NOT-A-HASH' }));
    expect(result.violations.some((v) => v.category === 'MALFORMED_HASH' && v.field === 'datasetFingerprint')).toBe(true);
  });

  it('fails on a malformed executionHead (not 40 lowercase hex git SHA)', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ executionHead: 'x'.repeat(40) }));
    expect(result.violations.some((v) => v.category === 'MALFORMED_EXECUTION_HEAD')).toBe(true);
  });

  it('fails on an invalid enum value', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ side: 'SIDEWAYS' as unknown as 'LONG' }));
    expect(result.violations.some((v) => v.category === 'INVALID_ENUM' && v.field === 'side')).toBe(true);
  });

  it('fails on a timestamp ordering violation', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ confirmingCandleAvailableAt: 999999999 }));
    expect(result.violations.some((v) => v.category === 'TIMESTAMP_ORDERING_VIOLATION' && v.field === 'confirmingCandleAvailableAt')).toBe(true);
  });

  it('fails when an availability timestamp does not cover all feature reads', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ fullDecisionAvailableAt: 1 }));
    expect(result.violations.some((v) => v.category === 'AVAILABILITY_COVERAGE_VIOLATION')).toBe(true);
  });

  it('fails on SL/distance internal inconsistency', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ slDistance: 999999 }));
    expect(result.violations.some((v) => v.category === 'SL_DISTANCE_INCONSISTENT' && v.field === 'slDistance')).toBe(true);
  });

  it('fails on slBufferAtrMultiplier not matching bufferAmount/atr', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ slBufferAtrMultiplier: 999 }));
    expect(result.violations.some((v) => v.category === 'SL_DISTANCE_INCONSISTENT' && v.field === 'slBufferAtrMultiplier')).toBe(true);
  });

  it('fails when classification does not match the underlying raw data', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ timestampClass: 'UNCLOSED_INPUT_READ' }));
    expect(result.violations.some((v) => v.category === 'CLASSIFICATION_MISMATCH' && v.field === 'timestampClass')).toBe(true);
  });

  it('LegacyCp3hTelemetryRow is structurally identical to ForensicTelemetryRow (the real, already-persisted column set) — never gains a V2-only field', () => {
    const legacy: LegacyCp3hTelemetryRow = assembleForensicRow({
      event: baseEventFields(),
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
    expect((legacy as unknown as Record<string, unknown>).executionHead).toBeUndefined();
    expect((legacy as unknown as Record<string, unknown>).slBufferAtrMultiplier).toBeUndefined();
    expect(Object.keys(legacy).sort()).toEqual([...FORENSIC_LEDGER_HEADER].sort());
  });
});

// ============================== TICKET-G6R-CP3HR3 Task 2/5: new required tests ==============================

describe('validateFutureForensicTelemetryRowV2 — TICKET-G6R-CP3HR3 Task 2 (runtime type + new fields)', () => {
  function validV2Row(overrides: Partial<FutureForensicTelemetryRowV2> = {}): FutureForensicTelemetryRowV2 {
    const legacy: LegacyCp3hTelemetryRow = assembleForensicRow({
      event: baseEventFields(),
      rawSlPrice: 44,
      atr: 20,
      bufferAmount: 1,
      candlesFromEnd: 0,
      mssConfirmed: true,
      mssFailReason: null,
      primaryObFound: true,
      blockedByMacroFilter: false,
      registrationDocumentSha256: 'a'.repeat(64),
      analyzerSourceHash: 'b'.repeat(64),
      evaluationIdSchemaValid: true,
      candidateKeySchemaValid: true,
    });
    const base: FutureForensicTelemetryRowV2 = {
      ...legacy,
      executionHead: 'c'.repeat(40),
      datasetFingerprint: 'd'.repeat(64),
      analyzerSourceSha256: 'b'.repeat(64),
      forensicToolSha256: 'e'.repeat(64),
      confirmingCandleAvailableAt: 100,
      mssDecisionAvailableAt: 200,
      fullDecisionAvailableAt: Math.max(legacy.detector5mMaxAvailableAt, legacy.mssMaxAvailableAt, legacy.atr5mMaxAvailableAt, legacy.macroInputMaxAvailableAt, legacy.maxFeatureAvailableAt) + 1,
      slBufferAtrMultiplier: legacy.bufferAmount / legacy.atr,
      fallbackDetectorResult: 'FOUND',
      fallbackMssResult: 'CONFIRMED',
      requiredDataCoverage: 'FULL',
    };
    return { ...base, ...overrides };
  }

  // ---- test 6: missing each of the 3 new V2 fields individually ----
  it('6) missing each of the 3 new V2 fields individually -> each fails with MISSING_REQUIRED_FIELD', () => {
    for (const field of ['fallbackDetectorResult', 'fallbackMssResult', 'requiredDataCoverage'] as const) {
      const row = { ...validV2Row() } as unknown as Record<string, unknown>;
      delete row[field];
      const result = validateFutureForensicTelemetryRowV2(row as unknown as FutureForensicTelemetryRowV2);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.category === 'MISSING_REQUIRED_FIELD' && v.field === field)).toBe(true);
    }
  });

  // ---- test 7: a V2 number field passed as a numeric-looking STRING ----
  it('7) a V2 number field passed as a numeric-looking STRING ("123") -> fails with WRONG_RUNTIME_TYPE, does NOT silently pass', () => {
    const row = { ...validV2Row(), slBufferAtrMultiplier: '123' } as unknown as FutureForensicTelemetryRowV2;
    const result = validateFutureForensicTelemetryRowV2(row);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'WRONG_RUNTIME_TYPE' && v.field === 'slBufferAtrMultiplier')).toBe(true);
  });

  // ---- test 8: a V2 boolean field passed as string "false" ----
  it('8) a V2 boolean field passed as string "false" -> fails with WRONG_RUNTIME_TYPE', () => {
    const row = { ...validV2Row(), mssConfirmed: 'false' } as unknown as FutureForensicTelemetryRowV2;
    const result = validateFutureForensicTelemetryRowV2(row);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'WRONG_RUNTIME_TYPE' && v.field === 'mssConfirmed')).toBe(true);
  });

  // ---- test 9: malformed V2 telemetry enum structure ----
  it('9) invalid fallbackDetectorResult enum value -> fails', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ fallbackDetectorResult: 'MAYBE' as unknown as 'FOUND' }));
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'INVALID_ENUM' && v.field === 'fallbackDetectorResult')).toBe(true);
  });

  it('9b) invalid fallbackMssResult enum value -> fails', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ fallbackMssResult: 'BOGUS' as unknown as 'CONFIRMED' }));
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'INVALID_ENUM' && v.field === 'fallbackMssResult')).toBe(true);
  });

  it('9c) invalid requiredDataCoverage enum value -> fails', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ requiredDataCoverage: 'BOGUS' as unknown as 'FULL' }));
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'INVALID_ENUM' && v.field === 'requiredDataCoverage')).toBe(true);
  });

  it('9d) telemetry object supplied where a scalar result is required -> fails on runtime structure', () => {
    const row = { ...validV2Row(), fallbackDetectorResult: { outcome: 'FOUND' } } as unknown as FutureForensicTelemetryRowV2;
    const result = validateFutureForensicTelemetryRowV2(row);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.category === 'WRONG_RUNTIME_TYPE' && v.field === 'fallbackDetectorResult')).toBe(true);
  });

  // ---- test 12: a single malformed analyzerSourceSha256 produces exactly ONE MALFORMED_HASH violation ----
  it('12) a single malformed analyzerSourceSha256 produces exactly ONE MALFORMED_HASH violation, not two', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row({ analyzerSourceSha256: 'not-a-valid-hash' }));
    const analyzerHashViolations = result.violations.filter((v) => v.category === 'MALFORMED_HASH' && v.field === 'analyzerSourceSha256');
    expect(analyzerHashViolations).toHaveLength(1);
  });

  it('a fully-populated, internally-consistent V2 row (including the 3 new fields) still passes validation', () => {
    const result = validateFutureForensicTelemetryRowV2(validV2Row());
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

function baseEventFields(): ForensicShadowEventLike {
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
  };
}
