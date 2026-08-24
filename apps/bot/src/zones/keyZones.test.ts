import { describe, it, expect } from 'vitest';
import { findKeyZones } from './keyZones.js';
import type { Candle } from '../regime/types.js';

function candle(high: number, low: number): Candle {
  return { openTime: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

// Two swing lows near price ~95 (idx2, idx10), one swing high at 106 (idx6, single touch).
const CANDLES: Candle[] = [
  candle(101, 99),
  candle(99, 97),
  candle(97, 95), // support touch 1 (price 95)
  candle(99, 97),
  candle(101, 99),
  candle(103, 101),
  candle(106, 104), // single resistance touch (price 106)
  candle(103, 101),
  candle(101, 99),
  candle(99, 97),
  candle(97, 95.2), // support touch 2 (price 95.2, close to touch 1)
  candle(99, 97),
  candle(101, 99),
];

const BASE_CONFIG = { swingPivotWidth: 2, clusterToleranceAtrMultiplier: 0.5, minTouches: 2, maxZoneAgeCandles: 5 };

describe('findKeyZones — clustering', () => {
  it('merges two nearby swing lows into one support zone with touchCount=2', () => {
    const zones = findKeyZones(CANDLES, 1, BASE_CONFIG);
    const support = zones.find((z) => z.type === 'support');
    expect(support).toBeDefined();
    expect(support!.touchCount).toBe(2);
    expect(support!.price).toBeCloseTo(95.1, 9); // avg(95, 95.2)
    expect(support!.lastTouchIndex).toBe(10);
  });

  it('drops the resistance zone when its touchCount is below minTouches', () => {
    const zones = findKeyZones(CANDLES, 1, BASE_CONFIG); // minTouches=2, resistance only has 1 touch
    expect(zones.find((z) => z.type === 'resistance')).toBeUndefined();
  });

  it('keeps the single-touch resistance zone when minTouches=1', () => {
    // maxZoneAgeCandles widened too: resistance's lastTouchIndex=6, now=12 -> age=6, exceeds BASE_CONFIG's 5.
    const zones = findKeyZones(CANDLES, 1, { ...BASE_CONFIG, minTouches: 1, maxZoneAgeCandles: 20 });
    const resistance = zones.find((z) => z.type === 'resistance');
    expect(resistance).toBeDefined();
    expect(resistance!.touchCount).toBe(1);
    expect(resistance!.price).toBe(106);
  });
});

describe('findKeyZones — age filter', () => {
  it('drops a zone whose last touch is older than maxZoneAgeCandles', () => {
    // now = 12, support's lastTouchIndex = 10 -> age = 2, which exceeds maxZoneAgeCandles=1.
    const zones = findKeyZones(CANDLES, 1, { ...BASE_CONFIG, maxZoneAgeCandles: 1 });
    expect(zones.find((z) => z.type === 'support')).toBeUndefined();
  });
});

describe('findKeyZones — edge cases', () => {
  it('returns empty array when atrH1 is zero or negative', () => {
    expect(findKeyZones(CANDLES, 0, BASE_CONFIG)).toEqual([]);
    expect(findKeyZones(CANDLES, -1, BASE_CONFIG)).toEqual([]);
  });

  it('returns empty array when there are not enough candles to form any swing point', () => {
    const short = [candle(101, 99), candle(102, 100)];
    expect(findKeyZones(short, 1, BASE_CONFIG)).toEqual([]);
  });

  it('does not cluster two swings whose price gap exceeds tolerance', () => {
    // tolerance = 0.5*1 = 0.5; touches are 0.2 apart in CANDLES (clusters), so widen the gap here.
    const farApart: Candle[] = [
      candle(101, 99),
      candle(99, 97),
      candle(97, 90), // low at 90
      candle(99, 97),
      candle(101, 99),
      candle(103, 101),
      candle(105, 103),
      candle(103, 101),
      candle(101, 99),
      candle(99, 97),
      candle(97, 96), // low at 96, 6 away from 90 -> exceeds tolerance 0.5
      candle(99, 97),
      candle(101, 99),
    ];
    // maxZoneAgeCandles widened: this test is about clustering-by-price, not age.
    const zones = findKeyZones(farApart, 1, { ...BASE_CONFIG, minTouches: 1, maxZoneAgeCandles: 20 });
    const supportZones = zones.filter((z) => z.type === 'support');
    expect(supportZones).toHaveLength(2); // stayed as two separate single-touch zones
  });
});
