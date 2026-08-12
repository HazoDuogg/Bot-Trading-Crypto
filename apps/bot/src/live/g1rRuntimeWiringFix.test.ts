/**
 * TICKET-G1R-B "Runtime Wiring Pass" — regression/behavior tests for items 1 (in-run SL/TP monitor),
 * 2 (coherent snapshot wired into the periodic cycle), and 3 (TP verification, both startup and
 * in-run). Same convention as every prior G1R checkpoint test file: real behavior tests through the
 * actual exported functions (runProtectiveOrderMonitorSweep/runAccountSyncCycle in liveStateSync.ts —
 * the SAME functions liveRunner.ts's real setInterval callback calls, see the source-scan tests at the
 * bottom proving that wiring), mocked executor, no real network access.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runProtectiveOrderMonitorSweep,
  runAccountSyncCycle,
  type ProtectiveMonitorPositionInput,
} from './liveStateSync.js';
import type { OpenAlgoOrder, BinanceOrderExecutor } from './binanceOrderExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');

function makeOrder(overrides: Partial<OpenAlgoOrder>): OpenAlgoOrder {
  return { algoId: 1, symbol: 'BTCUSDT', side: 'SELL', origQty: 1, triggerPrice: 100, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {}, ...overrides };
}

function makePosition(overrides: Partial<ProtectiveMonitorPositionInput> = {}): ProtectiveMonitorPositionInput {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryTimestamp: 1000,
    remainingPositionSize: 100, // quote notional
    positionSize: 100,
    entryPrice: 100,
    currentSlPrice: 95,
    tpLevels: [
      { label: 'TP1', price: 110, closePercent: 0.5 },
      { label: 'TP2', price: 120, closePercent: 0.3 },
      { label: 'TP3_RUNNER', price: null, closePercent: 0.2 },
    ],
    filledTiers: [],
    slAlgoId: 501,
    tpAlgoIds: [601, 602],
    quantityTolerance: 0.001,
    ...overrides,
  };
}

type FullExecutor = Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;
type SnapshotExecutor = Parameters<typeof runAccountSyncCycle>[0]['executor'];

// ==== Item 1 — SL missing mid-run (in-run, not just startup) =================================

describe('Item 1 — runProtectiveOrderMonitorSweep: SL missing mid-run', () => {
  it('SL algoId no longer resting on the exchange -> bounded recovery -> RECOVERED, position stays managed', async () => {
    const position = makePosition();
    let placeCalls = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => (placeCalls === 0 ? [] : [makeOrder({ algoId: 999, side: 'SELL', origQty: 1, triggerPrice: 95 })]),
      placeStopMarket: async () => {
        placeCalls++;
        return { algoId: 999, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      closePositionMarket: async () => {
        throw new Error('should never be called — recovery succeeds');
      },
      getPositionRisk: async () => [],
    };
    // The whole-account read for THIS cycle (already fetched by the caller, one call) shows the SL
    // algoId (501) is gone — the sweep must detect this and attempt recovery without ANY new call
    // to getOpenAlgoOrders() for the sweep itself (only recoverMissingProtectiveSl's own bounded
    // per-symbol repair reads, which the mock above provides).
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(results).toHaveLength(1);
    expect(results[0].sl.status).toBe('RECOVERED');
    if (results[0].sl.status === 'RECOVERED') expect(results[0].sl.newSlAlgoId).toBe(999);
  });

  it('SL missing, recovery exhausted, policy=OPERATOR_REQUIRED -> PROTECTION_DEGRADED (TICKET-G1R-A "Final Safety Hotfix" item 1 — NEVER QUARANTINE/removed, position stays fully managed), never calls closePositionMarket', async () => {
    const position = makePosition();
    let closeCalls = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [], // idempotency scan and every re-verify find nothing
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [],
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('PROTECTION_DEGRADED');
    if (results[0].sl.status === 'PROTECTION_DEGRADED') {
      expect(results[0].sl.reason).toBe('OPERATOR_REQUIRED');
      expect(results[0].sl.residualBaseQty).toBeNull();
    }
    expect(closeCalls).toBe(0);
  });

  it('SL missing, recovery exhausted, policy=EMERGENCY_CLOSE, exchange CONFIRMS qty=0 -> QUARANTINE(EMERGENCY_CLOSED) — the ONLY case removed from the ledger, closePositionMarket called exactly once for the FULL remaining qty', async () => {
    const position = makePosition({ remainingPositionSize: 50, entryPrice: 100 }); // expectedQty = 0.5
    let closeCalls = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async (symbol, side, qty) => {
        closeCalls++;
        expect(symbol).toBe('BTCUSDT');
        expect(side).toBe('LONG');
        expect(qty).toBe(0.5);
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }], // item 2 — verified closed
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'EMERGENCY_CLOSE', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('QUARANTINE');
    if (results[0].sl.status === 'QUARANTINE') expect(results[0].sl.reason).toBe('EMERGENCY_CLOSED');
    expect(closeCalls).toBe(1);
  });

  it('TICKET-G1R-A "Final Safety Hotfix" items 1+2 — SL missing, recovery exhausted, policy=EMERGENCY_CLOSE, but exchange confirms RESIDUAL qty after close -> PROTECTION_DEGRADED(EMERGENCY_CLOSE_FAILED), NEVER QUARANTINE — position stays fully managed with the residual qty reported', async () => {
    const position = makePosition({ remainingPositionSize: 50, entryPrice: 100 }); // expectedQty = 0.5
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.2' }], // partial fill — still exposed
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'EMERGENCY_CLOSE', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('PROTECTION_DEGRADED');
    if (results[0].sl.status === 'PROTECTION_DEGRADED') {
      expect(results[0].sl.reason).toBe('EMERGENCY_CLOSE_FAILED');
      expect(results[0].sl.residualBaseQty).toBe(0.2);
    }
  });

  it('restart interrupted mid-repair, resumed process finds the ALREADY-placed SL (findExistingCandidateSlOrder) -> RECOVERED, no duplicate placeStopMarket call', async () => {
    const position = makePosition();
    let placeCalls = 0;
    // Simulates: a PRIOR process's attempt already placed a real SL (algoId 888) then crashed before
    // persisting it. This fresh sweep's whole-account read for the cycle already shows it missing from
    // the OLD persisted id (501), but the idempotency scan inside recoverMissingProtectiveSl (its own
    // fresh per-symbol read) finds the already-resting order and adopts it.
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [makeOrder({ algoId: 888, side: 'SELL', origQty: 1, triggerPrice: 95 })],
      placeStopMarket: async () => {
        placeCalls++;
        throw new Error('must never place a duplicate — the existing order should be adopted instead');
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('RECOVERED');
    if (results[0].sl.status === 'RECOVERED') expect(results[0].sl.newSlAlgoId).toBe(888);
    expect(placeCalls).toBe(0);
  });

  it('VERIFIED SL (still resting, correct side/qty) produces no repair calls at all', async () => {
    const position = makePosition();
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => {
        throw new Error('must never be called — the sweep already has the whole-account read, no repair needed');
      },
      placeStopMarket: async () => {
        throw new Error('must never be called');
      },
      closePositionMarket: async () => {
        throw new Error('must never be called');
      },
      getPositionRisk: async () => [],
    };
    const openAlgoOrders = [makeOrder({ algoId: 501, side: 'SELL', origQty: 1, triggerPrice: 95 })]; // expectedQty = 100/100 = 1
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders });
    expect(results[0].sl.status).toBe('VERIFIED');
  });
});

// ==== Item 3 — TP verification: remaining/fill-tier awareness =================================

describe('Item 3 — runProtectiveOrderMonitorSweep: TP tier classification (EXPECTED_ACTIVE / ALREADY_FILLED / STALE)', () => {
  it('a not-yet-filled tier missing its resting order -> MISSING_ACTIVE finding', async () => {
    const position = makePosition({ filledTiers: [] });
    const openAlgoOrders = [makeOrder({ algoId: 501, side: 'SELL', origQty: 1, triggerPrice: 95 })]; // SL VERIFIED, no TP orders present
    const executor: FullExecutor = { getOpenAlgoOrders: async () => [], placeStopMarket: async () => { throw new Error('n/a'); }, closePositionMarket: async () => { throw new Error('n/a'); }, getPositionRisk: async () => [] };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders });
    expect(results[0].tpFindings).toHaveLength(2); // TP1 and TP2 both expected-active and both missing
    expect(results[0].tpFindings.map((f) => f.kind)).toEqual(['MISSING_ACTIVE', 'MISSING_ACTIVE']);
  });

  it('TP1 already filled, its algoId no longer resting -> CLEAN (not a finding); TP2 still expected-active and present -> VERIFIED (not a finding)', async () => {
    // After TP1 fires, remainingPositionSize shrinks but positionSize (original reconciled total)
    // stays the SAME — TP2's own order qty basis is closePercent * (positionSize/entryPrice), the
    // ORIGINAL total, not the post-TP1 remaining amount (ticket item 3's "remaining/fill tiers"
    // requirement: the tier's own qty was fixed at OPEN against the reconciled canonicalQty, never
    // re-derived from the currently-shrunk remainingPositionSize).
    const position = makePosition({ filledTiers: ['TP1'], remainingPositionSize: 50, positionSize: 100 });
    const openAlgoOrders = [
      makeOrder({ algoId: 501, side: 'SELL', origQty: 0.5, triggerPrice: 95 }), // SL now covers only the remaining 0.5 base qty
      makeOrder({ algoId: 602, side: 'SELL', origQty: 0.3, triggerPrice: 120, orderType: 'TAKE_PROFIT_MARKET' }), // TP2 = 0.3 closePercent * (100/100) = 0.3 base qty, unchanged since open
    ];
    const executor: FullExecutor = { getOpenAlgoOrders: async () => [], placeStopMarket: async () => { throw new Error('n/a'); }, closePositionMarket: async () => { throw new Error('n/a'); }, getPositionRisk: async () => [] };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders });
    expect(results[0].sl.status).toBe('VERIFIED');
    expect(results[0].tpFindings).toHaveLength(0); // TP1: already-filled+no order = clean; TP2: expected-active+present+correct qty = clean
  });

  it('a tier already filled but its algoId is STILL resting on the exchange -> STALE_FILLED_TIER finding (warning, not critical)', async () => {
    const position = makePosition({ filledTiers: ['TP1'], remainingPositionSize: 50, positionSize: 100 });
    const openAlgoOrders = [
      makeOrder({ algoId: 501, side: 'SELL', origQty: 0.5, triggerPrice: 95 }),
      makeOrder({ algoId: 601, side: 'SELL', origQty: 0.5, triggerPrice: 110, orderType: 'TAKE_PROFIT_MARKET' }), // TP1's own algoId — SHOULD be gone (filled), but still resting
      makeOrder({ algoId: 602, side: 'SELL', origQty: 0.3, triggerPrice: 120, orderType: 'TAKE_PROFIT_MARKET' }),
    ];
    const executor: FullExecutor = { getOpenAlgoOrders: async () => [], placeStopMarket: async () => { throw new Error('n/a'); }, closePositionMarket: async () => { throw new Error('n/a'); }, getPositionRisk: async () => [] };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders });
    expect(results[0].tpFindings).toHaveLength(1);
    expect(results[0].tpFindings[0]).toMatchObject({ tpAlgoId: 601, tier: 'TP1', kind: 'STALE_FILLED_TIER' });
  });

  it('TP findings never appear when the position is being QUARANTINED/PROTECTION_DEGRADED this cycle (SL CRITICAL is never obscured by a co-occurring TP WARNING)', async () => {
    const position = makePosition({ filledTiers: [] });
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [], // SL recovery exhausted
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        throw new Error('n/a — OPERATOR_REQUIRED');
      },
      getPositionRisk: async () => [],
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    // OPERATOR_REQUIRED is PROTECTION_DEGRADED (item 1), not QUARANTINE — either way TP findings must
    // be suppressed for a position whose SL outcome this cycle is not a clean VERIFIED/RECOVERED.
    expect(results[0].sl.status).toBe('PROTECTION_DEGRADED');
    expect(results[0].tpFindings).toHaveLength(0);
  });
});

// ==== Item 1+2 — runAccountSyncCycle: one whole-account read powers both admission-relevant snapshot
// AND the protective-order sweep, fail-closed on any snapshot failure ==========================

describe('Item 1+2 — runAccountSyncCycle (the real periodic entrypoint liveRunner.ts wires)', () => {
  const baseParams = { positions: [makePosition()], policy: 'OPERATOR_REQUIRED' as const, incomeWindowStartMs: 0, incomeWindowEndMs: 1000 };

  it('API timeout during the periodic snapshot itself -> SNAPSHOT_FAILED (READ_ERROR), sweep never runs, no partial data used', async () => {
    let sweepWouldHaveBeenCalled = false;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({ totalWalletBalance: '1000' }),
      getPositionRisk: async () => [],
      getIncome: async () => {
        throw new Error('ETIMEDOUT');
      },
      getOpenAlgoOrders: async () => {
        sweepWouldHaveBeenCalled = true;
        return [];
      },
      placeStopMarket: async () => {
        throw new Error('n/a');
      },
      closePositionMarket: async () => {
        throw new Error('n/a');
      },
    };
    const result = await runAccountSyncCycle({ executor, ...baseParams });
    expect(result.status).toBe('SNAPSHOT_FAILED');
    if (result.status === 'SNAPSHOT_FAILED') expect(result.snapshotStatus).toBe('READ_ERROR');
    // getOpenAlgoOrders is called by getIncome... no — but positions changed mid-cycle path calls
    // getOpenAlgoOrders AFTER getIncome, which already threw — so it should never be reached.
    expect(sweepWouldHaveBeenCalled).toBe(false);
  });

  it('snapshot VALIDATED -> the sweep runs using the snapshot\'s OWN protectiveOrders leg (data flows from the snapshot into the monitor, not a separate call)', async () => {
    let openAlgoOrdersCallCount = 0;
    const openAlgoOrdersFromSnapshot = [makeOrder({ algoId: 501, side: 'SELL', origQty: 1, triggerPrice: 95 })]; // matches makePosition()'s persisted slAlgoId=501 -> VERIFIED
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({ totalWalletBalance: '1000' }),
      getPositionRisk: async () => [],
      getIncome: async () => [],
      getOpenAlgoOrders: async () => {
        openAlgoOrdersCallCount++;
        return openAlgoOrdersFromSnapshot;
      },
      placeStopMarket: async () => {
        throw new Error('n/a — SL is VERIFIED, no repair needed');
      },
      closePositionMarket: async () => {
        throw new Error('n/a');
      },
    };
    const result = await runAccountSyncCycle({ executor, ...baseParams });
    expect(result.status).toBe('OK');
    if (result.status === 'OK') {
      expect(result.positionResults[0].sl.status).toBe('VERIFIED');
      // Exactly ONE getOpenAlgoOrders() call for the whole cycle (the snapshot's own protectiveOrders
      // leg) — the sweep itself must NOT issue a second whole-account call.
      expect(openAlgoOrdersCallCount).toBe(1);
    }
  });

  it('snapshot RETRY_NEEDED (position changed mid-cycle) exhausts retries -> SNAPSHOT_FAILED, sweep never runs', async () => {
    let positionsCall = 0;
    const executor: SnapshotExecutor = {
      getAccountInfo: async () => ({ totalWalletBalance: '1000' }),
      getPositionRisk: async () => {
        positionsCall++;
        // Every cycle sees the position change between its own first/closing re-read — persistent skew, never settles.
        return positionsCall % 2 === 0 ? [{ symbol: 'BTCUSDT', positionAmt: '1' }] : [{ symbol: 'BTCUSDT', positionAmt: '2' }];
      },
      getIncome: async () => [],
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => {
        throw new Error('n/a');
      },
      closePositionMarket: async () => {
        throw new Error('n/a');
      },
    };
    const result = await runAccountSyncCycle({ executor, ...baseParams, maxCycles: 2 });
    expect(result.status).toBe('SNAPSHOT_FAILED');
    if (result.status === 'SNAPSHOT_FAILED') expect(result.snapshotStatus).toBe('RETRY_NEEDED');
  });
});

// ==== liveRunner.ts wiring — proves the REAL runtime path uses these functions, not just that the
// module exists unused (source-scan, since liveRunner.ts calls main() unconditionally at import and
// cannot be imported/executed directly — same documented constraint as every other G1R wiring test) ==

describe('liveRunner.ts wiring — the periodic in-run monitor is REALLY wired', () => {
  it('a setInterval calls runAccountSyncCycleTick, which calls the real snapshot+sweep primitives (captureCoherentReconciliationSnapshotWithRetry + runProtectiveOrderMonitorSweep, imported from liveStateSync.js), on its OWN interval (not the 5s tick loop)', () => {
    // TICKET-G1R-A "Freshness Bootstrap Hotfix" item 2 inlined runAccountSyncCycle()'s own two steps
    // (capture-then-sweep) directly into liveRunner.ts's captureAndApplyFreshnessSnapshot() +
    // runAccountSyncCycleTickBody(), so the freshness/exposure work (steps a/b/c) is NEVER skipped by
    // the sweep-only (step d) `positions.length === 0` optimization — see g1rFreshnessBootstrapHotfixFix.test.ts.
    expect(liveRunnerSrc).toContain('captureCoherentReconciliationSnapshotWithRetry,');
    expect(liveRunnerSrc).toContain('runProtectiveOrderMonitorSweep,');
    expect(liveRunnerSrc).toContain("} from '../dist/live/liveStateSync.js'");
    expect(liveRunnerSrc).toContain('const accountSyncCycleTimer = setInterval(() => void runAccountSyncCycleTick(), ACCOUNT_SYNC_CYCLE_INTERVAL_MS);');
    expect(liveRunnerSrc).toContain('await captureCoherentReconciliationSnapshotWithRetry(executor, {');
    expect(liveRunnerSrc).toContain('await runProtectiveOrderMonitorSweep({');
    // Distinct constant from TICK_INTERVAL_MS (5000ms) — never accidentally the same variable.
    const match = liveRunnerSrc.match(/const ACCOUNT_SYNC_CYCLE_INTERVAL_MS = ([\d_* ]+);/);
    expect(match).not.toBeNull();
    // eslint-disable-next-line no-eval
    const value = Function(`return (${match![1]})`)();
    expect(value).toBeGreaterThanOrEqual(2 * 60_000);
    expect(value).toBeLessThanOrEqual(5 * 60_000);
  });

  it('buildProtectiveMonitorInputs() excludes entriesBlockedDueToRestartQuarantineBySymbol — never touches a quarantined symbol', () => {
    const fnStart = liveRunnerSrc.indexOf('function buildProtectiveMonitorInputs()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  }\n', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)');
    expect(fnBody).toContain('continue');
  });

  it('a QUARANTINE outcome from the in-run cycle reuses entriesBlockedDueToRestartQuarantineBySymbol and removes the position from openPositions — the SAME mechanism as every other quarantine trigger, never a new parallel one', () => {
    // TICKET-G1R-A "Final Safety Hotfix" item 3 renamed the real cycle body to
    // runAccountSyncCycleTickBody() (wrapped by a thin single-flight runAccountSyncCycleTick()) — the
    // body containing the QUARANTINE/PROTECTION_DEGRADED handling lives there now.
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain("posResult.sl.status === 'QUARANTINE'");
    expect(fnBody).toContain('entriesBlockedDueToRestartQuarantineBySymbol.add(posResult.symbol)');
    expect(fnBody).toContain('rs.symbolState.openPositions = rs.symbolState.openPositions.filter(');
    // item 1 (THE confirmed bug fix) — PROTECTION_DEGRADED (OPERATOR_REQUIRED / EMERGENCY_CLOSE_FAILED)
    // must NEVER join the same removal path as a confirmed QUARANTINE close.
    expect(fnBody).toContain("posResult.sl.status === 'PROTECTION_DEGRADED'");
    const degradedIdx = fnBody.indexOf("posResult.sl.status === 'PROTECTION_DEGRADED'");
    const quarantineIdx = fnBody.indexOf("posResult.sl.status === 'QUARANTINE'");
    const degradedBranch = fnBody.slice(degradedIdx, fnBody.indexOf('} else if', degradedIdx) === -1 ? fnBody.length : fnBody.indexOf('} else if', degradedIdx));
    expect(degradedBranch).not.toContain('entriesBlockedDueToRestartQuarantineBySymbol.add');
    expect(degradedBranch).not.toContain('openPositions.filter');
    expect(quarantineIdx).toBeGreaterThan(-1);
    // TP findings are logged as WARNING and never touch the quarantine Set.
    const tpFindingsIdx = fnBody.indexOf('for (const finding of posResult.tpFindings)');
    expect(tpFindingsIdx).toBeGreaterThan(-1);
    const afterTpFindings = fnBody.slice(tpFindingsIdx);
    expect(afterTpFindings).not.toContain('entriesBlockedDueToRestartQuarantineBySymbol.add');
  });

  it('shutdown() clears the accountSyncCycleTimer — no orphaned interval after SIGINT/SIGTERM', () => {
    const shutdownStart = liveRunnerSrc.indexOf('const shutdown = async');
    const shutdownEnd = liveRunnerSrc.indexOf('process.on(\'SIGINT\'', shutdownStart);
    const shutdownBody = liveRunnerSrc.slice(shutdownStart, shutdownEnd);
    expect(shutdownBody).toContain('clearInterval(accountSyncCycleTimer);');
  });

  it('verifyTpTiersAndWarn (startup TP verification) is called for BOTH the already-VERIFIED-SL and the RECOVERED-SL branches, never for a branch that ends in quarantine', () => {
    const loopStart = liveRunnerSrc.indexOf('for (const outcome of restartRecovery.symbols) {', liveRunnerSrc.indexOf('function verifyTpTiersAndWarn'));
    const loopEnd = liveRunnerSrc.indexOf('\n  if (accountSyncState ===', loopStart);
    const loopBody = liveRunnerSrc.slice(loopStart, loopEnd);
    const callCount = loopBody.split('verifyTpTiersAndWarn(outcome.symbol, entry, ids, openAlgoOrders)').length - 1;
    expect(callCount).toBe(2);
  });
});
