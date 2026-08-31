import { getNewYorkTimeParts } from './newYorkTime.js';
import type { CasperCandle } from './types.js';

export function isValidM1Candle(candle: CasperCandle, tradingDay: string): boolean {
  const start = getNewYorkTimeParts(candle.startTimeMs);
  const end = getNewYorkTimeParts(candle.endTimeMs);
  const prices = [candle.open, candle.high, candle.low, candle.close];
  return (
    candle.endTimeMs - candle.startTimeMs === 60_000 &&
    start?.tradingDay === tradingDay &&
    end?.tradingDay === tradingDay &&
    candle.startTimeMs % 1000 === 0 &&
    candle.endTimeMs % 1000 === 0 &&
    start.second === 0 &&
    end.second === 0 &&
    prices.every(Number.isFinite) &&
    candle.high >= candle.low &&
    candle.open <= candle.high &&
    candle.open >= candle.low &&
    candle.close <= candle.high &&
    candle.close >= candle.low
  );
}
