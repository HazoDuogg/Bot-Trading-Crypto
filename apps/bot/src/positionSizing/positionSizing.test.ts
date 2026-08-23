import { describe, it, expect } from 'vitest';
import { calculatePositionSize } from './positionSizing.js';

const BALANCE = 500;
const RISK_USD = 5;
const MAX_MARGIN_PCT = 0.3;

// Builds an entry/SL pair hitting an exact SL% off a round entry price, to match the documented median SL% figures.
function entryAndSlForPct(entryPrice: number, slPct: number) {
  return { entryPrice, slPrice: entryPrice * (1 - slPct / 100) };
}

describe('calculatePositionSize — margin clamp scenarios (matches doc-verified worked examples)', () => {
  it('BTC: leverage 20x, SL%=0.057% -> clamped, actualRisk ~= $1.71', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(70000, 0.057);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 20,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result).not.toBeNull();
    expect(result!.clampedByMargin).toBe(true);
    expect(result!.requiredMargin).toBeCloseTo(150, 6); // maxMarginPct binds exactly at 30% of balance
    expect(result!.actualRiskUsd).toBeCloseTo(1.71, 1);
    expect(result!.actualRiskUsd).toBeLessThan(RISK_USD); // invariant: never exceeds target risk
  });

  it('ETH: leverage 20x, SL%=0.086% -> clamped, actualRisk ~= $2.58', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(3500, 0.086);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 20,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result!.actualRiskUsd).toBeCloseTo(2.58, 1);
  });

  it('SOL: leverage 10x, SL%=0.109% -> clamped, actualRisk ~= $1.64', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(150, 0.109);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 10,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result!.requiredMargin).toBeCloseTo(150, 6);
    expect(result!.actualRiskUsd).toBeCloseTo(1.64, 1);
  });

  it('HYPE: leverage 10x, SL%=0.172% -> clamped, actualRisk ~= $2.58', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(10, 0.172);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 10,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result!.actualRiskUsd).toBeCloseTo(2.58, 1);
  });

  it('XRP: leverage 10x, SL%=0.077% -> clamped, actualRisk ~= $1.16', () => {
    const { entryPrice, slPrice } = entryAndSlForPct(0.6, 0.077);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 10,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result!.actualRiskUsd).toBeCloseTo(1.16, 1);
  });
});

describe('calculatePositionSize — unclamped scenario', () => {
  it('does not clamp when SL% is wide enough that risk-based notional stays under the margin cap', () => {
    // Wide SL (1.5%) -> risk-based notional is small, well under the margin cap.
    const { entryPrice, slPrice } = entryAndSlForPct(70000, 1.5);
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice,
      leverage: 20,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result!.clampedByMargin).toBe(false);
    expect(result!.actualRiskUsd).toBeCloseTo(RISK_USD, 6); // full target risk achieved, no clamp needed
  });
});

describe('calculatePositionSize — invalid inputs', () => {
  it('returns null when entry equals SL (zero distance)', () => {
    const result = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice: 100,
      slPrice: 100,
      leverage: 10,
      maxMarginPct: MAX_MARGIN_PCT,
    });
    expect(result).toBeNull();
  });

  it('returns null for non-positive balance, risk, leverage, or margin cap', () => {
    const base = { entryPrice: 100, slPrice: 99, leverage: 10, maxMarginPct: MAX_MARGIN_PCT };
    expect(calculatePositionSize({ balance: 0, riskUsd: RISK_USD, ...base })).toBeNull();
    expect(calculatePositionSize({ balance: BALANCE, riskUsd: 0, ...base })).toBeNull();
    expect(calculatePositionSize({ balance: BALANCE, riskUsd: RISK_USD, ...base, leverage: 0 })).toBeNull();
    expect(calculatePositionSize({ balance: BALANCE, riskUsd: RISK_USD, ...base, maxMarginPct: 0 })).toBeNull();
  });
});
