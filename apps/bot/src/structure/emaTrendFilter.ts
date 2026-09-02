import type { Candle } from '../noTradeZone/types.js';

// Class D — AUDIT ONLY (TICKET-029): measurement, not an active filter. Both constants are
// preregistered BEFORE running any PF/netR comparison and are never swept to find a
// "best" value — EMA has no data-geometry-derived threshold the way D4/D5's percentile
// cuts do, so trying multiple periods and keeping the best-looking one would be outcome-based
// tuning. EMA50 on M15 (~12.5h) is a common convention, chosen for being well beyond the
// D1-D8 horizons already in use (D1 swing window=20, D4/D5 windows=20) so it measures a
// different timescale rather than restating existing D1-D8 information. Trying a different
// period is a separate, independent hypothesis and belongs in its own ticket — never a
// cross-period comparison to cherry-pick the best PF.
export const EMA_TREND_V1_PERIOD = 50;
export const EMA_TREND_V1_SLOPE_LOOKBACK_CANDLES = 10;

export interface EmaTrendSnapshot {
  emaValue: number;
  aboveEma: boolean;
  emaSlopeSign: 1 | -1 | 0;
}

// Standard EMA: seeded with the SMA of the first `period` values, then the usual recursive
// smoothing for the rest. Entries before the seed index are `null` (insufficient history).
export function calculateEma(values: readonly number[], period: number): Array<number | null> {
  if (!Number.isSafeInteger(period) || period <= 0) {
    throw new Error('period must be a positive integer');
  }
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const k = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * k + previous * (1 - k);
    result[index] = previous;
  }
  return result;
}

// Evaluates trend alignment as of the candle immediately BEFORE triggerIndex — the trigger
// candle itself, and everything after it, is never read. This mirrors the causal boundary
// locked in TICKET-024/026 (pre-signal evidence only).
export function evaluateEmaTrend(
  candles: readonly Candle[],
  triggerIndex: number,
  options?: { period?: number; slopeLookbackCandles?: number },
): EmaTrendSnapshot | null {
  if (!Number.isSafeInteger(triggerIndex)) {
    throw new Error('triggerIndex must be a safe integer');
  }
  const asOfIndex = triggerIndex - 1;
  if (asOfIndex < 0) return null;
  const period = options?.period ?? EMA_TREND_V1_PERIOD;
  const slopeLookbackCandles = options?.slopeLookbackCandles ?? EMA_TREND_V1_SLOPE_LOOKBACK_CANDLES;
  if (!Number.isSafeInteger(slopeLookbackCandles) || slopeLookbackCandles <= 0) {
    throw new Error('slopeLookbackCandles must be a positive integer');
  }

  const priorIndex = asOfIndex - slopeLookbackCandles;
  if (priorIndex < period - 1) return null;

  // Only candles strictly before triggerIndex ever enter this computation.
  const closes = candles.slice(0, asOfIndex + 1).map((candle) => candle.close);
  const emaSeries = calculateEma(closes, period);
  const currentEma = emaSeries[asOfIndex];
  const priorEma = emaSeries[priorIndex];
  if (currentEma === null || priorEma === null) return null;

  const slopeDelta = currentEma - priorEma;
  return {
    emaValue: currentEma,
    aboveEma: candles[asOfIndex].close > currentEma,
    emaSlopeSign: slopeDelta > 0 ? 1 : slopeDelta < 0 ? -1 : 0,
  };
}
