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

/**
 * TICKET-036. Hard gate for NEUTRAL_TRANSITION only — unlike MomentumFilterConfig above (soft
 * risk-multiplier, never blocks entry outright), this one REJECTS the DraftSetup entirely when the
 * momentum score doesn't clear the threshold. Replaces the old fixed 0.5 risk-multiplier idea
 * (TICKET-012/retired by TICKET-036) with a binary confidence gate instead of a size reduction.
 */
export interface NeutralTransitionGateConfig {
  /**
   * Off by default. entryRouter.ts's routeEntry() always builds a real DraftSetup for
   * NEUTRAL_TRANSITION now (TICKET-036 Phần A) — this flag is read by orchestrator.ts, which
   * discards that DraftSetup with no event (byte-for-byte the pre-TICKET-036 behavior) whenever
   * false, instead of running it through the Momentum Gate below.
   */
  neutralTransitionTradingEnabled: boolean;
  /** TODO_CONFIRM: PM suggested 0.55. Momentum score (own-side model) must be >= this to allow the trade; missing/undetermined score always rejects, never defaults to passing. */
  neutralTransitionMomentumGateThreshold: number;
}

export const DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG: NeutralTransitionGateConfig = {
  neutralTransitionTradingEnabled: false,
  neutralTransitionMomentumGateThreshold: 0.55,
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
// TICKET-025 Phần C: SHORT-side model — replaces the 1-p(bullish) approximation used since TICKET-024.
// Its own schema, NOT assumed identical to the bullish one (category order can legitimately differ
// between the two separately-trained models).
export const MOMENTUM_BEARISH_MODEL_PATH = path.join(REPO_ROOT, 'models', 'xgb_momentum_bearish_v1.onnx');
export const MOMENTUM_BEARISH_SCHEMA_PATH = path.join(REPO_ROOT, 'models', 'xgb_momentum_bearish_v1_feature_schema.json');
