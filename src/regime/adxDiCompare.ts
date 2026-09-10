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
  atr: number[];
}

export function calculateTR(high: number, low: number, prevClose: number): number {
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
    atr: [...Array(pad).fill(0), ...trSmooth], // ATR14 = Wilder-smoothed true range, already computed above
  };
}

export interface RegimeLabel {
  openTime: number;
  state: RegimeState;
}

interface DirectionBreakdown {
  total: number;
  bothMatch: { count: number; pct: number }; // ADX>=threshold AND DI direction agrees (original 23.7% metric)
  adxOver25: { count: number; pct: number }; // ADX>=threshold, regardless of DI direction
  diCorrectGivenAdxOver25: { count: number; pct: number }; // of the adxOver25 group, DI direction agrees
  diCorrectPure: { count: number; pct: number }; // DI direction agrees, ADX ignored entirely (decision metric)
}

export interface AdxDiComparisonResult {
  uptrend: DirectionBreakdown;
  downtrend: DirectionBreakdown;
  overall: { total: number; bothMatch: { count: number; pct: number }; diCorrectPure: { count: number; pct: number } };
}

function pct(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function makeBreakdown(total: number, bothMatch: number, adxOver25: number, diCorrectOverAdxOver25: number, diCorrectPure: number): DirectionBreakdown {
  return {
    total,
    bothMatch: { count: bothMatch, pct: pct(bothMatch, total) },
    adxOver25: { count: adxOver25, pct: pct(adxOver25, total) },
    diCorrectGivenAdxOver25: { count: diCorrectOverAdxOver25, pct: pct(diCorrectOverAdxOver25, adxOver25) },
    diCorrectPure: { count: diCorrectPure, pct: pct(diCorrectPure, total) },
  };
}

/**
 * % of UPTREND/DOWNTREND-labeled bars where ADX>=threshold and +DI/-DI
 * agree with the label's direction, split into components so a low
 * bothMatch rate can be attributed to the ADX filter vs. wrong DI
 * direction. candles and labels must align 1:1 by index (same openTime).
 */
export function compareLabelsToAdxDi(
  candles: Candle[],
  labels: RegimeLabel[],
  adxThreshold = 25,
): AdxDiComparisonResult {
  const { adx, plusDI, minusDI } = computeAdxDi(candles);

  let upTotal = 0, upBoth = 0, upAdxOver = 0, upDiGivenAdxOver = 0, upDiPure = 0;
  let downTotal = 0, downBoth = 0, downAdxOver = 0, downDiGivenAdxOver = 0, downDiPure = 0;

  for (let i = 0; i < labels.length; i++) {
    if (candles[i].openTime !== labels[i].openTime) {
      throw new Error(`candle/label misalignment at index ${i}`);
    }
    const state = labels[i].state;
    if (state === "UPTREND") {
      upTotal++;
      const adxOver = adx[i] >= adxThreshold;
      const diCorrect = plusDI[i] > minusDI[i];
      if (adxOver) upAdxOver++;
      if (adxOver && diCorrect) { upBoth++; upDiGivenAdxOver++; }
      if (diCorrect) upDiPure++;
    } else if (state === "DOWNTREND") {
      downTotal++;
      const adxOver = adx[i] >= adxThreshold;
      const diCorrect = minusDI[i] > plusDI[i];
      if (adxOver) downAdxOver++;
      if (adxOver && diCorrect) { downBoth++; downDiGivenAdxOver++; }
      if (diCorrect) downDiPure++;
    }
  }

  const uptrend = makeBreakdown(upTotal, upBoth, upAdxOver, upDiGivenAdxOver, upDiPure);
  const downtrend = makeBreakdown(downTotal, downBoth, downAdxOver, downDiGivenAdxOver, downDiPure);
  const overallTotal = upTotal + downTotal;
  const overallBoth = upBoth + downBoth;
  const overallDiPure = upDiPure + downDiPure;

  return {
    uptrend,
    downtrend,
    overall: {
      total: overallTotal,
      bothMatch: { count: overallBoth, pct: pct(overallBoth, overallTotal) },
      diCorrectPure: { count: overallDiPure, pct: pct(overallDiPure, overallTotal) },
    },
  };
}
