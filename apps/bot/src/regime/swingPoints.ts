import type { Candle, SwingPoint } from './types.js';

// A candle is a swing high/low if its high/low is the extreme among `width` candles on each side (local pivot).
export function findSwingPoints(candles: Candle[], width: number): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = width; i < candles.length - width; i++) {
    const windowSlice = candles.slice(i - width, i + width + 1);
    const isHigh = windowSlice.every((c) => c.high <= candles[i].high);
    const isLow = windowSlice.every((c) => c.low >= candles[i].low);

    if (isHigh) points.push({ index: i, price: candles[i].high, type: 'high' });
    if (isLow) points.push({ index: i, price: candles[i].low, type: 'low' });
  }

  return points;
}
