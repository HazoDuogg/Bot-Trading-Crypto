import { describe, it, expect } from 'vitest';
import { detectFvg } from './fvg.js';
import type { Candle } from './types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, open, high, low, close, volume: 100 };
}

const CONFIG = { minCandle2BodyRatio: 0.6 };

describe('detectFvg — bullish', () => {
  it('detects a bullish FVG: gap up, strong bullish candle2, correct SL/gap prices', () => {
    const candle1 = candle(100, 102, 98, 101); // wick low at 98
    const candle2 = candle(101, 110, 100.5, 109.5); // strong bullish body
    const candle3 = candle(111, 115, 103, 114); // low(103) > candle1.high(102) -> gap

    const result = detectFvg(candle1, candle2, candle3, CONFIG);
    expect(result.isFvg).toBe(true);
    expect(result.direction).toBe('LONG');
    expect(result.gapLow).toBe(102); // candle1.high
    expect(result.gapHigh).toBe(103); // candle3.low
    expect(result.invalidationPrice).toBe(98); // candle1.low
  });

  it('rejects when there is no gap (candle3.low <= candle1.high)', () => {
    const candle1 = candle(100, 102, 98, 101);
    const candle2 = candle(101, 110, 100.5, 109.5);
    const candle3 = candle(111, 115, 101, 114); // low(101) <= candle1.high(102)
    expect(detectFvg(candle1, candle2, candle3, CONFIG).isFvg).toBe(false);
  });

  it('rejects when candle2 body/range ratio is below the threshold', () => {
    const candle1 = candle(100, 102, 98, 101);
    const candle2 = candle(101, 110, 95, 102); // wide range, tiny body -> low ratio
    const candle3 = candle(111, 115, 103, 114);
    expect(detectFvg(candle1, candle2, candle3, CONFIG).isFvg).toBe(false);
  });

  it('rejects when candle2 is bearish despite an apparent bullish gap shape', () => {
    const candle1 = candle(100, 102, 98, 101);
    const candle2 = candle(109.5, 110, 100.5, 101); // bearish body (close < open)
    const candle3 = candle(111, 115, 103, 114);
    expect(detectFvg(candle1, candle2, candle3, CONFIG).isFvg).toBe(false);
  });
});

describe('detectFvg — bearish', () => {
  it('detects a bearish FVG: gap down, strong bearish candle2, correct SL/gap prices', () => {
    const candle1 = candle(100, 102, 98, 99); // wick high at 102
    const candle2 = candle(99, 99.5, 90, 90.5); // strong bearish body
    const candle3 = candle(89, 97, 85, 86); // high(97) < candle1.low(98) -> gap

    const result = detectFvg(candle1, candle2, candle3, CONFIG);
    expect(result.isFvg).toBe(true);
    expect(result.direction).toBe('SHORT');
    expect(result.gapLow).toBe(97); // candle3.high
    expect(result.gapHigh).toBe(98); // candle1.low
    expect(result.invalidationPrice).toBe(102); // candle1.high
  });

  it('rejects when there is no gap (candle3.high >= candle1.low)', () => {
    const candle1 = candle(100, 102, 98, 99);
    const candle2 = candle(99, 99.5, 90, 90.5);
    const candle3 = candle(89, 98, 85, 86); // high(98) >= candle1.low(98)
    expect(detectFvg(candle1, candle2, candle3, CONFIG).isFvg).toBe(false);
  });
});

describe('detectFvg — edge cases', () => {
  it('returns isFvg:false without throwing when candle2 has zero range', () => {
    const candle1 = candle(100, 102, 98, 101);
    const candle2 = candle(100, 100, 100, 100);
    const candle3 = candle(111, 115, 103, 114);
    expect(detectFvg(candle1, candle2, candle3, CONFIG).isFvg).toBe(false);
  });
});
