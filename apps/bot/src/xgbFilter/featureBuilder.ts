import { readFileSync } from 'node:fs';
import type { CandleData } from '../regime/types.js';
import { RegimeConfig } from '../regime/config.js';
import { emaSeries, lastDefined, wilderATRSeries } from '../regime/indicators.js';

// TICKET-023 Phần B constants (generateMomentumTrainingData.ts) — must match exactly, kept in sync
// manually (same convention as calibrateThresholds.ts/backtest.ts's window constants).
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const EMA_1H_FAST_PERIOD = 50;
const EMA_1H_SLOW_PERIOD = 200;

export interface FeatureSchema {
  numeric_features: string[];
  categorical_feature_order: string[];
  categorical_features: Record<string, string[]>;
  missing_categorical_value: string;
  feature_order: string[];
}

export function loadFeatureSchema(schemaPath: string): FeatureSchema {
  return JSON.parse(readFileSync(schemaPath, 'utf-8')) as FeatureSchema;
}

/**
 * TICKET-023 Phần B.2 cross-features, on the caller's own already-windowed candles5m/candles1h
 * (ending at "now" — same no-look-ahead contract as the rest of orchestrator/). Same formulas as
 * generateMomentumTrainingData.ts, reusing the exact wilderATRSeries/emaSeries functions — no
 * formula re-derived here. `undefined` means insufficient history to score this candle.
 */
export function computeMomentumCrossFeatures(
  candles5m: CandleData[],
  candles1h: CandleData[],
): { volAdjReturn5m: number; emaRatioFast: number; emaRatioSlow: number } | undefined {
  const currentCandle = candles5m[candles5m.length - 1];
  const atr5mRaw = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  const emaFast5m = lastDefined(emaSeries(candles5m, EMA_FAST_PERIOD));
  const emaSlow5m = lastDefined(emaSeries(candles5m, EMA_SLOW_PERIOD));
  const ema1hFast = lastDefined(emaSeries(candles1h, EMA_1H_FAST_PERIOD));
  const ema1hSlow = lastDefined(emaSeries(candles1h, EMA_1H_SLOW_PERIOD));

  if (atr5mRaw === undefined || atr5mRaw === 0 || emaFast5m === undefined || emaSlow5m === undefined || ema1hFast === undefined || ema1hSlow === undefined) {
    return undefined;
  }

  // Same reading as generateMomentumTrainingData.ts (documented there, not re-derived here):
  // "% thay đổi giá nến 5m hiện tại" = this candle's own open->close move, (close-open)/open.
  const candleReturnPct = ((currentCandle.close - currentCandle.open) / currentCandle.open) * 100;

  return {
    volAdjReturn5m: candleReturnPct / atr5mRaw,
    emaRatioFast: emaFast5m / emaSlow5m,
    emaRatioSlow: ema1hFast / ema1hSlow,
  };
}

export interface RawMomentumFeatures {
  symbol: string;
  adx1h: number;
  atrPercentile5m: number;
  bbWidthPercentile15m: number;
  volumeZScore5m: number;
  atrTrend5m: string;
  adxDirection1h: string;
  /** May be undefined (insufficient 1D history) — treated as schema.missing_categorical_value, same as training. */
  macroDirection: string | undefined;
  volAdjReturn5m: number;
  emaRatioFast: number;
  emaRatioSlow: number;
}

/**
 * B.1 — assembles the model input vector STRICTLY from schema.feature_order; the column order and
 * one-hot category order are NEVER hard-coded here, always read from the schema at runtime, so a
 * future retrain with a reordered/expanded schema doesn't require touching this file. A categorical
 * value not present in schema.categorical_features[...] (out-of-vocabulary at inference) produces an
 * all-zero one-hot for that feature — the standard fallback, since there is no "correct" column to
 * light up for a category the model was never trained on.
 */
export function buildFeatureVector(raw: RawMomentumFeatures, schema: FeatureSchema): Float32Array {
  const numericValues: Record<string, number> = {
    adx1h: raw.adx1h,
    atrPercentile5m: raw.atrPercentile5m,
    bbWidthPercentile15m: raw.bbWidthPercentile15m,
    volumeZScore5m: raw.volumeZScore5m,
    volAdjReturn5m: raw.volAdjReturn5m,
    emaRatioFast: raw.emaRatioFast,
    emaRatioSlow: raw.emaRatioSlow,
  };
  const categoricalValues: Record<string, string> = {
    atrTrend5m: raw.atrTrend5m,
    adxDirection1h: raw.adxDirection1h,
    macroDirection: raw.macroDirection ?? schema.missing_categorical_value,
    symbol: raw.symbol,
  };

  const vector = new Float32Array(schema.feature_order.length);
  schema.feature_order.forEach((colName, i) => {
    if (colName in numericValues) {
      vector[i] = numericValues[colName];
      return;
    }
    const sepIndex = colName.indexOf('__');
    if (sepIndex === -1) {
      throw new Error(`buildFeatureVector: cột "${colName}" trong feature_order không khớp numeric feature nào và không có dạng "feature__category".`);
    }
    const featureName = colName.slice(0, sepIndex);
    const category = colName.slice(sepIndex + 2);
    vector[i] = categoricalValues[featureName] === category ? 1 : 0;
  });
  return vector;
}
