import { describe, expect, it } from 'vitest';
import { detectMomentumDirect, passesMomentumDirectBodyRatio } from './momentumDirect.js';

describe('detectMomentumDirect', () => {
  it('returns true when the score is exactly at the threshold', () => {
    expect(detectMomentumDirect(0.75, 'LONG', 0.75)).toBe(true);
  });

  it('returns true when the score clears the threshold', () => {
    expect(detectMomentumDirect(0.9, 'SHORT', 0.75)).toBe(true);
  });

  it('returns false when the score is below the threshold', () => {
    expect(detectMomentumDirect(0.74, 'LONG', 0.75)).toBe(false);
  });
});

describe('passesMomentumDirectBodyRatio', () => {
  it('passes exactly at the BOX_BREAKOUT threshold', () => {
    expect(passesMomentumDirectBodyRatio(100, 102, 98, 102, 0.5)).toBe(true);
  });

  it('rejects wick-dominant and zero-range candles', () => {
    expect(passesMomentumDirectBodyRatio(100, 102, 98, 101, 0.5)).toBe(false);
    expect(passesMomentumDirectBodyRatio(100, 100, 100, 100, 0.5)).toBe(false);
  });
});
