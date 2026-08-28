import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySoftVetoTier,
  applySoftVetoRiskAdjustment,
  loadSoftVetoModelMeta,
  predictSoftVetoScore,
  resolveSoftVetoAdjustedRiskPct,
  DEFAULT_SOFT_VETO_RISK_ADJUSTMENT_PP,
  type SoftVetoModelMeta,
} from './softVeto.js';

describe('classifySoftVetoTier', () => {
  it('classifies TOP when score >= topThreshold', () => {
    expect(classifySoftVetoTier(0.7, 0.6, 0.4)).toBe('TOP');
    expect(classifySoftVetoTier(0.6, 0.6, 0.4)).toBe('TOP'); // boundary: tie goes to TOP
  });

  it('classifies BOTTOM when score <= bottomThreshold', () => {
    expect(classifySoftVetoTier(0.2, 0.6, 0.4)).toBe('BOTTOM');
    expect(classifySoftVetoTier(0.4, 0.6, 0.4)).toBe('BOTTOM'); // boundary: tie goes to BOTTOM
  });

  it('classifies MIDDLE for everything strictly between the thresholds (the majority, by design)', () => {
    expect(classifySoftVetoTier(0.5, 0.6, 0.4)).toBe('MIDDLE');
    expect(classifySoftVetoTier(0.45, 0.6, 0.4)).toBe('MIDDLE');
  });
});

describe('applySoftVetoRiskAdjustment', () => {
  it('adds the adjustment for TOP', () => {
    expect(applySoftVetoRiskAdjustment(0.015, 'TOP')).toBeCloseTo(0.02, 10);
  });

  it('subtracts the adjustment for BOTTOM', () => {
    expect(applySoftVetoRiskAdjustment(0.015, 'BOTTOM')).toBeCloseTo(0.01, 10);
  });

  it('leaves MIDDLE unchanged', () => {
    expect(applySoftVetoRiskAdjustment(0.015, 'MIDDLE')).toBe(0.015);
  });

  it('applies the same flat adjustment to HYPE baseline (1.0%) and HYPE breaksKeyZone (1.5%)', () => {
    expect(applySoftVetoRiskAdjustment(0.01, 'TOP')).toBeCloseTo(0.015, 10);
    expect(applySoftVetoRiskAdjustment(0.015, 'TOP')).toBeCloseTo(0.02, 10);
    expect(applySoftVetoRiskAdjustment(0.01, 'BOTTOM')).toBeCloseTo(0.005, 10);
  });

  it('never goes negative (defensive clamp, not reached by today\'s real risk values)', () => {
    expect(applySoftVetoRiskAdjustment(0.002, 'BOTTOM', 0.005)).toBe(0);
  });

  it('default adjustment is 0.5 percentage points', () => {
    expect(DEFAULT_SOFT_VETO_RISK_ADJUSTMENT_PP).toBe(0.005);
  });

  it('respects a custom adjustmentPp override', () => {
    expect(applySoftVetoRiskAdjustment(0.015, 'TOP', 0.01)).toBeCloseTo(0.025, 10);
  });
});

// Resolved relative to this test file's own location (src/positionSizing/) — correct regardless of
// vitest's working directory, unlike a process.cwd()-based guess.
const APPS_BOT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const REPO_ROOT_DIR = path.resolve(APPS_BOT_DIR, '..', '..');
const META_PATH = path.join(APPS_BOT_DIR, 'data', 'models', 'softVetoModelC.meta.json');

async function loadMetaFromRepoRoot(): Promise<SoftVetoModelMeta> {
  return loadSoftVetoModelMeta(META_PATH);
}

describe('loadSoftVetoModelMeta (real trained artifact, retrained by RT-076 on BTC/ETH/SOL/HYPE/DOGE)', () => {
  it('parses the metadata file with the expected shape and sane values', async () => {
    const meta = await loadMetaFromRepoRoot();
    expect(meta.trainN).toBe(3804);
    expect(meta.featureColumns).toEqual(['fvgGapSizePct', 'keyZoneDistancePct', 'atrH1Pct', 'slPct']);
    expect(meta.topThreshold).toBeGreaterThan(meta.bottomThreshold);
    expect(meta.topThreshold).toBeGreaterThan(0);
    expect(meta.topThreshold).toBeLessThan(1);
    expect(meta.bottomThreshold).toBeGreaterThan(0);
    expect(meta.bottomThreshold).toBeLessThan(1);
  });
});

// Integration tests against the REAL trained model (RT-066 Part D) — same "so sanh so, khong chi
// doc code" standard used throughout this ticket series. Calls the actual Python inference script,
// same tooling already used everywhere else in this repo (xgbTrainFold.py etc.) — not mocked.
describe('predictSoftVetoScore + resolveSoftVetoAdjustedRiskPct (integration, real model)', () => {
  it('scores a known training row and reproduces a plausible in-range score', async () => {
    const meta = await loadMetaFromRepoRoot();
    const modelPath = path.join(REPO_ROOT_DIR, meta.modelPath);
    const score = await predictSoftVetoScore(
      { fvgGapSizePct: 0.18126, keyZoneDistancePct: 0.302819, atrH1Pct: 1.133062, slPct: 0.558884 },
      modelPath,
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    // This exact row/score pair was verified bit-identical against a fresh in-memory retrain
    // during RT-076's manual validation on the DOGE-lineup dataset (0.6105873584747314).
    expect(score).toBeCloseTo(0.6105873584747314, 9);
  }, 20000);

  it('resolveSoftVetoAdjustedRiskPct composes base risk% (unchanged resolveRiskPct) with the tier adjustment', async () => {
    const meta = await loadMetaFromRepoRoot();
    // A feature vector far above the training mean score should land in TOP given real thresholds.
    const result = await resolveSoftVetoAdjustedRiskPct(
      'BTCUSDT',
      false,
      { fvgGapSizePct: 5, keyZoneDistancePct: 0.01, atrH1Pct: 0.5, slPct: 0.4 },
      meta,
    );
    expect(result.baseRiskPct).toBe(0.015);
    expect(['TOP', 'MIDDLE', 'BOTTOM']).toContain(result.tier);
    if (result.tier === 'TOP') expect(result.adjustedRiskPct).toBeCloseTo(0.02, 10);
    else if (result.tier === 'BOTTOM') expect(result.adjustedRiskPct).toBeCloseTo(0.01, 10);
    else expect(result.adjustedRiskPct).toBe(0.015);
  }, 20000);
});
