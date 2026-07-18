import { describe, expect, it } from 'vitest';
import { detectLiquiditySweep } from './liquiditySweep.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

const config = { fractalN: 2, wickRatioThreshold: 0.65 };

describe('detectLiquiditySweep — BULLISH (sweeps a swing low)', () => {
  const base = [
    c(9, 9, 10, 8), // 0
    c(8, 8, 9.5, 7), // 1
    c(7, 7, 9, 5), // 2 — swing low (5)
    c(8, 8, 9.5, 7), // 3
    c(9, 9, 10, 8), // 4
  ];

  it('confirms a sweep: long lower wick past the swing low, closes back above it', () => {
    const candles = [...base, c(5.3, 5.5, 6, 3)]; // low=3<5, close=5.5>5, lowerWickRatio=(5.3-3)/3=0.77
    const result = detectLiquiditySweep(candles, 'BULLISH', config);
    expect(result).toEqual({ type: 'BULLISH', sweptLevel: 5, candleIndex: 5 });
  });

  it('does not confirm if the wick ratio is below threshold (body too large relative to range)', () => {
    const candles = [...base, c(4, 4.2, 6, 3)]; // low=3<5, close=4.2<5 (didn't even close back above) — fails anyway
    expect(detectLiquiditySweep(candles, 'BULLISH', config)).toBeNull();
  });

  it('does not confirm if price never actually swept below the swing low', () => {
    const candles = [...base, c(5.5, 5.8, 6, 5.2)]; // low=5.2, never went below swing low 5
    expect(detectLiquiditySweep(candles, 'BULLISH', config)).toBeNull();
  });
});

describe('detectLiquiditySweep — BEARISH (sweeps a swing high)', () => {
  it('mirrors BULLISH using high/upperWickRatio', () => {
    const candles = [
      c(9, 9, 10, 8), // 0
      c(9.5, 9.5, 11, 9), // 1
      c(10, 10, 13, 9), // 2 — swing high (13)
      c(9.5, 9.5, 11, 9), // 3
      c(9, 9, 10, 8), // 4
      c(11.7, 11.5, 15, 11), // 5 — high=15>13, close=11.5<13, upperWickRatio=(15-11.7)/4=0.825
    ];
    const result = detectLiquiditySweep(candles, 'BEARISH', config);
    expect(result).toEqual({ type: 'BEARISH', sweptLevel: 13, candleIndex: 5 });
  });
});
