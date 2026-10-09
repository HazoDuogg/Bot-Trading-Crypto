/**
 * A FeatureRecorder persists the feature values available at signal
 * time, independent of whatever ScoringModel (if any) consumed them -
 * this is what makes it possible to train/evaluate a future model
 * against history that was recorded before the model existed.
 *
 * Mirrors the Python scanner's signals.features_json /
 * signals.feature_version pattern (see docs/db_conventions.md) - kept
 * as a compatible shape on purpose, not a coincidence, so historical
 * Python-recorded features and future TypeScript-recorded features can
 * eventually be read the same way.
 *
 * Interface only - no implementation, no storage backend wired in yet.
 */

export interface FeatureSnapshot {
  configKey: string; // e.g. "BTCUSDT/v2f" - mirrors bot.db's configs table, not necessarily its surrogate id
  tsIso: string; // ISO8601 UTC, "Z" suffix - see docs/db_conventions.md's timestamp convention
  barTimeMs?: number;
  rowType: "event" | "per_bar";
  featureVersion: number;
  features: Record<string, unknown>;
}

export interface FeatureRecorder {
  record(snapshot: FeatureSnapshot): Promise<void>;
}
