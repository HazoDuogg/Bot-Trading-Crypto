import { describe, expect, it } from 'vitest';
import { computeDirection5m } from './neutral5mDirectionSelector.js';
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

// Same shape as structuralBreakRecent.test.ts's bullishConfirmedAtEnd fixture (TICKET-125's own
// tests) — confirmation lands at the very last candle (age=0), well within the default
// RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES=20 tolerance.
const bullishStructure1m: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.25, 9.25, 10, 8.5),
  c(7.5, 7.5, 9.5, 6), // swing low #1 (6)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // swing high between the two lows (12) — reference level
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(8.75, 8.75, 9.5, 8), // swing low #2 (8), higher-low
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(12.5, 13, 13.2, 12.3), // index 11 — close 13 > 12 -> MSS confirmed here (BULLISH)
];

const bearishStructure1m: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.75, 9.75, 10.5, 9),
  c(11.5, 11.5, 13, 10), // swing high #1 (13)
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(8, 8, 10, 6), // swing low between the two highs (6) — reference level
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // lower-high vs index 2
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(6.5, 5, 6.8, 4.8), // index 11 — close 5 < 6 -> MSS confirmed here (BEARISH)
];

// Flat 1m window — no confirmation either direction (structuralDirection sub-check -> NONE).
const flatStructure1m: CandleData[] = Array.from({ length: 30 }, (_, i) => c(100, 100, 100.2, 99.8, i * 60_000));

describe('computeDirection5m (TICKET-130)', () => {
  it('EMA + DI + structure all agree LONG -> LONG', () => {
    // Gentle uptrend (slope=0.3/candle) with a wide-enough per-candle range (2.5) to keep
    // overextensionAtr <= 2.0 — verified empirically below via the overextension-specific test,
    // this fixture is deliberately NOT near that boundary.
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5);
    expect(computeDirection5m(candles5m, bullishStructure1m)).toBe('LONG');
  });

  it('EMA + DI + structure all agree SHORT -> SHORT', () => {
    const candles5m = trendCandles5m(40, 150, -0.3, 2.5);
    expect(computeDirection5m(candles5m, bearishStructure1m)).toBe('SHORT');
  });

  it('no consensus (structure disagrees with EMA/DI) -> NONE', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5); // EMA/DI both LONG
    expect(computeDirection5m(candles5m, bearishStructure1m)).toBe('NONE'); // structure says SHORT
  });

  it('no consensus (flat EMA/DI, no trend at all) -> NONE', () => {
    const flatCandles5m = trendCandles5m(40, 100, 0, 1);
    expect(computeDirection5m(flatCandles5m, bullishStructure1m)).toBe('NONE');
  });

  it('no structural break at all -> NONE, even when EMA+DI agree', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5);
    expect(computeDirection5m(candles5m, flatStructure1m)).toBe('NONE');
  });

  it('overextension > 2.0 ATR overrides an otherwise-unanimous LONG verdict -> NONE', () => {
    // Steep trend (slope=3/candle) with a narrow range (0.3) -> EMA21 lags far behind close
    // relative to ATR, well past the 2.0 threshold, while EMA/DI/structure would otherwise agree.
    const candles5m = trendCandles5m(40, 100, 3, 0.3);
    expect(computeDirection5m(candles5m, bullishStructure1m)).toBe('NONE');
  });

  it('insufficient warm-up (fewer than EMA21+slope-lookback candles) -> NONE, never throws', () => {
    const candles5m = trendCandles5m(10, 100, 0.3, 2.5); // way under 21+3=24
    expect(() => computeDirection5m(candles5m, bullishStructure1m)).not.toThrow();
    expect(computeDirection5m(candles5m, bullishStructure1m)).toBe('NONE');
  });

  it('empty candle arrays -> NONE, never throws', () => {
    expect(() => computeDirection5m([], [])).not.toThrow();
    expect(computeDirection5m([], [])).toBe('NONE');
  });

  it('ATR=0 (perfectly flat candles, zero range) never produces NaN/Infinity -> NONE', () => {
    // Every candle identical (open=high=low=close) -> true range is 0 everywhere -> ATR=0.
    const zeroRangeCandles5m: CandleData[] = Array.from({ length: 40 }, (_, i) => c(100, 100, 100, 100, i * 300_000));
    const result = computeDirection5m(zeroRangeCandles5m, bullishStructure1m);
    expect(result).toBe('NONE');
    expect(Number.isNaN(result as unknown as number)).toBe(false);
  });
});
