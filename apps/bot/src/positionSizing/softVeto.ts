import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRiskPct, DEFAULT_RISK_CONFIG, type RiskConfig } from './riskConfig.js';

// Resolved relative to THIS module's own location, not process.cwd() — cwd varies depending on
// how the caller was invoked (repo root for most scripts/CI, but apps/bot itself when vitest runs
// `npm test` there), and this is production code that must resolve correctly either way. Works
// identically compiled (dist/positionSizing/softVeto.js) or as source (src/positionSizing/
// softVeto.ts), since dist/ mirrors src/'s structure one level under apps/bot/.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APPS_BOT_DIR = path.resolve(MODULE_DIR, '..', '..');
const REPO_ROOT_DIR = path.resolve(APPS_BOT_DIR, '..', '..');

// TICKET-RT-066 Part D: Soft Veto — "bo phat hien 2 cuc tri". Role agreed with Vinh Tam: the
// model only speaks when very confident (top/bottom quintile of its OWN training-time score
// distribution), stays silent (no risk change) for the middle ~60% of cases.
//
// Model: Option C (4 features: fvgGapSizePct, keyZoneDistancePct, atrH1Pct, slPct). Thresholds
// are FIXED at train time from that same training run's own score distribution (top/bottom 20%
// cutoffs) — never recomputed retroactively per future trade. Retrain cadence is NOT automated.
//
// TICKET-RT-077: wired into orderLifecycle.ts's onSignalDetected via an injected RiskResolverFn —
// resolveSoftVetoAdjustedRiskPct() now determines the risk% used for every real entry. The model
// currently loaded (apps/bot/data/models/softVetoModelC.meta.json) is trained on which 5-coin
// lineup / when — see that file's own trainedFrom/trainedAtUtc fields, kept up to date at every
// retrain (RT-076: BTC/ETH/SOL/HYPE/DOGE, trainedFrom apps/bot/data/xgbAuditDatasetDoge.csv).

const execFileAsync = promisify(execFile);

export interface SoftVetoFeatures {
  fvgGapSizePct: number;
  keyZoneDistancePct: number;
  atrH1Pct: number;
  slPct: number;
}

export type SoftVetoTier = 'TOP' | 'MIDDLE' | 'BOTTOM';

export interface SoftVetoModelMeta {
  trainN: number;
  featureColumns: string[];
  topThreshold: number;
  bottomThreshold: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
  modelPath: string; // repo-root-relative, e.g. "apps/bot/data/models/softVetoModelC.json"
  trainedAtUtc: string;
  trainedFrom: string;
  coinLineup?: string[]; // RT-077: which 5-coin universe this model was trained on
  xgboostHyperparams: Record<string, number>;
}

// 0.5 percentage points, per the ticket's Phan D step 3.
export const DEFAULT_SOFT_VETO_RISK_ADJUSTMENT_PP = 0.005;

// Pure — ties go to the extreme tier ("Diem >= nguong top" / "Diem <= nguong bottom"), matching
// the >=/<= wording in the ticket and the same convention used by every quintile-split script in
// RT-061..065 (Math.round-based boundaries, inclusive at the cut edge).
export function classifySoftVetoTier(predictedScore: number, topThreshold: number, bottomThreshold: number): SoftVetoTier {
  if (predictedScore >= topThreshold) return 'TOP';
  if (predictedScore <= bottomThreshold) return 'BOTTOM';
  return 'MIDDLE';
}

// Pure. MIDDLE (the majority of cases, by design) is a no-op — base risk unchanged. Clamped at 0
// defensively (never actually reached with today's base risk values: 1.0-1.5%, always > 0.5pp).
export function applySoftVetoRiskAdjustment(baseRiskPct: number, tier: SoftVetoTier, adjustmentPp: number = DEFAULT_SOFT_VETO_RISK_ADJUSTMENT_PP): number {
  if (tier === 'TOP') return baseRiskPct + adjustmentPp;
  if (tier === 'BOTTOM') return Math.max(0, baseRiskPct - adjustmentPp);
  return baseRiskPct;
}

export async function loadSoftVetoModelMeta(metaPath: string): Promise<SoftVetoModelMeta> {
  const raw = await readFile(metaPath, 'utf8');
  return JSON.parse(raw) as SoftVetoModelMeta;
}

// Calls scripts/predictSoftVeto.py — loads the ALREADY-TRAINED model (no retraining) and scores
// one candidate. A single subprocess call per trade candidate (at fill time, not per candle) is
// negligible against maxWaitCandles=20's ~5-hour tolerance window — Part E measures this directly
// rather than assuming it.
export async function predictSoftVetoScore(
  features: SoftVetoFeatures,
  modelPath: string,
  options?: { pythonExe?: string; scriptPath?: string },
): Promise<number> {
  const pythonExe = options?.pythonExe ?? 'python';
  const scriptPath = options?.scriptPath ?? path.join(APPS_BOT_DIR, 'scripts', 'predictSoftVeto.py');
  const args = [scriptPath, modelPath, String(features.fvgGapSizePct), String(features.keyZoneDistancePct), String(features.atrH1Pct), String(features.slPct)];
  const { stdout } = await execFileAsync(pythonExe, args);
  const result = JSON.parse(stdout) as { predicted: number };
  return result.predicted;
}

export interface SoftVetoResolution {
  baseRiskPct: number;
  adjustedRiskPct: number;
  tier: SoftVetoTier;
  predictedScore: number;
}

// Composition point for whenever this gets wired in: base risk% comes from the EXISTING, unchanged
// resolveRiskPct() (symbol/breaksKeyZone logic untouched) — Soft Veto only adds/subtracts a flat
// adjustment ON TOP, per the ticket ("HYPE 1.0%/1.5% baseline van cong them 0.5pp tuong ung").
// Does not touch SL/TP/entry price — risk% only, per the ticket's "Khong dam" list.
export async function resolveSoftVetoAdjustedRiskPct(
  symbol: string,
  breaksKeyZone: boolean,
  features: SoftVetoFeatures,
  meta: SoftVetoModelMeta,
  options?: { pythonExe?: string; scriptPath?: string; riskConfig?: RiskConfig; adjustmentPp?: number },
): Promise<SoftVetoResolution> {
  const baseRiskPct = resolveRiskPct(symbol, breaksKeyZone, options?.riskConfig ?? DEFAULT_RISK_CONFIG);
  const absoluteModelPath = path.isAbsolute(meta.modelPath) ? meta.modelPath : path.join(REPO_ROOT_DIR, meta.modelPath);
  const predictedScore = await predictSoftVetoScore(features, absoluteModelPath, options);
  const tier = classifySoftVetoTier(predictedScore, meta.topThreshold, meta.bottomThreshold);
  const adjustedRiskPct = applySoftVetoRiskAdjustment(baseRiskPct, tier, options?.adjustmentPp);
  return { baseRiskPct, adjustedRiskPct, tier, predictedScore };
}
