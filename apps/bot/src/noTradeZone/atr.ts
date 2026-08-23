import type { Candle } from './types.js';

// Wilder-smoothed ATR. Returns one value per candle from index `period` onward (index-aligned to candles.slice(period)).
export function computeAtr(candles: Candle[], period: number): number[] {
  if (candles.length < period + 1) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)),
    );
  }

  const atrValues: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrValues.push(atr);
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrValues.push(atr);
  }
  return atrValues;
}
