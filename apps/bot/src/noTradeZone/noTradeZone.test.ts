import { describe, it, expect } from 'vitest';
import { checkNoTradeZone } from './noTradeZone.js';
import type { Candle } from './types.js';

function calmCandles(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push({ openTime: 0, open: 100, high: 101, low: 99, close: 100, volume: 100 });
  return out;
}

describe('checkNoTradeZone', () => {
  it('does not block under calm, tight-spread conditions', () => {
    const result = checkNoTradeZone({
      nowMs: Date.now(),
      bid: 99.99,
      ask: 100.01,
      h1Candles: calmCandles(25),
      m15Candles: calmCandles(20),
    });
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('blocks and reports all matching reasons, not just the first', () => {
    const shockH1: Candle[] = [...calmCandles(24), { openTime: 0, open: 100, high: 112, low: 100, close: 110, volume: 100 }];
    const result = checkNoTradeZone({
      nowMs: Date.now(),
      bid: 99.9,
      ask: 100.1, // spread% = 0.2, over 0.075 threshold
      h1Candles: shockH1, // range% = 12 (volatility_extreme) and move% = 10 (shock_event)
      m15Candles: calmCandles(20),
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('spread_too_high');
    expect(result.reasons).toContain('volatility_extreme');
    expect(result.reasons).toContain('shock_event');
    expect(result.reasons).not.toContain('pump_dump_flag');
  });
});
