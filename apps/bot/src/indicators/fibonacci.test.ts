import { describe, it, expect } from 'vitest';
import { computeFibZone } from './fibonacci.js';

describe('computeFibZone', () => {
  it('retracementPct=0 at swingHighPrice, 1 at swingLowPrice', () => {
    expect(computeFibZone(100, 200, 200).retracementPct).toBeCloseTo(0, 9);
    expect(computeFibZone(100, 200, 100).retracementPct).toBeCloseTo(1, 9);
    expect(computeFibZone(100, 200, 150).retracementPct).toBeCloseTo(0.5, 9);
  });

  it('inDiscountZone true within [0.618, 0.786], for a deep pullback toward the low', () => {
    // range 100 (100..200): retracementPct=0.7 -> currentPrice = 200 - 0.7*100 = 130
    const result = computeFibZone(100, 200, 130);
    expect(result.retracementPct).toBeCloseTo(0.7, 9);
    expect(result.inDiscountZone).toBe(true);
    expect(result.inPremiumZone).toBe(false);
  });

  it('inPremiumZone true within the mirrored [0.214, 0.382] band, near the high', () => {
    // retracementPct=0.3 -> currentPrice = 200 - 0.3*100 = 170
    const result = computeFibZone(100, 200, 170);
    expect(result.retracementPct).toBeCloseTo(0.3, 9);
    expect(result.inPremiumZone).toBe(true);
    expect(result.inDiscountZone).toBe(false);
  });

  it('neither zone when retracementPct is near the midpoint (0.5)', () => {
    const result = computeFibZone(100, 200, 150);
    expect(result.inDiscountZone).toBe(false);
    expect(result.inPremiumZone).toBe(false);
  });

  it('boundary: retracementPct exactly 0.618 and 0.786 count as inDiscountZone', () => {
    const at618 = computeFibZone(0, 100, 100 - 61.8);
    expect(at618.inDiscountZone).toBe(true);
    const at786 = computeFibZone(0, 100, 100 - 78.6);
    expect(at786.inDiscountZone).toBe(true);
  });

  it('returns NaN/false/false for an invalid (zero or inverted) range', () => {
    expect(computeFibZone(100, 100, 100)).toEqual({ retracementPct: NaN, inDiscountZone: false, inPremiumZone: false });
    expect(computeFibZone(200, 100, 150)).toEqual({ retracementPct: NaN, inDiscountZone: false, inPremiumZone: false });
  });
});
