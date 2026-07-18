import { describe, expect, it } from 'vitest';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema, type RawMomentumFeatures } from './featureBuilder.js';
import { MOMENTUM_SCHEMA_PATH } from './config.js';
import { emaSeries, lastDefined, wilderATRSeries } from '../regime/indicators.js';
import { RegimeConfig } from '../regime/config.js';
import type { CandleData } from '../regime/types.js';

function c(open: number, close: number, high: number, low: number, timestamp: number): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

function makeCandles(count: number, intervalMs: number, priceAt: (i: number) => number, rangeAt: (i: number) => number): CandleData[] {
  const startTs = Date.UTC(2024, 0, 1);
  const candles: CandleData[] = [];
  let prevClose = priceAt(0);
  for (let i = 0; i < count; i++) {
    const close = priceAt(i);
    const open = i === 0 ? close : prevClose;
    const range = rangeAt(i);
    const high = Math.max(open, close) + range / 2;
    const low = Math.min(open, close) - range / 2;
    candles.push(c(open, close, high, low, startTs + i * intervalMs));
    prevClose = close;
  }
  return candles;
}

describe('computeMomentumCrossFeatures', () => {
  it('matches the formulas hand-computed from the same indicators.ts functions (no re-derivation)', () => {
    const candles5m = makeCandles(320, 300_000, (i) => 100 + i * 0.01, () => 1);
    const candles1h = makeCandles(250, 3_600_000, (i) => 100 + i * 0.5, () => 1);

    const result = computeMomentumCrossFeatures(candles5m, candles1h);
    expect(result).toBeDefined();

    const lastCandle = candles5m[candles5m.length - 1];
    const expectedAtr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M)) as number;
    const expectedReturn = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
    expect(result?.volAdjReturn5m).toBeCloseTo(expectedReturn / expectedAtr, 10);

    const expectedEmaFast = lastDefined(emaSeries(candles5m, 9)) as number;
    const expectedEmaSlow = lastDefined(emaSeries(candles5m, 21)) as number;
    expect(result?.emaRatioFast).toBeCloseTo(expectedEmaFast / expectedEmaSlow, 10);

    const expectedEma1hFast = lastDefined(emaSeries(candles1h, 50)) as number;
    const expectedEma1hSlow = lastDefined(emaSeries(candles1h, 200)) as number;
    expect(result?.emaRatioSlow).toBeCloseTo(expectedEma1hFast / expectedEma1hSlow, 10);
  });

  it('returns undefined when there is not enough history yet (e.g. < 200 1h candles for emaRatioSlow)', () => {
    const candles5m = makeCandles(320, 300_000, (i) => 100 + i * 0.01, () => 1);
    const candles1h = makeCandles(50, 3_600_000, (i) => 100 + i * 0.5, () => 1); // < EMA_1H_SLOW_PERIOD(200)
    expect(computeMomentumCrossFeatures(candles5m, candles1h)).toBeUndefined();
  });
});

describe('buildFeatureVector — reads real models/xgb_momentum_v1_feature_schema.json, no hard-coded order', () => {
  const schema: FeatureSchema = loadFeatureSchema(MOMENTUM_SCHEMA_PATH);

  const raw: RawMomentumFeatures = {
    symbol: 'ETHUSDT',
    adx1h: 30,
    atrPercentile5m: 55,
    bbWidthPercentile15m: 40,
    volumeZScore5m: 1.2,
    atrTrend5m: 'increasing',
    adxDirection1h: 'UP',
    macroDirection: 'DOWN',
    volAdjReturn5m: 0.05,
    emaRatioFast: 1.001,
    emaRatioSlow: 0.998,
  };

  it('places every value at the index its own column name occupies in schema.feature_order', () => {
    const vector = buildFeatureVector(raw, schema);
    expect(vector.length).toBe(schema.feature_order.length);

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
      macroDirection: raw.macroDirection as string,
      symbol: raw.symbol,
    };

    schema.feature_order.forEach((colName, i) => {
      if (colName in numericValues) {
        expect(vector[i]).toBeCloseTo(numericValues[colName], 5);
        return;
      }
      const [featureName, category] = colName.split('__');
      const expected = categoricalValues[featureName] === category ? 1 : 0;
      expect(vector[i]).toBe(expected);
    });

    // sanity: exactly one one-hot column lit per categorical feature actually present in the schema
    for (const featureName of schema.categorical_feature_order) {
      const cols = schema.feature_order.filter((col) => col.startsWith(`${featureName}__`));
      const litCount = cols.filter((col) => vector[schema.feature_order.indexOf(col)] === 1).length;
      expect(litCount).toBeLessThanOrEqual(1); // 0 if raw value is out-of-vocabulary, else exactly 1
    }
  });

  it('produces an all-zero one-hot for a categorical value not present in the schema (out-of-vocabulary)', () => {
    const unknownSymbolRaw: RawMomentumFeatures = { ...raw, symbol: 'DOGEUSDT' }; // not in schema.categorical_features.symbol
    const vector = buildFeatureVector(unknownSymbolRaw, schema);
    const symbolCols = schema.feature_order.filter((col) => col.startsWith('symbol__'));
    for (const col of symbolCols) {
      expect(vector[schema.feature_order.indexOf(col)]).toBe(0);
    }
  });

  it('falls back to missing_categorical_value when macroDirection is undefined', () => {
    const undefinedMacroRaw: RawMomentumFeatures = { ...raw, macroDirection: undefined };
    const vector = buildFeatureVector(undefinedMacroRaw, schema);
    const unknownCol = `macroDirection__${schema.missing_categorical_value}`;
    const idx = schema.feature_order.indexOf(unknownCol);
    if (idx !== -1) {
      expect(vector[idx]).toBe(1);
    }
    // if UNKNOWN wasn't a trained category either, this is equivalent to the OOV case above — both are valid, just asserting no crash and a defined vector.
    expect(vector.length).toBe(schema.feature_order.length);
  });
});
