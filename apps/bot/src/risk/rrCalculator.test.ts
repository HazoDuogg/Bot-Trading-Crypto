import { describe, it, expect } from 'vitest';
import { calculateRr } from './rrCalculator.js';

describe('calculateRr', () => {
  it('with zero cost, ideal TP is exactly entry + 3xSL for LONG', () => {
    const result = calculateRr({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98, // risk = 2
      targetRMultiple: 3,
      feeConfig: { takerFeePct: 0, slippagePct: 0 },
    });
    expect(result.idealTpPrice).toBeCloseTo(106, 6); // 100 + 3*2
    expect(result.netRMultiple).toBeCloseTo(3, 6);
    expect(result.passesThreshold).toBe(true);
  });

  it('with zero cost, ideal TP is exactly entry - 3xSL for SHORT', () => {
    const result = calculateRr({
      direction: 'SHORT',
      entryPrice: 100,
      slPrice: 102,
      targetRMultiple: 3,
      feeConfig: { takerFeePct: 0, slippagePct: 0 },
    });
    expect(result.idealTpPrice).toBeCloseTo(94, 6);
  });

  it('with real cost, ideal TP extends beyond raw 3xSL to compensate, and still nets exactly targetRMultiple', () => {
    const result = calculateRr({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98,
      targetRMultiple: 3,
      feeConfig: { takerFeePct: 0.05, slippagePct: 0.05 },
    });
    // cost = 100*0.002 = 0.2; netRisk = 2.2; idealReward = 3*2.2+0.2 = 6.8; idealTp = 106.8 (beyond raw 106)
    expect(result.idealTpPrice).toBeCloseTo(106.8, 6);
    expect(result.netRMultiple).toBeCloseTo(3, 6);
    expect(result.passesThreshold).toBe(true);
  });

  it('fails threshold when a resistance zone caps TP short of the ideal cost-adjusted level', () => {
    const result = calculateRr({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98,
      targetRMultiple: 3,
      feeConfig: { takerFeePct: 0.05, slippagePct: 0.05 },
      cappedTpPrice: 104, // well short of the ideal ~106.8
    });
    expect(result.tpPrice).toBe(104);
    expect(result.passesThreshold).toBe(false);
  });

  it('accepts an uncapped TP that happens to sit beyond the ideal level (cap does not bind)', () => {
    const result = calculateRr({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98,
      targetRMultiple: 3,
      feeConfig: { takerFeePct: 0.05, slippagePct: 0.05 },
      cappedTpPrice: 110, // beyond the ideal ~106.8, so it does not constrain anything
    });
    expect(result.tpPrice).toBeCloseTo(result.idealTpPrice, 6);
    expect(result.passesThreshold).toBe(true);
  });
});
