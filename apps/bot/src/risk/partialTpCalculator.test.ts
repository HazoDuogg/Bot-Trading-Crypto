import { describe, it, expect } from 'vitest';
import { calculatePartialTp } from './partialTpCalculator.js';
import { TAKER_ONLY_FEE_CONFIG, MAKER_EXIT_FEE_CONFIG } from './partialTp.js';

function entryAndSlForPct(entryPrice: number, slPct: number) {
  return { entryPrice, slPrice: entryPrice * (1 - slPct / 100) };
}

const ZERO_COST = { entryFeePct: 0, entrySlippagePct: 0, exitFeePct: 0, exitSlippagePct: 0 };

describe('calculatePartialTp — zero cost', () => {
  it('nets exactly the blended gross R:R (2.25R by default) with no fee/slippage', () => {
    const result = calculatePartialTp({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98,
      feeConfig: ZERO_COST,
    });
    expect(result.blendedGrossRMultiple).toBeCloseTo(2.25, 6); // 0.5*1.5 + 0.5*3.0
    expect(result.netRMultiple).toBeCloseTo(2.25, 6);
    expect(result.tp1Price).toBeCloseTo(103, 6); // 100 + 1.5*2
    expect(result.tp2Price).toBeCloseTo(106, 6); // 100 + 3.0*2
    expect(result.passes).toBe(true);
  });

  it('computes TP1/TP2 correctly for SHORT', () => {
    const result = calculatePartialTp({
      direction: 'SHORT',
      entryPrice: 100,
      slPrice: 102,
      feeConfig: ZERO_COST,
    });
    expect(result.tp1Price).toBeCloseTo(97, 6);
    expect(result.tp2Price).toBeCloseTo(94, 6);
  });
});

describe('calculatePartialTp — TAKER_ONLY_FEE_CONFIG matches previously hand-verified figures', () => {
  it('SL%=0.4% (tight, e.g. Range) -> net R:R ~1.17, fails the 1.2R real threshold', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(100, 0.4);
    const result = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: TAKER_ONLY_FEE_CONFIG });
    expect(result.netRMultiple).toBeCloseTo(1.1667, 3);
    expect(result.passes).toBe(false);
  });

  it('SL%=0.5% (typical Trend/Breakout median) -> net R:R ~1.32, passes the 1.2R real threshold', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(100, 0.5);
    const result = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: TAKER_ONLY_FEE_CONFIG });
    expect(result.netRMultiple).toBeCloseTo(1.3214, 3);
    expect(result.passes).toBe(true);
  });
});

describe('calculatePartialTp — MAKER_EXIT_FEE_CONFIG (entry taker, TP legs maker, 0 exit slippage)', () => {
  it('lowers cost vs taker-only, turning a previously-failing tight-SL trade into a pass', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(100, 0.4);
    const taker = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: TAKER_ONLY_FEE_CONFIG });
    const makerExit = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: MAKER_EXIT_FEE_CONFIG });

    expect(taker.passes).toBe(false);
    expect(makerExit.netRMultiple).toBeCloseTo(1.5, 4); // cost=0.12 vs 0.2 -> netR = (0.9-0.12)/(0.4+0.12) = 1.5
    expect(makerExit.passes).toBe(true);
    expect(makerExit.netRMultiple).toBeGreaterThan(taker.netRMultiple);
  });

  it('matches the BTC/TREND_PULLBACK median SL% finding: fails taker-only, passes maker-exit', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(100, 0.343); // BTC/TREND_PULLBACK median SL% from TICKET-RT-006
    const taker = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: TAKER_ONLY_FEE_CONFIG });
    const makerExit = calculatePartialTp({ direction: 'LONG', entryPrice, slPrice, feeConfig: MAKER_EXIT_FEE_CONFIG });

    expect(taker.passes).toBe(false);
    expect(makerExit.passes).toBe(true);
  });
});

describe('calculatePartialTp — nominal threshold invariant', () => {
  it('flags passesNominalThreshold=false if config sets tp1RMultiple below minNominalRMultiple', () => {
    const result = calculatePartialTp({
      direction: 'LONG',
      entryPrice: 100,
      slPrice: 98,
      feeConfig: ZERO_COST,
      config: {
        tp1RMultiple: 1.0, // below default minNominalRMultiple of 1.5
        tp1ClosePct: 0.5,
        tp2RMultiple: 3.0,
        tp2ClosePct: 0.5,
        minNominalRMultiple: 1.5,
        minRealRMultiple: 1.2,
      },
    });
    expect(result.passesNominalThreshold).toBe(false);
    expect(result.passes).toBe(false);
  });
});
