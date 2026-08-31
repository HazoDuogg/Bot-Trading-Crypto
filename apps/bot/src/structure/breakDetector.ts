import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';

const ATR_PERIOD = 14;
const ATR_BUFFER_MULTIPLIER = 0.1;
const COUNTER_TEST_CANDLES = 3;

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

export function evaluateDominance(candles: readonly Candle[], breakout: BreakResult): DominanceEvidence {
  const neutral: DominanceEvidence = {
    side: 'NEUTRAL',
    brokeLevel: breakout.level,
    counterTestFailed: false,
  };
  const endIndex = breakout.brokeAt + COUNTER_TEST_CANDLES;
  if (endIndex >= candles.length) return neutral;

  const counterCandles = candles.slice(breakout.brokeAt + 1, endIndex + 1);
  const counterTested = counterCandles.some((item) =>
    breakout.direction === 'up' ? item.low <= breakout.level : item.high >= breakout.level,
  );
  if (!counterTested) return neutral;

  const reclaimDirection: BreakDirection = breakout.direction === 'up' ? 'down' : 'up';
  const reclaim = detectMeaningfulBreak(candles, {
    level: breakout.level,
    direction: reclaimDirection,
    startIndex: breakout.brokeAt + 1,
    endIndex,
  });
  if (reclaim !== null) return neutral;

  return {
    side: breakout.direction === 'up' ? 'BULL' : 'BEAR',
    brokeLevel: breakout.level,
    counterTestFailed: true,
  };
}
