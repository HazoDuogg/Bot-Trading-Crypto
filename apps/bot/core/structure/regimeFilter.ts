import type { Candle } from '../../backtest/engine/noTradeZone/types.js';

// TICKET-04X-N: pure regime classifier (RANGING/TRENDING) from M15 ADX. Signal-generation only —
// no TP/SL/PnL anywhere in this file.
export type Regime = 'RANGING' | 'TRENDING';

// CONVENTION: standard Wilder ADX(14) and the common ADX>=25 "trending" threshold — textbook
// defaults, not backtest-tuned. A separate ticket would be needed to calibrate these against data.
export const ADX_PERIOD = 14;
export const ADX_TRENDING_THRESHOLD = 25;

function wilderSmoothedSeries(values: readonly number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let smoothed = values.slice(0, period).reduce((sum, v) => sum + v, 0);
  result[period - 1] = smoothed;
  for (let i = period; i < values.length; i += 1) {
    smoothed = smoothed - smoothed / period + values[i];
    result[i] = smoothed;
  }
  return result;
}

// Standard Wilder ADX: true range and directional movement per candle (index 1..n-1, since each
// needs the previous candle), Wilder-smoothed over `period`, then DX Wilder-smoothed again for ADX.
// Returned array is index-aligned to `candles` (adxSeries[i] corresponds to candles[i]); entries
// before enough warmup history exists are null.
export function computeAdxSeries(candles: readonly Candle[], period = ADX_PERIOD): Array<number | null> {
  const n = candles.length;
  const adxSeries: Array<number | null> = new Array(n).fill(null);
  if (n < 2) return adxSeries;

  const trueRanges: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    trueRanges.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDms.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothedTr = wilderSmoothedSeries(trueRanges, period);
  const smoothedPlusDm = wilderSmoothedSeries(plusDms, period);
  const smoothedMinusDm = wilderSmoothedSeries(minusDms, period);

  // dx[k] corresponds to trueRanges[k], i.e. candles[k+1].
  const dx: Array<number | null> = new Array(trueRanges.length).fill(null);
  for (let k = 0; k < trueRanges.length; k += 1) {
    const tr = smoothedTr[k];
    const plusDm = smoothedPlusDm[k];
    const minusDm = smoothedMinusDm[k];
    if (tr === null || plusDm === null || minusDm === null || tr === 0) continue;
    const plusDi = (100 * plusDm) / tr;
    const minusDi = (100 * minusDm) / tr;
    const diSum = plusDi + minusDi;
    dx[k] = diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum;
  }

  // ADX seeds as a simple average of the first `period` valid DX values, then Wilder-smooths.
  const firstValidDx = dx.findIndex((v) => v !== null);
  if (firstValidDx === -1 || firstValidDx + period > dx.length) return adxSeries;
  const seedWindow = dx.slice(firstValidDx, firstValidDx + period) as number[];
  let adx = seedWindow.reduce((sum, v) => sum + v, 0) / period;
  adxSeries[firstValidDx + period] = adx; // dx[k] -> candles[k+1], so dx index (firstValidDx+period-1) -> candle (firstValidDx+period)
  for (let k = firstValidDx + period; k < dx.length; k += 1) {
    const value = dx[k];
    if (value === null) break;
    adx = (adx * (period - 1) + value) / period;
    adxSeries[k + 1] = adx;
  }
  return adxSeries;
}

export function classifyRegime(adx: number, threshold = ADX_TRENDING_THRESHOLD): Regime {
  return adx >= threshold ? 'TRENDING' : 'RANGING';
}
