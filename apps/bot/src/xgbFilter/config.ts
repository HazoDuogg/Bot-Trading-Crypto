import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TICKET-024 Phần C. Soft risk-multiplier from the momentum model's calibrated probability —
 * does NOT gate entry (no setup is ever blocked outright), only scales position size.
 */
export interface MomentumFilterConfig {
  /** Off by default — baseline behavior unchanged unless a caller (backtest.ts CLI) opts in. */
  momentumFilterEnabled: boolean;
  /** TODO_CONFIRM: PM suggested 0.45. p <= this -> momentumMultiplier = momentumLowMultiplier. */
  momentumLowThreshold: number;
  /** TODO_CONFIRM: PM suggested 0.60. p >= this -> momentumMultiplier = 1.0. */
  momentumHighThreshold: number;
  /** TODO_CONFIRM: PM suggested 0.5. Multiplier floor at/below momentumLowThreshold. */
  momentumLowMultiplier: number;
}

export const DEFAULT_MOMENTUM_FILTER_CONFIG: MomentumFilterConfig = {
  momentumFilterEnabled: false,
  momentumLowThreshold: 0.45,
  momentumHighThreshold: 0.6,
  momentumLowMultiplier: 0.5,
};

// TICKET-023 model artifacts, read at runtime (path only — never hard-code feature order/categories,
// those are always read fresh from the schema JSON by featureBuilder.ts).
//
// Resolved relative to THIS FILE (not process.cwd()): backtest.ts runs with cwd = repo root, but
// `npm test --workspace apps/bot` runs vitest with cwd = apps/bot/ — a process.cwd()-relative path
// would silently point at the wrong place (or nowhere) depending on which one invoked this module.
// apps/bot/{src,dist}/xgbFilter/config.{ts,js} is always 4 directories below repo root either way.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const MOMENTUM_MODEL_PATH = path.join(REPO_ROOT, 'models', 'xgb_momentum_v1.onnx');
export const MOMENTUM_SCHEMA_PATH = path.join(REPO_ROOT, 'models', 'xgb_momentum_v1_feature_schema.json');
