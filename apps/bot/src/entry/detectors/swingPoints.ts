import type { CandleData } from '../../regime/types.js';
import type { SwingPoint } from '../types.js';

/**
 * Standard N-candle fractal: candle i is a swing HIGH if its high is strictly greater than the
 * `fractalN` candles on each side; swing LOW is the mirror on low. A fractal at index i can only
 * be confirmed once `fractalN` candles exist after it — the trailing `fractalN` candles never
 * produce a confirmed fractal (same lag as live trading).
 */
export function detectSwingPoints(candles: CandleData[], fractalN: number): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = fractalN; i < candles.length - fractalN; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= fractalN; k++) {
      if (candles[i - k].high >= candles[i].high || candles[i + k].high >= candles[i].high) isHigh = false;
      if (candles[i - k].low <= candles[i].low || candles[i + k].low <= candles[i].low) isLow = false;
    }
    if (isHigh) points.push({ index: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) points.push({ index: i, price: candles[i].low, type: 'LOW' });
  }
  return points;
}

/** Most recent confirmed swing point of the given type strictly before `beforeIndex`, or null. */
export function latestSwingPointBefore(
  points: SwingPoint[],
  type: 'HIGH' | 'LOW',
  beforeIndex: number,
): SwingPoint | null {
  let latest: SwingPoint | null = null;
  for (const p of points) {
    if (p.type === type && p.index < beforeIndex) {
      if (latest === null || p.index > latest.index) latest = p;
    }
  }
  return latest;
}
