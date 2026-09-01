import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';

// D5 — CONVENTION v1: distribution-selected constants, not a Nukida rule or outcome/PnL optimization.
export const D5_COMPRESSION_V1_WINDOW = 8;
export const D5_COMPRESSION_V1_ATR_PERIOD = 14;
export const D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO = 1.95;

export interface CompressionResult {
  isCompressed: boolean;
  bandwidthAtrRatio: number;
  windowStartIndex: number;
  windowEndIndex: number;
}

function resultForWindow(
  candles: readonly Candle[],
  windowStartIndex: number,
  windowEndIndex: number,
  frozenAtr: number,
): CompressionResult | null {
  if (!(frozenAtr > 0)) return null;
  const window = candles.slice(windowStartIndex, windowEndIndex + 1);
  const bandwidth =
    Math.max(...window.map((item) => item.high)) - Math.min(...window.map((item) => item.low));
  const bandwidthAtrRatio = bandwidth / frozenAtr;
  return {
    isCompressed: bandwidthAtrRatio <= D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO,
    bandwidthAtrRatio,
    windowStartIndex,
    windowEndIndex,
  };
}

export function detectCompression(
  candles: readonly Candle[],
  windowEndIndex = candles.length - 1,
): CompressionResult | null {
  if (!Number.isSafeInteger(windowEndIndex) || windowEndIndex < 0 || windowEndIndex >= candles.length) {
    throw new Error('windowEndIndex must reference an available candle');
  }
  const windowStartIndex = windowEndIndex - D5_COMPRESSION_V1_WINDOW + 1;
  const atrFreezeIndex = windowStartIndex - 1;
  if (atrFreezeIndex < D5_COMPRESSION_V1_ATR_PERIOD) return null;

  const tracker = createAtrTracker(D5_COMPRESSION_V1_ATR_PERIOD);
  let frozenAtr: number | null = null;
  for (let index = 0; index <= atrFreezeIndex; index += 1) {
    frozenAtr = tracker.next(candles[index]);
  }
  if (frozenAtr === null) return null;
  return resultForWindow(candles, windowStartIndex, windowEndIndex, frozenAtr);
}

export function detectCompressionSeries(candles: readonly Candle[]): CompressionResult[] {
  const tracker = createAtrTracker(D5_COMPRESSION_V1_ATR_PERIOD);
  const atrAtIndex: Array<number | null> = [];
  const results: CompressionResult[] = [];

  for (let windowEndIndex = 0; windowEndIndex < candles.length; windowEndIndex += 1) {
    atrAtIndex.push(tracker.next(candles[windowEndIndex]));
    const windowStartIndex = windowEndIndex - D5_COMPRESSION_V1_WINDOW + 1;
    const atrFreezeIndex = windowStartIndex - 1;
    if (atrFreezeIndex < 0) continue;
    const frozenAtr = atrAtIndex[atrFreezeIndex];
    if (frozenAtr === null) continue;
    const result = resultForWindow(candles, windowStartIndex, windowEndIndex, frozenAtr);
    if (result !== null) results.push(result);
  }
  return results;
}
