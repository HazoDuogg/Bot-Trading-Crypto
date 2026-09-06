import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAdxSeries, classifyRegime, type Regime } from '../structure/regimeFilter.js';

// TICKET-04X-N: pure z-score mean-reversion signal generator. Signal-generation only — no
// TP/SL/PnL anywhere in this file (that's a separate, later ticket).
export type Signal = 'LONG' | 'SHORT' | 'NONE';

// CONVENTION: N=20 lookback matches this project's established convention (TICKET-04X-C/04X-F);
// entry threshold |z|>=2 is the standard mean-reversion z-score convention. Neither is backtest-tuned.
export const ZSCORE_LOOKBACK = 20;
export const ZSCORE_ENTRY_THRESHOLD = 2;

export interface MeanReversionResult {
  regime: Regime | null;
  zScore: number | null;
  signal: Signal;
  // TICKET-04X-O: the exact mean/std of the same 20-candle window the z-score above was computed
  // from — exposed so a consumer (e.g. an SL-distance comparison) reuses them rather than
  // re-deriving a second, possibly-diverging copy. Non-null whenever zScore is non-null.
  windowMean: number | null;
  windowStd: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Population std (same convention as TICKET-04X-F): a descriptive statistic over the fixed,
// fully-known lookback window, not an estimate of a larger population.
function populationStd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

export function computeWindowStats(
  m5Closes: readonly number[],
  index: number,
  lookback = ZSCORE_LOOKBACK,
): { mean: number; std: number } | null {
  if (index < lookback) return null;
  const window = m5Closes.slice(index - lookback, index);
  return { mean: mean(window), std: populationStd(window) };
}

// z-score at 5m candle i uses ONLY the ZSCORE_LOOKBACK candles strictly before it (closes[i-20..
// i-1]), never candle i itself — avoids self-inclusion bias and matches this project's established
// "candles before entry" causal convention. Requires i >= ZSCORE_LOOKBACK; the first
// ZSCORE_LOOKBACK candles (indices 0..19) are warmup and produce signal 'NONE'.
export function computeZScore(m5Closes: readonly number[], index: number, lookback = ZSCORE_LOOKBACK): number | null {
  const stats = computeWindowStats(m5Closes, index, lookback);
  if (stats === null || stats.std === 0) return null;
  return (m5Closes[index] - stats.mean) / stats.std;
}

export function classifyMeanReversionSignal(
  regime: Regime | null,
  zScore: number | null,
  threshold = ZSCORE_ENTRY_THRESHOLD,
): Signal {
  if (regime !== 'RANGING' || zScore === null) return 'NONE';
  if (zScore <= -threshold) return 'LONG';
  if (zScore >= threshold) return 'SHORT';
  return 'NONE';
}

// Maps each 5m candle to the most recently CLOSED 15m candle strictly before its own close time
// (causal — never a 15m candle still forming as of the 5m close), then derives that 15m's regime.
export function computeMeanReversionSignals(
  m15Candles: readonly Candle[],
  m5Candles: readonly Candle[],
  m15DurationMs: number,
  m5DurationMs: number,
): MeanReversionResult[] {
  const adxSeries = computeAdxSeries(m15Candles);
  const m5Closes = m5Candles.map((c) => c.close);

  const results: MeanReversionResult[] = new Array(m5Candles.length);
  let m15Cursor = 0;
  let latestClosedAdx: number | null = null;

  for (let i = 0; i < m5Candles.length; i += 1) {
    const m5CloseTime = m5Candles[i].openTime + m5DurationMs;
    while (m15Cursor < m15Candles.length && m15Candles[m15Cursor].openTime + m15DurationMs <= m5CloseTime) {
      latestClosedAdx = adxSeries[m15Cursor];
      m15Cursor += 1;
    }
    const regime = latestClosedAdx === null ? null : classifyRegime(latestClosedAdx);
    const stats = computeWindowStats(m5Closes, i);
    const zScore = stats === null || stats.std === 0 ? null : (m5Closes[i] - stats.mean) / stats.std;
    results[i] = {
      regime,
      zScore,
      signal: classifyMeanReversionSignal(regime, zScore),
      windowMean: stats?.mean ?? null,
      windowStd: stats?.std ?? null,
    };
  }
  return results;
}
