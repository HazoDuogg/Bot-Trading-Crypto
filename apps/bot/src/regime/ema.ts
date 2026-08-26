import type { Candle } from './types.js';

// Standard EMA: seed = SMA of first `period` closes, then smoothed forward. Returns one value per candle from index period-1 onward.
export function computeEma(candles: Candle[], period: number): number[] {
  if (candles.length < period) return [];

  const closes = candles.map((c) => c.close);
  const k = 2 / (period + 1);
  const emaValues: number[] = [];

  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaValues.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emaValues.push(ema);
  }
  return emaValues; // emaValues[j] aligns with candles[j + period - 1]
}

// TICKET-RT-065 Part B: incremental EMA tracker — same seed-then-forward algorithm as computeEma()
// above (verified numerically identical in ema.test.ts, step for step, against a growing-prefix
// computeEma() call), but fed ONE close at a time so a caller walking forward candle-by-candle over
// a growing window (a backtest) never has to re-scan the whole window from scratch on every step.
// computeEma() itself is untouched — this is purely additive, no existing call site needs to change.
export interface EmaTracker {
  // Returns the EMA value once `period` closes have been fed (aligned to the period-th call, same
  // as computeEma()'s first returned value aligning to candles[period-1]); null before that.
  next(close: number): number | null;
}

export function createEmaTracker(period: number): EmaTracker {
  const k = 2 / (period + 1);
  const seedBuffer: number[] = [];
  let ema = 0;
  let seeded = false;

  return {
    next(close: number): number | null {
      if (!seeded) {
        seedBuffer.push(close);
        if (seedBuffer.length < period) return null;
        ema = seedBuffer.reduce((a, b) => a + b, 0) / period;
        seeded = true;
        return ema;
      }
      ema = close * k + ema * (1 - k);
      return ema;
    },
  };
}
