import type { CandleData } from '../../regime/types.js';
import type { Direction, OrderBlock } from '../types.js';
import { detectSwingPoints, latestSwingPointBefore } from './swingPoints.js';

export interface OrderBlockConfig {
  fractalN: number;
  /** Max candles forward from the OB candidate to find BOS before giving up. */
  lookforwardK: number;
}

/**
 * B.1 — scans backward from the most recent candle for the newest valid, BOS-confirmed OB.
 * BULLISH: last down-close candle before a push (not necessarily every candle green) whose CLOSE
 * breaks the nearest prior swing high within `lookforwardK` candles. Invalidated (candidate
 * discarded, older one tried) if price's low breaks back below the OB candle's low first.
 * BEARISH is the mirror (up-close candle, swing low, high invalidation).
 */
export function detectOrderBlock(candles: CandleData[], direction: Direction, config: OrderBlockConfig): OrderBlock | null {
  const swings = detectSwingPoints(candles, config.fractalN);
  const swingType = direction === 'BULLISH' ? 'HIGH' : 'LOW';

  for (let i = candles.length - 1; i >= 1; i--) {
    const isCandidateCandle = direction === 'BULLISH' ? candles[i].close < candles[i].open : candles[i].close > candles[i].open;
    if (!isCandidateCandle) continue;

    const referenceSwing = latestSwingPointBefore(swings, swingType, i);
    if (referenceSwing === null) continue;

    const forwardLimit = Math.min(i + config.lookforwardK, candles.length - 1);
    for (let j = i + 1; j <= forwardLimit; j++) {
      const brokeOwnExtreme = direction === 'BULLISH' ? candles[j].low < candles[i].low : candles[j].high > candles[i].high;
      if (brokeOwnExtreme) break; // invalidated — try an older candidate

      const bosConfirmed = direction === 'BULLISH' ? candles[j].close > referenceSwing.price : candles[j].close < referenceSwing.price;
      if (bosConfirmed) {
        return { type: direction, high: candles[i].high, low: candles[i].low, candleIndex: i, confirmedAtIndex: j };
      }
    }
  }
  return null;
}
