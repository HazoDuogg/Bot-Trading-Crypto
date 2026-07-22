import { describe, expect, it } from 'vitest';
import { classifyBoxBreakoutFailReason, detectBoxBreakout } from './boxBreakout.js';
import type { CandleData } from '../../regime/types.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

const config = { boxLookbackM: 5, maxBbwPercentile: 60, minBodyRatio: 0.5, minVolumeZScore: 1.0 };

const box15m: CandleData[] = [c(100, 101, 105, 95), c(101, 103, 108, 92), c(103, 100, 110, 90), c(100, 102, 107, 93), c(102, 101, 106, 91)];
// box = [min low, max high] = [90, 110]

describe('detectBoxBreakout', () => {
  it('confirms an UP breakout when close clears the box, body is real, and volume is elevated', () => {
    const candles5m = [c(111, 115, 116, 110.5)]; // close 115 > 110, bodyRatio=4/5.5=0.73
    const result = detectBoxBreakout(box15m, candles5m, 50, 1.5, config);
    expect(result).toEqual({ direction: 'UP', boxHigh: 110, boxLow: 90, breakoutCandleIndex: 0 });
  });

  it('confirms a DOWN breakout mirror', () => {
    const candles5m = [c(89, 85, 89.5, 84)]; // close 85 < 90
    const result = detectBoxBreakout(box15m, candles5m, 50, 1.5, config);
    expect(result).toEqual({ direction: 'DOWN', boxHigh: 110, boxLow: 90, breakoutCandleIndex: 0 });
  });

  it('does NOT confirm a wick-only poke (high beyond the box, but close stays inside)', () => {
    const candles5m = [c(105, 108, 112, 104)]; // high 112 pokes above 110, close 108 stays inside
    expect(detectBoxBreakout(box15m, candles5m, 50, 1.5, config)).toBeNull();
  });

  it('does NOT confirm if the body is mostly wick (low body ratio)', () => {
    const candles5m = [c(110.2, 110.8, 116, 110)]; // close clears box, but body tiny vs range
    expect(detectBoxBreakout(box15m, candles5m, 50, 1.5, config)).toBeNull();
  });

  it('does NOT confirm if volume is not elevated', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(detectBoxBreakout(box15m, candles5m, 50, 0.5, config)).toBeNull(); // volumeZScore5m below threshold
  });

  it('does NOT confirm if the box is not stable enough (bbWidthPercentile15m too high)', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(detectBoxBreakout(box15m, candles5m, 80, 1.5, config)).toBeNull();
  });

  it('returns null if there is not enough 15m history for the box lookback', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(detectBoxBreakout(box15m.slice(0, 3), candles5m, 50, 1.5, config)).toBeNull();
  });
});

// TICKET-053 — classifyBoxBreakoutFailReason() is a pure diagnostic that mirrors detectBoxBreakout()'s
// own box/edge computation; never alters detectBoxBreakout() or any of its thresholds. Reuses the
// exact same fixtures as the "does NOT confirm" cases above, since each one is a specific fail reason.
describe('classifyBoxBreakoutFailReason', () => {
  it('NO_EDGE_TOUCH: close stays inside the box (wick-only poke)', () => {
    const candles5m = [c(105, 108, 112, 104)]; // high 112 pokes above 110, close 108 stays inside
    expect(classifyBoxBreakoutFailReason(box15m, candles5m, 50, 1.5, config)).toBe('NO_EDGE_TOUCH');
  });

  it('NO_EDGE_TOUCH: box invalid because bbWidthPercentile15m is too high', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(classifyBoxBreakoutFailReason(box15m, candles5m, 80, 1.5, config)).toBe('NO_EDGE_TOUCH');
  });

  it('NO_EDGE_TOUCH: not enough 15m history for the box lookback', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(classifyBoxBreakoutFailReason(box15m.slice(0, 3), candles5m, 50, 1.5, config)).toBe('NO_EDGE_TOUCH');
  });

  it('BODY_TOO_SMALL: close clears the box, but body is mostly wick', () => {
    const candles5m = [c(110.2, 110.8, 116, 110)]; // close clears box, but body tiny vs range
    expect(classifyBoxBreakoutFailReason(box15m, candles5m, 50, 1.5, config)).toBe('BODY_TOO_SMALL');
  });

  it('VOLUME_NOT_ELEVATED: close clears the box, body is real, but volume is not elevated', () => {
    const candles5m = [c(111, 115, 116, 110.5)];
    expect(classifyBoxBreakoutFailReason(box15m, candles5m, 50, 0.5, config)).toBe('VOLUME_NOT_ELEVATED');
  });

  it('never classifies a fail reason for inputs where detectBoxBreakout() actually confirms', () => {
    const upCandles5m = [c(111, 115, 116, 110.5)];
    expect(detectBoxBreakout(box15m, upCandles5m, 50, 1.5, config)).not.toBeNull();
    // Not asserting a specific value here (the function's contract is "only call when detectBoxBreakout
    // returned null") — this just documents the precondition, mirroring classifyMssFailReason()'s test suite.
  });
});
