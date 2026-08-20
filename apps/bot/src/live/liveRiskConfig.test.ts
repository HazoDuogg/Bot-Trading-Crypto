import { describe, it, expect } from 'vitest';
import { LIVE_FIXED_RISK_USD_REQUIRED, parseLiveFixedRiskUsd } from './liveRiskConfig.js';

describe('parseLiveFixedRiskUsd', () => {
  it('accepts exactly the production fixed risk', () => {
    expect(parseLiveFixedRiskUsd('20')).toBe(LIVE_FIXED_RISK_USD_REQUIRED);
  });

  it('rejects every positive value other than the production fixed risk', () => {
    for (const value of ['0.01', '15.5', '19.99', '20.01', '100']) {
      expect(() => parseLiveFixedRiskUsd(value)).toThrow(/phải đúng bằng 20/);
    }
  });

  it('throws when missing', () => {
    expect(() => parseLiveFixedRiskUsd(undefined)).toThrow(/thiếu biến môi trường/);
  });

  it('throws when empty string', () => {
    expect(() => parseLiveFixedRiskUsd('')).toThrow(/thiếu biến môi trường/);
  });

  it('throws when whitespace-only', () => {
    expect(() => parseLiveFixedRiskUsd('   ')).toThrow(/thiếu biến môi trường/);
  });

  it('throws when NaN/non-numeric', () => {
    expect(() => parseLiveFixedRiskUsd('abc')).toThrow(/không phải số hợp lệ/);
  });

  it('throws when Infinity', () => {
    expect(() => parseLiveFixedRiskUsd('Infinity')).toThrow(/không phải số hợp lệ/);
  });

  it('throws when <= 0', () => {
    expect(() => parseLiveFixedRiskUsd('0')).toThrow(/phải > 0/);
    expect(() => parseLiveFixedRiskUsd('-20')).toThrow(/phải > 0/);
  });
});
