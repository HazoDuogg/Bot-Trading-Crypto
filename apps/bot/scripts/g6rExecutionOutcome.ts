/**
 * TICKET-G6R-CP3F Fix 2 — unambiguous execution-outcome record schema.
 *
 * Extracted from g6rCheckpoint3Replay.ts so it can be unit-tested without ever
 * spawning a replay. The historical g6r-cp3-final-execution.json (frozen,
 * NOT modified by this module) wrote `exitCode: 0` at a point in the script
 * where only `runReplay()` itself had returned — before schema/geometry/
 * leakage validation ran. That field name implies the overall Node process's
 * exit code, which was actually 1 (the script threw and its top-level
 * `.catch` calls `process.exit(1)`) once validation failed. This module
 * defines the corrected schema for all FUTURE runs: no field named
 * `exitCode` is ever produced, and `validationStatus` /
 * `expectedProcessExitCode` are always mutually consistent because
 * `expectedProcessExitCode` is DERIVED from `validationStatus`, never set
 * independently.
 */

export type ValidationStatus = 'CHECKPOINT_3_PASS' | 'CHECKPOINT_3_INVALID';

export interface ExecutionOutcomeInput {
  runCountThisAuthorization: number;
  utcBeforeSpawn: string;
  utcAfterExit: string;
  /** Error message if the runReplay() call itself threw; null if it returned normally. */
  replayCallError: string | null;
  /** The FINAL validation decision — known only after schema/geometry/leakage/parity checks complete. */
  validationStatus: ValidationStatus;
  command: string;
  env: Readonly<Record<string, string>>;
  stopStep: number;
  sourceHashes: Readonly<Record<string, string>>;
  observerReplayTradeIdentityDigestSha256: string | null;
  observerRunParity: unknown | null;
  futureCandleViolationsCaught: number;
  futureCandleViolationSamples: readonly unknown[];
}

export interface ExecutionOutcomeArtifact extends ExecutionOutcomeInput {
  /** True only when runReplay() returned normally; false when it threw. */
  replayCallCompleted: boolean;
  /**
   * The exit code THIS SCRIPT's own `main().catch(e => { ...; process.exit(1); })` handler
   * would produce for this validationStatus. This is what the script INTENDS to exit with,
   * derived purely from validationStatus — it can never contradict validationStatus because
   * it is computed FROM it, not set independently.
   */
  expectedProcessExitCode: 0 | 1;
  /**
   * The actual OS-level exit code of the Node process cannot be captured by the process
   * itself before it exits. Getting a real, externally-observed exit code requires a parent
   * process / wrapper (e.g. a shell script or CI step) to run this script and record
   * `$LASTEXITCODE` / `echo $?` after it terminates. This field documents that limitation
   * explicitly rather than guessing or omitting it.
   */
  processExitCodeCaptureStatus: 'REQUIRES_EXTERNAL_WRAPPER';
}

const FORBIDDEN_FIELD_NAME = 'exitCode';

/**
 * Build the execution-outcome artifact. Pure — no I/O, no replay dependency, no reliance on
 * the calling script's own process lifecycle. Throws if the caller attempts to smuggle a
 * field literally named `exitCode` into the input (defense against reintroducing the bug).
 */
export function buildExecutionOutcomeArtifact(input: ExecutionOutcomeInput): ExecutionOutcomeArtifact {
  if (FORBIDDEN_FIELD_NAME in (input as unknown as Record<string, unknown>)) {
    throw new Error(`ExecutionOutcomeInput must never contain a field named '${FORBIDDEN_FIELD_NAME}' — use validationStatus/expectedProcessExitCode instead.`);
  }
  const expectedProcessExitCode: 0 | 1 = input.validationStatus === 'CHECKPOINT_3_PASS' ? 0 : 1;
  const artifact: ExecutionOutcomeArtifact = {
    ...input,
    replayCallCompleted: input.replayCallError === null,
    expectedProcessExitCode,
    processExitCodeCaptureStatus: 'REQUIRES_EXTERNAL_WRAPPER',
  };
  if (FORBIDDEN_FIELD_NAME in (artifact as unknown as Record<string, unknown>)) {
    // Structurally unreachable given the type/spread above, but kept as a defense-in-depth
    // runtime guard so a future edit cannot silently reintroduce the field.
    throw new Error(`buildExecutionOutcomeArtifact must never emit a field named '${FORBIDDEN_FIELD_NAME}'.`);
  }
  return artifact;
}
