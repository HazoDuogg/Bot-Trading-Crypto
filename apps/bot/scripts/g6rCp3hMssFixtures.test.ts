process.env.T153_LIBRARY_MODE = 'true';
/**
 * TICKET-G6R-CP3H — Step 1 (ticket Section D): real MSS candle-window fixture tests exercising the
 * ACTUAL MSS evaluation code path (`evaluateStage()`, exported per the ticket's explicit pure-
 * extraction carve-out — see g6rShadowAnalyzer.ts's export site comment) with real candle windows,
 * not hand-built provenance objects (CP3G's g6rCp3RootCauseRepro.test.ts approach).
 *
 * `evaluateStage()` itself calls the real production `detectMarketStructureShift()` and
 * `wilderATRSeries()` — nothing here reimplements swing/pattern-matching logic. Only the calling
 * harness (candle arrays, timestamps, direct invocation) is test-authored.
 *
 * Parity: this file also proves the newly-exported `evaluateStage()` is behaviorally identical to
 * the same function reached through the public `observeDecision()` API — both call sites invoke the
 * SAME function object (extraction added only an `export` keyword + doc comment; `git diff --stat`
 * on g6rShadowAnalyzer.ts for this change shows 11 insertions / 1 deletion, no logic line touched).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateStage,
  createG6ShadowOpportunityAnalyzer,
  FutureCandleViolationError,
  ONE_MINUTE_MS,
  FIVE_MINUTES_MS,
  type ShadowAnalyzerInput,
  type ShadowDecisionContext,
} from './g6rShadowAnalyzer.js';
import type { CandleData } from '../dist/regime/types.js';
import { EntryConfig } from '../dist/entry/config.js';

function c(open: number, close: number, high: number, low: number, timestamp: number): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

const T0 = 1_700_000_000_000; // arbitrary real-looking base timestamp, ms

/**
 * Real higher-low / breakout candle pattern (same swing shape as g6rShadowAnalyzer.test.ts's
 * `mssCandles` fixture, which is itself modeled on the production-parity vector in
 * entryRouter.test.ts): swing low #1 at index 2 (price 6), swing high between at index 5 (price 12),
 * swing low #2 at index 8 (price 8, higher than #1 -> valid higher-low), MSS confirms at index 11
 * when close (13) breaks the reference high (12). BULLISH direction (LONG side).
 *
 * Timestamps are explicit, real 1-minute increments from T0 (not all-zero), so every timestamp
 * field asserted below (mssConfirmationTimestamp, mssMaxTimestampRead, candlesFromEnd-derived
 * gaps, availableAt values) is independently meaningful.
 */
function buildMssWindow(extraClosedCandles: number): CandleData[] {
  const base: CandleData[] = [
    c(9.5, 9.5, 10, 9, T0 + 0 * ONE_MINUTE_MS),
    c(9.25, 9.25, 10, 8.5, T0 + 1 * ONE_MINUTE_MS),
    c(7.5, 7.5, 9.5, 6, T0 + 2 * ONE_MINUTE_MS), // swing low #1 (6)
    c(9.25, 9.25, 10, 8.5, T0 + 3 * ONE_MINUTE_MS),
    c(9.5, 9.5, 10, 9, T0 + 4 * ONE_MINUTE_MS),
    c(10.5, 10.5, 12, 9, T0 + 5 * ONE_MINUTE_MS), // swing high between (12)
    c(9.25, 9.25, 10, 8.5, T0 + 6 * ONE_MINUTE_MS),
    c(9.5, 9.5, 10, 9, T0 + 7 * ONE_MINUTE_MS),
    c(8.75, 8.75, 9.5, 8, T0 + 8 * ONE_MINUTE_MS), // swing low #2 (8, higher-low vs #1)
    c(9.25, 9.25, 10, 8.5, T0 + 9 * ONE_MINUTE_MS),
    c(9.5, 9.5, 10, 9, T0 + 10 * ONE_MINUTE_MS),
    c(12.5, 13, 13.2, 12.3, T0 + 11 * ONE_MINUTE_MS), // MSS confirms here: close=13 > referenceHigh=12
  ];
  const extra: CandleData[] = [];
  for (let i = 0; i < extraClosedCandles; i++) {
    // Flat, already-closed candles that do not themselves confirm any new/earlier MSS (their close
    // does not exceed the reference high again in a way that would move the FIRST confirmation
    // earlier — detectMarketStructureShift() stops at the first confirming candle, index 11, always).
    extra.push(c(9.5, 9.5, 10, 9, T0 + (12 + i) * ONE_MINUTE_MS));
  }
  return [...base, ...extra];
}

