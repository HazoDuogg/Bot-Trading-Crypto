import { describe, expect, it } from 'vitest';
import { scoreMomentum } from './momentumScorer.js';
import { buildFeatureVector, loadFeatureSchema, type RawMomentumFeatures } from './featureBuilder.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH } from './config.js';

describe('scoreMomentum — real models/xgb_momentum_v1.onnx', () => {
  it('loads the model and returns a calibrated probability in [0,1]', async () => {
    const schema = loadFeatureSchema(MOMENTUM_SCHEMA_PATH);
    const raw: RawMomentumFeatures = {
      symbol: 'BTCUSDT',
      adx1h: 28,
      atrPercentile5m: 50,
      bbWidthPercentile15m: 45,
      volumeZScore5m: 0.5,
      atrTrend5m: 'increasing',
      adxDirection1h: 'UP',
      macroDirection: 'UP',
      volAdjReturn5m: 0.02,
      emaRatioFast: 1.002,
      emaRatioSlow: 1.001,
    };
    const vector = buildFeatureVector(raw, schema);

    const p = await scoreMomentum(MOMENTUM_MODEL_PATH, vector);

    expect(typeof p).toBe('number');
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('caches the loaded session — a second call for the same model path does not error and returns a valid probability', async () => {
    const schema = loadFeatureSchema(MOMENTUM_SCHEMA_PATH);
    const raw: RawMomentumFeatures = {
      symbol: 'XRPUSDT',
      adx1h: 15,
      atrPercentile5m: 30,
      bbWidthPercentile15m: 20,
      volumeZScore5m: -0.5,
      atrTrend5m: 'decreasing',
      adxDirection1h: 'DOWN',
      macroDirection: 'DOWN',
      volAdjReturn5m: -0.03,
      emaRatioFast: 0.998,
      emaRatioSlow: 0.997,
    };
    const vector = buildFeatureVector(raw, schema);

    const p2 = await scoreMomentum(MOMENTUM_MODEL_PATH, vector);
    expect(p2).toBeGreaterThanOrEqual(0);
    expect(p2).toBeLessThanOrEqual(1);
  });
});
