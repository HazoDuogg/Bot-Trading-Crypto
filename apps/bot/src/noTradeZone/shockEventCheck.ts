import type { Candle } from './types.js';

// A single H1 candle body move > threshold% counts as a shock event, per doc section 1.
export function isShockEvent(h1Candles: Candle[], thresholdPct: number): boolean {
  const latest = h1Candles[h1Candles.length - 1];
  if (!latest || latest.open <= 0) return false;
  const movePct = (Math.abs(latest.close - latest.open) / latest.open) * 100;
  return movePct > thresholdPct;
}
