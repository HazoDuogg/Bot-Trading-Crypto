import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { calculateEma, evaluateEmaTrend } from './emaTrendFilter.js';

function candle(index: number, close: number): Candle {
  return { openTime: index * 900_000, open: close, high: close, low: close, close, volume: 1 };
}

describe('calculateEma', () => {
  it('matches a hand-computed EMA on a known linear ramp', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // period=3: seed (SMA of first 3) = 2 at index 2; k=0.5;
    // ema[3]=4*.5+2*.5=3, ema[4]=4, ema[5]=5, ema[6]=6, ema[7]=7, ema[8]=8, ema[9]=9.
    expect(calculateEma(values, 3)).toEqual([null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns all-null when there is not enough history for the period', () => {
    expect(calculateEma([1, 2], 3)).toEqual([null, null]);
  });

  it('rejects a non-positive period', () => {
    expect(() => calculateEma([1, 2, 3], 0)).toThrow();
  });
});

describe('evaluateEmaTrend', () => {
  it('is causal: never reads the trigger candle or anything after it', () => {
    const rising = Array.from({ length: 80 }, (_, index) => candle(index, 100 + index));
    const triggerIndex = 70;
    const baseline = evaluateEmaTrend(rising, triggerIndex);
    expect(baseline).not.toBeNull();

    const mutated = rising.map((item, index) =>
      index >= triggerIndex ? candle(index, item.close - 100_000) : item,
    );
    expect(evaluateEmaTrend(mutated, triggerIndex)).toEqual(baseline);
  });

  it('reports aboveEma=true and a positive slope on a steadily rising series', () => {
    const rising = Array.from({ length: 80 }, (_, index) => candle(index, 100 + index));
    const result = evaluateEmaTrend(rising, 70);
    expect(result).not.toBeNull();
    expect(result!.aboveEma).toBe(true);
    expect(result!.emaSlopeSign).toBe(1);
  });

  it('reports aboveEma=false and a negative slope on a steadily falling series', () => {
    const falling = Array.from({ length: 80 }, (_, index) => candle(index, 200 - index));
    const result = evaluateEmaTrend(falling, 70);
    expect(result).not.toBeNull();
    expect(result!.aboveEma).toBe(false);
    expect(result!.emaSlopeSign).toBe(-1);
  });

  it('reports a zero slope on a perfectly flat series', () => {
    const flat = Array.from({ length: 80 }, (_, index) => candle(index, 100));
    const result = evaluateEmaTrend(flat, 70);
    expect(result).not.toBeNull();
    expect(result!.emaSlopeSign).toBe(0);
    expect(result!.aboveEma).toBe(false); // close === ema exactly, not strictly above
  });

  it('returns null when there is not enough pre-trigger history for the period', () => {
    const short = Array.from({ length: 40 }, (_, index) => candle(index, 100 + index));
    expect(evaluateEmaTrend(short, 30)).toBeNull();
  });

  it('returns null when triggerIndex is 0 (no prior candle at all)', () => {
    const candles = [candle(0, 100)];
    expect(evaluateEmaTrend(candles, 0)).toBeNull();
  });
});
