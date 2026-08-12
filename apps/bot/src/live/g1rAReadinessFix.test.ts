/**
 * TICKET-G1R-A "Readiness Remediation" — regression/behavior tests for items 1, 2, 3, 4.
 *
 * Same convention as every prior G1R checkpoint test file (g1rBalanceOwnershipFix.test.ts,
 * g1rExecutedStateReconciliationFix.test.ts, g1rRestartRecoveryFix.test.ts,
 * g1rFinalClosureFix.test.ts): real behavior tests through the actual exported functions, mocked
 * executor/fetchFn, no real network access, pure-function tests where possible, source-scan tests
 * to prove wiring where the function under test is only reachable inside liveRunner.ts's main().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyProtectiveTpOrder,
  findExistingCandidateSlOrder,
  recoverMissingProtectiveSl,
  captureCoherentReconciliationSnapshotOnce,
  captureCoherentReconciliationSnapshotWithRetry,
  DEFAULT_MISSING_PROTECTIVE_SL_FAILSAFE_POLICY,
  MISSING_SL_RECOVERY_MAX_ATTEMPTS,
  type MissingSlRecoveryOutcome,
} from './liveStateSync.js';
import type { OpenAlgoOrder, BinanceOrderExecutor } from './binanceOrderExecutor.js';
import { wouldExceedRiskPool } from '../risk/riskPool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const orchestratorSrc = readFileSync(path.resolve(__dirname, '../orchestrator/orchestrator.ts'), 'utf8').replace(/\r\n/g, '\n');
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');

function makeOrder(overrides: Partial<OpenAlgoOrder>): OpenAlgoOrder {
  // Schema-realistic defaults (confirmed testnet response): One-Way => positionSide 'BOTH',
  // protective orders are always reduce-only. triggerPrice 95 matches every SL fixture's slTriggerPrice.
  return { algoId: 1, symbol: 'BTCUSDT', side: 'SELL', origQty: 1, triggerPrice: 95, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {}, ...overrides };
}

// ==== Item 2 — verify TP (differentiated, non-critical) ====================================

describe('Item 2 — verifyProtectiveTpOrder (non-critical, never triggers SL failsafe)', () => {
  it('VERIFIED when the tpAlgoId is open, correct side/qty', () => {
    const r = verifyProtectiveTpOrder({ tpAlgoId: 5, expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ algoId: 5, side: 'SELL', origQty: 1, orderType: 'TAKE_PROFIT_MARKET' })] });
    expect(r.status).toBe('VERIFIED');
  });
  it('MISSING when the tpAlgoId is not in the open list', () => {
    const r = verifyProtectiveTpOrder({ tpAlgoId: 5, expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [] });
    expect(r.status).toBe('MISSING');
  });
  it('WRONG_QTY when the resting order qty is outside tolerance', () => {
    const r = verifyProtectiveTpOrder({ tpAlgoId: 5, expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ algoId: 5, side: 'SELL', origQty: 0.5, orderType: 'TAKE_PROFIT_MARKET' })] });
    expect(r.status).toBe('WRONG_QTY');
  });
  it('is a distinct status object per tpAlgoId — never reuses/mutates verifyProtectiveSlOrder state', () => {
    const shared: OpenAlgoOrder[] = [makeOrder({ algoId: 5, side: 'SELL', origQty: 1, orderType: 'TAKE_PROFIT_MARKET' }), makeOrder({ algoId: 6, side: 'SELL', origQty: 0.4, orderType: 'TAKE_PROFIT_MARKET' })];
    const r1 = verifyProtectiveTpOrder({ tpAlgoId: 5, expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: shared });
    const r2 = verifyProtectiveTpOrder({ tpAlgoId: 6, expectedSide: 'LONG', expectedQty: 0.5, quantityTolerance: 0.001, openAlgoOrders: shared });
    expect(r1.status).toBe('VERIFIED');
    expect(r2.status).toBe('WRONG_QTY');
  });
  it('liveRunner.ts wiring: a missing/wrong TP must never escalate through recoverMissingProtectiveSl/quarantine (source-scan — no call site couples verifyProtectiveTpOrder to those)', () => {
    // TICKET-G1R-B Runtime Wiring Pass — updated from the prior round's assertion (which required
    // verifyProtectiveTpOrder to be ABSENT from liveRunner.ts entirely, since it wasn't wired yet).
    // It is now wired at both startup (verifyTpTiersAndWarn) and the in-run monitor
    // (runAccountSyncCycle/liveStateSync.ts). The invariant that actually matters — differentiated
    // policy, never escalates through the SL failsafe — is what this test proves now: extract the
    // verifyTpTiersAndWarn() function body and confirm it never calls recoverMissingProtectiveSl,
    // never adds to entriesBlockedDueToRestartQuarantineBySymbol, never removes from openPositions.
    expect(liveRunnerSrc.includes('verifyProtectiveTpOrder')).toBe(true);
    const fnStart = liveRunnerSrc.indexOf('function verifyTpTiersAndWarn(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  }\n', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('verifyProtectiveTpOrder');
    expect(fnBody).not.toContain('recoverMissingProtectiveSl');
    expect(fnBody).not.toContain('entriesBlockedDueToRestartQuarantineBySymbol');
    expect(fnBody).not.toContain('openPositions.filter');
    expect(fnBody).not.toContain('placeStopMarket');
    expect(fnBody).not.toContain('closePositionMarket');
  });
});

// ==== Item 1 — findExistingCandidateSlOrder (restart-safe idempotency) =====================

describe('Item 1 — findExistingCandidateSlOrder (restart-safe anti-duplicate scan)', () => {
  it('finds a matching order by side+qty regardless of algoId', () => {
    const found = findExistingCandidateSlOrder({ expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ algoId: 999, side: 'SELL', origQty: 1 })] });
    expect(found?.algoId).toBe(999);
  });
  it('returns null when nothing matches', () => {
    const found = findExistingCandidateSlOrder({ expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ algoId: 999, side: 'BUY', origQty: 1 })] });
    expect(found).toBeNull();
  });
  it('rejects a qty outside tolerance', () => {
    const found = findExistingCandidateSlOrder({ expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, openAlgoOrders: [makeOrder({ algoId: 999, side: 'SELL', origQty: 0.5 })] });
    expect(found).toBeNull();
  });
});

// ==== Item 1 — recoverMissingProtectiveSl (bounded retry + policy) =========================

type MockExecutor = Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;

describe('Item 1 — recoverMissingProtectiveSl', () => {
  it('restart-safe idempotency: adopts an already-resting matching SL instead of placing a duplicate', async () => {
    let placeCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [makeOrder({ algoId: 777, side: 'SELL', origQty: 1 })],
      placeStopMarket: async () => {
        placeCalls++;
        throw new Error('should never be called');
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'OPERATOR_REQUIRED' });
    expect(outcome.status).toBe('ALREADY_RECOVERED_ON_RESTART');
    if (outcome.status === 'ALREADY_RECOVERED_ON_RESTART') expect(outcome.slAlgoId).toBe(777);
    expect(placeCalls).toBe(0);
  });

  it('happy path: place succeeds and is verified on the first attempt', async () => {
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => {
        // First call (idempotency scan): nothing there yet. Second call (post-place verify): the new order.
        callCount++;
        return callCount === 1 ? [] : [makeOrder({ algoId: 42, side: 'SELL', origQty: 1 })];
      },
      placeStopMarket: async () => ({ algoId: 42, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    let callCount = 0;
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'OPERATOR_REQUIRED' });
    expect(outcome.status).toBe('RECOVERED');
    if (outcome.status === 'RECOVERED') {
      expect(outcome.slAlgoId).toBe(42);
      expect(outcome.attemptsUsed).toBe(1);
    }
  });

  it('never trusts the placement response alone: succeeds only after re-verification confirms it (2nd attempt)', async () => {
    let placeCalls = 0;
    let verifyReadCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => {
        verifyReadCalls++;
        if (verifyReadCalls === 1) return []; // idempotency scan
        if (verifyReadCalls === 2) return []; // 1st post-place verify: order not actually visible yet -> fails
        return [makeOrder({ algoId: 2, side: 'SELL', origQty: 1 })]; // 2nd post-place verify: visible
      },
      placeStopMarket: async () => {
        placeCalls++;
        return { algoId: placeCalls === 1 ? 1 : 2, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'OPERATOR_REQUIRED' });
    expect(outcome.status).toBe('RECOVERED');
    if (outcome.status === 'RECOVERED') expect(outcome.attemptsUsed).toBe(2);
    expect(placeCalls).toBe(2);
  });

  it('EXHAUSTED_OPERATOR_REQUIRED: never calls closePositionMarket when policy=OPERATOR_REQUIRED', async () => {
    let closeCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [], // idempotency scan finds nothing, every post-place verify also finds nothing
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [],
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'OPERATOR_REQUIRED' });
    expect(outcome.status).toBe('EXHAUSTED_OPERATOR_REQUIRED');
    if (outcome.status === 'EXHAUSTED_OPERATOR_REQUIRED' || outcome.status === 'EXHAUSTED_EMERGENCY_CLOSED') expect(outcome.attemptsUsed).toBe(MISSING_SL_RECOVERY_MAX_ATTEMPTS);
    expect(closeCalls).toBe(0);
  });

  it('EXHAUSTED_EMERGENCY_CLOSED: calls closePositionMarket exactly once, THEN verifies qty=0 via a fresh getPositionRisk() read (TICKET-G1R-A "Final Safety Hotfix" item 2 — never trusts the close response alone)', async () => {
    let closeCalls = 0;
    let positionRiskCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async (symbol, side, qty) => {
        closeCalls++;
        expect(symbol).toBe('BTCUSDT');
        expect(side).toBe('LONG');
        expect(qty).toBe(1);
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => {
        positionRiskCalls++;
        return [{ symbol: 'BTCUSDT', positionAmt: '0' }]; // exchange confirms fully closed
      },
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSED');
    expect(closeCalls).toBe(1);
    expect(positionRiskCalls).toBe(1);
  });

  it('EXHAUSTED_EMERGENCY_CLOSE_FAILED: close order itself throws (network/reject) — never even reaches the verify read', async () => {
    let positionRiskCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        throw new Error('network down');
      },
      getPositionRisk: async () => {
        positionRiskCalls++;
        return [];
      },
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    if (outcome.status === 'EXHAUSTED_EMERGENCY_CLOSE_FAILED') {
      expect(outcome.closeError).toContain('network down');
      expect(outcome.residualBaseQty).toBeNull();
    }
    expect(positionRiskCalls).toBe(0); // never called — the close order itself failed, nothing to verify
  });

  it('TICKET-G1R-A "Final Safety Hotfix" item 2 — close order ACCEPTED but exchange confirms RESIDUAL qty (partial fill/race) -> EXHAUSTED_EMERGENCY_CLOSE_FAILED, never EXHAUSTED_EMERGENCY_CLOSED, and reports the exact residual qty', async () => {
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.3' }], // only partially closed
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    if (outcome.status === 'EXHAUSTED_EMERGENCY_CLOSE_FAILED') {
      expect(outcome.residualBaseQty).toBe(0.3);
      expect(outcome.closeError).toContain('0.3');
    }
  });

  it('TICKET-G1R-A "Final Safety Hotfix" item 2 — close order ACCEPTED but the verify read itself fails -> EXHAUSTED_EMERGENCY_CLOSE_FAILED with residualBaseQty=null (never assumed closed)', async () => {
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => {
        throw new Error('timeout re-reading position');
      },
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    if (outcome.status === 'EXHAUSTED_EMERGENCY_CLOSE_FAILED') {
      expect(outcome.residualBaseQty).toBeNull();
      expect(outcome.closeError).toContain('timeout re-reading position');
    }
  });

  it('a placeStopMarket() throw does not abort the whole recovery — counts as a failed attempt and retries within budget', async () => {
    let placeCalls = 0;
    const executor: MockExecutor = {
      getOpenAlgoOrders: async () => (placeCalls >= 2 ? [makeOrder({ algoId: 9, side: 'SELL', origQty: 1 })] : []),
      placeStopMarket: async () => {
        placeCalls++;
        if (placeCalls === 1) throw new Error('rate limited');
        return { algoId: 9, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'OPERATOR_REQUIRED' });
    expect(outcome.status).toBe('RECOVERED');
    expect(placeCalls).toBe(2);
  });

  it('default policy export is OPERATOR_REQUIRED (the safer default per the ticket)', () => {
    expect(DEFAULT_MISSING_PROTECTIVE_SL_FAILSAFE_POLICY).toBe('OPERATOR_REQUIRED');
  });

  it('liveRunner.ts wiring: recoverMissingProtectiveSl is only called for positions already inside symbolState.openPositions (proven RECOVERED by Checkpoint C — QUARANTINED sides never reach openPositions at all)', () => {
    const idx = liveRunnerSrc.indexOf('recoverMissingProtectiveSl({');
    expect(idx).toBeGreaterThan(-1);
    // Window widened 2500->3000 in the Runtime Wiring Pass round: item 3 (TICKET-G1R-B) inserted a
    // new verifyTpTiersAndWarn() helper function right before this loop, legitimately growing the
    // source distance between the loop's own declaration and the recoverMissingProtectiveSl() call.
    const surrounding = liveRunnerSrc.slice(Math.max(0, idx - 3000), idx);
    // Called inside the `for (const entry of positionsToVerify)` loop, itself derived from
    // rsForVerify.symbolState.openPositions (never from a separate quarantined-positions list).
    expect(surrounding).toContain('positionsToVerify');
    expect(surrounding).toContain('rsForVerify.symbolState.openPositions');
  });
});

// ==== Item 4 — coherent reconciliation snapshot =============================================

type SnapshotExecutor = Parameters<typeof captureCoherentReconciliationSnapshotOnce>[0];

describe('Item 4 — captureCoherentReconciliationSnapshotOnce', () => {
  const baseParams = { incomeWindowStartMs: 0, incomeWindowEndMs: 1000 };

  it('VALIDATED when all 4 reads succeed, positions unchanged between first and closing re-read, skew within limit', async () => {
    const positions = [{ symbol: 'BTCUSDT', positionAmt: '1.5' }];
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({ totalWalletBalance: '1000' }),
      getPositionRisk: async () => positions,
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotOnce(executor, baseParams);
    expect(result.status).toBe('VALIDATED');
    if (result.status === 'VALIDATED') {
      expect(result.snapshot.balance.source).toBe('getAccountInfo');
      expect(result.snapshot.positions.source).toBe('getPositionRisk');
      expect(result.snapshot.fills.source).toBe('getIncome');
      expect(result.snapshot.protectiveOrders.source).toBe('getOpenAlgoOrders');
      expect(result.snapshot.balance.requestId).not.toBe(result.snapshot.positions.requestId);
      expect(result.maxSkewMs).toBeGreaterThanOrEqual(0);
      expect(result.snapshotEnd).toBeGreaterThanOrEqual(result.snapshotStart);
    }
  });

  it('RETRY_NEEDED (POSITION_CHANGED_MID_CYCLE) when the closing re-read of positions disagrees with the first', async () => {
    let call = 0;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({}),
      getPositionRisk: async () => {
        call++;
        return call === 1 ? [{ symbol: 'BTCUSDT', positionAmt: '1.5' }] : [{ symbol: 'BTCUSDT', positionAmt: '2.0' }];
      },
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotOnce(executor, baseParams);
    expect(result.status).toBe('RETRY_NEEDED');
    if (result.status === 'RETRY_NEEDED') expect(result.reason).toBe('POSITION_CHANGED_MID_CYCLE');
  });

  it('RETRY_NEEDED (SKEW_EXCEEDED) when a read is artificially delayed past skewLimitMs', async () => {
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({}),
      getPositionRisk: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return [];
      },
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotOnce(executor, { ...baseParams, skewLimitMs: 1 });
    expect(result.status).toBe('RETRY_NEEDED');
    if (result.status === 'RETRY_NEEDED') expect(result.reason).toBe('SKEW_EXCEEDED');
  });

  it('READ_ERROR when any of the 4 reads throws — never returns a partial snapshot', async () => {
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({}),
      getPositionRisk: async () => [],
      getIncome: async () => {
        throw new Error('network blip');
      },
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotOnce(executor, baseParams);
    expect(result.status).toBe('READ_ERROR');
  });

  it('name/doc-comment honesty: never claims atomicity — the type is named CoherentReconciliationSnapshot*, not AtomicSnapshot', () => {
    const src = readFileSync(path.resolve(__dirname, './liveStateSync.ts'), 'utf8');
    expect(src).toContain('CoherentReconciliationSnapshotData');
    expect(src).not.toMatch(/AtomicSnapshot/);
  });
});

describe('Item 4 — captureCoherentReconciliationSnapshotWithRetry', () => {
  const baseParams = { incomeWindowStartMs: 0, incomeWindowEndMs: 1000 };

  it('retries the WHOLE cycle (not per-leg) and succeeds once positions stop changing', async () => {
    let positionReadCount = 0;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({}),
      getPositionRisk: async () => {
        positionReadCount++;
        // Cycle 1: both reads return DIFFERENT values (forces retry). Cycle 2: stable.
        if (positionReadCount <= 2) return [{ symbol: 'BTCUSDT', positionAmt: String(positionReadCount) }];
        return [{ symbol: 'BTCUSDT', positionAmt: '9' }];
      },
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { ...baseParams, maxCycles: 3 });
    expect(result.status).toBe('VALIDATED');
    // 2 reads for the failed cycle + 2 reads for the successful cycle = 4 total getPositionRisk calls.
    expect(positionReadCount).toBe(4);
  });

  it('gives up after maxCycles and returns the last RETRY_NEEDED result (not VALIDATED)', async () => {
    let call = 0;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({}),
      getPositionRisk: async () => {
        call++;
        return [{ symbol: 'BTCUSDT', positionAmt: String(call) }]; // always different -> always RETRY_NEEDED
      },
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { ...baseParams, maxCycles: 2 });
    expect(result.status).toBe('RETRY_NEEDED');
  });

  it('a real READ_ERROR is surfaced immediately, never retried blindly', async () => {
    let calls = 0;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => {
        calls++;
        throw new Error('auth failed');
      },
      getPositionRisk: async () => [],
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
    };
    const result = await captureCoherentReconciliationSnapshotWithRetry(executor, { ...baseParams, maxCycles: 5 });
    expect(result.status).toBe('READ_ERROR');
    expect(calls).toBe(1); // not retried 5 times
  });
});

// ==== Item 3 — F03: admission reflects partial realized PnL (Cách B) =======================

describe('Item 3 — F03 admission reflects partial realized PnL (Cách B: bookedRealizedPnl ledger + accountBalanceForAdmission, accountBalance crediting timing UNCHANGED)', () => {
  it('wouldExceedRiskPool (unchanged function) admits a candidate when accountBalanceForAdmission (real balance + booked partial PnL) is used, that the same candidate would be rejected under the real accountBalance alone — proves the mechanism actually changes admission outcomes, not just an inert audit field', () => {
    const openPositionsRisk = [{ id: 'OTHER', actualRiskDollar: 14 }];
    const candidateRisk = 2;
    const realAccountBalance = 100; // 15% cap = $15; 14 + 2 = 16 > 15 -> rejected on real balance alone
    const bookedRealizedPnlPortfolio = 50; // TP1 already filled on another position, not yet credited to accountBalance
    const rejectedOnRealBalance = wouldExceedRiskPool(openPositionsRisk, candidateRisk, realAccountBalance, { riskPoolMaxPct: 0.15 });
    const admittedWithBookedPnl = wouldExceedRiskPool(openPositionsRisk, candidateRisk, realAccountBalance + bookedRealizedPnlPortfolio, { riskPoolMaxPct: 0.15 });
    expect(rejectedOnRealBalance).toBe(true);
    expect(admittedWithBookedPnl).toBe(false);
  });

  it('orchestrator.ts source-scan: accountBalanceForAdmission (= accountBalance + bookedRealizedPnlPortfolio) feeds wouldExceedRiskPool/wouldExceedMaxTotalMargin/checkRiskPool, never the sizer\'s own accountBalance param', () => {
    expect(orchestratorSrc).toContain('const accountBalanceForAdmission = accountBalance + (input.bookedRealizedPnlPortfolio ?? 0);');
    expect(orchestratorSrc).toContain('wouldExceedRiskPool(input.allOpenPositionsRisk, sizingOutput.actualRiskDollar, accountBalanceForAdmission,');
    expect(orchestratorSrc).toContain('wouldExceedMaxTotalMargin(input.totalOpenMarginDollar ?? 0, sizingOutput.marginRequired, accountBalanceForAdmission,');
    // The sizer itself must still size off the REAL balance (real dollars available), never the inflated admission figure.
    expect(orchestratorSrc).toContain('new DynamicRMarginSizer().calculate({\n    accountBalance,');
  });

  it('orchestrator.ts source-scan: accountBalance crediting timing is UNCHANGED — still exactly one `accountBalance +=` site (at full CLOSE), PARTIAL_CLOSE branch never mutates accountBalance', () => {
    const matches = orchestratorSrc.match(/accountBalance\s*\+=/g);
    expect(matches).toHaveLength(1);
    expect(orchestratorSrc).toContain('accountBalance += pnlUsd;');
  });

  it('orchestrator.ts source-scan: bookedRealizedPnl is accumulated additively per tier, never reset/overwritten, and never read by the CLOSE branch\'s own crediting line (no double-count path)', () => {
    expect(orchestratorSrc).toContain('bookedRealizedPnl: entry.meta.bookedRealizedPnl + tierPnlUsd');
    // computeRealizedPnl() (the CLOSE crediting call) takes only (position, exitPrice) — never meta, so it structurally cannot read bookedRealizedPnl.
    expect(orchestratorSrc).toContain('const pnlUsd = computeRealizedPnl(position, exitPrice as number);');
  });

  it('backtest keeps modeled booked PnL while live admission does not add it to exchange wallet balance', () => {
    const backtestSrc = readFileSync(path.resolve(__dirname, '../../scripts/backtest.ts'), 'utf8');
    expect(backtestSrc).toContain('bookedRealizedPnlPortfolio');
    expect(liveRunnerSrc).not.toContain('bookedRealizedPnlPortfolio');
  });
});
