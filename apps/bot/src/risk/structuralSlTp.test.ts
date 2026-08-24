import { describe, it, expect } from 'vitest';
import { calculateStructuralSlTp } from './structuralSlTp.js';
import type { Candle } from '../regime/types.js';

function candle(high: number, low: number): Candle {
  return { openTime: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

// Single low (95) and single high (106), straddling entry=100.
const BASIC_CANDLES: Candle[] = [
  candle(101, 99),
  candle(99, 97),
  candle(97, 95), // low = 95
  candle(99, 97),
  candle(101, 99),
  candle(103, 101),
  candle(106, 104), // high = 106
  candle(103, 101),
  candle(101, 99),
];

const LOW_FLOOR = 0.01; // permissive floor for tests that aren't specifically about the floor

describe('calculateStructuralSlTp — LONG', () => {
  it('SL = nearest swing low below entry, TP = nearest swing high above entry', () => {
    const result = calculateStructuralSlTp({
      direction: 'LONG',
      entryPrice: 100,
      m5Candles: BASIC_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: LOW_FLOOR,
    });
    expect(result).not.toBeNull();
    expect(result!.slPrice).toBe(95);
    expect(result!.tpPrice).toBe(106);
    expect(result!.rMultiple).toBeCloseTo(6 / 5, 9);
  });

  it('returns null when there is no swing low below entry', () => {
    const result = calculateStructuralSlTp({
      direction: 'LONG',
      entryPrice: 50, // below every swing low in BASIC_CANDLES
      m5Candles: BASIC_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: LOW_FLOOR,
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no swing high above entry', () => {
    const result = calculateStructuralSlTp({
      direction: 'LONG',
      entryPrice: 200, // above every swing high in BASIC_CANDLES
      m5Candles: BASIC_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: LOW_FLOOR,
    });
    expect(result).toBeNull();
  });

  it('returns null when the resulting SL% is below minSlPctFloor', () => {
    const result = calculateStructuralSlTp({
      direction: 'LONG',
      entryPrice: 100,
      m5Candles: BASIC_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: 10, // actual SL% here is 5% (95 vs 100), below a 10% floor
    });
    expect(result).toBeNull();
  });
});

describe('calculateStructuralSlTp — SHORT', () => {
  it('SL = nearest swing high above entry, TP = nearest swing low below entry', () => {
    const result = calculateStructuralSlTp({
      direction: 'SHORT',
      entryPrice: 100,
      m5Candles: BASIC_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: LOW_FLOOR,
    });
    expect(result).not.toBeNull();
    expect(result!.slPrice).toBe(106);
    expect(result!.tpPrice).toBe(95);
    expect(result!.rMultiple).toBeCloseTo(5 / 6, 9);
  });
});

describe('calculateStructuralSlTp — picks nearest-by-price, not the farthest candidate', () => {
  const MULTI_CANDLES: Candle[] = [
    candle(101, 99),
    candle(99, 97),
    candle(97, 95), // low1 = 95 (nearer to entry=100)
    candle(99, 97),
    candle(101, 99),
    candle(103, 101),
    candle(106, 104), // high1 = 106 (nearer to entry=100)
    candle(103, 101),
    candle(101, 99),
    candle(99, 97),
    candle(97, 80), // low2 = 80 (farther below)
    candle(99, 97),
    candle(101, 99),
    candle(103, 101),
    candle(122, 120), // high2 = 122 (farther above)
    candle(103, 101),
    candle(101, 99),
  ];

  it('LONG uses the nearer low (95, not 80) and nearer high (106, not 122)', () => {
    const result = calculateStructuralSlTp({
      direction: 'LONG',
      entryPrice: 100,
      m5Candles: MULTI_CANDLES,
      swingPivotWidth: 2,
      minSlPctFloor: LOW_FLOOR,
    });
    expect(result!.slPrice).toBe(95);
    expect(result!.tpPrice).toBe(106);
  });
});
