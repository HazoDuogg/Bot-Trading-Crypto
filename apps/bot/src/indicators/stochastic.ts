import type { Candle } from '../regime/types.js';

export interface StochasticConfig {
  kPeriod: number; // TODO_CONFIRM — doc gives no number, common default 14 used as a placeholder
  dPeriod: number; // TODO_CONFIRM, placeholder 3
  smoothK: number; // TODO_CONFIRM, placeholder 3
}

export const DEFAULT_STOCHASTIC_CONFIG: StochasticConfig = {
  kPeriod: 14,
  dPeriod: 3,
  smoothK: 3,
};

// Trailing SMA, aligned like regime/ema.ts's computeEma: result[j] corresponds to values[j+period-1],
// so result's LAST element always aligns with values' last element regardless of period/array length.
function sma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result.push(sum / period);
  }
  return result;
}

// Standard slow stochastic: raw %K per candle, smoothed by smoothK to get the displayed %K, then %D
// = SMA(%K, dPeriod). A flat kPeriod range (highestHigh == lowestLow) has no meaningful %K — return
// the midpoint (50) rather than dividing by zero.
export function computeStochastic(candles: Candle[], config: StochasticConfig): { k: number[]; d: number[] } {
  if (candles.length < config.kPeriod) return { k: [], d: [] };

  const rawK: number[] = [];
  for (let i = config.kPeriod - 1; i < candles.length; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = i - config.kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
    }
    const range = highestHigh - lowestLow;
    rawK.push(range > 0 ? ((candles[i].close - lowestLow) / range) * 100 : 50);
  }

  const k = sma(rawK, config.smoothK);
  const d = sma(k, config.dPeriod);
  return { k, d };
}
