import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileExecutedOpenState } from './liveStateSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8');
const liveLifecycleSrc = fs.readFileSync(path.resolve(__dirname, './liveLifecycle.ts'), 'utf8');

describe('G1-F05 fixed — partial fill and quantity-normalization reconciliation', () => {
  it('partial fill (canonicalQty < planned qty) reconciles positionSize/actualRiskDollar/marginRequired against the corrected notional, entryPrice from observed avg fill', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 0.6,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: '100',
      freshPositionRiskEntryPrice: '100',
      freshPositionRiskQtyAbs: 0.6,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entryPriceBasis).toBe('OBSERVED_AVG_FILL');
    expect(result.entryPrice).toBe(100);
    expect(result.positionSize).toBeCloseTo(60, 6);
    expect(result.r).toBeCloseTo(2, 6);
    expect(result.actualRiskDollar).toBeCloseTo(60 * (2 / 100), 6);
    expect(result.marginRequired).toBeCloseTo(60 / 30, 6);
  });

  it('quantity normalization (step-size rounding) propagates consistently to positionSize, entryPrice-basis, actualRiskDollar AND marginRequired', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 49000,
      canonicalQty: 0.00987,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 50123.45,
      freshPositionRiskEntryPrice: 50123.45,
      freshPositionRiskQtyAbs: 0.00987,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.0001,
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
    expect(result.actualRiskDollar).toBeCloseTo(result.positionSize * (result.r / result.entryPrice), 10);
  });

  it('a fill missing avgPrice but with a valid fresh getPositionRisk() entryPrice reconciles successfully using that position evidence', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 99,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: undefined,
      freshPositionRiskEntryPrice: '100',
      freshPositionRiskQtyAbs: 1,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entryPriceBasis).toBe('POSITION_RISK_ENTRY_PRICE');
    expect(result.entryPrice).toBe(100);
    expect(result.actualRiskDollar).toBeCloseTo(1 * 100 * (1 / 100), 6);
  });
});

describe('G1-F05 fixed — unreconcilable fill provenance blocks instead of guessing (never falls back to the planned entry price)', () => {
  it('canonicalQty resolution falling all the way back to SUBMITTED_QTY_FALLBACK (unconfirmed guess) is rejected, not silently reconciled', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'SUBMITTED_QTY_FALLBACK',
      rawAvgPrice: '100',
      freshPositionRiskEntryPrice: '100',
      freshPositionRiskQtyAbs: 1,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('CANONICAL_QTY_UNCONFIRMED');
  });

  it('a non-positive/non-finite canonicalQty is rejected outright', () => {
    for (const badQty of [0, -1, NaN, Infinity]) {
      const result = reconcileExecutedOpenState({
        initialSlPrice: 98,
        canonicalQty: badQty,
        canonicalQtySource: 'EXECUTED_QTY',
        rawAvgPrice: '100',
        freshPositionRiskEntryPrice: '100',
        freshPositionRiskQtyAbs: Math.abs(badQty) || 1,
        preSubmissionBaselineQtyAbs: 0,
        quantityTolerance: 0.001,
        leverage: 30,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('CANONICAL_QTY_INVALID');
    }
  });

  it('both avgPrice and fresh getPositionRisk() entryPrice invalid/missing -> ENTRY_PRICE_UNAVAILABLE, never falls back to a planned price', () => {
    for (const bad of ['0', '', 'not-a-number', 0, null, undefined]) {
      const result = reconcileExecutedOpenState({
        initialSlPrice: 99,
        canonicalQty: 1,
        canonicalQtySource: 'EXECUTED_QTY',
        rawAvgPrice: bad,
        freshPositionRiskEntryPrice: bad,
        freshPositionRiskQtyAbs: 1,
        preSubmissionBaselineQtyAbs: 0,
        quantityTolerance: 0.001,
        leverage: 30,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('ENTRY_PRICE_UNAVAILABLE');
    }
  });

  it('avgPrice and fresh getPositionRisk() entryPrice materially disagree -> ENTRY_PRICE_DISAGREEMENT', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 100,
      freshPositionRiskEntryPrice: 120,
      freshPositionRiskQtyAbs: 1,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ENTRY_PRICE_DISAGREEMENT');
  });

  it('executedQty vs fresh getPositionRisk() qty mismatch beyond tolerance -> QUANTITY_MISMATCH', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 100,
      freshPositionRiskEntryPrice: 100,
      freshPositionRiskQtyAbs: 5,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('QUANTITY_MISMATCH');
  });

  it('missing pre-submission position baseline fails closed', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 100,
      freshPositionRiskEntryPrice: 100,
      freshPositionRiskQtyAbs: 1,
      preSubmissionBaselineQtyAbs: null as unknown as number,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result).toEqual({ ok: false, reason: 'PRE_SUBMISSION_BASELINE_UNAVAILABLE' });
  });

  it('missing post-fill position quantity fails closed instead of skipping corroboration', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 100,
      freshPositionRiskEntryPrice: null,
      freshPositionRiskQtyAbs: null,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result).toEqual({ ok: false, reason: 'POST_FILL_POSITION_UNAVAILABLE' });
  });

  it('a pre-existing baseline exposure on the same side is accounted for before comparing against fresh getPositionRisk() qty', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 100,
      freshPositionRiskEntryPrice: 100,
      freshPositionRiskQtyAbs: 3,
      preSubmissionBaselineQtyAbs: 2,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(true);
  });

  it('an observed average fill price that lands exactly ON the stop price (zero stop distance) is rejected rather than reporting a 0-risk position', () => {
    const result = reconcileExecutedOpenState({
      initialSlPrice: 98,
      canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY',
      rawAvgPrice: 98,
      freshPositionRiskEntryPrice: 98,
      freshPositionRiskQtyAbs: 1,
      preSubmissionBaselineQtyAbs: 0,
      quantityTolerance: 0.001,
      leverage: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ZERO_STOP_DISTANCE_AFTER_RECONCILE');
  });
});

