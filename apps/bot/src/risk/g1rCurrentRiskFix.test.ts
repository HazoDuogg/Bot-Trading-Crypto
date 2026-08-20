import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCurrentPositionRisk, rebuildPortfolioRisk, type KnownPositionForRisk, type PositionRiskBasis, type UnknownExposureForRisk } from './currentRisk.js';
import { openPosition, onTp1Hit, onTp2Hit, onSlHit, type ManagedPositionState, type SlTpManagerInput } from './slTpManager.js';
import { reconcileExecutedOpenState } from '../live/liveStateSync.js';
import { recoverSymbolState } from '../live/liveStateSync.js';
import { INITIAL_SYMBOL_STATE, type OpenPositionEntry } from '../orchestrator/types.js';

/**
 * TICKET-G1R Checkpoint D — regression tests proving G1-F04 no longer reproduces.
 *
 * G1-F04: the risk pool never released/recomputed actualRiskDollar after TP1/TP2 partial fills or SL
 * ratchets — a position's committed risk stayed at its full initial value in the pool's bookkeeping
 * even after quantity shrank or the stop moved favorably. computeCurrentPositionRisk()/
 * rebuildPortfolioRisk() (currentRisk.ts) fix this: every test below recomputes from CURRENT state
 * (remainingPositionSize/currentSlPrice/entryPrice), not a cached value — real behavior tests against
 * the actual pure functions, not source-text scans. liveRunner.ts/backtest.ts wiring (which cannot be
 * imported directly — same documented constraint every other G1R checkpoint's test file carries) is
 * additionally source-checked once at the bottom.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');
const backtestSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/backtest.ts'), 'utf8');

function makePosition(overrides: Partial<SlTpManagerInput> = {}): ManagedPositionState {
  return openPosition({
    scenario: 'TREND',
    entryPrice: 100,
    slPrice: 98, // r = 2
    side: 'LONG',
    tpPlan: 'PLAN_A', // tp1R=1.2, tp1Pct=0.4, tp2R=2.5, tp2Pct=0.3
    positionSize: 1000, // USD notional -> base qty = 10 at entry=100
    takerFeeRate: 0.0004,
    ...overrides,
  });
}

function basisFrom(p: ManagedPositionState): PositionRiskBasis {
  return { side: p.side, entryPrice: p.entryPrice, currentSlPrice: p.currentSlPrice, remainingPositionSize: p.remainingPositionSize };
}

describe('G1-F04 fixed — current-risk recomputation (computeCurrentPositionRisk)', () => {
  it('full position before any TP: risk = full remaining qty * |entry - SL| (remaining qty = original)', () => {
    const p = makePosition();
    const risk = computeCurrentPositionRisk(basisFrom(p));
    // baseQty = 1000/100 = 10, |100-98| = 2 -> 10*2 = 20
    expect(risk.openRiskDollar).toBeCloseTo(20, 6);
    expect(risk.lockedProfitDollar).toBe(0);
  });

  it('after TP1: remaining qty shrinks (40% closed) and SL moves to breakeven+fees — risk recomputed from BOTH, not frozen at the initial 20', () => {
    const p0 = makePosition();
    const afterTp1 = onTp1Hit(p0);
    // remainingPositionSize = 1000 - 0.4*1000 = 600; currentSlPrice = breakeven+fee (favorable vs entry for LONG)
    expect(afterTp1.remainingPositionSize).toBeCloseTo(600, 6);
    expect(afterTp1.currentSlPrice).toBeGreaterThan(afterTp1.entryPrice); // moved to breakeven+fee, past entry
    const risk = computeCurrentPositionRisk(basisFrom(afterTp1));
    // SL is now ABOVE entry for a LONG -> favorable -> downside risk must be 0, not the stale 20.
    expect(risk.openRiskDollar).toBe(0);
    expect(risk.lockedProfitDollar).toBeGreaterThan(0); // fee buffer locked in as guaranteed min profit
  });

  it('after TP1 and TP2: risk keeps shrinking with remaining qty at each tier (TP2 moves SL to TP1 price, further locking profit)', () => {
    const p0 = makePosition();
    const afterTp1 = onTp1Hit(p0);
    const afterTp2 = onTp2Hit(afterTp1);
    // remainingPositionSize = 600 - 0.3*1000 = 300 (TP2 closePercent applies to ORIGINAL positionSize)
    expect(afterTp2.remainingPositionSize).toBeCloseTo(300, 6);
    const tp1 = p0.tpLevels.find((t) => t.label === 'TP1')!;
    expect(afterTp2.currentSlPrice).toBeCloseTo(tp1.price as number, 6);
    const risk = computeCurrentPositionRisk(basisFrom(afterTp2));
    expect(risk.openRiskDollar).toBe(0); // SL well past entry into profit
    const baseQtyRemaining = 300 / afterTp2.entryPrice;
    expect(risk.lockedProfitDollar).toBeCloseTo(baseQtyRemaining * Math.abs(afterTp2.currentSlPrice - afterTp2.entryPrice), 6);
  });

  it('SL moved exactly to breakeven (currentSL === entryPrice): risk goes to ~0 via max(0, ...), never negative', () => {
    const p = makePosition({ slPrice: 98 });
    const atBreakeven: ManagedPositionState = { ...p, currentSlPrice: p.entryPrice };
    const risk = computeCurrentPositionRisk(basisFrom(atBreakeven));
    expect(risk.openRiskDollar).toBe(0);
    expect(risk.lockedProfitDollar).toBe(0); // exactly breakeven, no profit locked either
  });

  it('SL locked past entry into profit (favorable direction): downside risk = 0 (never negative), lockedProfitDollar > 0 tracked separately', () => {
    const p = makePosition({ slPrice: 98 }); // LONG
    const lockedProfit: ManagedPositionState = { ...p, currentSlPrice: 105 }; // SL now above entry
    const risk = computeCurrentPositionRisk(basisFrom(lockedProfit));
    expect(risk.openRiskDollar).toBe(0);
    expect(risk.openRiskDollar).toBeGreaterThanOrEqual(0); // explicit non-negative assertion
    const baseQty = lockedProfit.remainingPositionSize / lockedProfit.entryPrice;
    expect(risk.lockedProfitDollar).toBeCloseTo(baseQty * 5, 6); // (105-100)*10
    expect(risk.lockedProfitDollar).toBeGreaterThan(0);

    // SHORT side mirrored: favorable = currentSL <= entryPrice.
    const shortP = makePosition({ side: 'SHORT', entryPrice: 100, slPrice: 102 });
    const shortLocked: ManagedPositionState = { ...shortP, currentSlPrice: 95 };
    const shortRisk = computeCurrentPositionRisk(basisFrom(shortLocked));
    expect(shortRisk.openRiskDollar).toBe(0);
    expect(shortRisk.lockedProfitDollar).toBeCloseTo((shortLocked.remainingPositionSize / shortLocked.entryPrice) * 5, 6);
  });

  it('partial fill (canonicalQty < planned): risk computed from the ACTUAL filled qty via reconcileExecutedOpenState(), not the planned notional', () => {
    const planned = makePosition(); // planned qty = 10 (1000/100)
    const reconciled = reconcileExecutedOpenState({
      initialSlPrice: planned.initialSlPrice,
      canonicalQty: 6, // exchange only filled 60%
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: '100',
      freshPositionRiskEntryPrice: '100',
      freshPositionRiskQtyAbs: 6,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error('unreachable');
    const corrected: ManagedPositionState = { ...planned, entryPrice: reconciled.entryPrice, remainingPositionSize: reconciled.positionSize };
    const risk = computeCurrentPositionRisk(basisFrom(corrected));
    // corrected notional = 6*100 = 600 -> baseQty=6, |100-98|=2 -> 12, NOT the planned 20.
    expect(risk.openRiskDollar).toBeCloseTo(12, 6);
    expect(risk.openRiskDollar).not.toBeCloseTo(20, 6);
  });

  it("entry/quantity exchange-corrected (Checkpoint B's reconcileExecutedOpenState output): risk recomputed from CORRECTED entry+qty right after reconcile, not the old planned value", () => {
    const planned = makePosition({ entryPrice: 100, slPrice: 98 });
    // exchange actually filled at a worse avg price than planned (slippage) and at a different qty.
    const reconciled = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 12,
      canonicalQtySource: 'POSITION_RISK',
      rawAvgPrice: '101', // observed fill price, worse than planned 100
      freshPositionRiskEntryPrice: '101',
      freshPositionRiskQtyAbs: 12,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error('unreachable');
    expect(reconciled.entryPrice).toBe(101);
    const corrected: ManagedPositionState = { ...planned, entryPrice: reconciled.entryPrice, remainingPositionSize: reconciled.positionSize, r: reconciled.r };
    const staleRisk = computeCurrentPositionRisk(basisFrom(planned)); // what the OLD stale bookkeeping would have used
    const correctedRisk = computeCurrentPositionRisk(basisFrom(corrected));
    // corrected: baseQty=12, |101-98|=3 -> 36. Stale planned: baseQty=10, |100-98|=2 -> 20.
    expect(correctedRisk.openRiskDollar).toBeCloseTo(36, 6);
    expect(staleRisk.openRiskDollar).toBeCloseTo(20, 6);
    expect(correctedRisk.openRiskDollar).not.toBeCloseTo(staleRisk.openRiskDollar, 6);
  });

  it("restart after TP1 (Checkpoint C recovered state): risk is RECOMPUTED from recovered remainingPositionSize/currentSlPrice, not a stale persisted actualRiskDollar", () => {
    const p0 = makePosition();
    const afterTp1 = onTp1Hit(p0); // remaining=600, SL moved to breakeven+fee (favorable)
    const persistedEntry: OpenPositionEntry = {
      position: afterTp1,
      meta: { regime: 'TREND_RIDER' as never, setupType: 'OB', entryTimestamp: 1, actualRiskDollar: 20, marginRequired: 1000 / 30, riskMultiplier: 1, bookedRealizedPnl: 0 }, // meta.actualRiskDollar deliberately STALE (still 20, the pre-TP1 value)
    };
    const recovered = recoverSymbolState({
      symbol: 'BTCUSDT',
      persisted: { symbolState: { ...INITIAL_SYMBOL_STATE, openPositions: [persistedEntry] }, orderIds: [] },
      exchangeBaseQtyBySide: { LONG: 6, SHORT: 0 }, // 600/100 = 6, matches persisted -> RECOVERED
      quantityTolerance: 0.01,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(recovered.sideOutcomes.find((s) => s.side === 'LONG')?.status).toBe('RECOVERED');
    const recoveredEntry = recovered.symbolState.openPositions[0];
    const recomputedRisk = computeCurrentPositionRisk(basisFrom(recoveredEntry.position));
    // The recomputed risk (0, SL past breakeven) must NOT match the stale persisted meta.actualRiskDollar (20).
    expect(recomputedRisk.openRiskDollar).toBe(0);
    expect(recomputedRisk.openRiskDollar).not.toBe(recoveredEntry.meta.actualRiskDollar);
  });

  it('restart after an SL ratchet (Runner phase, SL trailed above entry): recomputed risk reflects the ratcheted SL, not the frozen open-time value', () => {
    const p0 = makePosition();
    const ratcheted: ManagedPositionState = { ...onTp2Hit(onTp1Hit(p0)), currentSlPrice: 110 }; // trailed well into profit
    const persistedEntry: OpenPositionEntry = {
      position: ratcheted,
      meta: { regime: 'TREND_RIDER' as never, setupType: 'OB', entryTimestamp: 2, actualRiskDollar: 20, marginRequired: 1000 / 30, riskMultiplier: 1, bookedRealizedPnl: 0 },
    };
    const remainingBaseQty = ratcheted.remainingPositionSize / ratcheted.entryPrice;
    const recovered = recoverSymbolState({
      symbol: 'ETHUSDT',
      persisted: { symbolState: { ...INITIAL_SYMBOL_STATE, openPositions: [persistedEntry] }, orderIds: [] },
      exchangeBaseQtyBySide: { LONG: remainingBaseQty, SHORT: 0 },
      quantityTolerance: 0.01,
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    const recoveredEntry = recovered.symbolState.openPositions[0];
    const risk = computeCurrentPositionRisk(basisFrom(recoveredEntry.position));
    expect(risk.openRiskDollar).toBe(0);
    expect(risk.lockedProfitDollar).toBeCloseTo(remainingBaseQty * 10, 6); // (110-100)*qty
  });

  it("quarantined external position (no persisted basis at all): rebuildPortfolioRisk marks it UNKNOWN_EXPOSURE with quantifiable=false, NEVER silently 0/absent, and flags the portfolio as unquantifiable", () => {
    const unknown: UnknownExposureForRisk = { id: 'BTCUSDT:LONG:QUARANTINED', basis: null };
    const result = rebuildPortfolioRisk({ knownPositions: [], unknownExposures: [unknown] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('UNKNOWN_EXPOSURE');
    expect(result.entries[0].quantifiable).toBe(false);
    expect(result.hasUnquantifiableExposure).toBe(true);
    // openRiskDollar reported as 0 for THIS entry (no basis to estimate from) but the ledger explicitly
    // flags it as unquantifiable — callers must block admission portfolio-wide on this flag, never read
    // a bare 0 total as "no risk".
    expect(result.entries[0].openRiskDollar).toBe(0);
  });

  it('quarantined external position WITH a last-known-good persisted basis: conservative non-zero risk estimate contributed to the ledger, not 0', () => {
    const lastKnown: PositionRiskBasis = { side: 'LONG', entryPrice: 100, currentSlPrice: 98, remainingPositionSize: 1000 };
    const unknown: UnknownExposureForRisk = { id: 'ETHUSDT:LONG:QUARANTINED', basis: lastKnown };
    const result = rebuildPortfolioRisk({ knownPositions: [], unknownExposures: [unknown] });
    expect(result.entries[0].status).toBe('UNKNOWN_EXPOSURE');
    expect(result.entries[0].quantifiable).toBe(true);
    expect(result.entries[0].openRiskDollar).toBeCloseTo(20, 6); // same formula, conservative last-known basis
    expect(result.totalRiskDollar).toBeCloseTo(20, 6);
  });

  it('two open positions on the same symbol+side: BOTH contribute to total risk, no double-counting and no dropping', () => {
    const a = makePosition({ positionSize: 1000 }); // baseQty=10, risk=20
    const b = makePosition({ positionSize: 500 }); // baseQty=5, risk=10
    const knownPositions: KnownPositionForRisk[] = [
      { id: 'BTCUSDT#1', basis: basisFrom(a) },
      { id: 'BTCUSDT#2', basis: basisFrom(b) },
    ];
    const result = rebuildPortfolioRisk({ knownPositions, unknownExposures: [] });
    expect(result.entries).toHaveLength(2);
    expect(result.totalRiskDollar).toBeCloseTo(30, 6); // 20 + 10, neither merged nor missing
  });

  it('full close releases exactly its own risk: portfolio total drops by exactly that position\'s contribution, no more no less', () => {
    const a = makePosition({ positionSize: 1000 }); // risk=20
    const b = makePosition({ positionSize: 500 }); // risk=10
    const before = rebuildPortfolioRisk({ knownPositions: [{ id: 'A', basis: basisFrom(a) }, { id: 'B', basis: basisFrom(b) }], unknownExposures: [] });
    expect(before.totalRiskDollar).toBeCloseTo(30, 6);

    const aClosed = onSlHit(a); // remainingPositionSize -> 0, closed:true
    expect(computeCurrentPositionRisk(basisFrom(aClosed)).openRiskDollar).toBe(0);
    // Simulate the close removing A from openPositions entirely (as liveRunner.ts/backtest.ts do).
    const after = rebuildPortfolioRisk({ knownPositions: [{ id: 'B', basis: basisFrom(b) }], unknownExposures: [] });
    expect(after.totalRiskDollar).toBeCloseTo(10, 6); // exactly B's own risk, A's 20 fully released
    expect(before.totalRiskDollar - after.totalRiskDollar).toBeCloseTo(20, 6);
  });

  it('repeated rebuild calls with the same input are deterministic (pure, rebuild-from-scratch — never drifts across repeated calls/restarts)', () => {
    const positions: KnownPositionForRisk[] = [
      { id: 'BTCUSDT', basis: basisFrom(onTp1Hit(makePosition())) },
      { id: 'ETHUSDT', basis: basisFrom(makePosition({ side: 'SHORT', entryPrice: 200, slPrice: 204 })) },
    ];
    const unknowns: UnknownExposureForRisk[] = [{ id: 'SOLUSDT:LONG:QUARANTINED', basis: null }];
    const r1 = rebuildPortfolioRisk({ knownPositions: positions, unknownExposures: unknowns });
    const r2 = rebuildPortfolioRisk({ knownPositions: positions, unknownExposures: unknowns });
    const r3 = rebuildPortfolioRisk({ knownPositions: positions, unknownExposures: unknowns });
    expect(r2.totalRiskDollar).toBe(r1.totalRiskDollar);
    expect(r3.totalRiskDollar).toBe(r1.totalRiskDollar);
    expect(r2.hasUnquantifiableExposure).toBe(r1.hasUnquantifiableExposure);
    expect(r2.entries).toEqual(r1.entries);
  });
});

describe('G1-F04 fixed — liveRunner.ts / backtest.ts wiring (source-checked; these scripts call main()/run top-level and cannot be imported directly)', () => {
  it('liveRunner.ts computes openRiskBySymbol from computeCurrentPositionRisk(e.position), not the stale e.meta.actualRiskDollar', () => {
    expect(liveRunnerSrc).toContain('computeCurrentPositionRisk(e.position).openRiskDollar');
    expect(liveRunnerSrc).not.toMatch(/openRiskBySymbol\[s\]\s*=\s*total;[\s\S]{0,5}e\.meta\.actualRiskDollar/);
  });

  it('liveRunner.ts refreshes openRiskBySymbol AFTER the events loop (post reconcile/close), not before', () => {
    const eventsLoopIdx = liveRunnerSrc.indexOf("for (const event of result.events)");
    const refreshIdx = liveRunnerSrc.indexOf('const newTotalRisk = result.symbolState.openPositions.reduce');
    expect(eventsLoopIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(eventsLoopIdx);
  });

  it('liveRunner.ts blocks admission portfolio-wide (sentinel over the 15% cap) while Checkpoint B/C unknown exposure exists', () => {
    // TICKET-G1R-A "Final Safety Hotfix" reformatted hasUnquantifiableExposureBlockingAdmission to a
    // multi-line const (adding PROTECTION_DEGRADED + freshness-staleness OR conditions) — the old
    // single-line substring no longer exists verbatim; each individual condition is still checked.
    expect(liveRunnerSrc).toContain('hasUnquantifiableExposureBlockingAdmission');
    expect(liveRunnerSrc).toContain('entriesBlockedDueToRestartQuarantineBySymbol.size > 0');
    expect(liveRunnerSrc).toContain("id: 'UNKNOWN_EXPOSURE_BLOCK'");
  });

  it('liveRunner.ts never touches the 15% riskPoolMaxPct value itself', () => {
    expect(liveRunnerSrc).toContain('riskPoolMaxPct: 0.15');
  });

  it('backtest.ts computes openRiskBySymbol from computeCurrentPositionRisk(entry.position), not the stale entry.meta.actualRiskDollar, in both the pre-loop seed and the post-step refresh', () => {
    const occurrences = backtestSrc.match(/computeCurrentPositionRisk\(entry\.position\)\.openRiskDollar/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(backtestSrc).not.toMatch(/openRiskBySymbol\[symbol\]\s*=\s*newTotalRisk;[\s\S]{0,5}entry\.meta\.actualRiskDollar/);
  });
});
