import { isValidClosedM5Candle } from './m5Candle.js';
import { getNewYorkTimeParts, minuteOfDay } from './newYorkTime.js';
import type { OpeningRangeResult } from './openingRange.js';
import type { CasperCandle } from './types.js';

export type BreakoutFvgResult =
  | { state: 'NO_FVG' | 'INVALID_DATA' | 'WINDOW_CLOSED'; tradingDay: string }
  | {
      state: 'VALID_BULLISH_FVG' | 'VALID_BEARISH_FVG';
      direction: 'BULLISH' | 'BEARISH';
      fvgLow: number;
      fvgHigh: number;
      c1: CasperCandle;
      c2: CasperCandle;
      c3: CasperCandle;
      tradingDay: string;
    };

export interface DetectBreakoutFvgInput {
  nowMs: number;
  c1: CasperCandle;
  c2: CasperCandle;
  c3: CasperCandle;
  openingRange: OpeningRangeResult;
}

function hasInsideThenOutside(
  closes: readonly number[],
  orLow: number,
  orHigh: number,
  isDirectionalOutside: (close: number) => boolean,
): boolean {
  let insideSeen = false;
  for (const close of closes) {
    if (close >= orLow && close <= orHigh) insideSeen = true;
    else if (insideSeen && isDirectionalOutside(close)) return true;
  }
  return false;
}

export function detectBreakoutFvg(input: DetectBreakoutFvgInput): BreakoutFvgResult {
  const { nowMs, c1, c2, c3, openingRange } = input;
  if (openingRange.state !== 'OR_LOCKED') {
    return { state: 'INVALID_DATA', tradingDay: openingRange.tradingDay };
  }

  const now = getNewYorkTimeParts(nowMs);
  const c1Start = getNewYorkTimeParts(c1.startTimeMs);
  const c3End = getNewYorkTimeParts(c3.endTimeMs);
  if (!now || !c1Start || !c3End || now.tradingDay !== openingRange.tradingDay) {
    return { state: 'INVALID_DATA', tradingDay: now?.tradingDay ?? openingRange.tradingDay };
  }

  const candles = [c1, c2, c3];
  if (
    !candles.every((candle) =>
      isValidClosedM5Candle(candle, nowMs, openingRange.tradingDay),
    ) ||
    c2.startTimeMs !== c1.endTimeMs ||
    c3.startTimeMs !== c2.endTimeMs
  ) {
    return { state: 'INVALID_DATA', tradingDay: openingRange.tradingDay };
  }

  const startMinute = minuteOfDay(c1Start);
  const endMinute = minuteOfDay(c3End);
  const nowMinute = minuteOfDay(now);
  if (startMinute < 9 * 60 + 45) {
    return { state: 'INVALID_DATA', tradingDay: openingRange.tradingDay };
  }
  if (endMinute >= 12 * 60 || nowMinute >= 12 * 60) {
    return { state: 'WINDOW_CLOSED', tradingDay: openingRange.tradingDay };
  }

  const { high: orHigh, low: orLow } = openingRange.range;
  if (!Number.isFinite(orHigh) || !Number.isFinite(orLow) || orHigh < orLow) {
    return { state: 'INVALID_DATA', tradingDay: openingRange.tradingDay };
  }
  const closes = [c1.close, c2.close, c3.close];

  const bullishGeometry = c3.low > c1.high;
  const bullishBreakout = hasInsideThenOutside(closes, orLow, orHigh, (close) => close > orHigh);
  if (bullishGeometry && bullishBreakout && c2.close > c2.open) {
    return {
      state: 'VALID_BULLISH_FVG',
      direction: 'BULLISH',
      fvgLow: c1.high,
      fvgHigh: c3.low,
      c1,
      c2,
      c3,
      tradingDay: openingRange.tradingDay,
    };
  }

  const bearishGeometry = c3.high < c1.low;
  const bearishBreakout = hasInsideThenOutside(closes, orLow, orHigh, (close) => close < orLow);
  if (bearishGeometry && bearishBreakout && c2.close < c2.open) {
    return {
      state: 'VALID_BEARISH_FVG',
      direction: 'BEARISH',
      fvgLow: c3.high,
      fvgHigh: c1.low,
      c1,
      c2,
      c3,
      tradingDay: openingRange.tradingDay,
    };
  }

  return { state: 'NO_FVG', tradingDay: openingRange.tradingDay };
}
