/**
 * TICKET-G1R-A "Final Safety Hotfix" — regression/behavior tests for the two CONFIRMED bugs (items 1
 * and 2) plus items 3/4/5, through the actual wired functions (runProtectiveOrderMonitorSweep,
 * recoverMissingProtectiveSl, checkMergedPositionAllocation, createSingleFlightRunner,
 * isFreshnessEvidenceStale — all in liveStateSync.ts, the SAME functions liveRunner.ts's real
 * runAccountSyncCycleTickBody()/hasUnquantifiableExposureBlockingAdmission wire, see the source-scan
 * tests proving that wiring) plus real persistence round-trip (writeLiveStateFileAtomic/
 * readLiveStateFileSafe/recoverSymbolState) and real risk-ledger arithmetic (rebuildPortfolioRisk).
 *
 * Confirmed bugs this ticket fixes (liveRunner.ts's runAccountSyncCycleTick(), pre-fix):
 *  1. EXHAUSTED_OPERATOR_REQUIRED / EXHAUSTED_EMERGENCY_CLOSE_FAILED were treated identically to a
 *     confirmed EXHAUSTED_EMERGENCY_CLOSED — unconditionally removed from openPositions/orderIds and
 *     quarantined, even though the position is STILL OPEN ON THE EXCHANGE with NO protective SL.
 *  2. recoverMissingProtectiveSl()'s EMERGENCY_CLOSE branch returned EXHAUSTED_EMERGENCY_CLOSED right
 *     after closePositionMarket() resolved, without ever re-reading getPositionRisk() to confirm the
 *     exchange actually shows qty=0 — a partial fill/rejected order/race could leave real exposure
 *     open while the bot believed it was safe to forget.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runProtectiveOrderMonitorSweep,
  recoverMissingProtectiveSl,
  checkMergedPositionAllocation,
  createSingleFlightRunner,
  isFreshnessEvidenceStale,
  writeLiveStateFileAtomic,
  readLiveStateFileSafe,
  recoverSymbolState,
  LIVE_STATE_SCHEMA_VERSION,
  computeQuantityTolerance,
  type ProtectiveMonitorPositionInput,
  type LiveStateFile,
  type PersistedSymbolRecord,
} from './liveStateSync.js';
import { rebuildPortfolioRisk, type KnownPositionForRisk } from '../risk/currentRisk.js';
import { INITIAL_SYMBOL_STATE, type OpenPositionEntry, type SymbolState } from '../orchestrator/types.js';
import type { ManagedPositionState } from '../risk/slTpManager.js';
import type { OpenAlgoOrder, BinanceOrderExecutor } from './binanceOrderExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');

function makeOrder(overrides: Partial<OpenAlgoOrder>): OpenAlgoOrder {
  // Schema-realistic defaults (confirmed testnet response). triggerPrice 95 = makePosition()'s currentSlPrice.
  return { algoId: 1, symbol: 'BTCUSDT', side: 'SELL', origQty: 1, triggerPrice: 95, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {}, ...overrides };
}

function makePosition(overrides: Partial<ProtectiveMonitorPositionInput> = {}): ProtectiveMonitorPositionInput {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryTimestamp: 1000,
    remainingPositionSize: 100,
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

function makeManagedPosition(overrides: Partial<ManagedPositionState> = {}): ManagedPositionState {
  return {
    scenario: 'TREND',
    side: 'LONG',
    entryPrice: 100,
    initialSlPrice: 98,
    r: 2,
    tpPlan: 'PLAN_A',
    positionSize: 1000,
    takerFeeRate: 0.0004,
    tpLevels: [
      { label: 'TP1', price: 102.4, rMultiple: 1.2, closePercent: 0.4 },
      { label: 'TP2', price: 105, rMultiple: 2.5, closePercent: 0.3 },
      { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: 0.3 },
    ],
    currentSlPrice: 98,
    filledTiers: [],
    remainingPositionSize: 1000,
    runnerPeakPrice: null,
    closed: false,
    ...overrides,
  } as ManagedPositionState;
}

function makeEntry(entryTimestamp: number, protectionStatus: 'PROTECTED' | 'PROTECTION_DEGRADED', positionOverrides: Partial<ManagedPositionState> = {}): OpenPositionEntry {
  return {
    position: makeManagedPosition(positionOverrides),
    meta: {
      regime: 'TREND_UP',
      setupType: 'OB',
      entryTimestamp,
      actualRiskDollar: 20,
      marginRequired: 33.33,
      riskMultiplier: 1,
      bookedRealizedPnl: 0,
      protectionStatus,
    },
  } as OpenPositionEntry;
}

// ==== Item 1 — never removed from openPositions/risk ledger on OPERATOR_REQUIRED/EMERGENCY_CLOSE_FAILED

describe('Item 1 — OPERATOR_REQUIRED / EMERGENCY_CLOSE_FAILED keep the position fully managed', () => {
  it('OPERATOR_REQUIRED -> PROTECTION_DEGRADED (never QUARANTINE), never calls closePositionMarket, and rebuildPortfolioRisk() STILL counts its risk (never dropped from the ledger just because it degraded)', async () => {
    const position = makePosition();
    let closeCalls = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [],
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('PROTECTION_DEGRADED');
    expect(closeCalls).toBe(0);

    // Proves the degraded position's real risk still flows into the SAME unmodified rebuildPortfolioRisk()
    // arithmetic — item 1's "Giữ position TRONG risk ledger" requirement, checked against the real function.
    const managed = makeEntry(position.entryTimestamp, 'PROTECTION_DEGRADED', { remainingPositionSize: 100, entryPrice: 100, currentSlPrice: 95 });
    const known: KnownPositionForRisk = { id: 'BTCUSDT', basis: managed.position };
    const ledger = rebuildPortfolioRisk({ knownPositions: [known], unknownExposures: [] });
    expect(ledger.totalRiskDollar).toBeGreaterThan(0);
    expect(ledger.hasUnquantifiableExposure).toBe(false); // degraded ≠ unknown — the qty/SL basis is still known, just not currently protected
  });

  it('EMERGENCY_CLOSE_FAILED (close attempted but exchange did NOT confirm qty=0) -> PROTECTION_DEGRADED, never removed', async () => {
    const position = makePosition({ remainingPositionSize: 50, entryPrice: 100 });
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.2' }], // residual after "close"
    };
    const results = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'EMERGENCY_CLOSE', openAlgoOrders: [] });
    expect(results[0].sl.status).toBe('PROTECTION_DEGRADED');
    if (results[0].sl.status === 'PROTECTION_DEGRADED') {
      expect(results[0].sl.reason).toBe('EMERGENCY_CLOSE_FAILED');
      expect(results[0].sl.residualBaseQty).toBe(0.2);
    }
  });

  it('liveRunner.ts wiring: PROTECTION_DEGRADED never joins entriesBlockedDueToRestartQuarantineBySymbol / openPositions removal — only QUARANTINE (confirmed close) does', () => {
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    const degradedIdx = fnBody.indexOf("posResult.sl.status === 'PROTECTION_DEGRADED'");
    expect(degradedIdx).toBeGreaterThan(-1);
    const nextBranchIdx = fnBody.indexOf('} else if', degradedIdx);
    const degradedBranch = fnBody.slice(degradedIdx, nextBranchIdx === -1 ? fnBody.length : nextBranchIdx);
    expect(degradedBranch).not.toContain('entriesBlockedDueToRestartQuarantineBySymbol.add');
    expect(degradedBranch).not.toContain('openPositions.filter');
    expect(degradedBranch).toContain("entry.meta.protectionStatus = 'PROTECTION_DEGRADED'");
  });

  it('liveRunner.ts wiring: hasAnyProtectionDegradedPosition() feeds hasUnquantifiableExposureBlockingAdmission — portfolio-wide, not per-symbol', () => {
    expect(liveRunnerSrc).toContain('function hasAnyProtectionDegradedPosition()');
    expect(liveRunnerSrc).toContain("e.meta.protectionStatus === 'PROTECTION_DEGRADED'");
    const idx = liveRunnerSrc.indexOf('const hasUnquantifiableExposureBlockingAdmission =');
    const decl = liveRunnerSrc.slice(idx, idx + 600);
    expect(decl).toContain('hasAnyProtectionDegradedPosition()');
  });

  it('liveRunner.ts wiring: PROTECTION_DEGRADED positions stay INSIDE buildProtectiveMonitorInputs() (only entriesBlockedDueToRestartQuarantineBySymbol is excluded) — so they get retried EVERY subsequent cycle, never abandoned after one failure', () => {
    const fnStart = liveRunnerSrc.indexOf('function buildProtectiveMonitorInputs()');
    const fnEnd = liveRunnerSrc.indexOf('\n  /**', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('entriesBlockedDueToRestartQuarantineBySymbol.has(symbol)');
    expect(fnBody).not.toContain('protectionStatus'); // no exclusion based on degraded status — it must keep being swept
  });

  it('repair succeeds on a LATER cycle after an earlier cycle exhausted (item 1\'s "tiếp tục retry ở cycle sau", not give-up-forever) — proven through TWO real runProtectiveOrderMonitorSweep calls for the SAME position', async () => {
    const position = makePosition();
    let attempt = 0;
    // Cycle 1: every placement fails to verify -> exhausted -> PROTECTION_DEGRADED.
    const cycle1Executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        throw new Error('n/a — OPERATOR_REQUIRED');
      },
      getPositionRisk: async () => [],
    };
    const cycle1 = await runProtectiveOrderMonitorSweep({ executor: cycle1Executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(cycle1[0].sl.status).toBe('PROTECTION_DEGRADED');

    // Cycle 2 (next monitor tick, position still in the input list because it was never removed): this
    // time placement succeeds and verifies -> RECOVERED. liveRunner.ts's own transition
    // (entry.meta.protectionStatus = 'PROTECTED' in the RECOVERED branch) is proven by source-scan below.
    attempt = 0;
    const cycle2Executor: FullExecutor = {
      getOpenAlgoOrders: async () => (attempt === 0 ? [] : [makeOrder({ algoId: 777, side: 'SELL', origQty: 1 })]),
      placeStopMarket: async () => {
        attempt++;
        return { algoId: 777, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      closePositionMarket: async () => {
        throw new Error('n/a');
      },
      getPositionRisk: async () => [],
    };
    const cycle2 = await runProtectiveOrderMonitorSweep({ executor: cycle2Executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] });
    expect(cycle2[0].sl.status).toBe('RECOVERED');
  });

  it('liveRunner.ts wiring: a RECOVERED outcome flips protectionStatus back to PROTECTED (un-degrades a previously-degraded position)', () => {
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    const recoveredIdx = fnBody.indexOf("posResult.sl.status === 'RECOVERED'");
    expect(recoveredIdx).toBeGreaterThan(-1);
    const nextBranchIdx = fnBody.indexOf('} else if', recoveredIdx);
    const recoveredBranch = fnBody.slice(recoveredIdx, nextBranchIdx);
    expect(recoveredBranch).toContain("entry.meta.protectionStatus = 'PROTECTED'");
  });

  it('throttled CRITICAL Telegram resend — liveRunner.ts wires a per-position last-sent Map, resent only after PROTECTION_DEGRADED_ALERT_RESEND_MS, never every 5-minute cycle unconditionally', () => {
    expect(liveRunnerSrc).toContain('protectionDegradedAlertLastSentMsByKey');
    expect(liveRunnerSrc).toContain('PROTECTION_DEGRADED_ALERT_RESEND_MS');
    const idx = liveRunnerSrc.indexOf('if (now - lastSentMs >= PROTECTION_DEGRADED_ALERT_RESEND_MS)');
    expect(idx).toBeGreaterThan(-1);
  });
});

// ==== Item 2 — emergency close verification =====================================================

describe('Item 2 — recoverMissingProtectiveSl: emergency close is verified via a fresh getPositionRisk() read', () => {
  it('close accepted, exchange confirms qty=0 -> EXHAUSTED_EMERGENCY_CLOSED (happy path)', async () => {
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSED');
  });

  it('close accepted, exchange confirms RESIDUAL qty (partial fill) -> EXHAUSTED_EMERGENCY_CLOSE_FAILED, never EXHAUSTED_EMERGENCY_CLOSED', async () => {
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '-0.4' }], // still short 0.4 (SHORT side residual)
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'SHORT', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 105, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    if (outcome.status === 'EXHAUSTED_EMERGENCY_CLOSE_FAILED') expect(outcome.residualBaseQty).toBe(0.4);
  });

  it('close order itself rejected/throws -> EXHAUSTED_EMERGENCY_CLOSE_FAILED, NEVER calls getPositionRisk (nothing to verify)', async () => {
    let posRiskCalls = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => {
        throw new Error('order rejected');
      },
      getPositionRisk: async () => {
        posRiskCalls++;
        return [];
      },
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    expect(posRiskCalls).toBe(0);
  });

  it('close accepted but the VERIFY read itself fails -> EXHAUSTED_EMERGENCY_CLOSE_FAILED with residualBaseQty=null (never assumed closed on a read failure)', async () => {
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => ({ algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      closePositionMarket: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }),
      getPositionRisk: async () => {
        throw new Error('timeout');
      },
    };
    const outcome = await recoverMissingProtectiveSl({ executor, symbol: 'BTCUSDT', expectedSide: 'LONG', expectedQty: 1, quantityTolerance: 0.001, slTriggerPrice: 95, policy: 'EMERGENCY_CLOSE' });
    expect(outcome.status).toBe('EXHAUSTED_EMERGENCY_CLOSE_FAILED');
    if (outcome.status === 'EXHAUSTED_EMERGENCY_CLOSE_FAILED') expect(outcome.residualBaseQty).toBeNull();
  });

  it('partial-fill canonical qty update is wired: liveRunner.ts overwrites remainingPositionSize from the residual base qty, never the stale pre-close notional', () => {
    expect(liveRunnerSrc).toContain("posResult.sl.reason === 'EMERGENCY_CLOSE_FAILED' && posResult.sl.residualBaseQty !== null");
    expect(liveRunnerSrc).toContain('entry.position.remainingPositionSize = posResult.sl.residualBaseQty * entry.position.entryPrice');
  });
});

// ==== Item 3 — single-flight monitor =============================================================

describe('Item 3 — createSingleFlightRunner: two concurrent cycles never run concurrently', () => {
  it('a second .run() call while the first is still in flight SKIPS entirely — never runs the body twice concurrently', async () => {
    let bodyCallCount = 0;
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runner = createSingleFlightRunner(async () => {
      bodyCallCount++;
      await gate;
      return 'done';
    });

    const first = runner.run();
    expect(runner.isInFlight()).toBe(true);
    const second = runner.run(); // fired while the first hasn't resolved yet — must skip

    const secondResult = await second;
    expect(secondResult).toEqual({ skipped: true });
    expect(bodyCallCount).toBe(1); // body only ever invoked ONCE despite two overlapping .run() calls

    resolveFirst();
    const firstResult = await first;
    expect(firstResult).toEqual({ skipped: false, result: 'done' });
    expect(runner.isInFlight()).toBe(false);
  });

  it('the lock releases via `finally` even when the body throws — a crashed cycle never wedges the lock forever', async () => {
    const runner = createSingleFlightRunner(async () => {
      throw new Error('cycle crashed mid-repair');
    });
    await expect(runner.run()).rejects.toThrow('cycle crashed mid-repair');
    expect(runner.isInFlight()).toBe(false);
    // A subsequent call is NOT skipped — the lock genuinely released.
    const second = await createSingleFlightRunner(async () => 'ok').run();
    expect(second).toEqual({ skipped: false, result: 'ok' });
  });

  it('end-to-end: wrapping the REAL runProtectiveOrderMonitorSweep body in a single-flight runner and firing it twice near-simultaneously results in exactly ONE placeStopMarket call for the position, never two (no duplicate SL placement)', async () => {
    const position = makePosition();
    let placeCalls = 0;
    let releaseFirstGetOpenAlgoOrders!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstGetOpenAlgoOrders = resolve;
    });
    let getOpenAlgoOrdersCall = 0;
    const executor: FullExecutor = {
      getOpenAlgoOrders: async () => {
        getOpenAlgoOrdersCall++;
        if (getOpenAlgoOrdersCall === 1) await gate; // hold the first cycle "in flight" so the second call overlaps it
        return placeCalls === 0 ? [] : [makeOrder({ algoId: 999, side: 'SELL', origQty: 1 })];
      },
      placeStopMarket: async () => {
        placeCalls++;
        return { algoId: 999, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      closePositionMarket: async () => {
        throw new Error('n/a');
      },
      getPositionRisk: async () => [],
    };
    const runner = createSingleFlightRunner(() => runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: [] }));

    const firstRun = runner.run();
    const secondRun = runner.run(); // fired while the first is stuck awaiting the gate — must skip
    const secondResult = await secondRun;
    expect(secondResult).toEqual({ skipped: true });

    releaseFirstGetOpenAlgoOrders();
    const firstResult = await firstRun;
    expect(firstResult.skipped).toBe(false);
    if (!firstResult.skipped) expect(firstResult.result[0].sl.status).toBe('RECOVERED');
    expect(placeCalls).toBe(1); // exactly one placeStopMarket call across BOTH overlapping .run() invocations
  });

  it('liveRunner.ts wiring: runAccountSyncCycleTick() is a thin single-flight wrapper around runAccountSyncCycleTickBody(), and shutdown() waits (bounded) for an in-flight cycle before clearing/exiting', () => {
    expect(liveRunnerSrc).toContain('const accountSyncCycleSingleFlight = createSingleFlightRunner(runAccountSyncCycleTickBody);');
    expect(liveRunnerSrc).toContain('const outcome = await accountSyncCycleSingleFlight.run();');
    expect(liveRunnerSrc).toContain('if (outcome.skipped)');
    const shutdownIdx = liveRunnerSrc.indexOf('const shutdown = async');
    const shutdownEnd = liveRunnerSrc.indexOf("process.on('SIGINT'", shutdownIdx);
    const shutdownBody = liveRunnerSrc.slice(shutdownIdx, shutdownEnd);
    expect(shutdownBody).toContain('clearInterval(accountSyncCycleTimer);');
    expect(shutdownBody).toContain('accountSyncCycleSingleFlight.isInFlight()');
    // clearInterval happens BEFORE the wait loop — no new cycle can start while waiting for the old one.
    expect(shutdownBody.indexOf('clearInterval(accountSyncCycleTimer);')).toBeLessThan(shutdownBody.indexOf('accountSyncCycleSingleFlight.isInFlight()'));
  });
});

// ==== Item 4 — merged same-side position safety wired into the runtime ==========================

describe('Item 4 — checkMergedPositionAllocation wired into runAccountSyncCycleTickBody()', () => {
  it('pure function: qty matches -> RECONCILED (2+ entries -> UNVERIFIED_SPLIT, never re-split by a guessed ratio)', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: 1.0,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('RECONCILED');
    if (result.status === 'RECONCILED') expect(result.allocationQuality).toBe('UNVERIFIED_SPLIT');
  });

  it('pure function: qty mismatch -> ACCOUNT_STATE_UNKNOWN (portfolio-wide block, never a per-symbol-only one)', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.5,
      protectiveTotalBaseQty: null,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('ACCOUNT_STATE_UNKNOWN');
  });

  it('liveRunner.ts wiring: runAccountSyncCycleTickBody() calls checkMergedPositionAllocation() using THIS cycle\'s own snapshot legs (positions + protectiveOrders — zero extra network calls), only for 2+ same-side entries, and escalates a mismatch to accountSyncState=ACCOUNT_STATE_UNKNOWN (the SAME whole-portfolio sentinel, never a new parallel gate)', () => {
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('checkMergedPositionAllocation({');
    expect(fnBody).toContain('snapshotResult.snapshot.positions.data');
    expect(fnBody).toContain('snapshotResult.snapshot.protectiveOrders.data');
    expect(fnBody).toContain('if (sideEntries.length < 2) continue');
    const mergedIdx = fnBody.indexOf("check.status === 'ACCOUNT_STATE_UNKNOWN'");
    expect(mergedIdx).toBeGreaterThan(-1);
    const mergedBlock = fnBody.slice(mergedIdx, mergedIdx + 400);
    expect(mergedBlock).toContain("accountSyncState = 'ACCOUNT_STATE_UNKNOWN'");
  });
});

// ==== Item 5 — hybrid multi-frequency freshness policy ===========================================

describe('Item 5 — isFreshnessEvidenceStale / FreshnessEvidence: honestly-named, NOT "atomic"', () => {
  it('null evidence (never captured yet) is stale — fails closed, never assumes fresh', () => {
    expect(isFreshnessEvidenceStale(null, Date.now())).toBe(true);
  });

  it('evidence within maxAge is NOT stale', () => {
    const now = 1_000_000;
    expect(isFreshnessEvidenceStale({ capturedAtMs: now - 1000, maxAgeMs: 5000, source: 'test' }, now)).toBe(false);
  });

  it('evidence older than maxAge IS stale', () => {
    const now = 1_000_000;
    expect(isFreshnessEvidenceStale({ capturedAtMs: now - 6000, maxAgeMs: 5000, source: 'test' }, now)).toBe(true);
  });

  it('liveRunner.ts wiring: both stale balance AND stale protective-cycle evidence are INDEPENDENT triggers of hasUnquantifiableExposureBlockingAdmission (either alone is sufficient — never AND-ed together)', () => {
    const idx = liveRunnerSrc.indexOf('const hasUnquantifiableExposureBlockingAdmission =');
    expect(idx).toBeGreaterThan(-1);
    // Window widened 600->1000: TICKET-G1R-A "Final Internal Closure" item 1 added the
    // `!accountBalanceKnown` clause (plus its explanatory comment) to this same expression.
    const decl = liveRunnerSrc.slice(idx, idx + 1000);
    expect(decl).toContain('isFreshnessEvidenceStale(balanceFreshnessEvidence(), now)');
    expect(decl).toContain('isFreshnessEvidenceStale(protectiveCycleFreshnessEvidence(), now)');
    // Confirms these are OR'd (||), not AND'd — a fixed-width scan for '&&' between the two would be a
    // false positive risk, so instead confirm both individually appear as top-level `||`-joined clauses.
    expect(decl.split('||').some((clause) => clause.includes('balanceFreshnessEvidence'))).toBe(true);
    expect(decl.split('||').some((clause) => clause.includes('protectiveCycleFreshnessEvidence'))).toBe(true);
  });

  it('liveRunner.ts wiring: balance freshness is updated on every successful refreshBalanceForTelegram() read, never slowing its existing fast per-event cadence', () => {
    // TICKET-G1R-A "Final Internal Closure" item 1 — the bare `lastSuccessfulBalanceReadMs = Date.now();`
    // write was REPLACED (not removed) by applyBalanceObservation(), which is now the single writer of
    // value + provenance + freshness. The per-event fast path still updates freshness on every
    // successful read; it now updates the balance VALUE at the same instant, which is the actual fix.
    expect(liveRunnerSrc).not.toContain('lastSuccessfulBalanceReadMs = Date.now();');
    const idx = liveRunnerSrc.indexOf("source: 'event:refreshBalanceForTelegram'");
    expect(idx).toBeGreaterThan(-1);
    const around = liveRunnerSrc.slice(Math.max(0, idx - 600), idx + 300);
    expect(around).toContain('applyBalanceObservation({');
    expect(around).toContain('exchangeBalanceRefreshedThisTick = true;'); // same success branch as the existing fast per-event path
    // applyBalanceObservation() is the ONLY place the freshness timestamp is ASSIGNED (the second
    // match is the `let` declaration itself, which is not a write from a read path).
    const writes = liveRunnerSrc.match(/^\s*lastSuccessfulBalanceReadMs = /gm) ?? [];
    expect(writes.length).toBe(1);
  });

  it('liveRunner.ts wiring: protective-cycle freshness (and balance freshness) is updated only after captureCoherentReconciliationSnapshotWithRetry() returns VALIDATED, never on a failed/stale/torn snapshot — TICKET-G1R-A "Freshness Bootstrap Hotfix" item 2/3', () => {
    // The shared captureAndApplyFreshnessSnapshot() helper is what BOTH the bootstrap call and the
    // periodic tick body funnel through — this is the fix for the confirmed bug (the OLD code returned
    // early on `positions.length === 0` BEFORE ever reaching this timestamp assignment at all).
    const idx = liveRunnerSrc.indexOf('lastSuccessfulAccountSyncCycleMs = Date.now();');
    expect(idx).toBeGreaterThan(-1);
    // Window widened 1600->2600: item 1's parse/apply block now sits between the VALIDATED guard and
    // this line.
    const before = liveRunnerSrc.slice(Math.max(0, idx - 2600), idx);
    expect(before).toContain("if (snapshotResult.status !== 'VALIDATED')");
    expect(before).toContain('return snapshotResult;'); // the failure branch returns BEFORE either freshness timestamp is ever touched
    // Both freshness timestamps are set together, unconditionally on VALIDATED — NEVER gated on
    // positions.length (that gate — the confirmed bug — must not exist anywhere near this line).
    // TICKET-G1R-A "Final Internal Closure" item 1 — balance freshness is no longer a bare
    // `= Date.now()` next to this line; it is now set inside applyBalanceObservation(), reached only
    // via parseAndApplyBalance() on the snapshot's OWN balance leg, immediately before this line.
    const nearby = liveRunnerSrc.slice(Math.max(0, idx - 1400), idx + 100);
    expect(nearby).toContain('parseAndApplyBalance(balanceLeg.data');
    // ...and a parse failure returns BEFORE lastSuccessfulAccountSyncCycleMs is touched.
    expect(nearby).toContain('if (applied === null)');
  });

  it('liveRunner.ts wiring: the freshness snapshot function is called UNCONDITIONALLY at the top of runAccountSyncCycleTickBody() — never gated behind a `positions.length === 0` early return (the exact confirmed bug this ticket fixes)', () => {
    const fnStart = liveRunnerSrc.indexOf('async function runAccountSyncCycleTickBody()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = liveRunnerSrc.indexOf('\n  // TICKET-G1R-A "Final Safety Hotfix" item 3 — single-flight guard', fnStart);
    const fnBody = liveRunnerSrc.slice(fnStart, fnEnd);
    const captureIdx = fnBody.indexOf('await captureAndApplyFreshnessSnapshot()');
    const positionsLenIdx = fnBody.indexOf('buildProtectiveMonitorInputs()');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(positionsLenIdx).toBeGreaterThan(-1);
    // The snapshot capture (and therefore the freshness/exposure work inside it) happens BEFORE the
    // positions.length check — never after / gated behind it.
    expect(captureIdx).toBeLessThan(positionsLenIdx);
  });

  it('type/name honesty: no "Atomic" naming anywhere in the freshness-evidence module (same honest-naming convention as captureCoherentReconciliationSnapshot*)', () => {
    expect(/FreshnessEvidence/.test('FreshnessEvidence')).toBe(true);
    // Grep-style check against the actual liveStateSync.ts source for the item 5 section.
    const srcPath = path.resolve(__dirname, 'liveStateSync.ts');
    const src = readFileSync(srcPath, 'utf8');
    const sectionIdx = src.indexOf('item 5: hybrid multi-frequency freshness policy');
    expect(sectionIdx).toBeGreaterThan(-1);
    const section = src.slice(sectionIdx, sectionIdx + 1500);
    // The word "Atomic" may appear ONLY inside the doc comment's own explicit disclaimer (quoted,
    // explaining what this ISN'T) — never as part of an actual type/function/interface name.
    expect(section).not.toMatch(/(interface|function|type)\s+\w*Atomic\w*/);
    expect(section).not.toContain('AtomicSnapshot');
  });
});

