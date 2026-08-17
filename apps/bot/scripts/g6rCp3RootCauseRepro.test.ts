/**
 * TICKET-G6R-CP3G — minimal, replay-independent reproduction of the two genuine CP3 findings:
 *   (1) 184 decision-feature timestamp violations (92 mssMaxTimestampRead + 92 stalenessReferenceTimestamp)
 *   (2) 31/105 candidates with invalid directional SL geometry
 *
 * ABSOLUTE CONSTRAINTS HONORED BY THIS FILE:
 *  - Never imports/executes g6rCheckpoint3Replay.ts.
 *  - Never calls runReplay().
 *  - Never modifies g6rShadowAnalyzer.ts decision logic (read-only citation of its real formulas
 *    in comments below, verified against the actual source at investigation time).
 *  - Uses ONLY: (a) the exported PURE functions validateShadowLedger / validateShadowCandidateRows /
 *    auditDecisionFeatureProvenance, (b) REAL numbers copied verbatim from the already-frozen
 *    data/g6r-runs/g6r-cp3-shadow-summary.json (which this file does not modify), and (c) small,
 *    hand-constructed synthetic objects to demonstrate sensitivity/boundary behavior.
 *  - Does not attempt to make CP3 PASS, does not filter/drop any real violation, does not change
 *    decisionTimestamp or the frozen rule.
 *
 * See data/g6r-cp3-root-cause-investigation.md for the full write-up these tests support.
 */
import { describe, expect, it } from 'vitest';
import { auditDecisionFeatureProvenance, validateShadowLedger, type DecisionFeatureProvenance, type FrozenShadowEvent } from './g6rShadowAnalyzer.js';

// ============================================================================
// SECTION 1 — TIMESTAMP MECHANISM
// ============================================================================
//
// Real candidateKey "BTCUSDT|SHORT|FVG|1770817320000|1770815700000" appears in BOTH
// data/g6r-runs/g6r-cp3-shadow-summary.json's invalidGeometrySample[0] AND
// leakageAuditB.representativeSamples[0] — copied verbatim below, not re-derived.
const REAL_PROVENANCE_FROM_FROZEN_SAMPLE: DecisionFeatureProvenance = {
  detector5mMaxTimestamp: 1770817200000,
  detector5mMaxAvailableAt: 1770817500000,
  mssMaxTimestampRead: 1770817440000,
  mssMaxAvailableAt: 1770817500000,
  mssConfirmationTimestamp: 1770817320000,
  stalenessReferenceTimestamp: 1770817440000,
  atr5mMaxTimestamp: 1770817200000,
  atr5mMaxAvailableAt: 1770817500000,
  macroInputMaxTimestamp: 1770681600000,
  macroInputMaxAvailableAt: 1770768000000,
  evaluationCutoffExclusive: 1770817500000,
  maxRawFeatureTimestamp: 1770817440000,
  maxFeatureAvailableAt: 1770817500000,
};
const REAL_EVENT_FROM_FROZEN_SAMPLE: FrozenShadowEvent = {
  candidateKey: 'BTCUSDT|SHORT|FVG|1770817320000|1770815700000',
  evaluationId: 'BTCUSDT|1770817200000|TREND_RIDER|0',
  symbol: 'BTCUSDT',
  side: 'SHORT',
  regime: 'TREND_RIDER',
  setupType: 'FVG',
  sourceTimestamp: 1770815700000,
  evaluationTimestamp: 1770817200000,
  decisionTimestamp: 1770817320000,
  entryPrice: 67169.5,
  slPrice: 66932.26944220664,
  slDistance: 237.23055779335846,
  provenance: REAL_PROVENANCE_FROM_FROZEN_SAMPLE,
};

