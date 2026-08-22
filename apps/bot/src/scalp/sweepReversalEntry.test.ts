import { describe, expect, it } from 'vitest';
import { detectSweepReversalEntry, type SweepReversalEntryInput } from './sweepReversalEntry.js';
import { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import { lastDefined, wilderATRSeries } from '../regime/indicators.js';
import type { CandleData } from '../regime/types.js';
import { ScalpConfig } from './config.js';

function c(open: number, close: number, high: number, low: number, timestamp = 0, volume = 100): CandleData {
  return { timestamp, open, close, high, low, volume };
}

const FIVE_MIN_MS = 300_000;
const ONE_MIN_MS = 60_000;

/**
 * 25 5m candles: 9 flat fillers, then the liquiditySweep.test.ts BULLISH fixture's swing-low
 * pattern (idx9-13, swing low = 5 at idx11 — also seeds ATR(14), period ends exactly at idx13),
 * 10 more flat fillers, then a sweep candle at idx24 (volume spike -> passes the z-score gate).
 * Flat fillers never form a fractal (strict inequality never holds), so idx11 stays the only LOW swing.
 */
function buildCandles5m(): CandleData[] {
  const candles: CandleData[] = [];
  const filler = () => c(9, 9, 9.3, 8.7);
  for (let i = 0; i < 9; i++) candles.push(filler());
  candles.push(c(9, 9, 10, 8)); // 9
  candles.push(c(8, 8, 9.5, 7)); // 10
  candles.push(c(7, 7, 9, 5)); // 11 — swing low (5)
  candles.push(c(8, 8, 9.5, 7)); // 12
  candles.push(c(9, 9, 10, 8)); // 13
  for (let i = 0; i < 10; i++) candles.push(filler()); // 14-23
  candles.push(c(5.3, 5.5, 6, 3, 0, 500)); // 24 — sweep: low=3<5, close=5.5>5, lowerWickRatio=0.77, volume spike
  return candles.map((candle, i) => ({ ...candle, timestamp: i * FIVE_MIN_MS }));
}

const SWEEP_TIMESTAMP = 24 * FIVE_MIN_MS;

/** marketStructureShift.test.ts's BULLISH fixture, confirmed at its own last index (11). */
function buildValidMssCandles(): CandleData[] {
  const candles: CandleData[] = [
    c(9.5, 9.5, 10, 9),
    c(9.25, 9.25, 10, 8.5),
    c(7.5, 7.5, 9.5, 6), // swing low #1 (6)
    c(9.25, 9.25, 10, 8.5),
    c(9.5, 9.5, 10, 9),
    c(10.5, 10.5, 12, 9), // reference swing high (12)
    c(9.25, 9.25, 10, 8.5),
    c(9.5, 9.5, 10, 9),
    c(8.75, 8.75, 9.5, 8), // swing low #2 (8) — higher-low
    c(9.25, 9.25, 10, 8.5),
    c(9.5, 9.5, 10, 9),
    c(12.5, 13, 13.2, 12.3), // close 13 > 12 -> MSS confirmed here (index 11)
  ];
  return candles.map((candle, i) => ({ ...candle, timestamp: SWEEP_TIMESTAMP + i * ONE_MIN_MS }));
}

/** Flat candles never produce a swing point — 15m path always fails so tests can isolate the 5m path. */
function buildFlatCandles15m(): CandleData[] {
  return Array.from({ length: 25 }, (_, i) => ({ ...c(9, 9, 9.3, 8.7), timestamp: i * 15 * 60_000 }));
}

function buildValidInput(overrides: Partial<SweepReversalEntryInput> = {}): SweepReversalEntryInput {
  return {
    symbol: 'BTCUSDT',
    candles15m: buildFlatCandles15m(),
    candles5m: buildCandles5m(),
    candlesMss: buildValidMssCandles(),
    htfContext: HTFContext.NEUTRAL,
    safetyState5m: SafetyState5m.NORMAL,
    ...overrides,
  };
}

describe('detectSweepReversalEntry', () => {
  it('returns a full LONG setup when every step passes', () => {
    const input = buildValidInput();
    const result = detectSweepReversalEntry(input);
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe('BTCUSDT');
    expect(result?.side).toBe('LONG');
    expect(result?.timeframe).toBe('5m');
    expect(result?.sweptLevel).toBe(5);
    expect(result?.entryPrice).toBe(13);
    expect(result?.timestamp).toBe(SWEEP_TIMESTAMP + 11 * ONE_MIN_MS);

    const atr = lastDefined(wilderATRSeries(input.candles5m, ScalpConfig.ATR_PERIOD_5M)) as number;
    const expectedSl = 3 - ScalpConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
    expect(result?.slPrice).toBeCloseTo(expectedSl, 8);

    const slDistancePercent = Math.abs(13 - (result?.slPrice as number)) / 13;
    const expectedTp = 13 * (1 + slDistancePercent * ScalpConfig.R_MULTIPLE);
    expect(result?.tpPriceOverride).toBeCloseTo(expectedTp, 8);
  });

  it('returns null when no swing point exists near the current candle', () => {
    const flat = buildFlatCandles15m();
    const result = detectSweepReversalEntry(buildValidInput({ candles5m: flat, candles15m: flat }));
    expect(result).toBeNull();
  });

  it('returns null when the sweep candle has no volume expansion (z-score below threshold)', () => {
    const candles5m = buildCandles5m();
    candles5m[candles5m.length - 1] = { ...candles5m[candles5m.length - 1], volume: 100 }; // no spike
    const result = detectSweepReversalEntry(buildValidInput({ candles5m }));
    expect(result).toBeNull();
  });

  it('returns null when MSS never confirms in the given window', () => {
    const result = detectSweepReversalEntry(buildValidInput({ candlesMss: buildValidMssCandles().slice(0, 8) }));
    expect(result).toBeNull();
  });

  it('returns null when the MSS confirmation is stale (older than MSS_STALENESS_TOLERANCE_CANDLES)', () => {
    const stale = buildValidMssCandles();
    const padding = Array.from({ length: 6 }, (_, i) => ({
      ...stale[stale.length - 1],
      timestamp: stale[stale.length - 1].timestamp + (i + 1) * ONE_MIN_MS,
    }));
    const result = detectSweepReversalEntry(buildValidInput({ candlesMss: [...stale, ...padding] }));
    expect(result).toBeNull();
  });

  it('vetoes when safetyState5m is not NORMAL', () => {
    const result = detectSweepReversalEntry(buildValidInput({ safetyState5m: SafetyState5m.SHOCK }));
    expect(result).toBeNull();
  });

  it('vetoes a LONG reversal when htfContext is a strong TREND_DOWN (same direction as the swept breakout)', () => {
    const result = detectSweepReversalEntry(buildValidInput({ htfContext: HTFContext.TREND_DOWN }));
    expect(result).toBeNull();
  });

  it('does NOT veto a LONG reversal when htfContext is TREND_UP (opposite the swept breakout)', () => {
    const result = detectSweepReversalEntry(buildValidInput({ htfContext: HTFContext.TREND_UP }));
    expect(result).not.toBeNull();
    expect(result?.side).toBe('LONG');
  });

  // TICKET-SCALP-002 Bug 1 regression: sweep must NOT be required to be the current candle —
  // that left MSS's window always empty (nothing in candlesMss is ever timestamped >= "now").
  it('still fires when the sweep candle is one candle behind "now" (price consolidating near the level)', () => {
    const candles5m = [...buildCandles5m(), c(5.0, 5.05, 5.15, 4.9, 25 * FIVE_MIN_MS)];
    const result = detectSweepReversalEntry(buildValidInput({ candles5m }));
    expect(result).not.toBeNull();
    expect(result?.sweptLevel).toBe(5);
  });

  it('TICKET-SCALP-003 Phần B: rejects a setup whose real slDistancePercent is below minSlDistancePercent', () => {
    const result = detectSweepReversalEntry(buildValidInput(), 0.9); // fixture's SL% is well under 90%
    expect(result).toBeNull();
  });

  it('TICKET-SCALP-003 Phần B: passes when real slDistancePercent clears minSlDistancePercent', () => {
    const result = detectSweepReversalEntry(buildValidInput(), 0.5);
    expect(result).not.toBeNull();
  });
});
