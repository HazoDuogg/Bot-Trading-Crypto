import type { Candle } from '../noTradeZone/types.js';
import { calculateEma } from './emaTrendFilter.js';
import { aggregateM15ToClosedH1 } from './h1Aggregator.js';

// Class D — AUDIT ONLY (TICKET-030): independent hypothesis from TICKET-029's EMA50/M15
// audit. Period=200 and timeframe=H1 are preregistered here BEFORE running any PF
// comparison, because EMA200/H1 is the trend foundation already used by the VICION scalp
// system — not chosen by trying periods against this backtest's PF. No other period is
// tried in this ticket, and this result is never compared against TICKET-029's to pick
// "which EMA is better" — each is reported standalone.
export const EMA_TREND_H1_V1_PERIOD = 200;
export const EMA_TREND_H1_V1_SLOPE_LOOKBACK_CANDLES = 10;

export interface EmaTrendSnapshot {
  emaValue: number;
  aboveEma: boolean;
  emaSlopeSign: 1 | -1 | 0;
}

// Evaluates EMA200/H1 trend alignment as of the most recent CLOSED H1 candle strictly
// before triggerIndex (an index into the M15 series). `m15Candles.slice(0, triggerIndex)`
// enforces the causal cut — the M15 trigger candle and anything after it is never read —
// and aggregateM15ToClosedH1() then drops any trailing partial/forming hour on its own, so
// a triggerIndex that falls mid-hour correctly falls back to the prior fully-closed H1
// candle rather than using the one still being built.
export function evaluateEmaTrendH1(
  m15Candles: readonly Candle[],
  triggerIndex: number,
  options?: { period?: number; slopeLookbackCandles?: number },
): EmaTrendSnapshot | null {
  if (!Number.isSafeInteger(triggerIndex)) {
    throw new Error('triggerIndex must be a safe integer');
  }
  if (triggerIndex < 0) return null;
  const period = options?.period ?? EMA_TREND_H1_V1_PERIOD;
  const slopeLookbackCandles = options?.slopeLookbackCandles ?? EMA_TREND_H1_V1_SLOPE_LOOKBACK_CANDLES;
  if (!Number.isSafeInteger(slopeLookbackCandles) || slopeLookbackCandles <= 0) {
    throw new Error('slopeLookbackCandles must be a positive integer');
  }

  const closedH1 = aggregateM15ToClosedH1(m15Candles.slice(0, triggerIndex));
  const asOfIndex = closedH1.length - 1;
  const priorIndex = asOfIndex - slopeLookbackCandles;
  if (asOfIndex < 0 || priorIndex < period - 1) return null;

  const closes = closedH1.map((candle) => candle.close);
  const emaSeries = calculateEma(closes, period);
  const currentEma = emaSeries[asOfIndex];
  const priorEma = emaSeries[priorIndex];
  if (currentEma === null || priorEma === null) return null;

  const slopeDelta = currentEma - priorEma;
  return {
    emaValue: currentEma,
    aboveEma: closedH1[asOfIndex].close > currentEma,
    emaSlopeSign: slopeDelta > 0 ? 1 : slopeDelta < 0 ? -1 : 0,
  };
}
