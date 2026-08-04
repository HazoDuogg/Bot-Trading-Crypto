import { describe, expect, it } from 'vitest';
import { computeDirection5mRelaxed } from './neutral5mDirectionGatedRouting.js';
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

// Same fixtures as neutral5mDirectionSelector.test.ts (TICKET-130) — structural break confirmed at
// the very last 1m candle, well within the default tolerance window.
const bullishStructure1m: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.25, 9.25, 10, 8.5),
  c(7.5, 7.5, 9.5, 6),
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9),
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(8.75, 8.75, 9.5, 8),
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(12.5, 13, 13.2, 12.3),
];

const bearishStructure1m: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.75, 9.75, 10.5, 9),
  c(11.5, 11.5, 13, 10),
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(8, 8, 10, 6),
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9),
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(6.5, 5, 6.8, 4.8),
];

const flatStructure1m: CandleData[] = Array.from({ length: 30 }, (_, i) => c(100, 100, 100.2, 99.8, i * 60_000));

describe('computeDirection5mRelaxed (TICKET-131)', () => {
  it('EMA + DI both LONG -> LONG (structural break irrelevant here, has one anyway)', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5);
    const result = computeDirection5mRelaxed(candles5m, bullishStructure1m);
    expect(result.direction5m).toBe('LONG');
    expect(result.structuralBreakDiagnostic).toBe('LONG');
  });

  it('EMA + DI both SHORT -> SHORT', () => {
    const candles5m = trendCandles5m(40, 150, -0.3, 2.5);
    const result = computeDirection5mRelaxed(candles5m, bearishStructure1m);
    expect(result.direction5m).toBe('SHORT');
    expect(result.structuralBreakDiagnostic).toBe('SHORT');
  });

  it('EMA LONG but DI would need to disagree -> NONE (flat 5m has no consensus at all)', () => {
    const flatCandles5m = trendCandles5m(40, 100, 0, 1);
    const result = computeDirection5mRelaxed(flatCandles5m, bullishStructure1m);
    expect(result.direction5m).toBe('NONE');
  });

  it('EMA+DI agree LONG even though structural break disagrees (SHORT) -> still LONG (structure is diagnostic-only, never a decision input)', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5); // EMA/DI both LONG
    const result = computeDirection5mRelaxed(candles5m, bearishStructure1m); // structure says SHORT
    expect(result.direction5m).toBe('LONG'); // KEY DIFFERENCE from TICKET-130's 3-of-3 rule
    expect(result.structuralBreakDiagnostic).toBe('SHORT');
  });

  it('EMA+DI agree LONG with NO structural break at all -> still LONG (unlike TICKET-130, which would be NONE)', () => {
    const candles5m = trendCandles5m(40, 100, 0.3, 2.5);
    const result = computeDirection5mRelaxed(candles5m, flatStructure1m);
    expect(result.direction5m).toBe('LONG');
    expect(result.structuralBreakDiagnostic).toBe('NONE');
  });

  it('overextension > 2.0 ATR overrides an otherwise-agreeing LONG verdict -> NONE', () => {
    const candles5m = trendCandles5m(40, 100, 3, 0.3); // steep trend, narrow range -> overextended
    const result = computeDirection5mRelaxed(candles5m, bullishStructure1m);
    expect(result.direction5m).toBe('NONE');
  });

  it('insufficient warm-up (fewer than EMA21+slope-lookback candles) -> NONE, never throws', () => {
    const candles5m = trendCandles5m(10, 100, 0.3, 2.5); // way under 21+3=24
    expect(() => computeDirection5mRelaxed(candles5m, bullishStructure1m)).not.toThrow();
    expect(computeDirection5mRelaxed(candles5m, bullishStructure1m).direction5m).toBe('NONE');
  });

  it('empty candle arrays -> NONE, never throws', () => {
    expect(() => computeDirection5mRelaxed([], [])).not.toThrow();
    expect(computeDirection5mRelaxed([], []).direction5m).toBe('NONE');
    expect(computeDirection5mRelaxed([], []).structuralBreakDiagnostic).toBe('NONE');
  });

  it('ATR=0 (perfectly flat candles, zero range) never produces NaN/Infinity -> NONE', () => {
    const zeroRangeCandles5m: CandleData[] = Array.from({ length: 40 }, (_, i) => c(100, 100, 100, 100, i * 300_000));
    const result = computeDirection5mRelaxed(zeroRangeCandles5m, bullishStructure1m);
    expect(result.direction5m).toBe('NONE');
    expect(Number.isNaN(result.direction5m as unknown as number)).toBe(false);
  });
});
