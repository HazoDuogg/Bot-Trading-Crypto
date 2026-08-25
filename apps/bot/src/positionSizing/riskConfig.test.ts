import { describe, it, expect } from 'vitest';
import { resolveRiskPct, DEFAULT_RISK_CONFIG } from './riskConfig.js';

describe('resolveRiskPct', () => {
  it('returns fourCoinRiskPct (1.5%) for BTC/ETH/SOL/XRP regardless of breaksKeyZone', () => {
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
      expect(resolveRiskPct(symbol, false)).toBe(0.015);
      expect(resolveRiskPct(symbol, true)).toBe(0.015);
    }
  });

  it('returns hypeBaselineRiskPct (1.0%) for HYPEUSDT when breaksKeyZone=false', () => {
    expect(resolveRiskPct('HYPEUSDT', false)).toBe(0.01);
  });

  it('returns hypeKeyZoneRiskPct (1.5%) for HYPEUSDT when breaksKeyZone=true', () => {
    expect(resolveRiskPct('HYPEUSDT', true)).toBe(0.015);
  });

  it('respects an explicit config override instead of the default', () => {
    const config = { fourCoinRiskPct: 0.02, hypeBaselineRiskPct: 0.005, hypeKeyZoneRiskPct: 0.03 };
    expect(resolveRiskPct('BTCUSDT', false, config)).toBe(0.02);
    expect(resolveRiskPct('HYPEUSDT', false, config)).toBe(0.005);
    expect(resolveRiskPct('HYPEUSDT', true, config)).toBe(0.03);
  });

  it('DEFAULT_RISK_CONFIG matches the RT-057 backtest-confirmed values', () => {
    expect(DEFAULT_RISK_CONFIG).toEqual({ fourCoinRiskPct: 0.015, hypeBaselineRiskPct: 0.01, hypeKeyZoneRiskPct: 0.015 });
  });
});
