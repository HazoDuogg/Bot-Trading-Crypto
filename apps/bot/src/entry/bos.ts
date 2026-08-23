import type { Candle, BosConfig, BosResult } from './types.js';
import { DEFAULT_BOS_CONFIG } from './types.js';
import { findSwingPoints } from '../regime/swingPoints.js';
import { computeAtr } from '../noTradeZone/atr.js';

// A break candle qualifies as BOS if its close clears the last *fresh* confirmed swing level (within maxSwingAgeCandles)
// by >= minBreakoutAtrMultiplier*ATR, and the level isn't reclaimed for `confirmationCandles` candles afterward.
export function detectBos(candles: Candle[], config: BosConfig = DEFAULT_BOS_CONFIG): BosResult {
  const need = config.confirmationCandles;
  const breakIndex = candles.length - 1 - need;
  if (breakIndex < config.swingPivotWidth * 2 + 1) return { isBos: false };

  const priorCandles = candles.slice(0, breakIndex); // structure formed strictly before the break candle — no look-ahead
  const swingPoints = findSwingPoints(priorCandles, config.swingPivotWidth);
  const freshSwingPoints = swingPoints.filter((p) => breakIndex - p.index <= config.maxSwingAgeCandles);
  const highs = freshSwingPoints.filter((p) => p.type === 'high');
  const lows = freshSwingPoints.filter((p) => p.type === 'low');
  if (highs.length === 0 || lows.length === 0) return { isBos: false };

  const lastSwingHigh = highs[highs.length - 1];
  const lastSwingLow = lows[lows.length - 1];

  const atrValues = computeAtr(priorCandles, config.atrPeriod);
  if (atrValues.length === 0) return { isBos: false };
  const minBreakout = atrValues[atrValues.length - 1] * config.minBreakoutAtrMultiplier;

  const breakCandle = candles[breakIndex];
  const confirmation = candles.slice(breakIndex + 1, breakIndex + 1 + need);

  if (breakCandle.close > lastSwingHigh.price + minBreakout) {
    const notReclaimed = confirmation.every((c) => c.close > lastSwingHigh.price);
    if (notReclaimed) return { isBos: true, direction: 'LONG', brokenLevel: lastSwingHigh.price };
  }

  if (breakCandle.close < lastSwingLow.price - minBreakout) {
    const notReclaimed = confirmation.every((c) => c.close < lastSwingLow.price);
    if (notReclaimed) return { isBos: true, direction: 'SHORT', brokenLevel: lastSwingLow.price };
  }

  return { isBos: false };
}
