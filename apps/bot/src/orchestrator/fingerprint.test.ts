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
