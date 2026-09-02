import { describe, expect, it } from 'vitest';
import {
  CLASS_D_CONSTANTS,
  STRATEGY_CONSTANTS,
  computeSetupBConfirmationCandleFingerprint,
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
      minimumTestOccurrence: 1,
    });
    expect(first.constants.setupB).toEqual({ slBufferAtrMultiple: 0.5 });
    expect(first.constants.D7).toEqual({ minBodyRatio: 0.55, minRangeAtrRatio: 1 });
    expect(first.hash).not.toBe(
      '1cb8cc7d15f2d2afe24e899b7027df8aede04ba487ae06d3c57ad9e4d77d1614',
    );
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

describe('computeSetupBConfirmationCandleFingerprint', () => {
  it('produces a distinct hash from the D1-D8 baseline fingerprint, never colliding with it', () => {
    const baseline = computeStrategyFingerprint();
    const classD = computeSetupBConfirmationCandleFingerprint();

    expect(classD.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(classD.hash).not.toBe(baseline.hash);
    expect(classD.constants).toEqual(STRATEGY_CONSTANTS);
    expect(classD.classDConstants).toEqual(CLASS_D_CONSTANTS);
  });

  it('changes when the Class D threshold constants change, independent of D1-D8', () => {
    const changed = {
      setupBConfirmationCandle: {
        ...CLASS_D_CONSTANTS.setupBConfirmationCandle,
        minCloseBias: CLASS_D_CONSTANTS.setupBConfirmationCandle.minCloseBias + 0.01,
      },
    };

    expect(computeSetupBConfirmationCandleFingerprint(changed).hash).not.toBe(
      computeSetupBConfirmationCandleFingerprint().hash,
    );
    // D1-D8 baseline is untouched by the Class D constant change.
    expect(computeStrategyFingerprint().hash).toBe(computeStrategyFingerprint().hash);
  });
});
