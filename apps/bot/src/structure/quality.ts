import type { Candle } from '../noTradeZone/types.js';

// D4 — CONVENTION v1: percentile-selected quality constants, not outcome/PnL optimization.
export const D4_QUALITY_V1_WINDOW = 20;
export const D4_QUALITY_V1_SWEEP_REJECTION_MIN = 0.6;
export const D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN = 0.148;
export const D4_QUALITY_V1_CLEAN_SWEEP_MAX = 1;
export const D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX = 0.041;
export const D4_QUALITY_V1_CHAOTIC_SWEEP_MIN = 3;

export interface QualityComposite {
  label: 'CLEAN' | 'CHAOTIC' | 'UNCLEAR';
  efficiency: number;
  sweepCount: number;
}

export interface QualityWindowResult extends QualityComposite {
  windowStartIndex: number;
  windowEndIndex: number;
}

export function calculateDirectionalEfficiency(candles: readonly Candle[]): number {
  if (candles.length === 0) return 0;
  const totalRange = candles.reduce((sum, item) => sum + (item.high - item.low), 0);
  if (!(totalRange > 0)) return 0;
  return Math.abs(candles[candles.length - 1].close - candles[0].open) / totalRange;
}

export function calculateSweepCount(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0;
  let runningHigh = candles[0].high;
  let runningLow = candles[0].low;
  let sweepCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const range = current.high - current.low;
    if (range > 0) {
      if (
        current.high > runningHigh &&
        (current.high - current.close) / range >= D4_QUALITY_V1_SWEEP_REJECTION_MIN
      ) {
        sweepCount += 1;
      }
      if (
        current.low < runningLow &&
        (current.close - current.low) / range >= D4_QUALITY_V1_SWEEP_REJECTION_MIN
      ) {
        sweepCount += 1;
      }
    }
    runningHigh = Math.max(runningHigh, current.high);
    runningLow = Math.min(runningLow, current.low);
  }
  return sweepCount;
}

function classifyQuality(efficiency: number, sweepCount: number): QualityComposite['label'] {
  if (
    efficiency >= D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN &&
    sweepCount <= D4_QUALITY_V1_CLEAN_SWEEP_MAX
  ) {
    return 'CLEAN';
  }
  if (
    efficiency <= D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX &&
    sweepCount >= D4_QUALITY_V1_CHAOTIC_SWEEP_MIN
  ) {
    return 'CHAOTIC';
  }
  return 'UNCLEAR';
}

export function evaluateQuality(
  candles: readonly Candle[],
  windowEndIndex = candles.length - 1,
): QualityComposite | null {
  if (!Number.isSafeInteger(windowEndIndex) || windowEndIndex < 0 || windowEndIndex >= candles.length) {
    throw new Error('windowEndIndex must reference an available candle');
  }
  const windowStartIndex = windowEndIndex - D4_QUALITY_V1_WINDOW + 1;
  if (windowStartIndex < 0) return null;
  const window = candles.slice(windowStartIndex, windowEndIndex + 1);
  const efficiency = calculateDirectionalEfficiency(window);
  const sweepCount = calculateSweepCount(window);
  return { label: classifyQuality(efficiency, sweepCount), efficiency, sweepCount };
}

export function evaluateQualitySeries(candles: readonly Candle[]): QualityWindowResult[] {
  const results: QualityWindowResult[] = [];
  for (
    let windowEndIndex = D4_QUALITY_V1_WINDOW - 1;
    windowEndIndex < candles.length;
    windowEndIndex += 1
  ) {
    const quality = evaluateQuality(candles, windowEndIndex);
    if (quality !== null) {
      results.push({
        ...quality,
        windowStartIndex: windowEndIndex - D4_QUALITY_V1_WINDOW + 1,
        windowEndIndex,
      });
    }
  }
  return results;
}
