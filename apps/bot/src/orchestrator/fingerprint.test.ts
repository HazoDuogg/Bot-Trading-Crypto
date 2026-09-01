import { describe, expect, it } from 'vitest';
import {
  STRATEGY_CONSTANTS,
  computeStrategyFingerprint,
  type StrategyConstantManifest,
} from './fingerprint.js';

describe('computeStrategyFingerprint', () => {
  it('is deterministic and exposes the exact constant manifest that was hashed', () => {
    const first = computeStrategyFingerprint();
    const second = computeStrategyFingerprint();

    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.constants).toEqual(STRATEGY_CONSTANTS);
    expect(first.constants.D6).toEqual({
      counterTestWindow: 10,
      secondTestCounterWindow: 20,
      reclaimWindow: 3,
    });
    expect(first.constants.D7).toEqual({ minBodyRatio: 0.55, minRangeAtrRatio: 1 });
    expect(first.hash).not.toBe('ca2fb797a389b565b5d38aa519a1a363595f8ee69b7cff5493f44144974fc07e');
  });

  it('changes when one D-ID constant changes', () => {
    const changed: StrategyConstantManifest = {
      ...STRATEGY_CONSTANTS,
      D5: {
        ...STRATEGY_CONSTANTS.D5,
        maxBandwidthAtrRatio: STRATEGY_CONSTANTS.D5.maxBandwidthAtrRatio + 0.01,
      },
    };

    expect(computeStrategyFingerprint(changed).hash).not.toBe(computeStrategyFingerprint().hash);
  });
});
