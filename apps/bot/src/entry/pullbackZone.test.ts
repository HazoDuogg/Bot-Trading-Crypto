import { describe, it, expect } from 'vitest';
import { checkPullbackZone } from './pullbackZone.js';
import type { Candle } from './types.js';

function candle(high: number, low: number): Candle {
  return { openTime: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

// Fall-then-rise -> swing low at index 2 (price 95).
const SWING_LOW_CANDLES: Candle[] = [
  candle(101, 99),
  candle(99, 97),
  candle(97, 95), // trough
  candle(99, 97),
  candle(101, 99),
];

// Rise-then-fall -> swing high at index 2 (price 106).
const SWING_HIGH_CANDLES: Candle[] = [
  candle(101, 99),
  candle(103, 101),
  candle(106, 104), // peak
  candle(103, 101),
  candle(101, 99),
];

describe('checkPullbackZone — LONG uses the most recent M15 swing low', () => {
  it('valid when entry is within tolerance of the swing low', () => {
    const result = checkPullbackZone({
      direction: 'LONG',
      entryPrice: 95.5, // 0.5 away from the swing low at 95
      m15Candles: SWING_LOW_CANDLES,
      swingPivotWidth: 2,
      atrM5: 2, // 0.5/2 = 0.25 <= default-style 0.5 tolerance
      toleranceAtrMultiplier: 0.5,
    });
    expect(result.valid).toBe(true);
    expect(result.nearestZonePrice).toBe(95);
    expect(result.distanceAtr).toBeCloseTo(0.25, 9);
  });

  it('invalid when entry is too far from the swing low, but still reports the zone/distance', () => {
    const result = checkPullbackZone({
      direction: 'LONG',
      entryPrice: 200,
      m15Candles: SWING_LOW_CANDLES,
      swingPivotWidth: 2,
      atrM5: 2,
      toleranceAtrMultiplier: 0.5,
    });
    expect(result.valid).toBe(false);
    expect(result.nearestZonePrice).toBe(95);
    expect(result.distanceAtr).toBeCloseTo(52.5, 9);
  });
});

describe('checkPullbackZone — SHORT uses the most recent M15 swing high', () => {
  it('valid when entry is within tolerance of the swing high', () => {
    const result = checkPullbackZone({
      direction: 'SHORT',
      entryPrice: 106.5,
      m15Candles: SWING_HIGH_CANDLES,
      swingPivotWidth: 2,
      atrM5: 2,
      toleranceAtrMultiplier: 0.5,
    });
    expect(result.valid).toBe(true);
    expect(result.nearestZonePrice).toBe(106);
    expect(result.distanceAtr).toBeCloseTo(0.25, 9);
  });
});

describe('checkPullbackZone — picks most-recent zone, not nearest-by-price', () => {
  it('uses the later swing low even when an earlier one is closer in price to entry', () => {
    // Two swing lows (width=2 needs 2 candles of padding on each side): older one at price 100
    // (closer to entry=101), newer one at price 90 (farther).
    const candles: Candle[] = [
      candle(105, 103),
      candle(103, 101),
      candle(102, 100), // older trough, price 100
      candle(104, 102),
      candle(106, 104),
      candle(104, 102),
      candle(92, 90), // newer trough, price 90
      candle(104, 102),
      candle(105, 103),
    ];
    const result = checkPullbackZone({
      direction: 'LONG',
      entryPrice: 101,
      m15Candles: candles,
      swingPivotWidth: 2,
      atrM5: 20, // wide enough that both would be "valid" by tolerance alone
      toleranceAtrMultiplier: 1,
    });
    expect(result.nearestZonePrice).toBe(90); // the newer trough, not the price-closer 100
  });
});

describe('checkPullbackZone — no relevant swing / invalid atr', () => {
  it('invalid with nulls when there is no swing of the needed type', () => {
    // SWING_HIGH_CANDLES has a high, no low -> LONG direction has nothing to match.
    const result = checkPullbackZone({
      direction: 'LONG',
      entryPrice: 100,
      m15Candles: SWING_HIGH_CANDLES,
      swingPivotWidth: 2,
      atrM5: 2,
      toleranceAtrMultiplier: 0.5,
    });
    expect(result).toEqual({ valid: false, nearestZonePrice: null, distanceAtr: null });
  });

  it('invalid with nulls when atrM5 is zero or negative', () => {
    const result = checkPullbackZone({
      direction: 'LONG',
      entryPrice: 95,
      m15Candles: SWING_LOW_CANDLES,
      swingPivotWidth: 2,
      atrM5: 0,
      toleranceAtrMultiplier: 0.5,
    });
    expect(result).toEqual({ valid: false, nearestZonePrice: null, distanceAtr: null });
  });
});
