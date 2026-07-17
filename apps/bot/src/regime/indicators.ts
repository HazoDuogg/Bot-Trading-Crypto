import type { CandleData } from './types.js';

/**
 * Wilder's method for True Range/ATR/ADX. Bollinger Bandwidth uses standard SMA +
 * population stddev instead (not a Wilder indicator — confirmed with PM).
 * All series functions return arrays the same length as input, NaN where history is insufficient.
 */

export function trueRangeSeries(candles: CandleData[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder's RMA-smoothed Average True Range. */
export function wilderATRSeries(candles: CandleData[], period: number): number[] {
  const n = candles.length;
  const atr = new Array<number>(n).fill(NaN);
  if (n < period) return atr;

  const tr = trueRangeSeries(candles);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  seed /= period;
  atr[period - 1] = seed;

  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/** Wilder's ADX, via smoothed +DM/-DM/TR -> +DI/-DI -> DX -> RMA(DX). */
export function wilderADXSeries(candles: CandleData[], period: number): number[] {
  const n = candles.length;
  const adx = new Array<number>(n).fill(NaN);
  if (n < period * 2) return adx;

  const tr = trueRangeSeries(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const wilderSmooth = (series: number[]): number[] => {
    const out = new Array<number>(n).fill(NaN);
    let seed = 0;
    for (let i = 1; i <= period; i++) seed += series[i]; // series[0] has no prior candle
    out[period] = seed;
    for (let i = period + 1; i < n; i++) {
      out[i] = out[i - 1] - out[i - 1] / period + series[i];
    }
    return out;
  };

  const smoothedTR = wilderSmooth(tr);
  const smoothedPlusDM = wilderSmooth(plusDM);
  const smoothedMinusDM = wilderSmooth(minusDM);

  const dx = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (Number.isNaN(smoothedTR[i]) || smoothedTR[i] === 0) continue;
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  }

  let seedSum = 0;
  let seedCount = 0;
  let seedStartIndex = -1;
  for (let i = period; i < n; i++) {
    if (Number.isNaN(dx[i])) continue;
    if (seedStartIndex === -1) seedStartIndex = i;
    seedSum += dx[i];
    seedCount++;
    if (seedCount === period) break;
  }
  if (seedCount < period) return adx;

  const seedEndIndex = seedStartIndex + period - 1;
  adx[seedEndIndex] = seedSum / period;
  for (let i = seedEndIndex + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return adx;
}

export function smaSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Population standard deviation (divide by N) — matches the common charting-platform convention. */
export function stdDevSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const means = smaSeries(values, period);
  for (let i = period - 1; i < n; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - means[i];
      sumSq += diff * diff;
    }
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

/** Bollinger Bandwidth % = (upper - lower) / middle * 100, upper/lower = middle +/- 2*stdDev. */
export function bollingerBandwidthSeries(candles: CandleData[], period: number): number[] {
  const closes = candles.map((c) => c.close);
  const middle = smaSeries(closes, period);
  const stdDev = stdDevSeries(closes, period);
  return closes.map((_, i) => {
    if (Number.isNaN(middle[i]) || Number.isNaN(stdDev[i]) || middle[i] === 0) return NaN;
    const upper = middle[i] + 2 * stdDev[i];
    const lower = middle[i] - 2 * stdDev[i];
    return ((upper - lower) / middle[i]) * 100;
  });
}

/**
 * Percentile rank of the value at each index against the trailing `lookback` values
 * (window includes the value itself): % of the window at or below that value.
 */
export function percentileRankSeries(values: number[], lookback: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(values[i])) continue;
    const windowStart = i - lookback + 1;
    if (windowStart < 0) continue;
    const window = values.slice(windowStart, i + 1);
    if (window.some((v) => Number.isNaN(v))) continue;
    const countLE = window.filter((v) => v <= values[i]).length;
    out[i] = (countLE / window.length) * 100;
  }
  return out;
}

/** Rolling z-score against the trailing `lookback` values (window includes the value itself). */
export function zScoreSeries(values: number[], lookback: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const windowStart = i - lookback + 1;
    if (windowStart < 0) continue;
    const window = values.slice(windowStart, i + 1);
    if (window.some((v) => Number.isNaN(v))) continue;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const stdDev = Math.sqrt(variance);
    out[i] = stdDev === 0 ? 0 : (values[i] - mean) / stdDev;
  }
  return out;
}

/** Direction of the latest value vs `lookbackN` periods ago. */
export function trendDirection(
  values: number[],
  lookbackN: number,
): 'increasing' | 'decreasing' | 'flat' | undefined {
  const n = values.length;
  if (n <= lookbackN) return undefined;
  const current = values[n - 1];
  const prior = values[n - 1 - lookbackN];
  if (Number.isNaN(current) || Number.isNaN(prior)) return undefined;
  if (current > prior) return 'increasing';
  if (current < prior) return 'decreasing';
  return 'flat';
}

/** Last non-NaN value in a series, or undefined if the series has no computed values yet. */
export function lastDefined(series: number[]): number | undefined {
  for (let i = series.length - 1; i >= 0; i--) {
    if (!Number.isNaN(series[i])) return series[i];
  }
  return undefined;
}
