import { describe, it, expect, vi } from 'vitest';
import {
  resolveCanonicalOpenQty,
  computeQuantityTolerance,
  checkQuantityMismatch,
  formatReconcileQtySyncLog,
  isOrderAlreadyTerminalBinanceError,
  cancelAlgoOrderIdempotent,
  classifyExternalCloseReason,
  reconcileExternalPositionClose,
  ReconcileGuard,
  type ExternalCloseWorkflowInput,
} from './liveStateSync.js';

// ---- P0-A: resolveCanonicalOpenQty ------------------------------------------------------------

describe('resolveCanonicalOpenQty (P0-A)', () => {
  it('prefers executedQty from the fill response when present and > 0', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.010438833, orderRaw: { executedQty: '0.01' }, positionRiskAmt: 0.02 });
    expect(result).toEqual({ qty: 0.01, source: 'EXECUTED_QTY' });
  });

  it('falls back to positionRisk when executedQty is missing', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.010438833, orderRaw: {}, positionRiskAmt: 0.01 });
    expect(result).toEqual({ qty: 0.01, source: 'POSITION_RISK' });
  });

  it('falls back to positionRisk when executedQty is 0 (order accepted but not yet reflected)', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.010438833, orderRaw: { executedQty: '0' }, positionRiskAmt: -0.5 });
    expect(result).toEqual({ qty: 0.5, source: 'POSITION_RISK' }); // abs() of a SHORT positionAmt
  });

  it('falls back to the submitted (already-rounded) qty ONLY as a last resort — never the raw pre-normalization value', () => {
    // submittedQty here represents the value AFTER liveRunner's own rounding was passed to openMarketPosition,
    // i.e. never the crude pre-stepSize calculatedQty from the incident (0.010438833...).
    const result = resolveCanonicalOpenQty({ submittedQty: 0.01, orderRaw: null, positionRiskAmt: null });
    expect(result).toEqual({ qty: 0.01, source: 'SUBMITTED_QTY_FALLBACK' });
  });

  it('ignores a non-numeric executedQty and a null positionRiskAmt, falling through correctly', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.02, orderRaw: { executedQty: 'not-a-number' }, positionRiskAmt: null });
    expect(result).toEqual({ qty: 0.02, source: 'SUBMITTED_QTY_FALLBACK' });
  });

  // TICKET-151B — found during T151A testnet Test H: Binance one-way mode merges same-symbol/
  // same-side positions into ONE positionAmt. Reproduced live on testnet: opening a 2nd 0.313 ETH
  // position while a 1st 0.313 ETH position was still open returned positionRiskAmt=0.626 (the
  // MERGED total), which — without subtracting the already-known 1st position's qty — would wrongly
  // become the 2nd position's own canonicalQty (double its real size).
  it('subtracts existingSameSideQtyBaseAsset from a merged positionRiskAmt to recover the incremental (2nd position) qty', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.313, orderRaw: { executedQty: '0' }, positionRiskAmt: 0.626, existingSameSideQtyBaseAsset: 0.313 });
    expect(result).toEqual({ qty: 0.313, source: 'POSITION_RISK' });
  });

  it('defaults existingSameSideQtyBaseAsset to 0, reproducing the exact pre-T151B single-position behavior', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.01, orderRaw: {}, positionRiskAmt: 0.01 });
    expect(result).toEqual({ qty: 0.01, source: 'POSITION_RISK' });
  });

  it('falls back to submittedQty (never a zero/negative qty) when existingSameSideQtyBaseAsset >= positionRiskAmt (internal bookkeeping cannot be trusted)', () => {
    const result = resolveCanonicalOpenQty({ submittedQty: 0.313, orderRaw: {}, positionRiskAmt: 0.3, existingSameSideQtyBaseAsset: 0.313 });
    expect(result).toEqual({ qty: 0.313, source: 'SUBMITTED_QTY_FALLBACK' });
  });
});

// ---- P0-B: step-size-aware tolerance + RECONCILE_QTY_SYNC -------------------------------------

describe('computeQuantityTolerance (P0-B)', () => {
  it('scales with stepSize instead of a fixed epsilon', () => {
    expect(computeQuantityTolerance(0.001)).toBeCloseTo(0.0015, 10);
    expect(computeQuantityTolerance(1)).toBeCloseTo(1.5, 10);
  });

  it('throws on a non-positive stepSize rather than silently returning a bogus tolerance', () => {
    expect(() => computeQuantityTolerance(0)).toThrow();
    expect(() => computeQuantityTolerance(-1)).toThrow();
  });
});

