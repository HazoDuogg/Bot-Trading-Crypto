import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import { isValidClosedM5Candle } from './m5Candle.js';
import type { OpeningRangeResult } from './openingRange.js';
import type { CasperCandle, CasperState } from './types.js';

export type BreakoutRejection = 'BULLISH_WICK_ONLY' | 'BEARISH_WICK_ONLY' | 'BOTH_WICKS_ONLY';

export interface M5BreakoutResult {
  state: CasperState;
  tradingDay: string;
  signal: 'BULLISH' | 'BEARISH' | null;
  rejection: BreakoutRejection | null;
}

export interface DetectM5BreakoutInput {
  nowMs: number;
  candle: CasperCandle;
  openingRange: OpeningRangeResult;
}

function result(
  state: CasperState,
  tradingDay: string,
  signal: M5BreakoutResult['signal'] = null,
  rejection: BreakoutRejection | null = null,
): M5BreakoutResult {
  return { state, tradingDay, signal, rejection };
}

export function detectM5Breakout(input: DetectM5BreakoutInput): M5BreakoutResult {
  const { nowMs, candle, openingRange } = input;
  const now = getNewYorkTimeParts(nowMs);
  const startTime = getNewYorkTimeParts(candle.startTimeMs);
  const closeTime = getNewYorkTimeParts(candle.endTimeMs);
  if (!now || !startTime || !closeTime) return result('INVALID_DATA', openingRange.tradingDay);
  const nowMinute = minuteOfDay(now);
  const startMinute = minuteOfDay(startTime);
  const closeMinute = minuteOfDay(closeTime);

  if (openingRange.state !== 'OR_LOCKED') {
    return result(openingRange.state, openingRange.tradingDay);
  }
  if (
    now.tradingDay !== openingRange.tradingDay ||
    startTime.tradingDay !== openingRange.tradingDay ||
    closeTime.tradingDay !== openingRange.tradingDay
  ) {
    return result('INVALID_DATA', now.tradingDay);
  }
  if (nowMinute < 9 * 60 + 30 || startMinute < 9 * 60 + 30) {
    return result('UNINITIALIZED', closeTime.tradingDay);
  }
  if (nowMinute < 9 * 60 + 45 || startMinute < 9 * 60 + 45) {
    return result('OR_BUILDING', closeTime.tradingDay);
  }
  if (nowMinute >= 12 * 60 || closeMinute >= 12 * 60) {
    return result('WINDOW_CLOSED', closeTime.tradingDay);
  }

  const validCandle = isValidClosedM5Candle(candle, nowMs, openingRange.tradingDay);
  const validRange =
    Number.isFinite(openingRange.range.high) &&
    Number.isFinite(openingRange.range.low) &&
    openingRange.range.high >= openingRange.range.low;
  if (!validCandle || !validRange) return result('INVALID_DATA', closeTime.tradingDay);

  if (candle.close > openingRange.range.high) {
    return result('BULLISH_BREAKOUT', closeTime.tradingDay, 'BULLISH');
  }
  if (candle.close < openingRange.range.low) {
    return result('BEARISH_BREAKOUT', closeTime.tradingDay, 'BEARISH');
  }

  const bullishWick = candle.high > openingRange.range.high;
  const bearishWick = candle.low < openingRange.range.low;
  if (bullishWick && bearishWick) {
    return result('OR_LOCKED', closeTime.tradingDay, null, 'BOTH_WICKS_ONLY');
  }
  if (bullishWick) {
    return result('OR_LOCKED', closeTime.tradingDay, null, 'BULLISH_WICK_ONLY');
  }
  if (bearishWick) {
    return result('OR_LOCKED', closeTime.tradingDay, null, 'BEARISH_WICK_ONLY');
  }
  return result('OR_LOCKED', closeTime.tradingDay);
}