/** 14 flat 5m candles ending strictly before T0, sufficient for wilderATRSeries(ATR_PERIOD_5M=14). */
function buildCandles5m(): CandleData[] {
  return Array.from({ length: 14 }, (_, i) => c(9, 9, 9.5, 8.5, T0 - (14 - i) * FIVE_MINUTES_MS));
}

const SOURCE_TIMESTAMP = T0; // zone formed at the window's own first candle
const RAW_SL_PRICE = 8.5; // below the eventual entry (13) -> valid LONG geometry by construction
const SL_BUFFER_ATR_MULTIPLIER = 0.1; // EntryConfig.SL_BUFFER_ATR_MULTIPLIER (production value)
const MSS_CONFIRMATION_TIMESTAMP = T0 + 11 * ONE_MINUTE_MS; // window[11].timestamp, constant across cases 1-5

describe('TICKET-G6R-CP3H Step 1 — real MSS candle-window fixture tests (evaluateStage, real production detector)', () => {
  it('case 1: confirming candle IS the window tail (candlesFromEnd=0) — full value set asserted', () => {
    const window = buildMssWindow(0); // length 12, confirm at index 11 -> tail
    const candles5m = buildCandles5m();
    const result = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, window, SL_BUFFER_ATR_MULTIPLIER);

    expect(result.mssConfirmed).toBe(true);
    expect(result.mssConfirmedIndex).toBe(11);
    expect(result.mssConfirmationTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP);
    const confirmingCandleAvailableAt = MSS_CONFIRMATION_TIMESTAMP + ONE_MINUTE_MS;
    const windowTailTimestamp = window[window.length - 1].timestamp;
    const windowTailAvailableAt = windowTailTimestamp + ONE_MINUTE_MS;
    expect(windowTailTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP); // tail === confirming candle here
    expect(windowTailAvailableAt).toBe(confirmingCandleAvailableAt);
    const candlesFromEnd = window.length - 1 - (result.mssConfirmedIndex as number);
    expect(candlesFromEnd).toBe(0);
    expect(result.provenancePartial?.stalenessReferenceTimestamp).toBe(windowTailTimestamp);
    expect(result.provenancePartial?.mssMaxTimestampRead).toBe(windowTailTimestamp);
    const proposedDecisionAvailableAt = windowTailAvailableAt; // T1-style candidate field (CP3G §10 option T1): mssMaxAvailableAt
    expect(proposedDecisionAvailableAt).toBe(confirmingCandleAvailableAt);
    // decisionTimestamp === mssMaxTimestampRead in this specific case (candlesFromEnd=0) — the only
    // case where the CP3G-identified structural gap is zero.
    expect(result.mssConfirmationTimestamp).toBe(result.provenancePartial?.mssMaxTimestampRead);
    expect(result.entryPrice).toBe(13); // window[11].close
    expect(result.slPrice).not.toBeNull();
  });

  it('case 2: confirming candle is 1 before the tail (candlesFromEnd=1) — decisionTimestamp unchanged, mssMaxTimestampRead advances', () => {
    const window = buildMssWindow(1); // length 13
    const candles5m = buildCandles5m();
    const result = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, window, SL_BUFFER_ATR_MULTIPLIER);

    expect(result.mssConfirmed).toBe(true);
    expect(result.mssConfirmedIndex).toBe(11);
    expect(result.mssConfirmationTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP);
    const candlesFromEnd = window.length - 1 - (result.mssConfirmedIndex as number);
    expect(candlesFromEnd).toBe(1);
    const windowTailTimestamp = window[window.length - 1].timestamp;
    expect(windowTailTimestamp).toBe(T0 + 12 * ONE_MINUTE_MS);
    expect(result.provenancePartial?.mssMaxTimestampRead).toBe(windowTailTimestamp);
    expect(result.provenancePartial?.stalenessReferenceTimestamp).toBe(windowTailTimestamp);
    const proposedDecisionAvailableAt = windowTailTimestamp + ONE_MINUTE_MS;
    expect(proposedDecisionAvailableAt).toBe(T0 + 13 * ONE_MINUTE_MS);
    // decisionTimestamp (confirming candle's own open time) is strictly earlier than mssMaxTimestampRead now.
    expect(result.mssConfirmationTimestamp).toBeLessThan(result.provenancePartial!.mssMaxTimestampRead);
  });

  it('case 3: confirming candle is 2 before the tail (candlesFromEnd=2)', () => {
    const window = buildMssWindow(2); // length 14
    const candles5m = buildCandles5m();
    const result = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, window, SL_BUFFER_ATR_MULTIPLIER);

    expect(result.mssConfirmed).toBe(true);
    expect(result.mssConfirmedIndex).toBe(11);
    expect(result.mssConfirmationTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP);
    const candlesFromEnd = window.length - 1 - (result.mssConfirmedIndex as number);
    expect(candlesFromEnd).toBe(2);
    const windowTailTimestamp = window[window.length - 1].timestamp;
    expect(windowTailTimestamp).toBe(T0 + 13 * ONE_MINUTE_MS);
    expect(result.provenancePartial?.mssMaxTimestampRead).toBe(windowTailTimestamp);
    const proposedDecisionAvailableAt = windowTailTimestamp + ONE_MINUTE_MS;
    expect(proposedDecisionAvailableAt).toBe(T0 + 14 * ONE_MINUTE_MS);
    expect(result.entryPrice).toBe(13);
  });

  it('case 4: confirming candle exceeds staleness tolerance (candlesFromEnd >= MSS_STALENESS_TOLERANCE_CANDLES=5) -> STALE', () => {
    expect(EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES).toBe(5);
    const window = buildMssWindow(5); // length 17, candlesFromEnd = 17-1-11 = 5
    const candles5m = buildCandles5m();
    const result = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, window, SL_BUFFER_ATR_MULTIPLIER);

    expect(result.mssConfirmed).toBe(false);
    expect(result.mssFailReason).toBe('STALE');
    expect(result.mssConfirmedIndex).toBe(11); // still found, just rejected as stale
    expect(result.mssConfirmationTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP);
    expect(result.entryPrice).toBeNull();
    expect(result.slPrice).toBeNull();
    const candlesFromEnd = window.length - 1 - 11;
    expect(candlesFromEnd).toBe(5);
    expect(candlesFromEnd).toBeGreaterThanOrEqual(EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES);
    const windowTailTimestamp = window[window.length - 1].timestamp;
    expect(windowTailTimestamp).toBe(T0 + 16 * ONE_MINUTE_MS);
    expect(result.provenancePartial?.mssMaxTimestampRead).toBe(windowTailTimestamp);
    expect(result.provenancePartial?.stalenessReferenceTimestamp).toBe(windowTailTimestamp);
  });

  it('case 4b: one candle short of the tolerance boundary (candlesFromEnd=4) still confirms (not stale) — boundary proof', () => {
    const window = buildMssWindow(4); // length 16, candlesFromEnd = 16-1-11 = 4
    const candles5m = buildCandles5m();
    const result = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, window, SL_BUFFER_ATR_MULTIPLIER);
    expect(result.mssConfirmed).toBe(true);
    expect(result.mssFailReason).toBeNull();
    const candlesFromEnd = window.length - 1 - 11;
    expect(candlesFromEnd).toBe(4);
    expect(candlesFromEnd).toBeLessThan(EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES);
  });

  it('case 5: appending one more already-closed candle after confirmation changes candlesFromEnd/mssMaxTimestampRead WITHOUT changing decisionTimestamp — explicit before/after comparison', () => {
    const candles5m = buildCandles5m();
    const before = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, buildMssWindow(1), SL_BUFFER_ATR_MULTIPLIER); // candlesFromEnd=1
    const after = evaluateStage('FVG', 'LONG', SOURCE_TIMESTAMP, RAW_SL_PRICE, candles5m, buildMssWindow(2), SL_BUFFER_ATR_MULTIPLIER); // candlesFromEnd=2, one more closed candle appended

    // decisionTimestamp (the confirming candle's own timestamp) is IDENTICAL before/after.
    expect(before.mssConfirmationTimestamp).toBe(after.mssConfirmationTimestamp);
    expect(before.mssConfirmationTimestamp).toBe(MSS_CONFIRMATION_TIMESTAMP);
    // mssMaxTimestampRead (== stalenessReferenceTimestamp) DOES change: it advances by exactly one
    // candle interval (ONE_MINUTE_MS), proving the appended candle was genuinely read into the
    // staleness computation even though it did not alter which candle confirmed MSS.
    expect(after.provenancePartial!.mssMaxTimestampRead - before.provenancePartial!.mssMaxTimestampRead).toBe(ONE_MINUTE_MS);
    expect(after.provenancePartial!.stalenessReferenceTimestamp - before.provenancePartial!.stalenessReferenceTimestamp).toBe(ONE_MINUTE_MS);
    // candlesFromEnd itself (not a field on StageEvaluation directly, but derivable) also advances by 1.
    const beforeCandlesFromEnd = buildMssWindow(1).length - 1 - (before.mssConfirmedIndex as number);
    const afterCandlesFromEnd = buildMssWindow(2).length - 1 - (after.mssConfirmedIndex as number);
    expect(afterCandlesFromEnd - beforeCandlesFromEnd).toBe(1);
    // entryPrice/slPrice (both anchored to the confirming candle, not the window tail) are also unchanged.
    expect(before.entryPrice).toBe(after.entryPrice);
    expect(before.slPrice).toBe(after.slPrice);
  });

  it('case 6: an unclosed candle (or one beyond the evaluation cutoff) is rejected by the analyzer BEFORE evaluation — candidate not silently computed with it', () => {
    // evaluateStage() itself has no closure check (the caller/analyzer is responsible for supplying
    // an already-closed candlesMss array) — the actual enforcement point is
    // observeDecision()'s assertCandlesClosed() gate, called BEFORE evaluateStage() is ever reached.
    // This test therefore exercises the full analyzer (real code path), not evaluateStage() directly,
    // to prove that gate holds for exactly the same window shape used in cases 1-5.
    const analyzer = createG6ShadowOpportunityAnalyzer();

    // Baseline: with only the closed window (candlesFromEnd=0 shape), MSS confirms normally under a
    // cutoff that closes every supplied candle.
    const closedWindow = buildMssWindow(0);
    const cutoffAdmittingAll = closedWindow[closedWindow.length - 1].timestamp + ONE_MINUTE_MS; // exactly closes the tail
    const candles5mForCutoff: CandleData[] = [c(9, 9, 9.5, 8.5, cutoffAdmittingAll - FIVE_MINUTES_MS)];
    const baseInput: ShadowAnalyzerInput = {
      symbol: 'BTCUSDT',
      candles5m: candles5mForCutoff,
      candlesMss: closedWindow,
      macroInputCandles1d: [],
      adxDirection1h: 'UP',
      obEnabled: false, // isolate to FVG path is irrelevant here; obEnabled=false means primaryObFound=false, no evaluation at all — instead call evaluateStage-bearing path via OB directly below.
      obDisabledSymbols: [],
      obBosLookforwardK: 10,
      obSlBufferAtrMultiplier: SL_BUFFER_ATR_MULTIPLIER,
      macroTrendFilterEnabled: false,
      macroDirection: undefined,
      evaluationCutoffExclusive: cutoffAdmittingAll,
    };
    const ctx: ShadowDecisionContext = { evaluationId: 'BTCUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };
    // obEnabled=false above only proves the "no candidate" base case is harmless; the real closure
    // assertion is proven directly against candlesMss regardless of OB detection, since
    // assertCandlesClosed('candlesMss', ...) runs unconditionally at the top of observeDecision(),
    // before ANY detector call (see g6rShadowAnalyzer.ts observeDecision()).
    expect(() => analyzer.observeDecision(baseInput, ctx)).not.toThrow();

    // Now append ONE unclosed candle (exactly at the cutoff boundary -> not yet closed: closesAt =
    // cutoff + ONE_MINUTE_MS > cutoff) to candlesMss and re-run with the SAME cutoff.
    const unclosedCandle: CandleData = c(50, 50, 50, 50, cutoffAdmittingAll); // wildly different OHLC so if it were (wrongly) read, results would visibly differ
    const inputWithUnclosed: ShadowAnalyzerInput = { ...baseInput, candlesMss: [...closedWindow, unclosedCandle] };
    let threw = false;
    try {
      analyzer.observeDecision(inputWithUnclosed, ctx);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(FutureCandleViolationError);
      const err = e as FutureCandleViolationError;
      expect(err.array).toBe('candlesMss');
      expect(err.candleTimestamp).toBe(cutoffAdmittingAll);
    }
    expect(threw).toBe(true);

    // And: a candle strictly beyond the cutoff (not just at the boundary) is rejected identically.
    const beyondCutoffCandle: CandleData = c(50, 50, 50, 50, cutoffAdmittingAll + ONE_MINUTE_MS);
    const inputBeyond: ShadowAnalyzerInput = { ...baseInput, candlesMss: [...closedWindow, beyondCutoffCandle] };
    expect(() => analyzer.observeDecision(inputBeyond, ctx)).toThrow(FutureCandleViolationError);
  });

  describe('parity: evaluateStage() reached via the public observeDecision() API produces byte-identical output to the direct exported call (extraction did not change behavior)', () => {
    it('OB-primary evaluation through observeDecision() matches a direct evaluateStage() call with the same real inputs', () => {
      // Build a full OB-bearing 5m fixture (same shape used elsewhere in this ticket's test suite)
      // so observeDecision() reaches evaluateStage('OB', ...) internally, then prove the direct call
      // with equivalent extracted arguments (sourceTimestamp/rawSlPrice/candles5m/candlesMss/buffer)
      // returns the identical StageEvaluation.
      const filler: CandleData[] = Array.from({ length: 14 }, (_, i) => c(9, 9, 9.5, 8.5, T0 - (14 - i) * FIVE_MINUTES_MS - 3 * FIVE_MINUTES_MS));
      const trendCandles5m: CandleData[] = [
        ...filler,
        c(9, 9, 10, 8, T0 - 3 * FIVE_MINUTES_MS),
        c(10.5, 10.5, 12, 9, T0 - 2 * FIVE_MINUTES_MS),
        c(13, 13, 15, 11, T0 - FIVE_MINUTES_MS), // swing high (15)
        c(11, 11, 12, 10, T0),
        c(9, 9, 10, 8, T0 + FIVE_MINUTES_MS),
        c(11, 9, 11, 9, T0 + 2 * FIVE_MINUTES_MS), // OB candidate (down), zone [9, 11]
        c(9, 12, 12.5, 9, T0 + 3 * FIVE_MINUTES_MS),
        c(12, 16, 16, 11.5, T0 + 4 * FIVE_MINUTES_MS), // BOS confirmed
      ];
      const window = buildMssWindow(0);
      const cutoff = Math.max(window[window.length - 1].timestamp + ONE_MINUTE_MS, trendCandles5m[trendCandles5m.length - 1].timestamp + FIVE_MINUTES_MS);
      const input: ShadowAnalyzerInput = {
        symbol: 'BTCUSDT',
        candles5m: trendCandles5m,
        candlesMss: window,
        macroInputCandles1d: [],
        adxDirection1h: 'UP',
        obEnabled: true,
        obDisabledSymbols: [],
        obBosLookforwardK: 10,
        obSlBufferAtrMultiplier: SL_BUFFER_ATR_MULTIPLIER,
        macroTrendFilterEnabled: false,
        macroDirection: undefined,
        evaluationCutoffExclusive: cutoff,
      };
      const ctx: ShadowDecisionContext = { evaluationId: 'BTCUSDT|0|TREND_RIDER|0', regime: 'TREND_RIDER', evaluationTimestamp: 0 };
      const analyzer = createG6ShadowOpportunityAnalyzer();
      const obs = analyzer.observeDecision(input, ctx);
      expect(obs.primary).not.toBeNull();

      // Direct call: OB candle is index (14+5)=19 in trendCandles5m (`c(11, 9, 11, 9, ...)`), zone
      // low=9 (BULLISH direction reads .low per g6rShadowAnalyzer.ts line 513), sourceTimestamp =
      // that candle's own timestamp.
      const obCandleIndex = trendCandles5m.findIndex((x) => x.open === 11 && x.close === 9 && x.low === 9);
      expect(obCandleIndex).toBeGreaterThanOrEqual(0);
      const direct = evaluateStage('OB', 'LONG', trendCandles5m[obCandleIndex].timestamp, trendCandles5m[obCandleIndex].low, trendCandles5m, window, SL_BUFFER_ATR_MULTIPLIER);

      expect(direct).toEqual(obs.primary);
    });
  });
});