describe('checkQuantityMismatch (P0-B)', () => {
  it('flags a genuine multi-step mismatch beyond stepSize-aware tolerance and produces the exact 6-field RECONCILE_QTY_SYNC log', () => {
    const result = checkQuantityMismatch({
      symbol: 'BTCUSDT',
      side: 'LONG',
      internalQty: 0.015,
      exchangeQty: 0.01,
      stepSize: 0.001,
      reason: 'internal simulation drifted from exchange-confirmed position size',
    });
    expect(result.mismatched).toBe(true);
    expect(result.correctedQty).toBe(0.01); // exchange wins
    expect(result.logLine).toBe(
      '[RECONCILE_QTY_SYNC] symbol=BTCUSDT side=LONG internalQtyBefore=0.015 exchangeQty=0.01 internalQtyAfter=0.01 stepSize=0.001 reason=internal simulation drifted from exchange-confirmed position size',
    );
  });

  it('does NOT flag the exact real incident\'s rounding-only gap (internal=0.010438833 pre-normalization, exchange=0.01 post-stepSize-round) — this is normal single-step rounding, not a state-integrity bug; P0-A\'s fix is that the CANONICAL qty (resolveCanonicalOpenQty) is used downstream from the start, not that this periodic check catches it', () => {
    const result = checkQuantityMismatch({ symbol: 'BTCUSDT', side: 'LONG', internalQty: 0.010438833, exchangeQty: 0.01, stepSize: 0.001, reason: 'periodic reconcile' });
    expect(result.mismatched).toBe(false);
  });

  it('does NOT flag a difference within stepSize-aware tolerance (real lot-size rounding noise)', () => {
    const result = checkQuantityMismatch({ symbol: 'BTCUSDT', side: 'LONG', internalQty: 0.0100004, exchangeQty: 0.01, stepSize: 0.001, reason: 'noise' });
    expect(result.mismatched).toBe(false);
    expect(result.correctedQty).toBe(0.0100004);
    expect(result.logLine).toBeNull();
  });

  it('the OLD fixed 1e-8 tolerance would have wrongly flagged real lot-size noise as a mismatch — this is exactly what P0-B fixes', () => {
    const oldToleranceWouldFlag = Math.abs(0.0100004 - 0.01) > 1e-8;
    expect(oldToleranceWouldFlag).toBe(true); // proves the bug existed
    const newResult = checkQuantityMismatch({ symbol: 'ETHUSDT', side: 'SHORT', internalQty: 0.0100004, exchangeQty: 0.01, stepSize: 0.001, reason: 'noise' });
    expect(newResult.mismatched).toBe(false); // proves it's fixed
  });

  it('formatReconcileQtySyncLog emits all 6 required fields in order', () => {
    const line = formatReconcileQtySyncLog({ symbol: 'XRPUSDT', side: 'SHORT', internalQtyBefore: 100, exchangeQty: 99, internalQtyAfter: 99, stepSize: 1, reason: 'test' });
    for (const field of ['symbol=XRPUSDT', 'side=SHORT', 'internalQtyBefore=100', 'exchangeQty=99', 'internalQtyAfter=99', 'stepSize=1', 'reason=test']) {
      expect(line).toContain(field);
    }
  });
});

// ---- P0-E: -2011 idempotent handling -----------------------------------------------------------

describe('isOrderAlreadyTerminalBinanceError', () => {
  it('recognizes the -2011 code embedded in signedMutate()\'s error message format', () => {
    const err = new Error(`[cancelAlgoOrder(BTCUSDT,123)] HTTP 400 Bad Request: {"code":-2011,"msg":"Unknown order sent."} (KHÔNG tự retry...)`);
    expect(isOrderAlreadyTerminalBinanceError(err)).toBe(true);
  });

  it('does not misclassify an unrelated error (e.g. a real SL placement failure)', () => {
    const err = new Error(`[placeStopMarket(BTCUSDT,LONG)] HTTP 400 Bad Request: {"code":-1013,"msg":"Filter failure: MIN_NOTIONAL"}`);
    expect(isOrderAlreadyTerminalBinanceError(err)).toBe(false);
  });
});

