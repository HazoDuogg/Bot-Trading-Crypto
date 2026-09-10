import type { Candle, RegimeState } from "../core/types.js";

/**
 * ADX/+DI/-DI (Wilder) — a comparison metric only, not the official regime
 * detector. Formula ported unchanged from the manually-verified version in
 * tests/regime/regimeTest.ts (TICKET-04X), used here as an independent
 * cross-check against the HMM's UPTREND/DOWNTREND labels.
 */
export interface AdxDiSeries {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

function calculateTR(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function wilderSmooth(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period) {
      const sum = data.slice(0, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / (i + 1));
    } else {
      result.push((result[i - 1] * (period - 1) + data[i]) / period);
    }
  }
  return result;
}

export function computeAdxDi(candles: Candle[], period = 14): AdxDiSeries {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);

  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const hDiff = high[i] - high[i - 1];
    const lDiff = low[i - 1] - low[i];
    tr.push(calculateTR(high[i], low[i], close[i - 1]));
    plusDM.push(hDiff > lDiff && hDiff > 0 ? hDiff : 0);
    minusDM.push(lDiff > hDiff && lDiff > 0 ? lDiff : 0);
  }

  const trSmooth = wilderSmooth(tr, period);
  const plusSmooth = wilderSmooth(plusDM, period);
  const minusSmooth = wilderSmooth(minusDM, period);

  const plusDI = plusSmooth.map((p, i) => (trSmooth[i] > 0 ? (p / trSmooth[i]) * 100 : 0));
  const minusDI = minusSmooth.map((m, i) => (trSmooth[i] > 0 ? (m / trSmooth[i]) * 100 : 0));

  const dx: number[] = [];
  for (let i = 0; i < plusDI.length; i++) {
    const sum = plusDI[i] + minusDI[i];
    dx.push(sum > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0);
  }
  const adx = wilderSmooth(dx, period);

  const pad = candles.length - adx.length;
  return {
    adx: [...Array(pad).fill(0), ...adx],
    plusDI: [...Array(pad).fill(0), ...plusDI],
    minusDI: [...Array(pad).fill(0), ...minusDI],
  };
}

export interface RegimeLabel {
  openTime: number;
  state: RegimeState;
}

export interface AdxDiComparisonResult {
  uptrend: { total: number; matches: number; pct: number };
  downtrend: { total: number; matches: number; pct: number };
  overall: { total: number; matches: number; pct: number };
}

/**
 * % of UPTREND/DOWNTREND-labeled bars where ADX>=threshold and +DI/-DI
 * agree with the label's direction. candles and labels must align 1:1 by
 * index (same openTime), as produced by the walk-forward script.
 */
export function compareLabelsToAdxDi(
  candles: Candle[],
  labels: RegimeLabel[],
  adxThreshold = 25,
): AdxDiComparisonResult {
  const { adx, plusDI, minusDI } = computeAdxDi(candles);

  let upTotal = 0;
  let upMatch = 0;
  let downTotal = 0;
  let downMatch = 0;

  for (let i = 0; i < labels.length; i++) {
    if (candles[i].openTime !== labels[i].openTime) {
      throw new Error(`candle/label misalignment at index ${i}`);
    }
    const state = labels[i].state;
    if (state === "UPTREND") {
      upTotal++;
      if (adx[i] >= adxThreshold && plusDI[i] > minusDI[i]) upMatch++;
    } else if (state === "DOWNTREND") {
      downTotal++;
      if (adx[i] >= adxThreshold && minusDI[i] > plusDI[i]) downMatch++;
    }
  }

  const overall = { total: upTotal + downTotal, matches: upMatch + downMatch, pct: 0 };
  overall.pct = overall.total > 0 ? (overall.matches / overall.total) * 100 : 0;

  return {
    uptrend: { total: upTotal, matches: upMatch, pct: upTotal > 0 ? (upMatch / upTotal) * 100 : 0 },
    downtrend: { total: downTotal, matches: downMatch, pct: downTotal > 0 ? (downMatch / downTotal) * 100 : 0 },
    overall,
  };
}
