import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { aggregateM15ToClosedH1 } from './h1Aggregator.js';

const M15_MS = 900_000;
const H1_MS = 3_600_000;

function m15(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

function hourOfFlatCandles(hourStart: number, close: number): Candle[] {
  return Array.from({ length: 4 }, (_, offset) => m15(hourStart + offset * M15_MS, close, close, close, close));
}

describe('aggregateM15ToClosedH1', () => {
  it('aggregates exactly 4 contiguous M15 candles into 1 H1 candle at the hour boundary', () => {
    const candles = [
      m15(0, 100, 105, 95, 102),
      m15(M15_MS, 102, 108, 100, 106),
      m15(2 * M15_MS, 106, 110, 104, 107),
      m15(3 * M15_MS, 107, 109, 103, 108),
    ];

    expect(aggregateM15ToClosedH1(candles)).toEqual([
      { openTime: 0, open: 100, high: 110, low: 95, close: 108, volume: 4 },
    ]);
  });

  it('aggregates several complete hours in sequence', () => {
    const candles = [...hourOfFlatCandles(0, 10), ...hourOfFlatCandles(H1_MS, 20), ...hourOfFlatCandles(2 * H1_MS, 30)];
    const result = aggregateM15ToClosedH1(candles);
    expect(result.map((candle) => candle.openTime)).toEqual([0, H1_MS, 2 * H1_MS]);
    expect(result.map((candle) => candle.close)).toEqual([10, 20, 30]);
  });

  it('drops a trailing partial hour (fewer than 4 children present)', () => {
    const candles = [...hourOfFlatCandles(0, 10), m15(H1_MS, 999, 999, 999, 999), m15(H1_MS + M15_MS, 999, 999, 999, 999)];
    const result = aggregateM15ToClosedH1(candles);
    expect(result).toHaveLength(1);
    expect(result[0].close).toBe(10);
  });

  it('does not emit an H1 candle when the group starts off the hour boundary', () => {
    const misalignedStart = 5 * 60 * 1000; // :05, not a round hour
    const candles = Array.from({ length: 4 }, (_, offset) =>
      m15(misalignedStart + offset * M15_MS, 1, 1, 1, 1),
    );
    expect(aggregateM15ToClosedH1(candles)).toEqual([]);
  });

  it('skips an hour with a gap in its M15 children and still aggregates hours after it', () => {
    const gappedHour = [
      m15(0, 1, 1, 1, 1),
      m15(M15_MS, 1, 1, 1, 1),
      // gap: missing the 3rd child at 2*M15_MS
      m15(3 * M15_MS, 1, 1, 1, 1),
    ];
    const nextHour = hourOfFlatCandles(H1_MS, 50);
    const result = aggregateM15ToClosedH1([...gappedHour, ...nextHour]);
    expect(result).toEqual([{ openTime: H1_MS, open: 50, high: 50, low: 50, close: 50, volume: 4 }]);
  });
});
