import { describe, expect, it } from 'vitest';
import { is5mConfirmed } from './neutralMacroConflictOverride.js';
import type { CandleData } from '../regime/types.js';

function c(open: number, close: number, high: number, low: number, timestamp = 0): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

/** Steady linear trend, `slope` price units per 5m candle, `rangePerCandle` high-low range each candle. */
function trendCandles5m(count: number, startPrice: number, slope: number, rangePerCandle: number): CandleData[] {
  const candles: CandleData[] = [];
  let prevClose = startPrice;
  for (let i = 0; i < count; i++) {
    const close = startPrice + i * slope;
    const open = i === 0 ? close : prevClose;
    const high = Math.max(open, close) + rangePerCandle / 2;
    const low = Math.min(open, close) - rangePerCandle / 2;
    candles.push({ timestamp: i * 300_000, open, high, low, close, volume: 100 });
    prevClose = close;
  }
  return candles;
}

describe('is5mConfirmed (TICKET-138) — deliberately simpler than computeDirection5m/computeDirection5mRelaxed: raw EMA9-vs-EMA21 + raw DI, no slope/structure/overextension', () => {
  it('steady uptrend -> LONG confirmed, SHORT not confirmed', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5);
    expect(is5mConfirmed(candles5m, 'LONG')).toBe(true);
    expect(is5mConfirmed(candles5m, 'SHORT')).toBe(false);
  });

  it('steady downtrend -> SHORT confirmed, LONG not confirmed', () => {
    const candles5m = trendCandles5m(40, 150, -0.3, 2.5);
    expect(is5mConfirmed(candles5m, 'SHORT')).toBe(true);
    expect(is5mConfirmed(candles5m, 'LONG')).toBe(false);
  });

  it('flat/no-trend candles -> neither side confirmed', () => {
    const flatCandles5m = trendCandles5m(40, 100, 0, 1);
    expect(is5mConfirmed(flatCandles5m, 'LONG')).toBe(false);
    expect(is5mConfirmed(flatCandles5m, 'SHORT')).toBe(false);
  });

  it('does NOT require EMA21 slope (unlike computeDirection5m/computeDirection5mRelaxed) — a trend that just started (EMA fast>slow but EMA21 itself still barely moving) can still confirm', () => {
    // A trend so recent that EMA21's own slope over the last 3 candles is negligible, but EMA9 has
    // already crossed above EMA21 and DI already agrees — the OLD rules would require a real EMA21
    // slope; this rule does not.
    const flat = trendCandles5m(30, 100, 0, 1);
    const kick = trendCandles5m(10, 100, 2, 1).map((cd, i) => ({ ...cd, timestamp: (30 + i) * 300_000 }));
    const candles5m = [...flat, ...kick];
    expect(is5mConfirmed(candles5m, 'LONG')).toBe(true);
  });

  it('does NOT apply an overextension override (unlike computeDirection5m/computeDirection5mRelaxed) — a very steep/narrow-range trend still confirms', () => {
    const candles5m = trendCandles5m(40, 100, 3, 0.3); // steep trend, narrow range -> would be overextended under the old rules
    expect(is5mConfirmed(candles5m, 'LONG')).toBe(true);
  });

  it('insufficient warm-up (fewer than EMA21 period candles) -> false, never throws', () => {
    const candles5m = trendCandles5m(10, 100, 0.3, 2.5); // way under 21
    expect(() => is5mConfirmed(candles5m, 'LONG')).not.toThrow();
    expect(is5mConfirmed(candles5m, 'LONG')).toBe(false);
  });

  it('empty candle array -> false, never throws', () => {
    expect(() => is5mConfirmed([], 'LONG')).not.toThrow();
    expect(is5mConfirmed([], 'LONG')).toBe(false);
    expect(is5mConfirmed([], 'SHORT')).toBe(false);
  });

  it('requires BOTH sub-checks to agree (2-of-2 AND, not majority) — an uptrend never confirms SHORT even though only one of the two sub-checks needs to disagree to fail it', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5); // EMA and DI both agree LONG here
    expect(is5mConfirmed(candles5m, 'SHORT')).toBe(false);
  });
});
