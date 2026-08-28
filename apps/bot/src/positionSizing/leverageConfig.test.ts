import { describe, it, expect } from 'vitest';
import { resolveLeverage, DEFAULT_LEVERAGE_CONFIG } from './leverageConfig.js';

describe('resolveLeverage', () => {
  it('returns 20x for BTC/ETH', () => {
    expect(resolveLeverage('BTCUSDT')).toBe(20);
    expect(resolveLeverage('ETHUSDT')).toBe(20);
  });

  it('returns 10x for SOL/HYPE/DOGE', () => {
    expect(resolveLeverage('SOLUSDT')).toBe(10);
    expect(resolveLeverage('HYPEUSDT')).toBe(10);
    expect(resolveLeverage('DOGEUSDT')).toBe(10);
  });

  it('throws CORRECTION_REQUIRED for a symbol not in the config (fail loud, not silent default)', () => {
    expect(() => resolveLeverage('ADAUSDT')).toThrow(/CORRECTION_REQUIRED/);
  });

  it('respects an explicit config override instead of the default', () => {
    const config = { fourCoinLeverage: { BTCUSDT: 5 } };
    expect(resolveLeverage('BTCUSDT', config)).toBe(5);
  });

  it('DEFAULT_LEVERAGE_CONFIG matches the RT-AUDIT-001-confirmed design table (BTC/ETH=20x, SOL/HYPE/DOGE=10x)', () => {
    expect(DEFAULT_LEVERAGE_CONFIG).toEqual({
      fourCoinLeverage: { BTCUSDT: 20, ETHUSDT: 20, SOLUSDT: 10, HYPEUSDT: 10, DOGEUSDT: 10 },
    });
  });
});
