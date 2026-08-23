import type { Candle, SlConfig, SlInput, SlResult } from './types.js';
import { DEFAULT_SL_CONFIG } from './types.js';
import { findSwingPoints } from '../regime/swingPoints.js';

function slFromTrendPullback(input: SlInput): number | null {
  const swingPoints = findSwingPoints(input.m5Candles, input.swingPivotWidth);
  if (input.direction === 'LONG') {
    const lows = swingPoints.filter((p) => p.type === 'low');
    if (lows.length === 0) return null;
    return lows[lows.length - 1].price; // SL below the most recent M5 swing low
  }
  const highs = swingPoints.filter((p) => p.type === 'high');
  if (highs.length === 0) return null;
  return highs[highs.length - 1].price; // SL above the most recent M5 swing high
}

function slFromRangeTrading(input: SlInput, config: SlConfig): number | null {
  if (input.rangeLevel === undefined) return null;
  const buffer = input.atrM5 * config.rangeBufferAtrMultiplier;
  return input.direction === 'LONG' ? input.rangeLevel - buffer : input.rangeLevel + buffer;
}

function slFromBreakoutWatch(input: SlInput, config: SlConfig): number | null {
  if (input.brokenLevel === undefined) return null;
  const buffer = input.atrM5 * config.breakoutBufferAtrMultiplier;
  return input.direction === 'LONG' ? input.brokenLevel - buffer : input.brokenLevel + buffer;
}

export function calculateSl(input: SlInput, config: SlConfig = DEFAULT_SL_CONFIG): SlResult | null {
  let slPrice: number | null;
  switch (input.strategy) {
    case 'TREND_PULLBACK':
      slPrice = slFromTrendPullback(input);
      break;
    case 'RANGE_TRADING':
      slPrice = slFromRangeTrading(input, config);
      break;
    case 'BREAKOUT_WATCH':
      slPrice = slFromBreakoutWatch(input, config);
      break;
  }
  if (slPrice === null) return null;

  const distance = Math.abs(input.entryPrice - slPrice);
  if (distance <= 0) return null;
  return { slPrice, distance };
}

export type { Candle };
