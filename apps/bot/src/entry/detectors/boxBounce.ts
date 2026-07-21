import type { CandleData } from '../../regime/types.js';
import { wickRatios } from '../../regime/indicators.js';
import { computeBox } from './boxBreakout.js';

export interface BoxBounce {
  side: 'LONG' | 'SHORT';
  boxMidpoint: number;
  candleIndex: number;
}

/**
 * TICKET-047 — trades the "bounce" inside a tight consolidation box, higher frequency than
 * detectBoxBreakout() since it doesn't wait for price to leave the box. Reuses computeBox() (same
 * box as detectBoxBreakout()/COMPRESSION, no separate formula) and wickRatios() (same wick-ratio
 * math already used for Sweep/MANIPULATED) — no new formula, only a new combination of existing ones.
 *
 * The latest 5m candle confirms a bounce when its wick reaches into the box's own edge zone
 * (bottom edgeZonePercent of the range for LONG, top edgeZonePercent for SHORT) AND rejects hard
 * enough from there (lowerWickRatio/upperWickRatio > wickRatioThreshold, same threshold Sweep uses).
 * boxMidpoint is returned as the natural take-profit target for a bounce trade (the OPPOSITE side
 * of the box, not a full breakout) — used by entryRouter.ts/orchestrator.ts, not decided here.
 */
export function detectBoxBounce(
  candles15m: CandleData[],
  candles5m: CandleData[],
  boxLookbackM: number,
  edgeZonePercent: number,
  wickRatioThreshold: number,
): BoxBounce | null {
  if (candles5m.length === 0) return null;
  const box = computeBox(candles15m, boxLookbackM);
  if (box === null) return null;
  const { boxHigh, boxLow } = box;
  const boxRange = boxHigh - boxLow;
  if (boxRange <= 0) return null;
  const boxMidpoint = (boxHigh + boxLow) / 2;

  const candleIndex = candles5m.length - 1;
  const candle = candles5m[candleIndex];
  const { upperWickRatio, lowerWickRatio } = wickRatios(candle);

  const lowerEdgeThreshold = boxLow + edgeZonePercent * boxRange;
  if (candle.low <= lowerEdgeThreshold && lowerWickRatio > wickRatioThreshold) {
    return { side: 'LONG', boxMidpoint, candleIndex };
  }

  const upperEdgeThreshold = boxHigh - edgeZonePercent * boxRange;
  if (candle.high >= upperEdgeThreshold && upperWickRatio > wickRatioThreshold) {
    return { side: 'SHORT', boxMidpoint, candleIndex };
  }

  return null;
}
