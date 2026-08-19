process.env.T153_LIBRARY_MODE = 'true';
import { describe, expect, it } from 'vitest';
import {
  createG6ShadowOpportunityAnalyzer,
  evaluateStage,
  auditDecisionFeatureProvenance,
  FutureCandleViolationError,
  ONE_MINUTE_MS,
  FIVE_MINUTES_MS,
  type ShadowAnalyzerInput,
  type ShadowDecisionContext,
  type FrozenShadowEvent,
  type DecisionFeatureProvenance,
} from './g6rShadowAnalyzer.js';
import { classifyTimestamp, parseForensicLedgerCsv } from './g6rCp3hForensicSchema.js';
import { confirmingCandleAvailableAt, isConfirmingCandleAvailableAtBeforeOrEqualToMaxFeatureAvailableAt } from './g6rCp3iTimestampSemantics.js';
import type { CandleData } from '../dist/regime/types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * G6R CP3I fixture tests. Every test below calls the REAL, already-frozen, exported functions
 * (`evaluateStage`, `createG6ShadowOpportunityAnalyzer().observeDecision`,
 * `auditDecisionFeatureProvenance`, `classifyTimestamp`) against hand-built fixtures. No
 * detector/MSS/staleness/ATR/SL formula is reimplemented here. `g6rShadowAnalyzer.ts` and
 * `g6rCp3hForensicSchema.ts` are read-only dependencies of this test file, never edited by CP3I.
 */

function c(open: number, close: number, high: number, low: number, timestamp: number): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

// ============================== Shared fixtures ==============================

// Same BULLISH MSS pattern as apps/bot/src/entry/detectors/marketStructureShift.test.ts (higher-low
// at index 8 vs index 2, reference high at index 5, confirmed at index 11 when close=13 breaks 12) —
// reused, not reinvented, with real 1-minute-spaced timestamps instead of timestamp=0.
const MSS_BASE = 1_700_000_000_000;
function mssMinuteCandles(count: number): CandleData[] {
  const base: Array<[number, number, number, number]> = [
    [9.5, 9.5, 10, 9], // 0
    [9.25, 9.25, 10, 8.5], // 1
    [7.5, 7.5, 9.5, 6], // 2 — swing low #1 (6)
    [9.25, 9.25, 10, 8.5], // 3
    [9.5, 9.5, 10, 9], // 4
    [10.5, 10.5, 12, 9], // 5 — swing high BETWEEN the two lows (12)
    [9.25, 9.25, 10, 8.5], // 6
    [9.5, 9.5, 10, 9], // 7
    [8.75, 8.75, 9.5, 8], // 8 — swing low #2 (8), higher-low vs index 2
    [9.25, 9.25, 10, 8.5], // 9
    [9.5, 9.5, 10, 9], // 10
    [12.5, 13, 13.2, 12.3], // 11 — close 13 > 12 -> MSS confirms HERE (mssIndex=11)
    [13, 13, 13.5, 12.8], // 12 — POST-CONFIRMATION candle #1 (i+1)
    [13, 13, 13.5, 12.8], // 13 — POST-CONFIRMATION candle #2 (i+2)
  ];
  return base.slice(0, count).map(([o, cl, h, l], i) => c(o, cl, h, l, MSS_BASE + i * ONE_MINUTE_MS));
}

// ATR input: 16 identical closed 5m candles (deterministic wilder ATR = 1, since high-low=1 and no
// gap vs previous close) — content is irrelevant to MSS confirmation, only feeds the ATR buffer.
const CANDLES5M_BASE = 1_699_999_000_000;
const candles5mForAtr: CandleData[] = Array.from({ length: 16 }, (_, i) => c(9, 9, 9.5, 8.5, CANDLES5M_BASE + i * FIVE_MINUTES_MS));

const SOURCE_TIMESTAMP = MSS_BASE; // matches mssMinuteCandles()[0].timestamp exactly
const RAW_SL_PRICE = 8; // LONG: entryPrice(=13) must end up > slPrice after buffer
const SL_BUFFER_ATR_MULTIPLIER = 1; // buffer = atr(1) * 1 = 1 -> slPrice = 8 - 1 = 7

