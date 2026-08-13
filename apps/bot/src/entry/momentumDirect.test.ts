import { describe, expect, it } from 'vitest';
import { detectMomentumDirect } from './momentumDirect.js';

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
