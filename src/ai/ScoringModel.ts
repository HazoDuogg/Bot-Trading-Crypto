/**
 * A ScoringModel is ADVISORY ONLY (see src/pipeline.ts): given a Signal
 * and the features available at signal time, it returns a score plus
 * the inputs it used. It never places an order and never has the
 * authority to block one by itself - only `risk` (downstream) decides
 * what, if anything, a score changes.
 *
 * If a ScoringModel is missing, fails to load, or throws when scoring,
 * the engine MUST fall back to rule-based only - treat the pipeline as
 * if `ai` were absent, not as a reason to block or alter a trade.
 *
 * Interface only - no implementation, no actual model (e.g. XGBoost)
 * wired in yet.
 */

import type { Signal } from "../strategy/Strategy";

export interface ScoreResult {
  /** Model's confidence/score for this signal - scale and meaning are model-specific, not fixed by this interface. */
  score: number;
  /** The exact feature values this score was computed from - for logging/FeatureRecorder, so a score is always auditable. */
  featuresUsed: Record<string, unknown>;
  modelVersion: string;
}

export interface ScoringModel {
  readonly modelVersion: string;

  /**
   * Score one signal. May throw (missing model, bad input, inference
   * error) - callers MUST catch and fall back to rule-based-only
   * behavior rather than letting a scoring failure block or alter a
   * trade decision.
   */
  score(signal: Signal, features: Record<string, unknown>): Promise<ScoreResult>;
}