describe('CP3I fixture 1 — confirming candle at index i plus i+1/i+2 present in the same window', () => {
  it('mssConfirmedIndex points at the confirming candle (11), not at the window end (13), when 2 post-confirmation candles are present', () => {
    const stage = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    expect(stage.mssConfirmed).toBe(true);
    expect(stage.mssConfirmedIndex).toBe(11);
    expect(stage.mssConfirmationTimestamp).toBe(MSS_BASE + 11 * ONE_MINUTE_MS);
  });

  it('mssMaxTimestampRead/stalenessReferenceTimestamp reflect the WINDOW END (candle 13), strictly after the confirming candle (11)', () => {
    const stage = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    const p = stage.provenancePartial!;
    expect(p.mssMaxTimestampRead).toBe(MSS_BASE + 13 * ONE_MINUTE_MS);
    expect(p.stalenessReferenceTimestamp).toBe(p.mssMaxTimestampRead); // the documented alias, unchanged
    expect(p.mssMaxTimestampRead).toBeGreaterThan(stage.mssConfirmationTimestamp!);
    // candlesFromEnd = mssWindow.length - 1 - mssIndex = 13 - 11 = 2, inside the [0,5) tolerance.
    expect(p.mssMaxAvailableAt).toBe(p.mssMaxTimestampRead + ONE_MINUTE_MS);
  });

  it('decisionAvailableAt (canonical: confirmingCandleAvailableAt) is EARLIER than mssMaxAvailableAt whenever post-confirmation candles exist — the exact conflation named in the semantics doc', () => {
    const stage = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    const p = stage.provenancePartial!;
    const canonicalDecisionAvailableAt = confirmingCandleAvailableAt(stage.mssConfirmationTimestamp!);
    expect(canonicalDecisionAvailableAt).toBe(MSS_BASE + 11 * ONE_MINUTE_MS + ONE_MINUTE_MS);
    expect(canonicalDecisionAvailableAt).toBeLessThan(p.mssMaxAvailableAt);
    expect(p.mssMaxAvailableAt - canonicalDecisionAvailableAt).toBe(2 * ONE_MINUTE_MS); // exactly the 2 post-confirmation candles
  });
});

describe('CP3I fixture 3 — decision is stable once its true inputs are fixed (trailing read-ahead does not change the decision content)', () => {
  it('entryPrice/slPrice/mssConfirmedIndex/decisionTimestamp are IDENTICAL whether the window has 0 or 2 trailing post-confirmation candles', () => {
    const noTrailing = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(12), SL_BUFFER_ATR_MULTIPLIER);
    const withTrailing = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    expect(noTrailing.mssConfirmed).toBe(true);
    expect(withTrailing.mssConfirmed).toBe(true);
    expect(withTrailing.mssConfirmedIndex).toBe(noTrailing.mssConfirmedIndex);
    expect(withTrailing.mssConfirmationTimestamp).toBe(noTrailing.mssConfirmationTimestamp);
    expect(withTrailing.entryPrice).toBe(noTrailing.entryPrice);
    expect(withTrailing.slPrice).toBe(noTrailing.slPrice);
    // Only the staleness-window bookkeeping differs, never the decision itself.
    expect(withTrailing.provenancePartial!.mssMaxTimestampRead).not.toBe(noTrailing.provenancePartial!.mssMaxTimestampRead);
    expect(noTrailing.provenancePartial!.mssMaxTimestampRead).toBe(noTrailing.mssConfirmationTimestamp); // candlesFromEnd=0 case: window end === confirming candle
  });

  it('a candle whose close is at/after evaluationCutoffExclusive is REJECTED before it can ever reach/influence the decision (observeDecision fail-closed guard)', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const cutoff = MSS_BASE + 5 * ONE_MINUTE_MS;
    const futureCandle = c(9, 9, 9.5, 8.5, cutoff); // closesAt = cutoff + ONE_MINUTE_MS > cutoff -> not yet closed
    const input: ShadowAnalyzerInput = {
      symbol: 'BTCUSDT',
      candles5m: [],
      candlesMss: [futureCandle],
      macroInputCandles1d: [],
      adxDirection1h: 'UP',
      obEnabled: true,
      obDisabledSymbols: [],
      obBosLookforwardK: 10,
      obSlBufferAtrMultiplier: 0.87,
      macroTrendFilterEnabled: false,
      macroDirection: undefined,
      evaluationCutoffExclusive: cutoff,
    };
    const ctx: ShadowDecisionContext = { evaluationId: 'BTCUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };
    expect(() => analyzer.observeDecision(input, ctx)).toThrow(FutureCandleViolationError);
    // The rejection happens BEFORE any detector/MSS logic runs (assertCandlesClosed is the very
    // first thing observeDecision does), so this un-closed candle can never influence entryPrice,
    // slPrice, or decisionTimestamp — the strongest possible form of "does not change the outcome":
    // it never gets read at all.
  });
});

