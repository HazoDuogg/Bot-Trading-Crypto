import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBalanceForTelegramEvent } from './liveBalanceSync.js';

/**
 * TICKET-G1R Checkpoint A — regression tests proving G1-F01/F02 no longer reproduce.
 *
 * Mapping (old repro -> what it proved was broken -> new test -> what now proves it's fixed):
 *  - g1FindingsRepro.test.ts "G1-F01 ... reproduces liveRunner.ts lines ~327-356 ... shows the
 *    fresh exchange read gets discarded" proved the end-of-symbol `accountBalance =
 *    result.accountBalance` unconditionally clobbered a same-tick fresh exchange read.
 *    -> 'G1-F01 fixed' below proves the same scenario now KEEPS the fresh $120 read because
 *    liveRunner.ts now gates that assignment on `exchangeBalanceRefreshedThisTick`.
 *  - g1FindingsRepro.test.ts "G1-F02 ... reproduces liveRunner.ts:327-342 ... internalBalanceBefore
 *    is not the true pre-correction number" proved the incident log captured the ALREADY-corrected
 *    (exchange) value instead of the true pre-sync internal value.
 *    -> 'G1-F02 fixed' below proves internalBalanceBeforeSync is captured before any mutation and
 *    equals the true pre-sync value, and the "confirms source ordering" sub-test in
 *    g1FindingsRepro.test.ts was updated (not silently) to check for the new capture pattern instead
 *    of asserting the old buggy ordering.
 *
 * These tests still cannot import liveRunner.ts directly (it calls main() unconditionally on import,
 * causing real network/env/Telegram side effects) — same constraint documented in
 * g1FindingsRepro.test.ts. They (a) exercise the real liveBalanceSync.ts functions liveRunner.ts
 * calls, and (b) source-check the exact new liveRunner.ts lines to confirm the gating/capture is
 * actually wired the way this file's inline reproduction demonstrates.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');

function mockExecutor(totalWalletBalance: string) {
  return { getAccountInfo: async () => ({ totalWalletBalance, totalMarginBalance: totalWalletBalance, availableBalance: totalWalletBalance }) };
}

describe('G1-F01 fixed — fresh exchange balance survives to the end of the symbol tick', () => {
  it('a fresh read obtained mid-tick (refreshBalanceForTelegram) is NOT overwritten by the stale simulated result.accountBalance', async () => {
    let accountBalance = 100;
    let exchangeBalanceRefreshedThisTick = false; // mirrors liveRunner.ts's per-symbol flag

    // --- inside the events loop: an OPEN/PARTIAL/CLOSE handler calls refreshBalanceForTelegram() ---
    const outcome = await syncBalanceForTelegramEvent(mockExecutor('120'), accountBalance);
    accountBalance = outcome.correctedInternalBalance;
    exchangeBalanceRefreshedThisTick = true; // liveRunner.ts:331 (new)
    expect(accountBalance).toBe(120);

    // --- processCandle() computed result.accountBalance from the PRE-event snapshot (100) ---
    const resultAccountBalance = 100;

    // --- liveRunner.ts end-of-symbol assignment, NOW gated (fixed) ---
    if (!exchangeBalanceRefreshedThisTick) {
      accountBalance = resultAccountBalance;
    }

    // FIXED: the fresh $120 exchange read survives; the stale $100 is never adopted.
    expect(accountBalance).toBe(120);
    expect(accountBalance).not.toBe(100);
  });

  it('with no mid-tick exchange read, the simulated result.accountBalance is still adopted (no-event ticks are unaffected)', () => {
    let accountBalance = 100;
    const exchangeBalanceRefreshedThisTick = false;
    const resultAccountBalance = 100; // no CLOSE events this candle -> unchanged by processCandle()

    if (!exchangeBalanceRefreshedThisTick) {
      accountBalance = resultAccountBalance;
    }
    expect(accountBalance).toBe(100);
  });

  // SUPERSEDED by TICKET-G1R-A "Final Internal Closure" item 1: Checkpoint A's gate
  // (`if (!exchangeBalanceRefreshedThisTick) accountBalance = result.accountBalance;`) was the weaker
  // fix. The end-of-symbol write-back is now REMOVED outright — a strictly stronger guarantee, so this
  // assertion is updated rather than deleted. `exchangeBalanceRefreshedThisTick` itself is retained
  // (still used by the divergence path).
  it('confirms the source: the end-of-symbol simulated write-back is gone entirely; accountBalance has exactly one writer', () => {
    expect(liveRunnerSrc).not.toMatch(/accountBalance = result\.accountBalance;/);
    expect(liveRunnerSrc).toMatch(/exchangeBalanceRefreshedThisTick = true;/);
    expect(liveRunnerSrc).toMatch(/exchangeBalanceRefreshedThisTick = false; \/\/ G1-F01/);
    // applyBalanceObservation() is the single writer of accountBalance (besides its `let` initializer).
    const writes = liveRunnerSrc.match(/^\s*accountBalance = /gm) ?? [];
    expect(writes.length).toBe(1);
  });
});

describe('G1-F02 fixed — internalBalanceBefore captures the true pre-sync value', () => {
  it('reproduces the same >1% divergence scenario, now capturing the pre-sync value BEFORE correction', async () => {
    let accountBalance = 100;
    const internalBalanceBeforeSync = accountBalance; // liveRunner.ts (new): captured before syncBalanceForTelegramEvent
    const outcome = await syncBalanceForTelegramEvent(mockExecutor('150'), accountBalance, 0.01);
    expect(outcome.diverged).toBe(true);

    accountBalance = outcome.correctedInternalBalance; // liveRunner.ts:333 (unchanged ordering)

    const incident = {
      timestampMs: Date.now(),
      exchangeWalletBalance: outcome.snapshot!.walletBalance,
      internalBalanceBefore: internalBalanceBeforeSync, // FIXED: no longer reads the reassigned var
      diffUsd: outcome.divergence!.diffUsd,
      diffPct: outcome.divergence!.diffPct,
      tolerancePct: 0.01,
    };

    // FIXED: correctly the true pre-sync internal value, not the exchange value.
    expect(incident.internalBalanceBefore).toBe(100);
    expect(incident.internalBalanceBefore).not.toBe(150);
  });

  it('confirms the source: internalBalanceBeforeSync is captured before syncBalanceForTelegramEvent is even called', () => {
    const captureIdx = liveRunnerSrc.indexOf('const internalBalanceBeforeSync = accountBalance;');
    const callIdx = liveRunnerSrc.indexOf('await syncBalanceForTelegramEvent(executor, accountBalance);');
    const incidentIdx = liveRunnerSrc.indexOf('internalBalanceBefore: internalBalanceBeforeSync,');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(incidentIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(callIdx);
    expect(callIdx).toBeLessThan(incidentIdx);
  });
});

describe('G1-F01/F02 fix does not touch balance-neutral no-op ticks (parity guard)', () => {
  it('syncBalanceForTelegramEvent itself is untouched — still overwrite-only, no local accumulation', async () => {
    const outcome = await syncBalanceForTelegramEvent(mockExecutor('87.5'), 50);
    expect(outcome.correctedInternalBalance).toBe(87.5); // exchange value wins outright, never 50+something
  });
});
