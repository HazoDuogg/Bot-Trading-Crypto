import type { Candle } from './types.js';
import { computeAtr } from './atr.js';

const ATR_PERIOD = 14; // TODO_CONFIRM: doc doesn't specify a period; using the standard default.

// ATR_ratio = ATR(H1 now) / avg ATR(H1, prior 20) > threshold, OR latest H1 range% > threshold.
export function isVolatilityExtreme(
  h1Candles: Candle[],
  atrRatioThreshold: number,
  h1RangePctThreshold: number,
): boolean {
  const atrValues = computeAtr(h1Candles, ATR_PERIOD);
  if (atrValues.length >= 21) {
    const currentAtr = atrValues[atrValues.length - 1];
    const priorAvg =
      atrValues.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (priorAvg > 0 && currentAtr / priorAvg > atrRatioThreshold) return true;
  }

  const latest = h1Candles[h1Candles.length - 1];
  if (latest && latest.open > 0) {
    const rangePct = ((latest.high - latest.low) / latest.open) * 100;
    if (rangePct > h1RangePctThreshold) return true;
  }

  return false;
}
