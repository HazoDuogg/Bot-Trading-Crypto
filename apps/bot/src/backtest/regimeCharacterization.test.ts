import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  calculateDirectionalExcursions,
  calculateMeanRangeOverlap,
  calculateRegimeDirectionalEfficiency,
  calculateReturnFlipDensity,
  calculateSignedAlignment,
  characterizePreSignal,
} from './regimeCharacterization.js';

function candle(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

describe('regime metric formulas', () => {
  const candles = [candle(0, 10, 12, 8, 11), candle(1, 11, 15, 10, 14)];

  it('calculates directional efficiency from net displacement over total M15 range', () => {
    expect(calculateRegimeDirectionalEfficiency(candles)).toBeCloseTo(4 / 9);
  });

  it('signs alignment relative to the setup direction', () => {
    expect(calculateSignedAlignment(candles, 'BULL')).toBeCloseTo(4 / 9);
    expect(calculateSignedAlignment(candles, 'BEAR')).toBeCloseTo(-4 / 9);
  });

  it('averages adjacent range overlap normalized by the smaller candle range', () => {
    expect(calculateMeanRangeOverlap(candles)).toBeCloseTo(0.5);
  });

  it('calculates close-return sign flip density from adjacent return pairs', () => {
    const alternating = [
      candle(0, 10, 11, 9, 10),
      candle(1, 10, 13, 9, 12),
      candle(2, 12, 13, 10, 11),
      candle(3, 11, 14, 10, 13),
    ];
    expect(calculateReturnFlipDensity(alternating)).toBe(1);
  });

  it('calculates raw directional MFE and MAE from the first open without SL/TP', () => {
    expect(calculateDirectionalExcursions(candles, 'BULL')).toEqual({ mfe: 5, mae: 2 });
    expect(calculateDirectionalExcursions(candles, 'BEAR')).toEqual({ mfe: 2, mae: 5 });
  });
});

describe('pre-signal regime causality', () => {
  it('does not read the trigger candle or any later candle', () => {
    const base = Array.from({ length: 20 }, (_, index) =>
      candle(index, 100 + index, 102 + index, 99 + index, 101 + index),
    );
    const mutated = base.map((item, index) =>
      index < 16 ? item : candle(index, -10_000, 20_000, -20_000, 10_000),
    );

    const original = characterizePreSignal({
      candles: base,
      triggerIndex: 16,
      direction: 'BULL',
      horizons: [16],
    });
    const afterTriggerMutation = characterizePreSignal({
      candles: mutated,
      triggerIndex: 16,
      direction: 'BULL',
      horizons: [16],
    });

    expect(afterTriggerMutation).toEqual(original);
    expect(original[0].windowStartIndex).toBe(0);
    expect(original[0].windowEndIndex).toBe(15);
  });
});
