import type { Candle } from './types.js';

// Wilder-smoothed ATR. Returns one value per candle from index `period` onward (index-aligned to candles.slice(period)).
export function computeAtr(candles: Candle[], period: number): number[] {
  if (candles.length < period + 1) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)),
    );
  }

  const atrValues: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrValues.push(atr);
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrValues.push(atr);
  }
  return atrValues;
}

// TICKET-RT-065 Part B: incremental ATR tracker — same true-range + Wilder-smoothing algorithm as
// computeAtr() above (verified numerically identical in atr.test.ts, step for step, against a
// growing-prefix computeAtr() call), fed one candle at a time. computeAtr() itself is untouched —
// purely additive, no existing call site needs to change.
export interface AtrTracker {
  // Returns the ATR value once `period` true ranges have been fed (aligned to computeAtr()'s first
  // returned value, candles.slice(period)); null before that (including the very first candle, which
  // only seeds prevClose and produces no true range yet — mirrors computeAtr()'s loop starting at i=1).
  next(candle: Candle): number | null;
}

export function createAtrTracker(period: number): AtrTracker {
  let prevClose: number | null = null;
  const trueRangeSeedBuffer: number[] = [];
  let atr = 0;
  let seeded = false;

  return {
    next(candle: Candle): number | null {
      if (prevClose === null) {
        prevClose = candle.close;
        return null;
      }
      const tr = Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
      prevClose = candle.close;

      if (!seeded) {
        trueRangeSeedBuffer.push(tr);
        if (trueRangeSeedBuffer.length < period) return null;
        atr = trueRangeSeedBuffer.reduce((a, b) => a + b, 0) / period;
        seeded = true;
        return atr;
      }
      atr = (atr * (period - 1) + tr) / period;
      return atr;
    },
  };
}
