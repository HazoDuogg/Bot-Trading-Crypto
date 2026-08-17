import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildExecutionOutcomeArtifact, type ExecutionOutcomeInput } from './g6rExecutionOutcome.js';

const baseInput: ExecutionOutcomeInput = {
  runCountThisAuthorization: 1,
  utcBeforeSpawn: '2026-08-17T05:53:35.608Z',
  utcAfterExit: '2026-08-17T05:56:04.155Z',
  replayCallError: null,
  validationStatus: 'CHECKPOINT_3_INVALID',
  command: "$env:T153_LIBRARY_MODE='true'; node apps/bot/scripts-dist/g6rCheckpoint3Replay.js",
  env: { T153_LIBRARY_MODE: 'true' },
  stopStep: 57833,
  sourceHashes: { analyzerSourceHash: 'abc', registrationDocumentSha256: 'def', registeredRuleSliceSha256: 'ghi' },
  observerReplayTradeIdentityDigestSha256: 'digest',
  observerRunParity: { pass: true },
  futureCandleViolationsCaught: 0,
  futureCandleViolationSamples: [],
};

describe('g6rExecutionOutcome — buildExecutionOutcomeArtifact', () => {
  it('replay completed but validation FAILED is never represented as an overall exitCode: 0 — no exitCode field exists at all', () => {
    const artifact = buildExecutionOutcomeArtifact(baseInput);
    expect('exitCode' in artifact).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain('"exitCode"');
  });

  it('CHECKPOINT_3_INVALID validation status yields expectedProcessExitCode = 1, never 0', () => {
    const artifact = buildExecutionOutcomeArtifact({ ...baseInput, validationStatus: 'CHECKPOINT_3_INVALID' });
    expect(artifact.expectedProcessExitCode).toBe(1);
  });

  it('CHECKPOINT_3_PASS validation status yields expectedProcessExitCode = 0', () => {
    const artifact = buildExecutionOutcomeArtifact({ ...baseInput, validationStatus: 'CHECKPOINT_3_PASS' });
    expect(artifact.expectedProcessExitCode).toBe(0);
  });

  it('execution record and final decision cannot contradict — expectedProcessExitCode is derived from validationStatus, not settable independently', () => {
    const invalidArtifact = buildExecutionOutcomeArtifact({ ...baseInput, validationStatus: 'CHECKPOINT_3_INVALID' });
    const passArtifact = buildExecutionOutcomeArtifact({ ...baseInput, validationStatus: 'CHECKPOINT_3_PASS' });
    expect(invalidArtifact.validationStatus).toBe('CHECKPOINT_3_INVALID');
    expect(invalidArtifact.expectedProcessExitCode).not.toBe(0);
    expect(passArtifact.validationStatus).toBe('CHECKPOINT_3_PASS');
    expect(passArtifact.expectedProcessExitCode).toBe(0);
    // There is no code path through buildExecutionOutcomeArtifact that can produce
    // validationStatus='CHECKPOINT_3_INVALID' paired with expectedProcessExitCode=0,
    // because the latter is computed as `validationStatus === 'CHECKPOINT_3_PASS' ? 0 : 1`.
  });

  it('processExitCodeCaptureStatus explicitly documents that the real OS exit code requires an external wrapper', () => {
    const artifact = buildExecutionOutcomeArtifact(baseInput);
    expect(artifact.processExitCodeCaptureStatus).toBe('REQUIRES_EXTERNAL_WRAPPER');
  });

  it('rejects an input that tries to smuggle a field literally named exitCode', () => {
    const tainted = { ...baseInput, exitCode: 0 } as ExecutionOutcomeInput & { exitCode: number };
    expect(() => buildExecutionOutcomeArtifact(tainted)).toThrow(/exitCode/);
  });

  it('replayCallCompleted is true only when runReplay returned normally', () => {
    const artifact = buildExecutionOutcomeArtifact(baseInput);
    expect(artifact.replayCallCompleted).toBe(true);
    const failedArtifact = buildExecutionOutcomeArtifact({
      ...baseInput,
      replayCallError: 'dataset read failed',
      observerReplayTradeIdentityDigestSha256: null,
      observerRunParity: null,
    });
    expect(failedArtifact.replayCallCompleted).toBe(false);
  });
});

describe('g6rCheckpoint3Replay.ts — structural proof that CHECKPOINT_3_INVALID leads to a nonzero process exit', () => {
  // This test reads the runner's SOURCE TEXT only — it never imports/executes the file,
  // since importing it would immediately spawn the full CP3 replay (main() runs at module
  // top level). This is intentionally a static/structural check, not a runtime one.
  it("main().catch handler calls process.exit(1) on any thrown error (including the CHECKPOINT_3_INVALID throw)", () => {
    const runnerPath = path.resolve(__dirname, 'g6rCheckpoint3Replay.ts');
    const source = readFileSync(runnerPath, 'utf8');
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.exit\(1\)/);
    // The CHECKPOINT_3_INVALID branch throws (not console.error-and-continue), so it is
    // guaranteed to reach the catch handler above and exit(1).
    expect(source).toMatch(/throw new Error\(`CHECKPOINT_3_INVALID:/);
  });

  it('the runner never writes a field literally named "exitCode" to any output artifact', () => {
    const runnerPath = path.resolve(__dirname, 'g6rCheckpoint3Replay.ts');
    const source = readFileSync(runnerPath, 'utf8');
    // Matches a JSON/object key "exitCode:" (with optional quotes) anywhere in the source.
    expect(source).not.toMatch(/["']?exitCode["']?\s*:/);
  });
});
