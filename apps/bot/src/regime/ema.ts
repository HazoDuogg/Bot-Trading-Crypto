import type { Candle } from './types.js';

// Standard EMA: seed = SMA of first `period` closes, then smoothed forward. Returns one value per candle from index period-1 onward.
export function computeEma(candles: Candle[], period: number): number[] {
  if (candles.length < period) return [];

  const closes = candles.map((c) => c.close);
  const k = 2 / (period + 1);
  const emaValues: number[] = [];

  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaValues.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emaValues.push(ema);
  }
  return emaValues; // emaValues[j] aligns with candles[j + period - 1]
}