describe('cancelAlgoOrderIdempotent (P0-E)', () => {
  it('returns CANCELLED on a normal successful cancel — never touches the terminal path', async () => {
    const executor = { cancelAlgoOrder: vi.fn().mockResolvedValue({}) };
    const outcome = await cancelAlgoOrderIdempotent(executor, 'BTCUSDT', 1, 'handleCloseEvent', true);
    expect(outcome).toEqual({ status: 'CANCELLED' });
    expect(executor.cancelAlgoOrder).toHaveBeenCalledTimes(1); // exactly once — never retried
  });

  it('treats -2011 as ALREADY_TERMINAL when the position is confirmed closed, with the exact log tag', async () => {
    const executor = { cancelAlgoOrder: vi.fn().mockRejectedValue(new Error('[cancelAlgoOrder(BTCUSDT,1)] HTTP 400: {"code":-2011,"msg":"Unknown order sent."}')) };
    const outcome = await cancelAlgoOrderIdempotent(executor, 'BTCUSDT', 1, 'handleCloseEvent', true);
    expect(outcome.status).toBe('ALREADY_TERMINAL');
    if (outcome.status === 'ALREADY_TERMINAL') {
      expect(outcome.logLine).toContain('[CLEANUP_ORDER_ALREADY_TERMINAL]');
      expect(outcome.logLine).toContain('symbol=BTCUSDT');
      expect(outcome.logLine).toContain('algoId=1');
    }
    expect(executor.cancelAlgoOrder).toHaveBeenCalledTimes(1); // never blindly retried
  });

  it('a -2011 WITHOUT confirmed-closed context stays a loud ERROR — the unsafe case the ticket explicitly warns about', async () => {
    const executor = { cancelAlgoOrder: vi.fn().mockRejectedValue(new Error('[cancelAlgoOrder(BTCUSDT,1)] HTTP 400: {"code":-2011,"msg":"Unknown order sent."}')) };
    const outcome = await cancelAlgoOrderIdempotent(executor, 'BTCUSDT', 1, 'handleCloseEvent', false);
    expect(outcome.status).toBe('ERROR');
  });

  it('a non-2011 error always stays ERROR even when position is confirmed closed', async () => {
    const executor = { cancelAlgoOrder: vi.fn().mockRejectedValue(new Error('network timeout')) };
    const outcome = await cancelAlgoOrderIdempotent(executor, 'BTCUSDT', 1, 'handleCloseEvent', true);
    expect(outcome.status).toBe('ERROR');
  });
});

// ---- §6: close-reason classification -----------------------------------------------------------

describe('classifyExternalCloseReason', () => {
  const baseInput = {
    side: 'LONG' as const,
    entryPrice: 100,
    slPrice: 95,
    remainingBaseAssetQty: 1,
    tpLevels: [
      { label: 'TP1' as const, price: 106, closePercent: 0.4 },
      { label: 'TP2' as const, price: 112.5, closePercent: 0.3 },
      { label: 'TP3_RUNNER' as const, price: null, closePercent: 0.3 },
    ],
  };

  it('classifies SL when realized PnL matches the known SL price within tolerance', () => {
    const result = classifyExternalCloseReason({ ...baseInput, incomeEntries: [{ incomeType: 'REALIZED_PNL', income: '-5.1' }] });
    expect(result.reason).toBe('SL');
    expect(result.realizedPnlUsd).toBeCloseTo(-5.1);
  });

  it('classifies TP1 when realized PnL matches the known TP1 price/closePercent within tolerance', () => {
    // expected = (106-100) * 1 * 0.4 = 2.4
    const result = classifyExternalCloseReason({ ...baseInput, incomeEntries: [{ incomeType: 'REALIZED_PNL', income: '2.3' }] });
    expect(result.reason).toBe('TP1');
  });

  it('returns UNKNOWN_EXCHANGE_CLOSE when there is no income evidence at all — never guesses from price alone', () => {
    const result = classifyExternalCloseReason({ ...baseInput, incomeEntries: [] });
    expect(result.reason).toBe('UNKNOWN_EXCHANGE_CLOSE');
    expect(result.realizedPnlUsd).toBeNull();
  });

  it('returns UNKNOWN_EXCHANGE_CLOSE for a manual/unexpected-price close whose PnL matches no known SL/TP (no fake attribution)', () => {
    const result = classifyExternalCloseReason({ ...baseInput, incomeEntries: [{ incomeType: 'REALIZED_PNL', income: '50' }] }); // way off any SL/TP
    expect(result.reason).toBe('UNKNOWN_EXCHANGE_CLOSE');
    expect(result.realizedPnlUsd).toBe(50);
  });

  it('ignores non-REALIZED_PNL income entries (e.g. FUNDING_FEE/COMMISSION) when summing', () => {
    const result = classifyExternalCloseReason({
      ...baseInput,
      incomeEntries: [
        { incomeType: 'FUNDING_FEE', income: '-1000' }, // must be ignored — would otherwise wreck the match
        { incomeType: 'REALIZED_PNL', income: '-5.0' },
      ],
    });
    expect(result.reason).toBe('SL');
    expect(result.realizedPnlUsd).toBeCloseTo(-5.0);
  });
});

// ---- P0-C: the external-close workflow ---------------------------------------------------------

