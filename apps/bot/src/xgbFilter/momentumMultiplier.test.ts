import { describe, expect, it } from 'vitest';
import { computeMomentumMultiplier } from './momentumMultiplier.js';
import type { MomentumFilterConfig } from './config.js';

const config: MomentumFilterConfig = {
  momentumFilterEnabled: true,
  momentumLowThreshold: 0.45,
  momentumHighThreshold: 0.6,
  momentumLowMultiplier: 0.5,
};

describe('computeMomentumMultiplier', () => {
  it('returns momentumLowMultiplier at and below momentumLowThreshold', () => {
    expect(computeMomentumMultiplier(0.45, config)).toBe(0.5);
    expect(computeMomentumMultiplier(0.1, config)).toBe(0.5);
    expect(computeMomentumMultiplier(0, config)).toBe(0.5);
  });

  it('returns 1.0 at and above momentumHighThreshold', () => {
    expect(computeMomentumMultiplier(0.6, config)).toBe(1.0);
    expect(computeMomentumMultiplier(0.9, config)).toBe(1.0);
    expect(computeMomentumMultiplier(1, config)).toBe(1.0);
  });

  it('linearly interpolates between the two thresholds', () => {
    // midpoint of [0.45, 0.6] -> midpoint of [0.5, 1.0] = 0.75
    const mid = (config.momentumLowThreshold + config.momentumHighThreshold) / 2;
    expect(computeMomentumMultiplier(mid, config)).toBeCloseTo(0.75, 10);

    // 25% of the way from low to high -> 25% of the way from 0.5 to 1.0 = 0.625
    const quarter = config.momentumLowThreshold + 0.25 * (config.momentumHighThreshold - config.momentumLowThreshold);
    expect(computeMomentumMultiplier(quarter, config)).toBeCloseTo(0.625, 10);
  });
});
