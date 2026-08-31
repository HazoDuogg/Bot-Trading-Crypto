import { getNewYorkTimeParts } from './newYorkTime.js';
import type { CasperCandle } from './types.js';

export function isValidClosedM5Candle(
  candle: CasperCandle,
  nowMs: number,
  tradingDay: string,
): boolean {
  const start = getNewYorkTimeParts(candle.startTimeMs);
  const end = getNewYorkTimeParts(candle.endTimeMs);
  const prices = [candle.open, candle.high, candle.low, candle.close];
  return (
    candle.endTimeMs - candle.startTimeMs === 5 * 60_000 &&
    candle.endTimeMs <= nowMs &&
    start?.tradingDay === tradingDay &&
    end?.tradingDay === tradingDay &&
    candle.startTimeMs % 1000 === 0 &&
    candle.endTimeMs % 1000 === 0 &&
    start.minute % 5 === 0 &&
    start.second === 0 &&
    end.minute % 5 === 0 &&
    end.second === 0 &&
    prices.every(Number.isFinite) &&
    candle.high >= candle.low &&
    candle.open <= candle.high &&
    candle.open >= candle.low &&
    candle.close <= candle.high &&
    candle.close >= candle.low
  );
}
