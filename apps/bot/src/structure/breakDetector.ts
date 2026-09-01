import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';

export const D2_BREAK_V1_ATR_PERIOD = 14;
export const D2_BREAK_V1_ATR_BUFFER_MULTIPLIER = 0.1;
export const D6_COUNTER_TEST_WINDOW = 10;
export const D6_RECLAIM_WINDOW = 3;
// N=2 gets twice the baseline search horizon so two distinct touch-and-withdraw episodes can form.
export const D6_SECOND_TEST_COUNTER_WINDOW = 20;
export const D6_DEFAULT_MINIMUM_TEST_OCCURRENCE = 1;

export type BreakDirection = 'up' | 'down';

export interface BreakResult {
  brokeAt: number;
  direction: BreakDirection;
  level: number;
}

export interface BreakRequest {
  level: number;
  direction: BreakDirection;
  startIndex?: number;
  endIndex?: number;
}

export interface DominanceEvidence {
  side: 'BULL' | 'BEAR' | 'NEUTRAL';
  brokeLevel: number;
  counterTestFailed: boolean;
  counterTestIndex: number | null;
}

export interface DominanceEvaluationOptions {
  counterTestWindow?: number;
  reclaimWindow?: number;
  minimumTestOccurrence?: number;
}

export function isMeaningfulBreakAtClose(
  close: number,
  level: number,
  direction: BreakDirection,
  priorAtr: number,
): boolean {
  if (!Number.isFinite(close) || !Number.isFinite(level)) {
    throw new Error('Break close and level must be finite');
  }
  if (!Number.isFinite(priorAtr) || priorAtr <= 0) {
    throw new Error('priorAtr must be finite and greater than zero');
  }
  const buffer = priorAtr * D2_BREAK_V1_ATR_BUFFER_MULTIPLIER;
  return direction === 'up' ? close > level + buffer : close < level - buffer;
}

// D2 — CONVENTION: close must clear the level by 0.1 × prior closed-candle ATR14.
export function detectMeaningfulBreak(candles: readonly Candle[], request: BreakRequest): BreakResult | null {
  if (!Number.isFinite(request.level)) throw new Error('Break level must be finite');
  const startIndex = Math.max(0, request.startIndex ?? 0);
  const endIndex = Math.min(candles.length - 1, request.endIndex ?? candles.length - 1);
  const tracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
  let priorAtr: number | null = null;

  for (let index = 0; index <= endIndex; index += 1) {
    const current = candles[index];
    if (index >= startIndex && priorAtr !== null) {
      const crossed = isMeaningfulBreakAtClose(
        current.close,
        request.level,
        request.direction,
        priorAtr,
      );
      if (crossed) return { brokeAt: index, direction: request.direction, level: request.level };
    }
    priorAtr = tracker.next(current);
  }
  return null;
}

export function evaluateDominance(
  candles: readonly Candle[],
  breakout: BreakResult,
  counterTestWindowOrOptions: number | DominanceEvaluationOptions = D6_COUNTER_TEST_WINDOW,
  legacyReclaimWindow = D6_RECLAIM_WINDOW,
): DominanceEvidence {
  const minimumTestOccurrence =
    typeof counterTestWindowOrOptions === 'number'
      ? 1
      : (counterTestWindowOrOptions.minimumTestOccurrence ??
        D6_DEFAULT_MINIMUM_TEST_OCCURRENCE);
  const counterTestWindow =
    typeof counterTestWindowOrOptions === 'number'
      ? counterTestWindowOrOptions
      : (counterTestWindowOrOptions.counterTestWindow ??
        (minimumTestOccurrence === 1
          ? D6_COUNTER_TEST_WINDOW
          : D6_SECOND_TEST_COUNTER_WINDOW));
  const reclaimWindow =
    typeof counterTestWindowOrOptions === 'number'
      ? legacyReclaimWindow
      : (counterTestWindowOrOptions.reclaimWindow ?? D6_RECLAIM_WINDOW);
  if (!Number.isSafeInteger(counterTestWindow) || counterTestWindow <= 0) {
    throw new Error('counterTestWindow must be a positive integer');
  }
  if (!Number.isSafeInteger(reclaimWindow) || reclaimWindow <= 0) {
    throw new Error('reclaimWindow must be a positive integer');
  }
  if (!Number.isSafeInteger(minimumTestOccurrence) || minimumTestOccurrence <= 0) {
    throw new Error('minimumTestOccurrence must be a positive integer');
  }
  const neutral: DominanceEvidence = {
    side: 'NEUTRAL',
    brokeLevel: breakout.level,
    counterTestFailed: false,
    counterTestIndex: null,
  };
  const counterSearchEnd = Math.min(breakout.brokeAt + counterTestWindow, candles.length - 1);
  const reclaimDirection: BreakDirection = breakout.direction === 'up' ? 'down' : 'up';
  const evaluateOccurrence = (counterTestIndex: number): DominanceEvidence => {
    const neutralAfterCounterTest = { ...neutral, counterTestIndex };
    const reclaimEndIndex = counterTestIndex + reclaimWindow;
    const reclaim = detectMeaningfulBreak(candles, {
      level: breakout.level,
      direction: reclaimDirection,
      startIndex: counterTestIndex,
      endIndex: Math.min(reclaimEndIndex, candles.length - 1),
    });
    if (reclaim !== null || reclaimEndIndex >= candles.length) return neutralAfterCounterTest;
    return {
      side: breakout.direction === 'up' ? 'BULL' : 'BEAR',
      brokeLevel: breakout.level,
      counterTestFailed: true,
      counterTestIndex,
    };
  };

  if (minimumTestOccurrence === 1) {
    for (let index = breakout.brokeAt + 1; index <= counterSearchEnd; index += 1) {
      const touched =
        breakout.direction === 'up'
          ? candles[index].low <= breakout.level
          : candles[index].high >= breakout.level;
      if (touched) return evaluateOccurrence(index);
    }
    return neutral;
  }

  let occurrence = 0;
  let inTestEpisode = false;
  for (let index = breakout.brokeAt + 1; index <= counterSearchEnd; index += 1) {
    const current = candles[index];
    const touched =
      breakout.direction === 'up'
        ? current.low <= breakout.level
        : current.high >= breakout.level;
    if (!inTestEpisode && touched) {
      occurrence += 1;
      inTestEpisode = true;
      if (occurrence >= minimumTestOccurrence) {
        const result = evaluateOccurrence(index);
        if (
          result.side !== 'NEUTRAL' ||
          (result.counterTestIndex !== null && index + reclaimWindow >= candles.length)
        ) {
          return result;
        }
      }
    }
    const withdrew =
      breakout.direction === 'up' ? current.close > breakout.level : current.close < breakout.level;
    if (inTestEpisode && withdrew) inTestEpisode = false;
  }
  return neutral;
}
