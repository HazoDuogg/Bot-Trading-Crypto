import type { Candle, PinBarConfig, PinBarResult } from './types.js';
import { DEFAULT_PIN_BAR_CONFIG } from './types.js';

export function detectPinBar(candle: Candle, config: PinBarConfig = DEFAULT_PIN_BAR_CONFIG): PinBarResult {
  const totalRange = candle.high - candle.low;
  if (totalRange <= 0) return { isPinBar: false };

  const body = Math.abs(candle.close - candle.open);
  if (body > config.maxBodyToRangeRatio * totalRange) return { isPinBar: false };

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const closeFromLow = (candle.close - candle.low) / totalRange;

  // Bullish: long lower wick (rejection of lower prices), close in the top third.
  if (lowerWick >= config.minWickToBodyRatio * body && closeFromLow >= 1 - config.closeZoneRatio) {
    return { isPinBar: true, direction: 'LONG' };
  }
  // Bearish: long upper wick (rejection of higher prices), close in the bottom third.
  if (upperWick >= config.minWickToBodyRatio * body && closeFromLow <= config.closeZoneRatio) {
    return { isPinBar: true, direction: 'SHORT' };
  }

  return { isPinBar: false };
}
