import { describe, it, expect } from 'vitest';
import { detectBreakout } from './breakout.js';
import type { Candle } from './types.js';

function candle(high: number, low: number, close: number, volume = 100): Candle {
  return { openTime: 0, open: close, high, low, close, volume };
}

// Fall-then-rise (support=95) then rise-then-fall (resistance=106) — a clean range.
const RANGE_CANDLES: Candle[] = [
  candle(101, 99, 100),
  candle(99, 97, 98),
  candle(97, 95, 96), // trough -> support 95
  candle(99, 97, 98),
  candle(101, 99, 100),
  candle(103, 101, 102),
  candle(106, 104, 105), // peak -> resistance 106
  candle(103, 101, 102),
  candle(101, 99, 100),
];

// Steep monotonic decline, never reversing — a strictly monotonic run can't form a new interior
// swing low (every later point is lower, so no point's window neighbors are all >= it). The step
// must be steep enough that it drops below RANGE_CANDLES' tail low (99) within the first couple of
// candles, otherwise the tail itself briefly looks like a local min before the decline "catches up".
function buildFiller(n: number, startPrice: number): Candle[] {
  const filler: Candle[] = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    p -= 3;
    filler.push(candle(p + 0.5, p - 0.5, p, 100));
  }
  return filler;
}

const CONFIG = { volumeSpikeMultiplier: 1.5, volumeLookback: 5 };

describe('detectBreakout — LONG', () => {
  it('confirms breakout: M15 close beyond resistance + volume spike', () => {
    const filler = buildFiller(5, 100);
    const breakoutCandle = candle(112, 108, 110, 400); // close 110 > resistance 106, volume 400 vs ~100 avg
    const candles = [...RANGE_CANDLES, ...filler, breakoutCandle];

    const result = detectBreakout({
      direction: 'LONG',
      m15Candles: candles,
      swingPivotWidth: 2,
      ...CONFIG,
    });

    expect(result.isBreakout).toBe(true);
    expect(result.brokenLevel).toBe(106);
    expect(result.rangeHeight).toBeCloseTo(11, 9); // |106 - 95|
    expect(result.volumeRatio).toBeCloseTo(4, 9); // 400 / 100
  });

  it('rejects when price breaks out but volume does not spike', () => {
    const filler = buildFiller(5, 100);
    const weakVolumeBreak = candle(112, 108, 110, 120); // close breaks out, volume only 1.2x avg
    const candles = [...RANGE_CANDLES, ...filler, weakVolumeBreak];

    const result = detectBreakout({
      direction: 'LONG',
      m15Candles: candles,
      swingPivotWidth: 2,
      ...CONFIG,
    });

    expect(result.isBreakout).toBe(false);
    expect(result.brokenLevel).toBe(106); // still reported, even though not confirmed
  });

  it('rejects when volume spikes but price does not clear resistance', () => {
    const filler = buildFiller(5, 100);
    const noBreak = candle(104, 100, 102, 400); // close 102 stays under resistance 106
    const candles = [...RANGE_CANDLES, ...filler, noBreak];

    const result = detectBreakout({
      direction: 'LONG',
      m15Candles: candles,
      swingPivotWidth: 2,
      ...CONFIG,
    });

    expect(result.isBreakout).toBe(false);
  });
});

describe('detectBreakout — SHORT', () => {
  it('confirms breakout: M15 close beyond support + volume spike', () => {
    const filler = buildFiller(5, 100);
    const breakoutCandle = candle(92, 88, 90, 400); // close 90 < support 95
    const candles = [...RANGE_CANDLES, ...filler, breakoutCandle];

    const result = detectBreakout({
      direction: 'SHORT',
      m15Candles: candles,
      swingPivotWidth: 2,
      ...CONFIG,
    });

    expect(result.isBreakout).toBe(true);
    expect(result.brokenLevel).toBe(95);
    expect(result.rangeHeight).toBeCloseTo(11, 9);
  });
});

describe('detectBreakout — insufficient structure/data, no throw', () => {
  it('returns isBreakout:false with all nulls when there are not enough candles to form a range', () => {
    const candles = [candle(101, 99, 100), candle(102, 100, 101)];
    const result = detectBreakout({
      direction: 'LONG',
      m15Candles: candles,
      swingPivotWidth: 2,
      ...CONFIG,
    });
    expect(result).toEqual({ isBreakout: false, brokenLevel: null, rangeHeight: null, volumeRatio: null });
  });

  it('returns volumeRatio:null (and isBreakout:false) when there are not enough candles for volumeLookback', () => {
    const breakoutCandle = candle(112, 108, 110, 400);
    const candles = [...RANGE_CANDLES, breakoutCandle]; // 10 candles total, fewer than volumeLookback=20 needs
    const result = detectBreakout({
      direction: 'LONG',
      m15Candles: candles,
      swingPivotWidth: 2,
      volumeSpikeMultiplier: CONFIG.volumeSpikeMultiplier,
      volumeLookback: 20,
    });
    expect(result.volumeRatio).toBeNull();
    expect(result.isBreakout).toBe(false);
    expect(result.brokenLevel).toBe(106); // range is still reported
  });
});
