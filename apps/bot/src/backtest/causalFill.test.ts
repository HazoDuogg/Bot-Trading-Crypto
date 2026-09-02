import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { findCausalM1Fill } from './causalFill.js';

const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;

function candle(openTime: number, low: number, high: number): Candle {
  return { openTime, open: 100, high, low, close: 100, volume: 1 };
}

describe('findCausalM1Fill', () => {
  it('ignores touches before order activation and selects the first touch inside the confirmed M15 fill candle', () => {
    const m15Candles = Array.from({ length: 4 }, (_, index) =>
      candle(index * M15_MS, index === 2 ? 99 : 101, 105),
    );
    const orderActiveTime = 2 * M15_MS;
    const m1Candles = [
      candle(orderActiveTime - M1_MS, 99, 101),
      candle(orderActiveTime, 101, 103),
      candle(orderActiveTime + M1_MS, 99, 102),
      candle(orderActiveTime + 2 * M1_MS, 98, 102),
      candle(orderActiveTime + M15_MS, 99, 101),
    ];

    expect(
      findCausalM1Fill({
        m15Candles,
        m1Candles,
        triggerIndex: 1,
        fillIndex: 2,
        limitPrice: 100,
      }),
    ).toEqual({
      signalTime: orderActiveTime,
      orderActiveTime,
      firstTouchFillTimestamp: orderActiveTime + M1_MS,
      firstTouchFillPrice: 100,
    });
  });
});
