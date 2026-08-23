import type { Candle, EngulfingResult } from './types.js';

export function detectEngulfing(prev: Candle, current: Candle): EngulfingResult {
  const prevBearish = prev.close < prev.open;
  const currBullish = current.close > current.open;
  if (prevBearish && currBullish && current.open <= prev.low && current.close >= prev.high) {
    return { isEngulfing: true, direction: 'LONG' };
  }

  const prevBullish = prev.close > prev.open;
  const currBearish = current.close < current.open;
  if (prevBullish && currBearish && current.open >= prev.high && current.close <= prev.low) {
    return { isEngulfing: true, direction: 'SHORT' };
  }

  return { isEngulfing: false };
}
