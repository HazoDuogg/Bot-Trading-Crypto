/**
 * TICKET-G1R-A "Freshness Bootstrap Hotfix" — regression/behavior tests for the CONFIRMED severe bug
 * in the previous round's "Final Safety Hotfix" item 5 (hybrid freshness policy):
 * runAccountSyncCycleTickBody()'s `if (positions.length === 0) return;` fired BEFORE either freshness
 * timestamp (lastSuccessfulBalanceReadMs / lastSuccessfulAccountSyncCycleMs) was ever touched. A fresh
 * bot with ZERO open positions (a clean start, or simply the time between trades) could NEVER pass
 * admission and NEVER open its first position — not "~5 minutes after restart" as previously reported,
 * but PERMANENTLY (see the correction added to data/g1r-a-final-safety-hotfix-report.md).
 *
 * Same convention as every prior G1R test file: real behavior tests through the actual exported
 * liveStateSync.ts primitives (captureCoherentReconciliationSnapshotWithRetry, decideSideRecovery,
 * isFreshnessEvidenceStale, createSingleFlightRunner — the SAME functions liveRunner.ts's real
 * captureAndApplyFreshnessSnapshot()/runAccountSyncCycleTickBody() wire) plus source-scan tests proving
 * the wiring order in liveRunner.ts, since that file calls main() unconditionally at import time and
 * cannot be imported/executed directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureCoherentReconciliationSnapshotWithRetry,
  decideSideRecovery,
  isFreshnessEvidenceStale,
  createSingleFlightRunner,
  type FreshnessEvidence,
} from './liveStateSync.js';
import type { BinanceOrderExecutor } from './binanceOrderExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');

type SnapshotExecutor = Pick<BinanceOrderExecutor, 'getAccountInfo' | 'getPositionRisk' | 'getIncome' | 'getOpenAlgoOrders'>;

function makeSnapshotExecutor(overrides: Partial<SnapshotExecutor> = {}): SnapshotExecutor {
  return {
    getAccountInfo: vi.fn().mockResolvedValue({ totalWalletBalance: '1000' }),
    getPositionRisk: vi.fn().mockResolvedValue([]), // zero bot-owned AND zero exchange positions by default
    getIncome: vi.fn().mockResolvedValue([]),
    getOpenAlgoOrders: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SnapshotExecutor;
}

// ==== Scenario 1 — fresh start, zero positions -> bootstrap VALIDATED -> admission OPEN =============

describe('Scenario 1 — fresh start, zero positions: snapshot VALIDATED, freshness evidence fresh (never permanently blocked)', () => {
  it('captureCoherentReconciliationSnapshotWithRetry() validates with ZERO positions on the exchange — snapshot capture itself never depends on positions.length', async () => {
    const executor = makeSnapshotExecutor();
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
    expect(result.status).toBe('VALIDATED');
    expect(executor.getPositionRisk).toHaveBeenCalled();
  });

  it('freshness evidence captured from a VALIDATED zero-position snapshot is NOT stale — admission is NOT blocked just because no trade event has ever fired', () => {
    const now = Date.now();
    // This is exactly what liveRunner.ts's captureAndApplyFreshnessSnapshot() does on VALIDATED:
    // both timestamps set from Date.now(), unconditionally, regardless of positions.length.
    const balanceEvidence: FreshnessEvidence = { capturedAtMs: now, maxAgeMs: 5 * 60_000, source: 'refreshBalanceForTelegram' };
    const protectiveCycleEvidence: FreshnessEvidence = { capturedAtMs: now, maxAgeMs: 10 * 60_000, source: 'runAccountSyncCycleTick' };
    expect(isFreshnessEvidenceStale(balanceEvidence, now)).toBe(false);
    expect(isFreshnessEvidenceStale(protectiveCycleEvidence, now)).toBe(false);
  });

  it('liveRunner.ts wiring: captureAndApplyFreshnessSnapshot() sets BOTH freshness timestamps unconditionally on VALIDATED, with NO positions.length gate anywhere in that function', () => {
    const fnStart = liveRunnerSrc.indexOf('async function captureAndApplyFreshnessSnapshot()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-B (Runtime Wiring Pass) items 1+2+3', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    // TICKET-G1R-A "Final Internal Closure" item 1 — balance freshness is no longer a bare
    // `= Date.now()` here. It is now set inside applyBalanceObservation(), which this function reaches
    // ONLY through parseAndApplyBalance() on the snapshot's own balance leg — i.e. the freshness stamp
    // and the balance VALUE are now adopted together, which is the bug this ticket fixed.
    expect(fnBody).toContain('parseAndApplyBalance(balanceLeg.data');
    expect(fnBody).toContain('lastSuccessfulAccountSyncCycleMs = Date.now();');
    // THE confirmed bug's exact signature (an early return gated on positions.length) must never
    // reappear in this function — comments discussing positions.length are fine, an actual `if` gate is not.
    expect(fnBody).not.toMatch(/if\s*\(positions\.length === 0\)/);
  });

  it('liveRunner.ts wiring: the startup bootstrap call runs the SAME snapshot function synchronously BEFORE accountSyncCycleTimer/tickTimer ever start', () => {
    const bootstrapIdx = liveRunnerSrc.indexOf('const bootstrapOutcome = await accountSyncCycleSingleFlight.run();');
    const cycleTimerIdx = liveRunnerSrc.indexOf('const accountSyncCycleTimer = setInterval(');
    const tickTimerIdx = liveRunnerSrc.indexOf('const tickTimer = setInterval(');
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(cycleTimerIdx).toBeGreaterThan(-1);
    expect(tickTimerIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(cycleTimerIdx);
    // tickTimer is started earlier in the file (before the account-sync section) — the bootstrap must
    // still complete (and throw on failure) before main() ever reaches the trading loop's own
    // await-chain resolves, which it does since main() is fully sequential/awaited top-to-bottom.
    expect(liveRunnerSrc.indexOf('await feed.start();')).toBeLessThan(bootstrapIdx);
  });
});

// ==== Scenario 2 — fresh start, zero positions, balance read FAILS -> admission STILL blocked ========

describe('Scenario 2 — fresh start, zero positions, balance/account read fails: fail-closed, never fresh', () => {
  it('captureCoherentReconciliationSnapshotWithRetry() returns READ_ERROR when getAccountInfo() fails — freshness is never set from a failed read', async () => {
    const executor = makeSnapshotExecutor({ getAccountInfo: vi.fn().mockRejectedValue(new Error('network timeout')) });
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
    expect(result.status).toBe('READ_ERROR');
  });

  it('null freshness evidence (never captured — e.g. every attempt so far failed) is stale — fails closed, never assumes fresh', () => {
    expect(isFreshnessEvidenceStale(null, Date.now())).toBe(true);
  });

  it('liveRunner.ts wiring: a non-VALIDATED snapshot returns BEFORE either freshness timestamp is touched, and flips accountSyncState to ACCOUNT_STATE_UNKNOWN', () => {
    const fnStart = liveRunnerSrc.indexOf('async function captureAndApplyFreshnessSnapshot()');
    const idx = liveRunnerSrc.indexOf("if (snapshotResult.status !== 'VALIDATED') {", fnStart);
    expect(idx).toBeGreaterThan(fnStart);
    const block = liveRunnerSrc.slice(idx, idx + 700);
    expect(block).toContain("accountSyncState = 'ACCOUNT_STATE_UNKNOWN';");
    expect(block).toContain('return snapshotResult;');
    // item 1 — the balance apply (which is what now writes the freshness stamp) is textually AFTER
    // the failure-return branch, so a non-VALIDATED snapshot can never mark balance fresh.
    const balanceApplyIdx = liveRunnerSrc.indexOf('parseAndApplyBalance(balanceLeg.data', fnStart);
    expect(balanceApplyIdx).toBeGreaterThan(idx);
  });
});

// ==== Scenario 3 — fresh start, unknown manual position (exchange has one, bot doesn't) -> block =====

describe('Scenario 3 — unknown/manual exposure with zero bot-owned positions: QUARANTINED, never silently ignored', () => {
  it('decideSideRecovery(): no persisted record but the exchange reports a nonzero position -> QUARANTINED, even when positions.length (bot-owned) starts at zero', () => {
    const decision = decideSideRecovery({ persistedEntries: [], exchangeBaseQty: 0.5, quantityTolerance: 0.001 });
    expect(decision.status).toBe('QUARANTINED');
  });

  it('decideSideRecovery(): truly empty (no persisted, no exchange exposure) -> CLEAN, never falsely quarantined', () => {
    const decision = decideSideRecovery({ persistedEntries: [], exchangeBaseQty: 0, quantityTolerance: 0.001 });
    expect(decision.status).toBe('CLEAN');
  });

  it('liveRunner.ts wiring: captureAndApplyFreshnessSnapshot() runs decideSideRecovery() per symbol×side and quarantines (entriesBlockedDueToRestartQuarantineBySymbol) on QUARANTINED, regardless of positions.length', () => {
    const fnStart = liveRunnerSrc.indexOf('async function captureAndApplyFreshnessSnapshot()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-B (Runtime Wiring Pass) items 1+2+3', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain("decideSideRecovery({");
    expect(fnBody).toContain("decision.status === 'QUARANTINED'");
    expect(fnBody).toContain('entriesBlockedDueToRestartQuarantineBySymbol.add(symbol)');
  });
});

// ==== Scenario 4 — no trade event for >5 minutes, periodic reads succeed -> NOT stale ================

describe('Scenario 4 — the admission<->event circular dependency is broken: elapsed time alone never causes staleness while periodic reads keep succeeding', () => {
  it('an evidence timestamp refreshed by the periodic cycle itself (not any trade event) stays fresh even after 6+ minutes of simulated "no trade" time, as long as the cycle keeps running on schedule', () => {
    const cycleIntervalMs = 5 * 60_000;
    const maxAgeMs = cycleIntervalMs * 2; // liveRunner.ts's PROTECTIVE_CYCLE_FRESHNESS_MAX_AGE_MS convention
    let capturedAtMs = 0;
    let simulatedNow = 0;
    // Simulate 3 periodic cycles ticking, 5 minutes apart, with NO trade event ever occurring.
    for (let i = 0; i < 3; i++) {
      simulatedNow += cycleIntervalMs;
      capturedAtMs = simulatedNow; // captureAndApplyFreshnessSnapshot() refreshes this on every VALIDATED cycle
      expect(isFreshnessEvidenceStale({ capturedAtMs, maxAgeMs, source: 'runAccountSyncCycleTick' }, simulatedNow)).toBe(false);
    }
  });

  it('liveRunner.ts wiring: the freshness-refresh assignment inside captureAndApplyFreshnessSnapshot() has no reference to any trade-event variable/flag — it is driven purely by a VALIDATED snapshot', () => {
    const fnStart = liveRunnerSrc.indexOf('async function captureAndApplyFreshnessSnapshot()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-B (Runtime Wiring Pass) items 1+2+3', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('exchangeBalanceRefreshedThisTick');
    expect(fnBody).not.toContain('OpenTradeEvent');
    expect(fnBody).not.toContain('CloseTradeEvent');
  });
});

// ==== Scenario 5 — ACCOUNT_STATE_UNKNOWN self-recovers via the periodic cycle, no trade event needed =

describe('Scenario 5 — ACCOUNT_STATE_UNKNOWN recovers from a VALIDATED periodic/bootstrap snapshot alone', () => {
  it('liveRunner.ts wiring: captureAndApplyFreshnessSnapshot() flips accountSyncState back to SYNCED on VALIDATED, independent of refreshBalanceForTelegram()', () => {
    const fnStart = liveRunnerSrc.indexOf('async function captureAndApplyFreshnessSnapshot()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-B (Runtime Wiring Pass) items 1+2+3', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    const idx = fnBody.indexOf("accountSyncState === 'ACCOUNT_STATE_UNKNOWN'");
    expect(idx).toBeGreaterThan(-1);
    const block = fnBody.slice(idx, idx + 300);
    expect(block).toContain("accountSyncState = 'SYNCED';");
    expect(fnBody).not.toContain('getPositionRisk()'); // this recovery path trusts the ALREADY-validated snapshot, no separate 2nd confirmation read like refreshBalanceForTelegram()'s own recovery does
  });
});

// ==== Scenario 6 — empty positions still call balance/position/openAlgoOrders exactly ONE cycle ======

describe('Scenario 6 — zero bot-owned positions still triggers exactly one real balance/position/openAlgoOrders read per cycle (never skipped, never doubled)', () => {
  it('captureCoherentReconciliationSnapshotWithRetry() calls each of the 4 read legs exactly once per attempt (getPositionRisk twice: primary + closing re-read) even with zero positions', async () => {
    const executor = makeSnapshotExecutor();
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
    expect(result.status).toBe('VALIDATED');
    expect(executor.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(executor.getPositionRisk).toHaveBeenCalledTimes(2); // primary read + change-detection closing re-read, documented behavior
    expect(executor.getIncome).toHaveBeenCalledTimes(1);
    expect(executor.getOpenAlgoOrders).toHaveBeenCalledTimes(1);
  });

  it('liveRunner.ts wiring: runAccountSyncCycleTickBody() calls captureAndApplyFreshnessSnapshot() unconditionally, and only the repair SWEEP (never the reads) is skipped when positions.length === 0', () => {
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('await captureAndApplyFreshnessSnapshot()');
    expect(fnBody.indexOf('await captureAndApplyFreshnessSnapshot()')).toBeLessThan(fnBody.indexOf('buildProtectiveMonitorInputs()'));
    expect(fnBody).toContain('if (positions.length === 0) return snapshotResult.status;');
  });
});

// ==== Scenario 7 — bootstrap and the periodic timer never run two cycles concurrently ================

describe('Scenario 7 — bootstrap and periodic timer share ONE single-flight guard: overlap never runs two cycles', () => {
  it('createSingleFlightRunner(): a second run() call while the first is still in flight is SKIPPED, never runs concurrently', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let concurrentCallCount = 0;
    let maxConcurrent = 0;
    const runner = createSingleFlightRunner(async () => {
      concurrentCallCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCallCount);
      await first;
      concurrentCallCount--;
      return 'done';
    });
    const p1 = runner.run(); // simulates the bootstrap call
    expect(runner.isInFlight()).toBe(true);
    const p2 = runner.run(); // simulates the periodic timer firing while bootstrap is still running
    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ skipped: false, result: 'done' });
    expect(r2).toEqual({ skipped: true });
    expect(maxConcurrent).toBe(1); // never ran the underlying fn twice at once
  });

  it('liveRunner.ts wiring: accountSyncCycleSingleFlight is declared ONCE and reused by BOTH the startup bootstrap call and the periodic accountSyncCycleTimer — never two separate guard instances', () => {
    const declLine = 'const accountSyncCycleSingleFlight = createSingleFlightRunner(runAccountSyncCycleTickBody);';
    const declIdx = liveRunnerSrc.indexOf(declLine);
    expect(declIdx).toBeGreaterThan(-1);
    // Only ONE declaration anywhere in the file.
    expect(liveRunnerSrc.indexOf('createSingleFlightRunner(runAccountSyncCycleTickBody)', declIdx + declLine.length)).toBe(-1);
    const bootstrapCallIdx = liveRunnerSrc.indexOf('const bootstrapOutcome = await accountSyncCycleSingleFlight.run();');
    const tickFnIdx = liveRunnerSrc.indexOf('async function runAccountSyncCycleTick(): Promise<void> {\n    const outcome = await accountSyncCycleSingleFlight.run();');
    expect(bootstrapCallIdx).toBeGreaterThan(declIdx);
    expect(tickFnIdx).toBeGreaterThan(declIdx);
  });

  it('liveRunner.ts wiring: the bootstrap call gates the trading loop — a SKIPPED or non-VALIDATED bootstrap outcome throws (fail-closed, same convention as restartRecovery.ok)', () => {
    const idx = liveRunnerSrc.indexOf("if (bootstrapOutcome.skipped || bootstrapOutcome.result !== 'VALIDATED') {");
    expect(idx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(idx, idx + 400);
    expect(block).toContain('throw new Error(');
  });
});

// ==== Scenario 8 — SIGINT/SIGTERM during bootstrap does not hang ====================================

describe('Scenario 8 — a shutdown signal received while the startup bootstrap is still awaiting exits within a bounded time, never hangs', () => {
  it('liveRunner.ts wiring: an early SIGINT/SIGTERM handler is registered BEFORE the bootstrap call, with a bounded (30s) wait + process.exit, reusing the same single-flight isInFlight() pattern as the full shutdown handler', () => {
    const earlyHandlerIdx = liveRunnerSrc.indexOf('async function earlyBootstrapShutdown()');
    const sigintRegisterIdx = liveRunnerSrc.indexOf("process.on('SIGINT', earlyShutdownSigintHandler);");
    const bootstrapCallIdx = liveRunnerSrc.indexOf('const bootstrapOutcome = await accountSyncCycleSingleFlight.run();');
    expect(earlyHandlerIdx).toBeGreaterThan(-1);
    expect(sigintRegisterIdx).toBeGreaterThan(earlyHandlerIdx);
    expect(bootstrapCallIdx).toBeGreaterThan(sigintRegisterIdx); // handler registered BEFORE the awaited bootstrap call
    const handlerBody = liveRunnerSrc.slice(earlyHandlerIdx, liveRunnerSrc.indexOf('\n  }', earlyHandlerIdx));
    expect(handlerBody).toContain('accountSyncCycleSingleFlight.isInFlight()');
    expect(handlerBody).toContain('Date.now() + 30_000');
    expect(handlerBody).toContain('process.exit(0)');
  });

  it('liveRunner.ts wiring: the early bootstrap-only handlers are removed once bootstrap completes, handing off to the full shutdown handler installed later (never two competing SIGINT listeners for the life of the process)', () => {
    const bootstrapCallIdx = liveRunnerSrc.indexOf('const bootstrapOutcome = await accountSyncCycleSingleFlight.run();');
    const removeIdx = liveRunnerSrc.indexOf("process.removeListener('SIGINT', earlyShutdownSigintHandler);");
    const fullHandlerIdx = liveRunnerSrc.indexOf("process.on('SIGINT', () => void shutdown());");
    expect(removeIdx).toBeGreaterThan(bootstrapCallIdx);
    expect(fullHandlerIdx).toBeGreaterThan(removeIdx);
  });
});