describe('G1-F05 fixed — liveRunner.ts wiring applies the reconciled basis and blocks on failure', () => {
  it('handleOpenEvent (via establishReconciledProtectedPosition) passes the real fill evidence (canonicalQty/rawAvgPrice/freshPositionRisk) into reconcileExecutedOpenState, computed BEFORE SL placement', () => {
    const fnStart = liveLifecycleSrc.indexOf('async function establishReconciledProtectedPosition(');
    const fnEnd = liveLifecycleSrc.indexOf('export async function handleOpenEvent(');
    const block = liveLifecycleSrc.slice(fnStart, fnEnd);
    expect(block).toContain('canonicalQtySource: \'EXECUTED_QTY\',');
    expect(block).toContain('rawAvgPrice: classificationAvgPrice,');
    expect(block).toContain('initialSlPrice: event.slPrice,');
    expect(block).toContain('freshPositionRiskEntryPrice:');
    expect(block).toContain('preSubmissionBaselineQtyAbs,');
  });

  it('a RECONCILIATION_FAILED (or geometry-invalid) fill routes to the unified quarantine path and blocks the symbol', () => {
    const phaseIdx = liveRunnerSrc.indexOf("phase: 'RECONCILIATION_FAILED',");
    const blockAddIdx = liveLifecycleSrc.indexOf('deps.blockSymbolAdmission(record.symbol);');
    expect(phaseIdx).toBeGreaterThan(-1);
    expect(blockAddIdx).toBeGreaterThan(-1);
  });

  it('TP/SL absolute prices are never reassigned by the reconcile block (they are already resting real exchange orders placed at the planned prices) — only entryPrice/r/positionSize/risk/margin are corrected', () => {
    const start = liveRunnerSrc.indexOf("outcome.kind === 'FILLED'");
    const end = liveRunnerSrc.indexOf("} else if (event.type === 'PARTIAL_CLOSE')");
    const block = liveRunnerSrc.slice(start, end);
    expect(block).not.toContain('.currentSlPrice =');
    expect(block).not.toContain('.tpLevels =');
    expect(block).not.toContain('.initialSlPrice =');
  });
});
