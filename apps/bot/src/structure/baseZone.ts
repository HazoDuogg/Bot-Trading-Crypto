import type { Candle } from '../noTradeZone/types.js';

export const D3_BASE_V1_MIN_CANDLES = 3;
export const D3_BASE_V1_IMPULSE_RANGE_MULTIPLIER = 1.5;
export const D3_BASE_V1_REQUIRED_OVERLAP_RATIO = 1;

export interface BaseZone {
  start_index: number;
  end_index: number;
  high: number;
  low: number;
}

export function candlesOverlap(left: Candle, right: Candle): boolean {
  return Math.min(left.high, right.high) > Math.max(left.low, right.low);
}

export function calculateOverlapRatio(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0;
  let overlappingPairs = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candlesOverlap(candles[index - 1], candles[index])) overlappingPairs += 1;
  }
  return overlappingPairs / (candles.length - 1);
}

// D3 — CONVENTION: an all-adjacent-overlap cluster is confirmed by the immediately following 1.5× impulse.
export function detectBaseZones(candles: readonly Candle[]): BaseZone[] {
  const zones: BaseZone[] = [];
  let searchFloor = 0;

  for (let impulseIndex = D3_BASE_V1_MIN_CANDLES; impulseIndex < candles.length; impulseIndex += 1) {
    const endIndex = impulseIndex - 1;
    let startIndex = endIndex;
    while (
      startIndex > searchFloor &&
      candlesOverlap(candles[startIndex - 1], candles[startIndex])
    ) {
      startIndex -= 1;
    }

    const base = candles.slice(startIndex, endIndex + 1);
    if (
      base.length < D3_BASE_V1_MIN_CANDLES ||
      calculateOverlapRatio(base) !== D3_BASE_V1_REQUIRED_OVERLAP_RATIO
    ) {
      continue;
    }
    const averageRange = base.reduce((sum, item) => sum + item.high - item.low, 0) / base.length;
    const impulseRange = candles[impulseIndex].high - candles[impulseIndex].low;
    if (impulseRange < averageRange * D3_BASE_V1_IMPULSE_RANGE_MULTIPLIER) continue;

    zones.push({
      start_index: startIndex,
      end_index: endIndex,
      high: Math.max(...base.map((item) => item.high)),
      low: Math.min(...base.map((item) => item.low)),
    });
    searchFloor = impulseIndex;
  }
  return zones;
}