describe('CP3G root-cause repro — timestamp mechanism (real frozen-evidence data)', () => {
  it('reproduces the exact real violation from the frozen summary: mssMaxTimestampRead and stalenessReferenceTimestamp (same value, 1770817440000) both exceed decisionTimestamp (1770817320000) by exactly 120000ms (2x 1m candles)', () => {
    const result = auditDecisionFeatureProvenance([REAL_EVENT_FROM_FROZEN_SAMPLE]);
    expect(result.violationCount).toBe(2);
    expect(result.byProvenanceField.mssMaxTimestampRead).toBe(1);
    expect(result.byProvenanceField.stalenessReferenceTimestamp).toBe(1);
    expect(result.violations.every((v) => v.kind === 'FEATURE_AFTER_DECISION_TIMESTAMP')).toBe(true);
    // Both violating fields carry the SAME numeric value — confirmed root cause: they are literally
    // the same underlying quantity (g6rShadowAnalyzer.ts line 228: `const stalenessReferenceTimestamp
    // = mssMaxTimestampRead;`), which is why the full-population counts are IDENTICAL (92 === 92),
    // not a coincidence.
    expect(REAL_PROVENANCE_FROM_FROZEN_SAMPLE.mssMaxTimestampRead).toBe(REAL_PROVENANCE_FROM_FROZEN_SAMPLE.stalenessReferenceTimestamp);
    const gapMs = REAL_PROVENANCE_FROM_FROZEN_SAMPLE.mssMaxTimestampRead - REAL_EVENT_FROM_FROZEN_SAMPLE.decisionTimestamp;
    expect(gapMs).toBe(120000); // candlesFromEnd=2 at MSS_STALENESS_TOLERANCE_CANDLES=5 (not stale, but not at the window tail either)
  });

  it('confirms mssMaxAvailableAt/detector5mMaxAvailableAt/atr5mMaxAvailableAt are all <= evaluationCutoffExclusive — this is NOT literal future-beyond-evaluation leakage (Audit A would catch that); it is entirely inside the legitimately-closed decision window', () => {
    const p = REAL_PROVENANCE_FROM_FROZEN_SAMPLE;
    expect(p.mssMaxAvailableAt).toBeLessThanOrEqual(p.evaluationCutoffExclusive);
    expect(p.detector5mMaxAvailableAt).toBeLessThanOrEqual(p.evaluationCutoffExclusive);
    expect(p.atr5mMaxAvailableAt).toBeLessThanOrEqual(p.evaluationCutoffExclusive);
    // mssMaxAvailableAt equals evaluationCutoffExclusive EXACTLY (1770817500000) — the MSS window's
    // last candle closes exactly at the evaluation boundary. The violation is entirely about
    // decisionTimestamp being defined narrower than the data the (production-faithful) staleness
    // check legitimately reads, not about reading anything that hadn't closed yet.
    expect(p.mssMaxAvailableAt).toBe(p.evaluationCutoffExclusive);
  });

  it('mechanism demonstration: candlesFromEnd=0 (confirmation IS the last candle in the MSS window) produces ZERO mssMaxTimestampRead/stalenessReferenceTimestamp violations', () => {
    const atWindowTail: FrozenShadowEvent = {
      ...REAL_EVENT_FROM_FROZEN_SAMPLE,
      candidateKey: 'SYNTHETIC|SHORT|FVG|1770817440000|1770815700000',
      decisionTimestamp: 1770817440000, // pretend confirmation happened on the LAST candle in the window
      provenance: { ...REAL_PROVENANCE_FROM_FROZEN_SAMPLE, mssConfirmationTimestamp: 1770817440000 },
      // mssMaxTimestampRead/stalenessReferenceTimestamp unchanged (1770817440000) — now EQUAL to decisionTimestamp
    };
    const result = auditDecisionFeatureProvenance([atWindowTail]);
    expect(result.violationCount).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('mechanism demonstration: appending exactly ONE more already-closed candle to the MSS window (extending mssMaxTimestampRead by 60000ms) turns a previously-clean candidate into a violating one — the audit is provably sensitive to a single extra candle, not tautological', () => {
    const clean: FrozenShadowEvent = {
      ...REAL_EVENT_FROM_FROZEN_SAMPLE,
      candidateKey: 'SYNTHETIC|SHORT|FVG|1770817440000|1770815700000',
      decisionTimestamp: 1770817440000,
      provenance: { ...REAL_PROVENANCE_FROM_FROZEN_SAMPLE, mssConfirmationTimestamp: 1770817440000, mssMaxTimestampRead: 1770817440000, stalenessReferenceTimestamp: 1770817440000, mssMaxAvailableAt: 1770817500000 },
    };
    expect(auditDecisionFeatureProvenance([clean]).violationCount).toBe(0);

    // Simulate "one more 1m candle now present in the window" (the exact real-world effect of the
    // caller's candlesMss array containing one additional already-closed candle beyond the confirming
    // one) by advancing mssMaxTimestampRead/stalenessReferenceTimestamp/mssMaxAvailableAt by one
    // 1-minute step, WITHOUT moving decisionTimestamp (which is pinned to the confirming candle).
    const oneExtraCandle: FrozenShadowEvent = {
      ...clean,
      candidateKey: 'SYNTHETIC|SHORT|FVG|1770817440000|1770815700000|plus1',
      provenance: {
        ...clean.provenance,
        mssMaxTimestampRead: 1770817500000,
        stalenessReferenceTimestamp: 1770817500000,
        mssMaxAvailableAt: 1770817560000,
        evaluationCutoffExclusive: 1770817560000, // window's own available boundary also advances, so this stays a real closed-candle scenario, not future-leakage
      },
    };
    const result = auditDecisionFeatureProvenance([oneExtraCandle]);
    expect(result.violationCount).toBe(2); // mssMaxTimestampRead and stalenessReferenceTimestamp both now exceed decisionTimestamp by 60000ms
    expect(result.byProvenanceField.mssMaxTimestampRead).toBe(1);
    expect(result.byProvenanceField.stalenessReferenceTimestamp).toBe(1);
  });
});

// ============================================================================
// SECTION 2 — SL GEOMETRY MECHANISM
// ============================================================================
//
// All 10 rows below are copied verbatim from data/g6r-runs/g6r-cp3-shadow-summary.json's
// invalidGeometrySample array (real, frozen, unmodified) — side/entryPrice/slPrice only (the
// fields needed for the LONG/SHORT directional check); no synthetic data in this describe block.
interface RealGeometrySampleRow {
  readonly candidateKey: string;
  readonly side: 'LONG' | 'SHORT';
  readonly entryPrice: number;
  readonly slPrice: number;
}
const REAL_INVALID_GEOMETRY_SAMPLES: readonly RealGeometrySampleRow[] = [
  { candidateKey: 'BTCUSDT|SHORT|FVG|1770817320000|1770815700000', side: 'SHORT', entryPrice: 67169.5, slPrice: 66932.26944220664 },
  { candidateKey: 'SOLUSDT|SHORT|FVG|1770827160000|1770822600000', side: 'SHORT', entryPrice: 80.24, slPrice: 79.52904802324892 },
  { candidateKey: 'SOLUSDT|LONG|FVG|1771076700000|1771074600000', side: 'LONG', entryPrice: 86.4, slPrice: 86.53240211154633 },
  { candidateKey: 'BTCUSDT|LONG|SWEEP|1771087440000|1771084800000', side: 'LONG', entryPrice: 69618.8, slPrice: 69655.042292212 },
  { candidateKey: 'SOLUSDT|LONG|FVG|1771074060000|1771070100000', side: 'LONG', entryPrice: 86.55, slPrice: 86.86375717037 },
  { candidateKey: 'BTCUSDT|LONG|FVG|1771076040000|1771070100000', side: 'LONG', entryPrice: 69426.3, slPrice: 70292.00338891534 },
  { candidateKey: 'SOLUSDT|LONG|FVG|1770849600000|1770845100000', side: 'LONG', entryPrice: 79.97, slPrice: 80.16846862652123 },
  { candidateKey: 'BTCUSDT|LONG|FVG|1770823320000|1770819300000', side: 'LONG', entryPrice: 66299.9, slPrice: 67945.83377274022 },
  { candidateKey: 'SOLUSDT|SHORT|FVG|1770844560000|1770841800000', side: 'SHORT', entryPrice: 79.97, slPrice: 79.33352594972611 },
  { candidateKey: 'SOLUSDT|SHORT|FVG|1770836520000|1770833100000', side: 'SHORT', entryPrice: 80.24, slPrice: 79.52904802324892 },
];

describe('CP3G root-cause repro — SL geometry mechanism (real frozen-evidence data)', () => {
  it('every one of the 10 real invalid-geometry samples genuinely violates the documented directional invariant (LONG: slPrice<entryPrice, SHORT: slPrice>entryPrice) — reproduced via the real exported validateShadowLedger(), not hand-rolled arithmetic', () => {
    const events: FrozenShadowEvent[] = REAL_INVALID_GEOMETRY_SAMPLES.map((s) => ({
      candidateKey: s.candidateKey,
      evaluationId: 'X',
      symbol: 'X',
      side: s.side,
      regime: 'TREND_RIDER',
      setupType: 'FVG',
      sourceTimestamp: 0,
      evaluationTimestamp: 0,
      decisionTimestamp: 0,
      entryPrice: s.entryPrice,
      slPrice: s.slPrice,
      slDistance: Math.abs(s.entryPrice - s.slPrice),
      provenance: REAL_PROVENANCE_FROM_FROZEN_SAMPLE,
    }));
    const result = validateShadowLedger(events, new Set());
    expect(result.invalidGeometryCount).toBe(10); // all 10 sample rows genuinely fail
  });

  it('classifies the direction of failure for each real sample: for LONG rows, slPrice ended up ABOVE entryPrice (SL on the wrong side, above instead of below); for SHORT rows, slPrice ended up BELOW entryPrice', () => {
    const longRows = REAL_INVALID_GEOMETRY_SAMPLES.filter((s) => s.side === 'LONG');
    const shortRows = REAL_INVALID_GEOMETRY_SAMPLES.filter((s) => s.side === 'SHORT');
    expect(longRows.length).toBeGreaterThan(0);
    expect(shortRows.length).toBeGreaterThan(0);
    for (const r of longRows) {
      // A valid LONG needs slPrice < entryPrice; every real sample instead has slPrice > entryPrice.
      expect(r.slPrice).toBeGreaterThan(r.entryPrice);
    }
    for (const r of shortRows) {
      // A valid SHORT needs slPrice > entryPrice; every real sample instead has slPrice < entryPrice.
      expect(r.slPrice).toBeLessThan(r.entryPrice);
    }
  });

  // ---- Isolated formula-level geometry illustration (NOT a re-derivation of g6rShadowAnalyzer.ts's
  // exact computation — no ATR/buffer/entry-selection logic is duplicated here; this is basic
  // interval arithmetic illustrating how a chosen raw-SL/buffer/entry combination can end invalid.
  // It does not attribute the real rows because their raw SL and buffer were not persisted). ----
  describe('isolated geometry-formula illustration (basic arithmetic, not a detector/MSS re-implementation)', () => {
    it('FVG LONG valid: raw SL below entry, buffer subtracted, stays below entry', () => {
      const rawSl = 100;
      const buffer = 2;
      const entry = 105; // confirming candle close, still above the raw zone level
      const finalSl = rawSl - buffer; // production formula: LONG -> rawSl - buffer
      expect(finalSl).toBeLessThan(entry);
    });

    it('FVG LONG invalid for the illustrated raw-SL/buffer/entry values', () => {
      const rawSl = 100;
      const buffer = 2;
      const entry = 98; // confirming candle close has moved BELOW the raw zone level itself
      const finalSl = rawSl - buffer; // 98
      // This exact buffer leaves finalSl equal to entry. A larger buffer could restore geometry;
      // the frozen evidence lacks the real raw SL/buffer, so this is possibility, not causality proof.
      expect(finalSl).toBeGreaterThanOrEqual(entry);
    });

    it('FVG SHORT valid: raw SL above entry, buffer added, stays above entry', () => {
      const rawSl = 100;
      const buffer = 2;
      const entry = 95;
      const finalSl = rawSl + buffer; // production formula: SHORT -> rawSl + buffer
      expect(finalSl).toBeGreaterThan(entry);
    });

    it('FVG SHORT invalid for the illustrated raw-SL/buffer/entry values', () => {
      const rawSl = 100;
      const buffer = 2;
      const entry = 103; // confirming candle close has moved ABOVE the raw zone level itself
      const finalSl = rawSl + buffer; // 102
      expect(finalSl).toBeLessThanOrEqual(entry);
    });

    it('Sweep LONG valid and invalid mirror the FVG cases exactly (same two-line formula, only rawSl source differs — sweep candle low/high vs FVG zone edge)', () => {
      const bufferedSl = (rawSl: number, buffer: number) => rawSl - buffer;
      expect(bufferedSl(100, 2)).toBeLessThan(105); // valid: entry 105 still above
      expect(bufferedSl(100, 2)).toBeGreaterThanOrEqual(97); // invalid: entry 97 already crossed
    });

    it('Sweep SHORT valid and invalid mirror the FVG cases exactly', () => {
      const bufferedSl = (rawSl: number, buffer: number) => rawSl + buffer;
      expect(bufferedSl(100, 2)).toBeGreaterThan(95); // valid: entry 95 still below
      expect(bufferedSl(100, 2)).toBeLessThanOrEqual(103); // invalid: entry 103 already crossed
    });

    it('the ATR buffer itself never flips valid raw geometry into invalid geometry when the raw level and entry are already correctly ordered with reasonable margin', () => {
      const rawSl = 100;
      const entry = 110; // 10-unit margin
      for (const buffer of [0, 0.5, 1, 2, 5]) {
        const finalSl = rawSl - buffer; // LONG direction
        expect(finalSl).toBeLessThan(entry); // buffer only pushes SL further away, never crosses a 10-unit margin at these buffer sizes
      }
    });

    it('raw geometry can already be wrong BEFORE any buffer is applied (buffer is not the sole or even primary cause in this scenario)', () => {
      const rawSl = 100;
      const entry = 99; // entry already below rawSl, i.e. price already crossed the raw zone level itself
      const buffer = 0;
      const finalSl = rawSl - buffer; // == rawSl == 100, unchanged by zero buffer
      expect(finalSl).toBeGreaterThan(entry); // already invalid for LONG (100 > 99) with ZERO buffer contribution
    });
  });
});
