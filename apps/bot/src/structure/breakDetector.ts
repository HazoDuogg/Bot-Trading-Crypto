import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';

const ATR_PERIOD = 14;
const ATR_BUFFER_MULTIPLIER = 0.1;
export const D6_COUNTER_TEST_WINDOW = 10;
export const D6_RECLAIM_WINDOW = 3;

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

// D2 — CONVENTION: close must clear the level by 0.1 × prior closed-candle ATR14.
export function detectMeaningfulBreak(candles: readonly Candle[], request: BreakRequest): BreakResult | null {
  if (!Number.isFinite(request.level)) throw new Error('Break level must be finite');
  const startIndex = Math.max(0, request.startIndex ?? 0);
  const endIndex = Math.min(candles.length - 1, request.endIndex ?? candles.length - 1);
  const tracker = createAtrTracker(ATR_PERIOD);
  let priorAtr: number | null = null;

  for (let index = 0; index <= endIndex; index += 1) {
    const current = candles[index];
    if (index >= startIndex && priorAtr !== null) {
      const buffer = priorAtr * ATR_BUFFER_MULTIPLIER;
      const crossed =
        request.direction === 'up'
          ? current.close > request.level + buffer
          : current.close < request.level - buffer;
      if (crossed) return { brokeAt: index, direction: request.direction, level: request.level };
    }
    priorAtr = tracker.next(current);
  }
  return null;
}

export function evaluateDominance(
  candles: readonly Candle[],
  breakout: BreakResult,
  counterTestWindow = D6_COUNTER_TEST_WINDOW,
  reclaimWindow = D6_RECLAIM_WINDOW,
): DominanceEvidence {
  if (!Number.isSafeInteger(counterTestWindow) || counterTestWindow <= 0) {
    throw new Error('counterTestWindow must be a positive integer');
  }
  if (!Number.isSafeInteger(reclaimWindow) || reclaimWindow <= 0) {
    throw new Error('reclaimWindow must be a positive integer');
  }
  const neutral: DominanceEvidence = {
    side: 'NEUTRAL',
    brokeLevel: breakout.level,
    counterTestFailed: false,
    counterTestIndex: null,
  };
  const counterSearchEnd = Math.min(breakout.brokeAt + counterTestWindow, candles.length - 1);
  let counterTestIndex: number | null = null;
  for (let index = breakout.brokeAt + 1; index <= counterSearchEnd; index += 1) {
    const counterTested =
      breakout.direction === 'up' ? candles[index].low <= breakout.level : candles[index].high >= breakout.level;
    if (counterTested) {
      counterTestIndex = index;
      break;
    }
  }
  if (counterTestIndex === null) return neutral;

  const neutralAfterCounterTest = { ...neutral, counterTestIndex };
  const reclaimEndIndex = counterTestIndex + reclaimWindow;

  const reclaimDirection: BreakDirection = breakout.direction === 'up' ? 'down' : 'up';
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
}
