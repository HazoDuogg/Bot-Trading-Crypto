import type { Candle } from '../noTradeZone/types.js';

export interface SwingPoint {
  index: number;
  type: 'high' | 'low';
  price: number;
}

// D1 — CONVENTION: strict five-candle fractal, confirmed only after both right-side candles close.
export function detectSwingPoints(candles: readonly Candle[]): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let confirmedAt = 4; confirmedAt < candles.length; confirmedAt += 1) {
    const window = candles.slice(confirmedAt - 4, confirmedAt + 1);
    const center = window[2];
    const neighbors = [window[0], window[1], window[3], window[4]];
    const index = confirmedAt - 2;

    if (neighbors.every((item) => center.high > item.high)) {
      swings.push({ index, type: 'high', price: center.high });
    }
    if (neighbors.every((item) => center.low < item.low)) {
      swings.push({ index, type: 'low', price: center.low });
    }
  }
  return swings;
}
