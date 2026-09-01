import type { Candle } from '../noTradeZone/types.js';

export const D1_SWING_V1_WINDOW = 5;
export const D1_SWING_V1_SIDE_CANDLES = 2;

export interface SwingPoint {
  index: number;
  type: 'high' | 'low';
  price: number;
}

// D1 — CONVENTION: strict five-candle fractal, confirmed only after both right-side candles close.
export function detectSwingPoints(candles: readonly Candle[]): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let confirmedAt = D1_SWING_V1_WINDOW - 1; confirmedAt < candles.length; confirmedAt += 1) {
    const window = candles.slice(confirmedAt - D1_SWING_V1_WINDOW + 1, confirmedAt + 1);
    const center = window[D1_SWING_V1_SIDE_CANDLES];
    const neighbors = window.filter((_, index) => index !== D1_SWING_V1_SIDE_CANDLES);
    const index = confirmedAt - D1_SWING_V1_SIDE_CANDLES;

    if (neighbors.every((item) => center.high > item.high)) {
      swings.push({ index, type: 'high', price: center.high });
    }
    if (neighbors.every((item) => center.low < item.low)) {
      swings.push({ index, type: 'low', price: center.low });
    }
  }
  return swings;
}
