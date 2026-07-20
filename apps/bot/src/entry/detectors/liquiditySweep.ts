import type { CandleData } from '../../regime/types.js';
import { wickRatios } from '../../regime/indicators.js';
import type { Direction, LiquiditySweep } from '../types.js';
import { detectSwingPoints, latestSwingPointBefore } from './swingPoints.js';

export interface LiquiditySweepConfig {
  fractalN: number;
  wickRatioThreshold: number;
}

/**
 * B.3 — PM-given formula (2026-07-17, formalized here for the first time; MANIPULATED in regime/
 * is still NOT_IMPLEMENTED and does not share this code, only the same agreed formula):
 *   BULLISH (sweeps a swing low): lowerWickRatio = (min(open,close) - low) / (high - low)
 *     lowerWickRatio > threshold AND low < swingLow.price AND close > swingLow.price
 *   BEARISH (sweeps a swing high): mirror, using high/upperWickRatio and swingHigh.
 * No volume condition here (unlike the MANIPULATED regime concept) — MSS (B.4) is the safety
 * layer after this at the setup level, per PM.
 *
 * wick-ratio formula itself lives in regime/indicators.ts's wickRatios() (TICKET-026: shared with
 * regime/regimeDetector.ts's MANIPULATED check — single implementation, not copy-pasted).
 */
export function detectLiquiditySweep(candles: CandleData[], direction: Direction, config: LiquiditySweepConfig): LiquiditySweep | null {
  const swings = detectSwingPoints(candles, config.fractalN);
  const swingType = direction === 'BULLISH' ? 'LOW' : 'HIGH';

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.high === c.low) continue; // zero-range candle — wickRatios() would report 0/0, never a sweep

    const referenceSwing = latestSwingPointBefore(swings, swingType, i);
    if (referenceSwing === null) continue;

    const { upperWickRatio, lowerWickRatio } = wickRatios(c);

    if (direction === 'BULLISH') {
      if (lowerWickRatio > config.wickRatioThreshold && c.low < referenceSwing.price && c.close > referenceSwing.price) {
        return { type: 'BULLISH', sweptLevel: referenceSwing.price, candleIndex: i };
      }
    } else {
      if (upperWickRatio > config.wickRatioThreshold && c.high > referenceSwing.price && c.close < referenceSwing.price) {
        return { type: 'BEARISH', sweptLevel: referenceSwing.price, candleIndex: i };
      }
    }
  }
  return null;
}
