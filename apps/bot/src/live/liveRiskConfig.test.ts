import { describe, it, expect } from 'vitest';
import { parseLiveRiskPerTradePct, computeRequestedRiskUsd } from './liveRiskConfig.js';

describe('parseLiveRiskPerTradePct', () => {
  it('accepts a valid value under riskPoolMaxPct', () => {
    expect(parseLiveRiskPerTradePct('0.01', 0.15)).toBe(0.01);
  });

  it('throws when missing', () => {
    expect(() => parseLiveRiskPerTradePct(undefined, 0.15)).toThrow(/thiếu biến môi trường/);
  });

  it('throws when empty string', () => {
    expect(() => parseLiveRiskPerTradePct('', 0.15)).toThrow(/thiếu biến môi trường/);
  });

  it('throws when NaN/non-numeric', () => {
    expect(() => parseLiveRiskPerTradePct('abc', 0.15)).toThrow(/không phải số hợp lệ/);
  });

  it('throws when <= 0', () => {
    expect(() => parseLiveRiskPerTradePct('0', 0.15)).toThrow(/phải > 0/);
    expect(() => parseLiveRiskPerTradePct('-0.01', 0.15)).toThrow(/phải > 0/);
  });

  it('throws when > riskPoolMaxPct', () => {
    expect(() => parseLiveRiskPerTradePct('0.2', 0.15)).toThrow(/vượt quá riskPoolMaxPct/);
  });

  it('accepts exactly equal to riskPoolMaxPct', () => {
    expect(parseLiveRiskPerTradePct('0.15', 0.15)).toBe(0.15);
  });
});

describe('computeRequestedRiskUsd', () => {
  it('computes risk USD correctly from several different balances', () => {
    expect(computeRequestedRiskUsd(1000, 0.01)).toBeCloseTo(10, 9);
    expect(computeRequestedRiskUsd(5432.17, 0.01)).toBeCloseTo(54.3217, 9);
    expect(computeRequestedRiskUsd(200, 0.05)).toBeCloseTo(10, 9);
    expect(computeRequestedRiskUsd(0, 0.01)).toBe(0);
  });
});