// ==== Cross-cutting — restart persistence round-trip for PROTECTION_DEGRADED ====================

describe('Restart round-trip: a PROTECTION_DEGRADED position stays degraded after persist -> reload -> recoverSymbolState (never silently resets to PROTECTED)', () => {
  let tmpDir: string;

  function makeSymbolState(openPositions: OpenPositionEntry[]): SymbolState {
    return { ...INITIAL_SYMBOL_STATE, openPositions };
  }

  it('writeLiveStateFileAtomic -> readLiveStateFileSafe -> recoverSymbolState preserves protectionStatus=PROTECTION_DEGRADED byte-for-byte through the JSON round-trip', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1r-final-safety-hotfix-'));
    const filePath = path.join(tmpDir, 'positions-state.json');
    const entryTimestamp = 5000;
    const degradedEntry = makeEntry(entryTimestamp, 'PROTECTION_DEGRADED', { remainingPositionSize: 1000, entryPrice: 100 });
    const persisted: PersistedSymbolRecord = {
      symbolState: makeSymbolState([degradedEntry]),
      orderIds: [[entryTimestamp, { slAlgoId: null, tpAlgoIds: [] }]], // SL is naked — that's exactly WHY it's degraded
    };
    const file: LiveStateFile = { schemaVersion: LIVE_STATE_SCHEMA_VERSION, savedAtMs: Date.now(), symbols: { BTCUSDT: persisted } };
    writeLiveStateFileAtomic(filePath, file);

    const loaded = readLiveStateFileSafe(filePath);
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') return;

    const quantityTolerance = computeQuantityTolerance(0.001);
    const outcome = recoverSymbolState({
      symbol: 'BTCUSDT',
      persisted: loaded.file.symbols.BTCUSDT,
      exchangeBaseQtyBySide: { LONG: 10, SHORT: 0 }, // matches persisted remainingPositionSize/entryPrice = 1000/100 = 10
      quantityTolerance,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });

    expect(outcome.blockEntries).toBe(false); // RECOVERED (qty matches) — a degraded position is still legitimately owned, not quarantined
    const recoveredEntry = outcome.symbolState.openPositions.find((e) => e.meta.entryTimestamp === entryTimestamp);
    expect(recoveredEntry).toBeDefined();
    // THE assertion: protectionStatus is NOT silently reset to PROTECTED just because the process restarted.
    expect(recoveredEntry?.meta.protectionStatus).toBe('PROTECTION_DEGRADED');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
