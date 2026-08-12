import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBalanceForTelegramEvent } from './liveBalanceSync.js';

/**
 * G1 — Logic, Calculation & Module-Matching Review Ledger — reproduction tests (live/ layer).
 * See data/g1-logic-calculation-module-matching-review-ledger.md for the full write-up.
 * NEW, isolated tests only — do not modify any existing test file's assertions. liveRunner.ts
 * itself is a script that calls main() unconditionally at import time (real network/env/Telegram
 * side effects) so it is deliberately NOT imported here — F01/F02/the restart finding reproduce
 * its exact documented line-level logic using the real (imported, non-mocked) liveBalanceSync.ts
 * functions plus a source-text check for the restart-persistence finding.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');

function mockExecutor(totalWalletBalance: string) {
  return { getAccountInfo: async () => ({ totalWalletBalance, totalMarginBalance: totalWalletBalance, availableBalance: totalWalletBalance }) };
}

// TICKET-G1R Checkpoint A FIXED this defect: the line 780 assignment is now gated on
// `exchangeBalanceRefreshedThisTick` (see g1rBalanceOwnershipFix.test.ts for the fix + new
// regression tests). The inline reproduction below still passes because it replays the pattern in
// isolation (unconditional assignment) — it documents what the bug WAS, it does not assert current
// end-to-end liveRunner.ts behavior. The "confirms the source" sub-test still matches because the
// literal `accountBalance = result.accountBalance;` line still exists, now inside an `if` guard.
describe('G1-F01 — exchange-authoritative balance overwritten at end of candle (CONFIRMED_DEFECT, FIXED — see g1rBalanceOwnershipFix.test.ts)', () => {
  it('reproduces liveRunner.ts lines ~327-356 (refreshBalanceForTelegram) followed by line 780 (accountBalance = result.accountBalance) and shows the fresh exchange read gets discarded', async () => {
    let accountBalance = 100; // pre-tick internal balance, same as liveRunner.ts's enclosing `accountBalance`

    // --- inside the events loop: handleCloseEvent() calls refreshBalanceForTelegram() (liveRunner.ts:513) ---
    const outcome = await syncBalanceForTelegramEvent(mockExecutor('120'), accountBalance); // real Binance snapshot: $120
    accountBalance = outcome.correctedInternalBalance; // liveRunner.ts:330 — exchange now authoritative
    expect(accountBalance).toBe(120);

    // --- processCandle() computed its OWN accountBalance from the PRE-event snapshot (orchestrator.ts:1571
    //     `let accountBalance = input.accountBalance`, captured as 100 before this tick's fresh read above
    //     ever happened) — no CLOSE events this candle, so result.accountBalance stays 100. ---
    const resultAccountBalance = 100;

    // --- liveRunner.ts:780, AFTER the events loop that already called refreshBalanceForTelegram ---
    accountBalance = resultAccountBalance;

    // BUG: the fresh, exchange-confirmed $120 obtained moments earlier in this SAME tick is gone —
    // the next symbol/tick sizes and risk-admits against the stale $100 again.
    expect(accountBalance).toBe(100);
    expect(accountBalance).not.toBe(120);
  });

  // TICKET-G1R-A "Final Internal Closure" item 1 FULLY REMOVED this write-back. Checkpoint A had only
  // GATED it (`if (!exchangeBalanceRefreshedThisTick)`); the balance-lifecycle work makes
  // `accountBalance` a pure cache of the exchange-authoritative wallet balance, so the simulator's own
  // number is never adopted into it at all. Live admission does not add simulator-booked tier PnL
  // a second time on top of the exchange wallet balance.
  it('G1R-A FIX: the simulated write-back accountBalance = result.accountBalance no longer exists anywhere in liveRunner.ts', () => {
    expect(liveRunnerSrc).not.toMatch(/accountBalance = result\.accountBalance;/);
    expect(liveRunnerSrc).toContain('function applyBalanceObservation(');
  });
});

// TICKET-G1R Checkpoint A FIXED this defect — see the updated "confirms the source ordering"
// sub-test below and g1rBalanceOwnershipFix.test.ts for the new regression coverage.
describe('G1-F02 — balance divergence incident records the wrong internalBalanceBefore (CONFIRMED_DEFECT, FIXED — see g1rBalanceOwnershipFix.test.ts)', () => {
  it('reproduces liveRunner.ts:327-342: accountBalance is reassigned to the corrected value BEFORE the incident record is built, so internalBalanceBefore is not the true pre-correction number', async () => {
    let accountBalance = 100; // true internal balance before this sync
    const outcome = await syncBalanceForTelegramEvent(mockExecutor('150'), accountBalance, 0.01); // >1% divergence
    expect(outcome.diverged).toBe(true);

    // liveRunner.ts:330 — happens BEFORE the incident object literal below, exactly as in the real file.
    accountBalance = outcome.correctedInternalBalance;

    // liveRunner.ts:335-341 — `internalBalanceBefore: accountBalance` reads the ALREADY-reassigned value.
    const incident = {
      timestampMs: Date.now(),
      exchangeWalletBalance: outcome.snapshot!.walletBalance,
      internalBalanceBefore: accountBalance,
      diffUsd: outcome.divergence!.diffUsd,
      diffPct: outcome.divergence!.diffPct,
      tolerancePct: 0.01,
    };

    // BUG: should be 100 (the real pre-sync internal value) but is 150 (the exchange value) — the
    // incident log now looks like "internal == exchange", corrupting forensic analysis exactly as
    // G1-F02 describes.
    expect(incident.internalBalanceBefore).toBe(150);
    expect(incident.internalBalanceBefore).not.toBe(100);
  });

  // TICKET-G1R Checkpoint A FIXED this: liveRunner.ts no longer builds the incident from the
  // reassigned `accountBalance` — it now captures `internalBalanceBeforeSync` before the
  // reassignment and uses that instead. This sub-test is updated (not silently — see
  // g1rBalanceOwnershipFix.test.ts for the full old->new mapping) to check for the new capture
  // instead of asserting the old buggy ordering, which no longer exists in the source.
  it('G1R FIX: internalBalanceBeforeSync is captured before accountBalance is reassigned (see g1rBalanceOwnershipFix.test.ts)', () => {
    const captureIdx = liveRunnerSrc.indexOf('const internalBalanceBeforeSync = accountBalance;');
    // item 1 — the bare reassignment became an applyBalanceObservation() call at the same point in
    // the same success branch; the ordering guarantee this test protects is unchanged.
    const reassignIdx = liveRunnerSrc.indexOf("source: 'event:refreshBalanceForTelegram'");
    const incidentIdx = liveRunnerSrc.indexOf('internalBalanceBefore: internalBalanceBeforeSync,');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(reassignIdx).toBeGreaterThan(-1);
    expect(incidentIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(reassignIdx);
    expect(reassignIdx).toBeLessThan(incidentIdx);
  });
});

// TICKET-G1R Checkpoint B FIXED this defect: the OPEN-event correction block now calls
// reconcileExecutedOpenState() (liveStateSync.ts) and also corrects position.entryPrice/r and
// meta.actualRiskDollar/marginRequired from the real fill (or blocks new entries on the symbol when
// the fill provenance can't be trusted) — see g1rExecutedStateReconciliationFix.test.ts for the fix +
// new regression coverage. The inline reproduction below is UNCHANGED (it's a self-contained, isolated
// replay of the exact old formula, not a read of liveRunner.ts's actual current source) — it still
// documents what the bug WAS. Only the "confirms the source" sub-test below (which scans the REAL,
// now-changed liveRunner.ts source) is updated, not silently — to check for the new pattern.
describe('G1-F05 — canonical qty correction leaves risk/margin/entry-price basis unreconciled (CONFIRMED_MISMATCH, FIXED — see g1rExecutedStateReconciliationFix.test.ts)', () => {
  it('reproduces liveRunner.ts:747-761 (as it was BEFORE the fix): only position.positionSize/remainingPositionSize were corrected to the canonical (exchange-confirmed) quantity; meta.actualRiskDollar/marginRequired/entryPrice were left at their PLANNED values', () => {
    const openedEntry = {
      position: { positionSize: 33, remainingPositionSize: 33, entryPrice: 100 },
      meta: { actualRiskDollar: 15, marginRequired: 1.1, entryTimestamp: 0 },
    };
    const canonicalQty = 0.00987; // exchange-confirmed real fill qty, slightly off the planned 0.033/100 = 0.00033*100 (slippage/rounding)

    // --- liveRunner.ts:750-757 (verbatim logic) ---
    const correctedNotional = canonicalQty * openedEntry.position.entryPrice;
    openedEntry.position.positionSize = correctedNotional;
    openedEntry.position.remainingPositionSize = correctedNotional;
    // --- end liveRunner.ts correction block ---

    expect(openedEntry.position.positionSize).toBeCloseTo(0.987, 6); // notional corrected
    // Nothing in the correction block touches these — confirmed by construction (they're never
    // assigned anywhere between the two comment markers above, matching the real liveRunner.ts code):
    expect(openedEntry.meta.actualRiskDollar).toBe(15); // NOT re-derived from correctedNotional * slDistancePercent
    expect(openedEntry.meta.marginRequired).toBe(1.1); // NOT re-derived from correctedNotional / leverage
    expect(openedEntry.position.entryPrice).toBe(100); // NOT set to the observed average fill price
  });

  // G1R FIX: liveRunner.ts's OPEN-event correction block now delegates to reconcileExecutedOpenState()
  // and, on success, corrects positionSize/remainingPositionSize/entryPrice/r AND
  // meta.actualRiskDollar/marginRequired together from the same reconciled basis — no longer leaves
  // risk/margin/entryPrice at their planned values while only positionSize gets corrected.
  it('G1R FIX: the OPEN-event correction block reconciles positionSize, entryPrice, r, actualRiskDollar AND marginRequired together (see g1rExecutedStateReconciliationFix.test.ts)', () => {
    const startMarker = 'if (openFillInfo !== null) {';
    const endMarker = 'POSITION_SIZE_CORRECTION_ERROR';
    const start = liveRunnerSrc.indexOf(startMarker);
    const end = liveRunnerSrc.indexOf(endMarker);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = liveRunnerSrc.slice(start, end);
    expect(block).toContain('reconcileExecutedOpenState(');
    expect(block).toContain('openedEntry.position.positionSize = reconciled.positionSize;');
    expect(block).toContain('openedEntry.position.remainingPositionSize = reconciled.positionSize;');
    expect(block).toContain('openedEntry.position.entryPrice = reconciled.entryPrice;');
    expect(block).toContain('openedEntry.position.r = reconciled.r;');
    expect(block).toContain('openedEntry.meta.actualRiskDollar = reconciled.actualRiskDollar;');
    expect(block).toContain('openedEntry.meta.marginRequired = reconciled.marginRequired;');
    // unreconcilable fill provenance blocks new entries on the symbol instead of guessing a value.
    expect(block).toContain('entriesBlockedDueToUnreconciledFillBySymbol.add(symbol);');
  });
});

// TICKET-G1R Checkpoint C FIXED this defect — see g1rRestartRecoveryFix.test.ts for the real
// fixture-driven behavior tests of the new persistence + startup-reconciliation logic
// (liveStateSync.ts's writeLiveStateFileAtomic/readLiveStateFileSafe/performStartupRestartRecovery/
// decideSideRecovery). The 3 sub-tests below are updated (not silently — same convention as
// F01/F02/F05 above) to check for the NEW pattern instead of asserting the old missing-persistence
// behavior, which no longer exists in the source.
describe('G1-F14 — restart persistence: no SymbolState/position/order-id data survives a process restart, and POSITION_MISSING_INTERNALLY is never actively handled (CONFIRMED_DEFECT, FIXED — see g1rRestartRecoveryFix.test.ts)', () => {
  it('G1R FIX: liveRunner.ts now persists runner state atomically via liveStateSync.ts (writeLiveStateFileAtomic), not a raw writeFileSync of its own', () => {
    expect(liveRunnerSrc).toContain('writeLiveStateFileAtomic');
    expect(liveRunnerSrc).toContain('function persistLiveState(): void {');
    expect(liveRunnerSrc).not.toMatch(/writeFileSync|fs\.writeFile|\.promises\.writeFile|fsPromises\.writeFile/);
  });

  it('G1R FIX: runnerState is built from performStartupRestartRecovery()\'s output (persisted + fresh exchange read reconciled), not unconditionally re-initialized to INITIAL_SYMBOL_STATE', () => {
    expect(liveRunnerSrc).toContain('readLiveStateFileSafe(LIVE_STATE_FILE_PATH)');
    expect(liveRunnerSrc).toContain('await performStartupRestartRecovery({');
    expect(liveRunnerSrc).toContain('runnerState[outcome.symbol] = { symbolState: outcome.symbolState,');
    // INITIAL_SYMBOL_STATE is still used, but only as the ownership-proof fallback passed INTO the
    // recovery function — no longer unconditionally assigned to every symbol's runnerState entry.
    expect(liveRunnerSrc).toContain('initialSymbolState: INITIAL_SYMBOL_STATE,');
  });

  it('G1R FIX: POSITION_MISSING_INTERNALLY now has an active handler (quarantine — never auto-adopt/close/cancel) alongside POSITION_MISSING_ON_EXCHANGE and BALANCE_MISMATCH', () => {
    expect(liveRunnerSrc).toContain("result.mismatches.some((m) => m.type === 'POSITION_MISSING_INTERNALLY')");
    expect(liveRunnerSrc).toContain('entriesBlockedDueToRestartQuarantineBySymbol.add(symbol);');
    expect(liveRunnerSrc).toContain('POSITION_MISSING_ON_EXCHANGE');
    expect(liveRunnerSrc).toContain('BALANCE_MISMATCH');
  });
});
