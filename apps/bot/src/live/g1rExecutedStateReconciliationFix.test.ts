import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileExecutedOpenState } from './liveStateSync.js';

/**
 * TICKET-G1R Checkpoint B — regression tests proving G1-F05 no longer reproduces.
 *
 * Mapping (old repro -> what it proved was broken -> new test -> what now proves it's fixed):
 *  - g1FindingsRepro.test.ts "G1-F05 ... reproduces liveRunner.ts:747-761 (as it was BEFORE the fix)
 *    ... only position.positionSize/remainingPositionSize are corrected ... meta.actualRiskDollar/
 *    marginRequired/entryPrice are left at their PLANNED values" proved the OPEN-event correction
 *    block only fixed the notional/qty, silently leaving risk$, margin$, and entryPrice stale
 *    (computed from the pre-fill planned numbers, never reconciled against the real fill).
 *    -> 'partial fill reconciles all four fields together' + 'step-size/rounding correction
 *    propagates consistently' below prove reconcileExecutedOpenState() (liveStateSync.ts), now wired
 *    into liveRunner.ts's OPEN-event handler, derives entryPrice/r/actualRiskDollar/marginRequired
 *    from the ACTUAL executed fill instead of the planned values. The "confirms the source" sub-test
 *    in g1FindingsRepro.test.ts was updated (not silently) to check for the new reconcile call instead
 *    of asserting the old buggy "only positionSize touched" shape, which no longer exists in the source.
 *  - 'rejected/unknown fill blocks instead of guessing' + 'canonical qty resolution failure blocks
 *    instead of guessing' below are NEW coverage (no prior repro existed for this — G1-F05's ledger
 *    entry only covered the "silently stale" case, not the "insufficient provenance" case) proving the
 *    fix never fabricates a corrected value when it can't trust the inputs: it returns `ok:false` and
 *    the liveRunner.ts caller then blocks new entries on that symbol (entriesBlockedDueToUnreconciledFillBySymbol).
 *
 * reconcileExecutedOpenState() is a pure function (no executor/network dependency), so these are true
 * behavior tests, not source-text scans — same testing style as resolveCanonicalOpenQty()'s own tests
 * in liveStateSync.test.ts. The liveRunner.ts wiring itself (the caller applying these results to
 * ManagedPositionState/OpenTradeMeta and the new per-symbol block) is additionally source-checked here
 * once, since liveRunner.ts cannot be imported directly (calls main() unconditionally on import) —
 * same documented constraint as g1FindingsRepro.test.ts / g1rBalanceOwnershipFix.test.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');

describe('G1-F05 fixed — partial fill and quantity-normalization reconciliation', () => {
  it('partial fill (canonicalQty < planned qty) reconciles positionSize/actualRiskDollar/marginRequired against the corrected notional, entryPrice unchanged (avg price == planned)', () => {
    // Planned: entry=100, sl=98 (r=2, slDistancePercent=2%), planned qty=1 -> notional=100, risk$=2, margin$=100/30.
    const result = reconcileExecutedOpenState({
      plannedEntryPrice: 100,
      initialSlPrice: 98,
      canonicalQty: 0.6, // exchange only filled 60% (partial execution)
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: '100', // exchange confirms the fill happened at the planned price
      leverage: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entryPriceBasis).toBe('OBSERVED_AVG_FILL');
    expect(result.entryPrice).toBe(100);
    expect(result.positionSize).toBeCloseTo(60, 6); // 0.6 * 100
    expect(result.r).toBeCloseTo(2, 6); // |100 - 98|
    expect(result.actualRiskDollar).toBeCloseTo(60 * (2 / 100), 6); // corrected notional * slDistancePercent, NOT the stale planned risk$
    expect(result.marginRequired).toBeCloseTo(60 / 30, 6); // corrected notional / leverage
  });

  it('quantity normalization (step-size rounding) propagates consistently to positionSize, entryPrice-basis, actualRiskDollar AND marginRequired', () => {
    // Observed avg fill price differs slightly from planned (slippage), AND canonicalQty differs from
    // planned due to stepSize rounding — both must feed the SAME corrected basis, not a mix of old/new.
    const result = reconcileExecutedOpenState({
      plannedEntryPrice: 50000,
      initialSlPrice: 49000, // r=1000 planned
      canonicalQty: 0.00987, // stepSize-rounded real fill, not the raw calculated qty
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 50123.45, // real average fill price, slightly above planned (slippage)
      leverage: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entryPriceBasis).toBe('OBSERVED_AVG_FILL');
    expect(result.entryPrice).toBe(50123.45);
    const expectedNotional = 0.00987 * 50123.45;
    const expectedR = Math.abs(50123.45 - 49000);
    const expectedSlPct = expectedR / 50123.45;
    expect(result.positionSize).toBeCloseTo(expectedNotional, 6);
    expect(result.r).toBeCloseTo(expectedR, 6);
    expect(result.actualRiskDollar).toBeCloseTo(expectedNotional * expectedSlPct, 6);
    expect(result.marginRequired).toBeCloseTo(expectedNotional / 30, 6);
    // basis consistency: actualRiskDollar recomputed from THIS SAME entryPrice, not a mix of bases.
    expect(result.actualRiskDollar).toBeCloseTo(result.positionSize * (result.r / result.entryPrice), 10);
  });

  it('exchange fill response with no average price falls back to the planned entry price, explicitly LABELED as a fallback (never called "observed")', () => {
    const result = reconcileExecutedOpenState({
      plannedEntryPrice: 100,
      initialSlPrice: 99,
      canonicalQty: 1,
      canonicalQtySource: 'POSITION_RISK', // qty itself IS confirmed (via getPositionRisk), just no avgPrice field
      rawAvgPrice: undefined, // exchange fill response missing avgPrice
      leverage: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entryPriceBasis).toBe('PLANNED_FALLBACK');
    expect(result.entryPrice).toBe(100); // reuses planned value verbatim, but labeled, not silently treated as observed
    expect(result.actualRiskDollar).toBeCloseTo(1 * 100 * (1 / 100), 6);
  });

  it('a non-numeric / zero avgPrice ("0", "", NaN-producing) is treated the same as missing — PLANNED_FALLBACK, not a fabricated observed price', () => {
    for (const bad of ['0', '', 'not-a-number', 0, null]) {
      const result = reconcileExecutedOpenState({
        plannedEntryPrice: 100,
        initialSlPrice: 99,
        canonicalQty: 1,
        canonicalQtySource: 'EXECUTED_QTY',
        rawAvgPrice: bad,
        leverage: 30,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.entryPriceBasis).toBe('PLANNED_FALLBACK');
      expect(result.entryPrice).toBe(100);
    }
  });
});

describe('G1-F05 fixed — unreconcilable fill provenance blocks instead of guessing', () => {
  it('canonicalQty resolution falling all the way back to SUBMITTED_QTY_FALLBACK (unconfirmed guess) is rejected, not silently reconciled', () => {
    const result = reconcileExecutedOpenState({
      plannedEntryPrice: 100,
      initialSlPrice: 98,
      canonicalQty: 1, // even though a number is present, the SOURCE says it's just the submitted guess
      canonicalQtySource: 'SUBMITTED_QTY_FALLBACK',
      rawAvgPrice: '100',
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('CANONICAL_QTY_UNCONFIRMED');
  });

  it('a non-positive/non-finite canonicalQty is rejected outright (defensive — should not happen upstream, but never divides/multiplies into a fabricated value)', () => {
    for (const badQty of [0, -1, NaN, Infinity]) {
      const result = reconcileExecutedOpenState({
        plannedEntryPrice: 100,
        initialSlPrice: 98,
        canonicalQty: badQty,
        canonicalQtySource: 'EXECUTED_QTY',
        rawAvgPrice: '100',
        leverage: 30,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('CANONICAL_QTY_INVALID');
    }
  });

  it('an observed average fill price that lands exactly ON the stop price (zero stop distance) is rejected rather than reporting a 0-risk position', () => {
    const result = reconcileExecutedOpenState({
      plannedEntryPrice: 100,
      initialSlPrice: 98, // LONG, planned stop below entry
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 98, // real fill landed exactly at the stop price — r === 0, nonsensical to size risk off
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ZERO_STOP_DISTANCE_AFTER_RECONCILE');
  });
});

describe('G1-F05 fixed — liveRunner.ts wiring applies the reconciled basis and blocks on failure', () => {
  it('the OPEN-event handler passes handleOpenEvent\'s real fill info (qty source + raw avgPrice) into reconcileExecutedOpenState, not just the bare quantity', () => {
    expect(liveRunnerSrc).toContain('canonicalQtySource: openFillInfo.qtySource,');
    expect(liveRunnerSrc).toContain('rawAvgPrice: openFillInfo.rawAvgPrice,');
    expect(liveRunnerSrc).toContain('initialSlPrice: openedEntry.position.initialSlPrice,');
  });

  it('an unreconciled fill adds the symbol to entriesBlockedDueToUnreconciledFillBySymbol, and the tick loop checks it before processing that symbol again', () => {
    const declIdx = liveRunnerSrc.indexOf('const entriesBlockedDueToUnreconciledFillBySymbol = new Set<string>();');
    const addIdx = liveRunnerSrc.indexOf('entriesBlockedDueToUnreconciledFillBySymbol.add(symbol);');
    const checkIdx = liveRunnerSrc.indexOf('entriesBlockedDueToUnreconciledFillBySymbol.has(symbol)');
    expect(declIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(declIdx);
    expect(checkIdx).toBeGreaterThan(declIdx);
  });

  it('TP/SL absolute prices are never reassigned by the reconcile block (they are already resting real exchange orders placed at the planned prices) — only entryPrice/r/positionSize/risk/margin are corrected', () => {
    const start = liveRunnerSrc.indexOf('if (openFillInfo !== null) {');
    const end = liveRunnerSrc.indexOf('POSITION_SIZE_CORRECTION_ERROR');
    const block = liveRunnerSrc.slice(start, end);
    expect(block).not.toContain('.currentSlPrice =');
    expect(block).not.toContain('.tpLevels =');
    expect(block).not.toContain('.initialSlPrice =');
  });
});
