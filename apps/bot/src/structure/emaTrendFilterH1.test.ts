import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { evaluateEmaTrendH1 } from './emaTrendFilterH1.js';

const M15_MS = 900_000;
const H1_MS = 3_600_000;

function m15(openTime: number, close: number): Candle {
  return { openTime, open: close, high: close, low: close, close, volume: 1 };
}

function buildHours(hourCloses: readonly number[]): Candle[] {
  return hourCloses.flatMap((close, hourIndex) =>
    Array.from({ length: 4 }, (_, offset) => m15(hourIndex * H1_MS + offset * M15_MS, close)),
  );
}

describe('evaluateEmaTrendH1', () => {
  it('matches calculateEma on the aggregated H1 close series (period=3, lookback=2, known ramp)', () => {
    // 10 complete H1 candles with closes 1..10. calculateEma([1..10], 3) is the known
    // ramp result from emaTrendFilter.test.ts: [null,null,2,3,4,5,6,7,8,9].
    const m15Candles = buildHours([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const triggerIndex = m15Candles.length; // one M15 candle past the last closed hour

    const result = evaluateEmaTrendH1(m15Candles, triggerIndex, { period: 3, slopeLookbackCandles: 2 });

    expect(result).not.toBeNull();
    expect(result!.emaValue).toBeCloseTo(9); // ema at the 10th (last) H1 candle, index 9
    expect(result!.aboveEma).toBe(true); // H1 close=10 > ema=9
    expect(result!.emaSlopeSign).toBe(1); // ema[9]=9 > ema[7]=7
  });

  it('is causal: a triggerIndex mid-hour uses only the prior closed H1 candles, never the forming hour', () => {
    const closedHours = buildHours([1, 2, 3, 4, 5]); // 20 M15 candles, 5 closed H1 candles
    const formingHour = Array.from({ length: 4 }, (_, offset) => m15(5 * H1_MS + offset * M15_MS, 999));
    const withForming = [...closedHours, ...formingHour];

    const atHourBoundary = evaluateEmaTrendH1(closedHours, closedHours.length, {
      period: 3,
      slopeLookbackCandles: 1,
    });
    // triggerIndex=21: 1 M15 candle into the forming 6th hour (analogous to "minute 15 of
    // the hour" in the ticket's example) — the forming hour has only 1 of its 4 children,
    // so it must be dropped entirely, falling back to the same 5 closed hours as above.
    const midForming = evaluateEmaTrendH1(withForming, closedHours.length + 1, {
      period: 3,
      slopeLookbackCandles: 1,
    });

    expect(atHourBoundary).not.toBeNull();
    expect(midForming).toEqual(atHourBoundary);
  });

  it('never reads M15 candles at or after triggerIndex, even when they resolve to a full closed hour', () => {
    const closedHours = buildHours([1, 2, 3, 4, 5]);
    const baseline = evaluateEmaTrendH1(closedHours, closedHours.length, {
      period: 3,
      slopeLookbackCandles: 1,
    });

    const extraCompleteHour = [...closedHours, ...buildHours([999]).map((c) => ({ ...c, openTime: c.openTime + 5 * H1_MS }))];
    const stillTriggeringBeforeIt = evaluateEmaTrendH1(extraCompleteHour, closedHours.length, {
      period: 3,
      slopeLookbackCandles: 1,
    });

    expect(stillTriggeringBeforeIt).toEqual(baseline);
  });

  it('returns null when there are not enough closed H1 candles for the period', () => {
    const shortHistory = buildHours([1, 2, 3]);
    expect(
      evaluateEmaTrendH1(shortHistory, shortHistory.length, { period: 200, slopeLookbackCandles: 10 }),
    ).toBeNull();
  });

  it('uses the preregistered EMA200/H1 defaults when no options are given', () => {
    expect(evaluateEmaTrendH1(buildHours([1, 2, 3]), 12)).toBeNull();
  });
});