function makeWorkflowInput(overrides: Partial<ExternalCloseWorkflowInput> = {}): ExternalCloseWorkflowInput {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    slPrice: 95,
    tpLevels: [{ label: 'TP1', price: 106, closePercent: 0.4 }],
    internalQtyBeforeBaseAsset: 1,
    actualRiskDollar: 15,
    marginRequired: 12.5,
    incomeWindowStartMs: 1_000,
    incomeWindowEndMs: 2_000,
    ...overrides,
  };
}

describe('reconcileExternalPositionClose (P0-C)', () => {
  it('confirms closed, classifies via income, and releases the exact risk$/margin$ that were attributed to this position (P0-F)', async () => {
    const executor = {
      getPositionRisk: vi.fn().mockResolvedValue([{ symbol: 'BTCUSDT', positionAmt: '0' }]),
      getIncome: vi.fn().mockResolvedValue([{ incomeType: 'REALIZED_PNL', income: '-5' }]),
    };
    const result = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    expect(result.confirmedClosed).toBe(true);
    expect(result.closeReason).toBe('SL');
    expect(result.releasedRiskDollar).toBe(15);
    expect(result.releasedMarginDollar).toBe(12.5);
    expect(result.logLine).toContain('[RECONCILE_POSITION_CLOSED]');
    expect(result.logLine).toContain('classification=\'reconciled_external_close\'');
    expect(executor.getPositionRisk).toHaveBeenCalledTimes(1); // single fresh query, no retry loop
  });

  it('does NOT fabricate a PnL number when getIncome has no evidence — reports realizedPnlUsd as unknown/null, never a computed guess', async () => {
    const executor = { getPositionRisk: vi.fn().mockResolvedValue([{ symbol: 'BTCUSDT', positionAmt: '0' }]), getIncome: vi.fn().mockResolvedValue([]) };
    const result = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    expect(result.confirmedClosed).toBe(true);
    expect(result.closeReason).toBe('UNKNOWN_EXCHANGE_CLOSE');
    expect(result.realizedPnlUsd).toBeNull();
  });

  it('refuses to close out internal state when a FRESH re-query shows the position is actually still open (stale mismatch / race)', async () => {
    const executor = { getPositionRisk: vi.fn().mockResolvedValue([{ symbol: 'BTCUSDT', positionAmt: '0.5' }]), getIncome: vi.fn() };
    const result = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    expect(result.confirmedClosed).toBe(false);
    expect(executor.getIncome).not.toHaveBeenCalled(); // never even queries income if the position isn't actually gone
  });

  it('still confirms closed (degrading classification to UNKNOWN) when getIncome() itself fails — a reporting-endpoint failure must never block clearing a confirmed-gone position', async () => {
    const executor = { getPositionRisk: vi.fn().mockResolvedValue([]), getIncome: vi.fn().mockRejectedValue(new Error('income endpoint down')) };
    const result = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    expect(result.confirmedClosed).toBe(true);
    expect(result.closeReason).toBe('UNKNOWN_EXCHANGE_CLOSE');
  });

  it('running the SAME confirmed-closed workflow twice with identical inputs produces the identical release amounts both times (idempotent at the pure-function level; caller\'s ReconcileGuard + state removal prevent it from actually running twice for real)', async () => {
    const executor = { getPositionRisk: vi.fn().mockResolvedValue([]), getIncome: vi.fn().mockResolvedValue([{ incomeType: 'REALIZED_PNL', income: '-5' }]) };
    const first = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    const second = await reconcileExternalPositionClose(executor, makeWorkflowInput());
    expect(first.releasedRiskDollar).toBe(second.releasedRiskDollar);
    expect(first.releasedMarginDollar).toBe(second.releasedMarginDollar);
  });
});

// ---- §11: ReconcileGuard -------------------------------------------------------------------------

describe('ReconcileGuard (§11 race-condition audit)', () => {
  it('tryStart() succeeds once, then refuses a second concurrent reconcile for the same symbol', () => {
    const guard = new ReconcileGuard();
    expect(guard.tryStart('BTCUSDT')).toBe(true);
    expect(guard.tryStart('BTCUSDT')).toBe(false); // the double-reconcile race this guard exists to prevent
    expect(guard.isReconciling('BTCUSDT')).toBe(true);
  });

  it('a different symbol is never blocked by another symbol\'s in-flight reconcile', () => {
    const guard = new ReconcileGuard();
    guard.tryStart('BTCUSDT');
    expect(guard.tryStart('ETHUSDT')).toBe(true);
  });

  it('finish() releases the guard so a later reconcile (or a new entry) on that symbol can proceed', () => {
    const guard = new ReconcileGuard();
    guard.tryStart('BTCUSDT');
    guard.finish('BTCUSDT');
    expect(guard.isReconciling('BTCUSDT')).toBe(false);
    expect(guard.tryStart('BTCUSDT')).toBe(true);
  });
});