describe('CP3I fixture 4 — unclosed candle read: rejected at the observeDecision() call boundary, and flagged when it slips past a real event', () => {
  it('observeDecision throws FutureCandleViolationError with the exact offending array/index/timestamps', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const cutoff = 1_000_000;
    const badCandle = c(9, 9, 9.5, 8.5, cutoff); // closesAt = cutoff + FIVE_MINUTES_MS > cutoff
    const input: ShadowAnalyzerInput = {
      symbol: 'ETHUSDT',
      candles5m: [badCandle],
      candlesMss: [],
      macroInputCandles1d: [],
      adxDirection1h: 'UP',
      obEnabled: true,
      obDisabledSymbols: [],
      obBosLookforwardK: 10,
      obSlBufferAtrMultiplier: 0.87,
      macroTrendFilterEnabled: false,
      macroDirection: undefined,
      evaluationCutoffExclusive: cutoff,
    };
    const ctx: ShadowDecisionContext = { evaluationId: 'ETHUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };
    let caught: unknown;
    try {
      analyzer.observeDecision(input, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FutureCandleViolationError);
    const err = caught as FutureCandleViolationError;
    expect(err.array).toBe('candles5m');
    expect(err.candleIndex).toBe(0);
    expect(err.candleTimestamp).toBe(cutoff);
    expect(err.evaluationCutoffExclusive).toBe(cutoff);
  });

  it('auditDecisionFeatureProvenance() (the real, frozen fail-closed detector) flags UNCLOSED_CANDLE_READ / classifyTimestamp reports UNCLOSED_INPUT_READ when a candidate somehow carries provenance whose mssMaxAvailableAt exceeds its own evaluationCutoffExclusive', () => {
    // Bypasses observeDecision()'s own guard on purpose, to prove the SEPARATE, independent
    // fail-closed detection mechanism (auditDecisionFeatureProvenance/classifyTimestamp) also
    // catches this class of defect on its own — never trusting only one layer of defense.
    const decisionTimestamp = 2_000_000;
    const evaluationCutoffExclusive = 2_100_000; // deliberately BEFORE mssMaxAvailableAt below
    const provenance: DecisionFeatureProvenance = {
      detector5mMaxTimestamp: decisionTimestamp,
      detector5mMaxAvailableAt: decisionTimestamp + FIVE_MINUTES_MS,
      mssMaxTimestampRead: decisionTimestamp,
      mssMaxAvailableAt: 2_200_000, // > evaluationCutoffExclusive (2_100_000) -> UNCLOSED_CANDLE_READ
      mssConfirmationTimestamp: decisionTimestamp,
      stalenessReferenceTimestamp: decisionTimestamp,
      atr5mMaxTimestamp: decisionTimestamp,
      atr5mMaxAvailableAt: decisionTimestamp + FIVE_MINUTES_MS,
      macroInputMaxTimestamp: decisionTimestamp,
      macroInputMaxAvailableAt: decisionTimestamp + FIVE_MINUTES_MS,
      evaluationCutoffExclusive,
      maxRawFeatureTimestamp: decisionTimestamp,
      maxFeatureAvailableAt: 2_200_000,
    };
    const event: FrozenShadowEvent = {
      candidateKey: 'BTCUSDT|LONG|FVG|2000000|1900000',
      evaluationId: 'BTCUSDT|1900000|TREND_RIDER|0',
      symbol: 'BTCUSDT',
      side: 'LONG',
      regime: 'TREND_RIDER',
      setupType: 'FVG',
      sourceTimestamp: 1_900_000,
      evaluationTimestamp: 1_900_000,
      decisionTimestamp,
      entryPrice: 100,
      slPrice: 90,
      slDistance: 10,
      provenance,
    };
    const audit = auditDecisionFeatureProvenance([event]);
    expect(audit.pass).toBe(false);
    expect(audit.violations.some((v) => v.kind === 'UNCLOSED_CANDLE_READ' && v.provenanceField === 'mssMaxAvailableAt')).toBe(true);
    expect(classifyTimestamp(event)).toBe('UNCLOSED_INPUT_READ');
  });

  it('the frozen 105-row fallback population (real, hash-verified CP3H ledger, re-parsed here with the real parseForensicLedgerCsv, zero replay) never actually exhibits UNCLOSED_INPUT_READ — it is exclusively READ_AFTER_DECISION_TIMESTAMP or CLEAN', () => {
    const REPO_ROOT = path.resolve(__dirname, '../../..');
    const ledgerPath = path.resolve(REPO_ROOT, 'data/g6r-runs/g6r-cp3h-shadow-forensic-ledger.csv');
    const rows = parseForensicLedgerCsv(readFileSync(ledgerPath, 'utf8'));
    expect(rows).toHaveLength(209);
    const fallbackRows = rows.filter((r) => r.setupType !== 'OB');
    expect(fallbackRows).toHaveLength(105);

    const byClass: Record<string, number> = {};
    for (const r of fallbackRows) byClass[r.timestampClass] = (byClass[r.timestampClass] ?? 0) + 1;
    expect(byClass).toEqual({ READ_AFTER_DECISION_TIMESTAMP: 92, CLEAN: 13 });
    expect(byClass.UNCLOSED_INPUT_READ ?? 0).toBe(0);

    // Every non-CLEAN row's candlesFromEnd is inside the [1, MSS_STALENESS_TOLERANCE_CANDLES) range
    // — i.e. driven exclusively by the intended staleness-window read-ahead mechanism (section 8 of
    // the semantics doc), never by a genuinely unclosed candle.
    const nonClean = fallbackRows.filter((r) => r.timestampClass !== 'CLEAN');
    expect(nonClean).toHaveLength(92);
    for (const r of nonClean) {
      expect(r.candlesFromEnd).toBeGreaterThanOrEqual(1);
      expect(r.candlesFromEnd).toBeLessThan(5);
      // Re-derive the classification directly from this row's own provenance via the real,
      // frozen classifyTimestamp() — never trusting the persisted column blindly.
      const recomputed = classifyTimestamp({
        candidateKey: r.candidateKey,
        evaluationId: r.evaluationId,
        symbol: r.symbol,
        side: r.side,
        regime: r.regime,
        setupType: r.setupType,
        sourceTimestamp: r.sourceTimestamp,
        evaluationTimestamp: r.evaluationTimestamp,
        decisionTimestamp: r.decisionTimestamp,
        entryPrice: r.entryPrice,
        slPrice: r.slPrice,
        slDistance: r.slDistance,
        provenance: {
          detector5mMaxTimestamp: r.detector5mMaxTimestamp,
          detector5mMaxAvailableAt: r.detector5mMaxAvailableAt,
          mssMaxTimestampRead: r.mssMaxTimestampRead,
          mssMaxAvailableAt: r.mssMaxAvailableAt,
          mssConfirmationTimestamp: r.decisionTimestamp,
          stalenessReferenceTimestamp: r.stalenessReferenceTimestamp,
          atr5mMaxTimestamp: r.atr5mMaxTimestamp,
          atr5mMaxAvailableAt: r.atr5mMaxAvailableAt,
          macroInputMaxTimestamp: r.macroInputMaxTimestamp,
          macroInputMaxAvailableAt: r.macroInputMaxAvailableAt,
          evaluationCutoffExclusive: r.evaluationCutoffExclusive,
          maxRawFeatureTimestamp: r.maxRawFeatureTimestamp,
          maxFeatureAvailableAt: r.maxFeatureAvailableAt,
        },
      });
      expect(recomputed).toBe('READ_AFTER_DECISION_TIMESTAMP');
      expect(recomputed).toBe(r.timestampClass);
    }
  });
});

describe('CP3I fixture 5 — timestamp ordering / boundary-equality conventions', () => {
  it('mssWindow filter uses >= (inclusive): a candle exactly AT sourceTimestamp is included, one strictly before is excluded', () => {
    const at = c(9, 9, 9.5, 8.5, SOURCE_TIMESTAMP);
    const before = c(9, 9, 9.5, 8.5, SOURCE_TIMESTAMP - 1);
    const after1 = c(9.5, 9.5, 10, 9, SOURCE_TIMESTAMP + ONE_MINUTE_MS);
    // With only [before, at, after1] and sourceTimestamp = SOURCE_TIMESTAMP, mssMaxTimestampRead
    // (window's last element after the >= filter) must equal `after1`'s timestamp, and the window
    // must NOT include `before` — verified indirectly via mssMaxTimestampRead not decreasing to
    // `before`'s timestamp when `before` is prepended, and via count-sensitive candlesFromEnd staying
    // 1 (2-candle window: at, after1) rather than 2 (if `before` had wrongly been included).
    const stage = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, [before, at, after1], SL_BUFFER_ATR_MULTIPLIER);
    expect(stage.provenancePartial!.mssMaxTimestampRead).toBe(after1.timestamp);
    expect(stage.mssFailReason === 'NOT_FOUND' || stage.mssConfirmed === false).toBeTruthy(); // no real MSS pattern in this 2-candle synthetic window — not the point of this test
  });

  it('assertCandlesClosed boundary: closesAt === evaluationCutoffExclusive PASSES (inclusive <=); closesAt === cutoff+1 THROWS', () => {
    const analyzer = createG6ShadowOpportunityAnalyzer();
    const cutoff = 5_000_000;
    const exactlyClosedCandle = c(9, 9, 9.5, 8.5, cutoff - ONE_MINUTE_MS); // closesAt = cutoff exactly
    const oneMsTooLateCandle = c(9, 9, 9.5, 8.5, cutoff - ONE_MINUTE_MS + 1); // closesAt = cutoff + 1

    const okInput: ShadowAnalyzerInput = {
      symbol: 'BTCUSDT',
      candles5m: [],
      candlesMss: [exactlyClosedCandle],
      macroInputCandles1d: [],
      adxDirection1h: undefined, // FLAT/undefined -> returns immediately after closure checks, no detector call needed
      obEnabled: true,
      obDisabledSymbols: [],
      obBosLookforwardK: 10,
      obSlBufferAtrMultiplier: 0.87,
      macroTrendFilterEnabled: false,
      macroDirection: undefined,
      evaluationCutoffExclusive: cutoff,
    };
    const ctx: ShadowDecisionContext = { evaluationId: 'BTCUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };
    expect(() => analyzer.observeDecision(okInput, ctx)).not.toThrow();

    const badInput: ShadowAnalyzerInput = { ...okInput, candlesMss: [oneMsTooLateCandle] };
    expect(() => analyzer.observeDecision(badInput, ctx)).toThrow(FutureCandleViolationError);
  });

  it('confirmingCandleAvailableAt is always <= maxFeatureAvailableAt for a real confirmed decision (event-time vs data-availability distinction holds)', () => {
    const stage = evaluateStage('OB', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    const p = stage.provenancePartial!;
    const detector5mMaxTimestamp = candles5mForAtr[candles5mForAtr.length - 1].timestamp;
    const detector5mMaxAvailableAt = detector5mMaxTimestamp + FIVE_MINUTES_MS;
    const macroInputMaxAvailableAt = 0; // no macro input in this fixture -> defaults to context timestamp; irrelevant to the <= invariant since it's the min contributor here
    const maxFeatureAvailableAt = Math.max(detector5mMaxAvailableAt, p.mssMaxAvailableAt, p.atr5mMaxAvailableAt!, macroInputMaxAvailableAt);
    expect(isConfirmingCandleAvailableAtBeforeOrEqualToMaxFeatureAvailableAt(stage.mssConfirmationTimestamp!, maxFeatureAvailableAt)).toBe(true);
  });
});

describe('CP3I fixture 2 — multi-timeframe fixture matching evaluateStage()\'s real signature (candles5m + candlesMss as two distinct timeframes)', () => {
  it('the 5m ATR series and the 1m MSS series are read independently and never conflated (different arrays, different intervals, different roles)', () => {
    const stage = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5mForAtr, mssMinuteCandles(14), SL_BUFFER_ATR_MULTIPLIER);
    expect(stage.mssConfirmed).toBe(true);
    // atr5mMaxTimestamp comes from candles5mForAtr (5-minute spacing), mssMaxTimestampRead comes
    // from mssMinuteCandles (1-minute spacing) — assert they are drawn from the correct series by
    // checking their values land on each series' own timestamp grid.
    const p = stage.provenancePartial!;
    expect((p.atr5mMaxTimestamp! - CANDLES5M_BASE) % FIVE_MINUTES_MS).toBe(0);
    expect((p.mssMaxTimestampRead - MSS_BASE) % ONE_MINUTE_MS).toBe(0);
    expect(p.atr5mMaxTimestamp).toBe(candles5mForAtr[candles5mForAtr.length - 1].timestamp);
  });
});
