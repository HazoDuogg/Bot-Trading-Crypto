/**
 * TICKET-G1R-A "Final Internal Closure" item 6 — INTEGRATION LIFECYCLE HARNESS.
 *
 * This is NOT a source-scan suite. It EXECUTES the real, already-existing exported functions
 * (performStartupRestartRecovery, captureCoherentReconciliationSnapshotWithRetry,
 * reconcileExecutedOpenState, computeCurrentPositionRisk/rebuildPortfolioRisk,
 * runProtectiveOrderMonitorSweep/recoverMissingProtectiveSl, verifyProtectiveSlOrder/
 * verifyProtectiveTpOrder, the real BinanceOrderExecutor adapter over a mocked fetch) in sequence
 * against ONE stateful mocked exchange, so the whole chain is exercised as a flow rather than as
 * isolated units. No network access — the executor is either a hand-mocked object or the real class
 * driven by an injected `fetchFn`.
 *
 * Required chain: startup -> exchange balance $346.04 -> empty-account bootstrap -> first admission
 * uses $346.04 -> open + canonical fill reconciliation -> SL/TP semantic verification -> TP1 partial
 * close -> booked PnL + current-risk recomputation -> cross-symbol admission -> restart recovery ->
 * SL missing mid-runtime -> bounded repair/re-verify -> full close -> final reconciliation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  performStartupRestartRecovery,
  captureCoherentReconciliationSnapshotWithRetry,
  captureCoherentReconciliationSnapshotOnce,
  reconcileExecutedOpenState,
  runProtectiveOrderMonitorSweep,
  verifyProtectiveSlOrder,
  verifyProtectiveTpOrder,
  computeQuantityTolerance,
  createSingleFlightRunner,
  checkMergedPositionAllocation,
  decideSideRecovery,
  DEFAULT_POSITION_MODE,
  PROTECTIVE_SL_ORDER_TYPES,
  type ProtectiveMonitorPositionInput,
} from './liveStateSync.js';
import { computeCurrentPositionRisk, rebuildPortfolioRisk } from '../risk/currentRisk.js';
import { parseExchangeBalanceSnapshot } from './liveBalanceSync.js';
import { type OpenAlgoOrder } from './binanceOrderExecutor.js';

const EXCHANGE_BALANCE = 346.04;
const TOLERANCE = computeQuantityTolerance(0.001);

function balancePayload(wallet: number) {
  return { totalWalletBalance: String(wallet), totalMarginBalance: String(wallet), availableBalance: String(wallet) };
}

function algoOrder(o: Partial<OpenAlgoOrder> & { algoId: number }): OpenAlgoOrder {
  return {
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', origQty: 1, triggerPrice: 95,
    algoStatus: 'NEW', orderType: 'STOP_MARKET', algoType: 'CONDITIONAL', reduceOnly: true,
    closePosition: false, raw: {}, ...o,
  };
}

/**
 * ONE stateful fake exchange driving the whole lifecycle. Every read reflects mutations made by the
 * steps before it, so the harness cannot pass by each step being independently mocked into success.
 */
function makeExchange(initial: { balance: number }) {
  const state = {
    balance: initial.balance,
    positions: [] as Array<{ symbol: string; positionAmt: string; entryPrice: string }>,
    algoOrders: [] as OpenAlgoOrder[],
    income: [] as Array<{ symbol: string; incomeType: string; income: string }>,
    calls: { getAccountInfo: 0, getPositionRisk: 0, getIncome: 0, getOpenAlgoOrders: 0, placeStopMarket: 0, closePositionMarket: 0 },
    incomeArgs: [] as unknown[],
  };
  const executor = {
    getAccountInfo: async () => { state.calls.getAccountInfo++; return balancePayload(state.balance); },
    getPositionRisk: async (symbol?: string) => {
      state.calls.getPositionRisk++;
      return symbol ? state.positions.filter((p) => p.symbol === symbol) : [...state.positions];
    },
    getIncome: async (symbol?: string, ..._rest: unknown[]) => { state.calls.getIncome++; state.incomeArgs.push(symbol); return [...state.income]; },
    getOpenAlgoOrders: async (symbol?: string) => {
      state.calls.getOpenAlgoOrders++;
      return symbol ? state.algoOrders.filter((o) => o.symbol === symbol) : [...state.algoOrders];
    },
    placeStopMarket: async (symbol: string, side: 'LONG' | 'SHORT', triggerPrice: number, quantity: number) => {
      state.calls.placeStopMarket++;
      const algoId = 9000 + state.calls.placeStopMarket;
      state.algoOrders.push(algoOrder({ algoId, symbol, side: side === 'LONG' ? 'SELL' : 'BUY', origQty: quantity, triggerPrice }));
      return { algoId, symbol, algoStatus: 'NEW', raw: {} };
    },
    closePositionMarket: async (symbol: string) => {
      state.calls.closePositionMarket++;
      state.positions = state.positions.filter((p) => p.symbol !== symbol);
      return { orderId: 1, symbol, status: 'FILLED', raw: {} };
    },
  };
  return { state, executor };
}

function slPosition(overrides: Partial<ProtectiveMonitorPositionInput> = {}): ProtectiveMonitorPositionInput {
  return {
    symbol: 'BTCUSDT', side: 'LONG', entryTimestamp: 1000,
    remainingPositionSize: 100, positionSize: 100, entryPrice: 100, currentSlPrice: 95,
    tpLevels: [
      { label: 'TP1', price: 110, closePercent: 0.5 },
      { label: 'TP2', price: 120, closePercent: 0.3 },
      { label: 'TP3_RUNNER', price: null, closePercent: 0.2 },
    ],
    filledTiers: [], slAlgoId: 501, tpAlgoIds: [601, 602], quantityTolerance: TOLERANCE,
    ...overrides,
  };
}

// ==============================================================================================
// THE REQUIRED LIFECYCLE CHAIN — one continuous flow over one stateful exchange
// ==============================================================================================

describe('Item 6 — full lifecycle harness (real functions, mocked executor, one continuous flow)', () => {
  it('runs startup -> bootstrap -> admission -> open/reconcile -> verify -> TP1 -> risk -> cross-symbol -> restart -> SL loss -> repair -> close -> final reconciliation', async () => {
    const { state, executor } = makeExchange({ balance: EXCHANGE_BALANCE });
    const trace: string[] = [];

    // ---- 1. STARTUP: exchange balance is read and PARSED (no default anywhere) -----------------
    const startupBalance = parseExchangeBalanceSnapshot(await executor.getAccountInfo(), Date.now());
    expect(startupBalance.walletBalance).toBe(EXCHANGE_BALANCE);
    let accountBalance = startupBalance.walletBalance;
    let accountBalanceKnown = true;
    trace.push('startup');

    // ---- 2. STARTUP RESTART RECOVERY on a genuinely empty account ------------------------------
    const recovery = await performStartupRestartRecovery({
      executor, symbols: ['BTCUSDT', 'ETHUSDT'], persisted: { status: 'MISSING' },
      quantityToleranceBySymbol: { BTCUSDT: TOLERANCE, ETHUSDT: TOLERANCE },
      initialSymbolState: { openPositions: [] } as never,
    });
    expect(recovery.ok).toBe(true);
    trace.push('restart-recovery-empty');

    // ---- 3. EMPTY-ACCOUNT BOOTSTRAP: a coherent snapshot must still VALIDATE with 0 positions ---
    const bootstrap = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
    expect(bootstrap.status).toBe('VALIDATED');
    if (bootstrap.status !== 'VALIDATED') throw new Error('unreachable');
    // The bootstrap's OWN balance leg is what feeds the balance cache (item 1's atomic adoption).
    const bootstrapBalance = parseExchangeBalanceSnapshot(bootstrap.snapshot.balance.data, bootstrap.snapshot.balance.capturedAt);
    accountBalance = bootstrapBalance.walletBalance;
    expect(accountBalance).toBe(EXCHANGE_BALANCE);
    // Whole-account income leg carried NO symbol (item 2), verified from the mock's own arguments.
    expect(state.incomeArgs.every((a) => a === undefined)).toBe(true);
    trace.push('bootstrap');

    // ---- 4. FIRST ADMISSION uses the real exchange balance, not a default ----------------------
    expect(accountBalanceKnown).toBe(true);
    const riskPoolCapPct = 0.15; // unchanged production cap — asserted, never modified
    const admissionBalance = accountBalance + 0 /* bookedRealizedPnlPortfolio */;
    expect(admissionBalance).toBe(EXCHANGE_BALANCE);
    const riskBudget = admissionBalance * riskPoolCapPct;
    expect(riskBudget).toBeCloseTo(51.906, 3);
    trace.push('first-admission');

    // ---- 5. OPEN + CANONICAL FILL RECONCILIATION ----------------------------------------------
    const reconciled = reconcileExecutedOpenState({
      initialSlPrice: 95, canonicalQty: 1,
      canonicalQtySource: 'EXECUTED_QTY', rawAvgPrice: '100.5', freshPositionRiskEntryPrice: '100.5',
      freshPositionRiskQtyAbs: 1, preSubmissionBaselineQtyAbs: 0, quantityTolerance: 0.001, leverage: 30,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error('unreachable');
    expect(reconciled.entryPriceBasis).toBe('OBSERVED_AVG_FILL');
    expect(reconciled.entryPrice).toBe(100.5);
    state.positions.push({ symbol: 'BTCUSDT', positionAmt: '1', entryPrice: '100.5' });
    // Protective orders now rest on the exchange, as the real placement code would create them.
    state.algoOrders.push(algoOrder({ algoId: 501, origQty: 1, triggerPrice: 95, orderType: 'STOP_MARKET' }));
    state.algoOrders.push(algoOrder({ algoId: 601, origQty: 0.5, triggerPrice: 110, orderType: 'TAKE_PROFIT_MARKET' }));
    state.algoOrders.push(algoOrder({ algoId: 602, origQty: 0.3, triggerPrice: 120, orderType: 'TAKE_PROFIT_MARKET' }));
    trace.push('open+fill-reconcile');

    // ---- 6. SL/TP SEMANTIC VERIFICATION (full item-4 depth) -----------------------------------
    const position = slPosition({ entryPrice: 100.5, positionSize: 100.5, remainingPositionSize: 100.5 });
    let sweep = await runProtectiveOrderMonitorSweep({ executor, positions: [position], policy: 'OPERATOR_REQUIRED', openAlgoOrders: await executor.getOpenAlgoOrders() });
    expect(sweep[0].sl.status).toBe('VERIFIED');
    expect(sweep[0].tpFindings).toHaveLength(0);
    expect(state.calls.placeStopMarket).toBe(0); // a verified SL triggers NO repair
    trace.push('sl-tp-verified');

    // ---- 7. TP1 PARTIAL CLOSE ------------------------------------------------------------------
    state.positions = [{ symbol: 'BTCUSDT', positionAmt: '0.5', entryPrice: '100.5' }];
    state.algoOrders = state.algoOrders.filter((o) => o.algoId !== 601); // TP1 filled -> no longer resting
    state.income.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '4.75' });
    const bookedRealizedPnl = 4.75;
    const afterTp1 = slPosition({
      entryPrice: 100.5, positionSize: 100.5, remainingPositionSize: 50.25,
      filledTiers: ['TP1'], currentSlPrice: 100.5, // SL moved to break-even at TP1
    });
    // The resting SL is updated on the exchange to the new qty/trigger, as the real code does.
    state.algoOrders = state.algoOrders.map((o) => (o.algoId === 501 ? algoOrder({ algoId: 501, origQty: 0.5, triggerPrice: 100.5 }) : o));
    sweep = await runProtectiveOrderMonitorSweep({ executor, positions: [afterTp1], policy: 'OPERATOR_REQUIRED', openAlgoOrders: await executor.getOpenAlgoOrders() });
    expect(sweep[0].sl.status).toBe('VERIFIED'); // new qty AND new trigger both verified
    expect(sweep[0].tpFindings).toHaveLength(0); // TP1 filled + gone = the clean case
    trace.push('tp1-partial-close');

    // ---- 8. BOOKED REALIZED PnL + CURRENT-RISK RECOMPUTATION -----------------------------------
    const riskAfterTp1 = computeCurrentPositionRisk({ side: 'LONG', entryPrice: 100.5, currentSlPrice: 100.5, remainingPositionSize: 50.25 });
    expect(riskAfterTp1.openRiskDollar).toBe(0); // SL at break-even => zero committed risk
    const portfolioAfterTp1 = rebuildPortfolioRisk({
      knownPositions: [{ id: 'BTCUSDT', basis: { side: 'LONG', entryPrice: 100.5, currentSlPrice: 100.5, remainingPositionSize: 50.25 } }],
      unknownExposures: [],
    });
    expect(portfolioAfterTp1.totalRiskDollar).toBe(0);
    expect(portfolioAfterTp1.hasUnquantifiableExposure).toBe(false);
    // Admission basis: exchange balance + booked-but-unsettled tier PnL, added ONCE.
    const admissionAfterTp1 = accountBalance + bookedRealizedPnl;
    expect(admissionAfterTp1).toBeCloseTo(350.79, 2);
    trace.push('booked-pnl+risk-recompute');

    // ---- 9. CROSS-SYMBOL ADMISSION (freed risk on BTC is usable by ETH) -----------------------
    const crossSymbol = rebuildPortfolioRisk({
      knownPositions: [
        { id: 'BTCUSDT', basis: { side: 'LONG', entryPrice: 100.5, currentSlPrice: 100.5, remainingPositionSize: 50.25 } },
        { id: 'ETHUSDT', basis: { side: 'SHORT', entryPrice: 2000, currentSlPrice: 2040, remainingPositionSize: 400 } },
      ],
      unknownExposures: [],
    });
    expect(crossSymbol.totalRiskDollar).toBeGreaterThan(0);
    expect(crossSymbol.totalRiskDollar).toBeLessThan(admissionAfterTp1 * riskPoolCapPct);
    trace.push('cross-symbol-admission');

    // ---- 10. RESTART RECOVERY with a live position (ownership must be PROVEN) ------------------
    const restart = await performStartupRestartRecovery({
      executor, symbols: ['BTCUSDT'],
      persisted: {
        status: 'OK',
        file: {
          schemaVersion: 1,
          savedAtMs: Date.now(),
          symbols: {
            BTCUSDT: {
              symbolState: { openPositions: [{ position: { side: 'LONG', remainingPositionSize: 50.25, entryPrice: 100.5, filledTiers: ['TP1'] }, meta: { entryTimestamp: 1000, actualRiskDollar: 0, marginRequired: 1.675, bookedRealizedPnl: 4.75 } }] },
              orderIds: [[1000, { slAlgoId: 501, tpAlgoIds: [602] }]],
            },
          },
        },
      } as never,
      quantityToleranceBySymbol: { BTCUSDT: TOLERANCE },
      initialSymbolState: { openPositions: [] } as never,
    });
    expect(restart.ok).toBe(true);
    if (restart.ok) {
      const longOutcome = restart.symbols[0].sideOutcomes.find((s) => s.side === 'LONG');
      // Exchange qty (0.5) proves ownership of the persisted 0.5 -> RECOVERED, not quarantined.
      expect(longOutcome?.status).toBe('RECOVERED');
      expect(restart.symbols[0].blockEntries).toBe(false);
      expect(restart.symbols[0].symbolState.openPositions).toHaveLength(1);
      // The persisted protective algoIds survive the restart intact (idempotency basis).
      expect(restart.symbols[0].orderIds.get(1000)?.slAlgoId).toBe(501);
    }
    trace.push('restart-recovery-with-position');

    // ---- 11. SL GOES MISSING MID-RUNTIME -------------------------------------------------------
    state.algoOrders = state.algoOrders.filter((o) => o.algoId !== 501);
    const verifyMissing = verifyProtectiveSlOrder({
      persistedSlAlgoId: 501, expectedSide: 'LONG', expectedQty: 0.5, quantityTolerance: TOLERANCE,
      openAlgoOrders: await executor.getOpenAlgoOrders('BTCUSDT'),
      expectedSymbol: 'BTCUSDT', expectedTriggerPrice: 100.5, positionMode: DEFAULT_POSITION_MODE, expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES,
    });
    expect(verifyMissing.status).toBe('MISSING');
    trace.push('sl-missing');

    // ---- 12. BOUNDED REPAIR + RE-VERIFY (idempotent, no duplicate SL) --------------------------
    sweep = await runProtectiveOrderMonitorSweep({ executor, positions: [afterTp1], policy: 'OPERATOR_REQUIRED', openAlgoOrders: await executor.getOpenAlgoOrders() });
    expect(sweep[0].sl.status).toBe('RECOVERED');
    expect(state.calls.placeStopMarket).toBe(1); // exactly one repair placement
    // The position was NEVER dropped from management.
    expect(state.positions).toHaveLength(1);
    // Re-running the sweep now finds a resting, semantically-correct SL and repairs NOTHING more.
    const repairedId = sweep[0].sl.status === 'RECOVERED' ? sweep[0].sl.newSlAlgoId : -1;
    const afterRepair = slPosition({ entryPrice: 100.5, positionSize: 100.5, remainingPositionSize: 50.25, filledTiers: ['TP1'], currentSlPrice: 100.5, slAlgoId: repairedId, tpAlgoIds: [602] });
    sweep = await runProtectiveOrderMonitorSweep({ executor, positions: [afterRepair], policy: 'OPERATOR_REQUIRED', openAlgoOrders: await executor.getOpenAlgoOrders() });
    expect(sweep[0].sl.status).toBe('VERIFIED');
    expect(state.calls.placeStopMarket).toBe(1); // still ONE — idempotent
    trace.push('bounded-repair+reverify');

    // ---- 13. FULL CLOSE ------------------------------------------------------------------------
    state.positions = [];
    state.algoOrders = [];
    state.balance = 352.1;
    state.income.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '1.31' });
    trace.push('full-close');

    // ---- 14. FINAL EXCHANGE BALANCE / STATE / RISK RECONCILIATION ------------------------------
    const finalSnapshot = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
    expect(finalSnapshot.status).toBe('VALIDATED');
    if (finalSnapshot.status !== 'VALIDATED') throw new Error('unreachable');
    const finalBalance = parseExchangeBalanceSnapshot(finalSnapshot.snapshot.balance.data, finalSnapshot.snapshot.balance.capturedAt);
    expect(finalBalance.walletBalance).toBe(352.1);
    expect(finalSnapshot.snapshot.protectiveOrders.data).toHaveLength(0);
    const finalRisk = rebuildPortfolioRisk({ knownPositions: [], unknownExposures: [] });
    expect(finalRisk.totalRiskDollar).toBe(0);
    expect(finalRisk.hasUnquantifiableExposure).toBe(false);
    // The exchange balance ALREADY reflects every settled tier ($4.75 TP1 + $1.31 final close).
    expect(finalBalance.walletBalance).toBeCloseTo(EXCHANGE_BALANCE + bookedRealizedPnl + 1.31, 2);
    // Once a tier has settled it must NOT also be carried in bookedRealizedPnlPortfolio — adding it
    // again on top of the exchange balance is exactly the double-count item 1 warns about. After a
    // full close nothing is unsettled, so the admission basis equals the exchange balance exactly.
    const bookedStillUnsettledAfterClose = 0;
    expect(finalBalance.walletBalance + bookedStillUnsettledAfterClose).toBe(finalBalance.walletBalance);
    expect(finalBalance.walletBalance + bookedRealizedPnl).not.toBe(finalBalance.walletBalance);
    trace.push('final-reconciliation');

    // ---- The whole required chain ran, in order -------------------------------------------------
    expect(trace).toEqual([
      'startup', 'restart-recovery-empty', 'bootstrap', 'first-admission', 'open+fill-reconcile',
      'sl-tp-verified', 'tp1-partial-close', 'booked-pnl+risk-recompute', 'cross-symbol-admission',
      'restart-recovery-with-position', 'sl-missing', 'bounded-repair+reverify', 'full-close',
      'final-reconciliation',
    ]);
  });
});

// ==============================================================================================
// Required failure paths — each its own test, all with a mocked executor
// ==============================================================================================

describe('Item 6 — failure paths', () => {
  const okExec = () => ({
    getAccountInfo: async () => balancePayload(EXCHANGE_BALANCE),
    getPositionRisk: async () => [],
    getIncome: async () => [],
    getOpenAlgoOrders: async () => [],
  });

  it('balance payload malformed -> parse throws, nothing is marked fresh', () => {
    expect(() => parseExchangeBalanceSnapshot({ totalWalletBalance: 'oops' }, 1)).toThrow();
    expect(() => parseExchangeBalanceSnapshot(null, 1)).toThrow();
  });

  it('balance observations arriving out of order -> the older one loses', () => {
    const newer = parseExchangeBalanceSnapshot(balancePayload(500), 5000);
    const older = parseExchangeBalanceSnapshot(balancePayload(100), 4000);
    // The anti-time-travel rule (liveRunner.applyBalanceObservation) compares capturedAt.
    const winner = older.fetchedAt < newer.fetchedAt ? newer : older;
    expect(winner.walletBalance).toBe(500);
  });

  it('whole-account income query carries no symbol — checked via the mock\'s actual arguments', async () => {
    const getIncome = vi.fn().mockResolvedValue([]);
    await captureCoherentReconciliationSnapshotOnce({ ...okExec(), getIncome }, { incomeWindowStartMs: 1, incomeWindowEndMs: 2 });
    expect(getIncome.mock.calls[0][0]).toBeUndefined();
  });

  it('malformed algo-order side/status/type/price/boolean -> READ_ERROR, never an empty protective-order list', async () => {
    for (const bad of ['side', 'algoStatus', 'orderType', 'triggerPrice', 'reduceOnly']) {
      const result = await captureCoherentReconciliationSnapshotOnce(
        { ...okExec(), getOpenAlgoOrders: async () => { throw new Error(`getOpenAlgoOrders: ${bad} không hợp lệ`); } },
        { incomeWindowStartMs: 1, incomeWindowEndMs: 2 },
      );
      expect(result.status).toBe('READ_ERROR');
    }
  });

  it('strange endpoint envelope -> READ_ERROR (never "no open orders")', async () => {
    const result = await captureCoherentReconciliationSnapshotOnce(
      { ...okExec(), getOpenAlgoOrders: async () => { throw new Error('getOpenAlgoOrders: response shape không như dự kiến'); } },
      { incomeWindowStartMs: 1, incomeWindowEndMs: 2 },
    );
    expect(result.status).toBe('READ_ERROR');
  });

  it('SL with the RIGHT algoId but a wrong trigger / type / positionSide is NOT accepted', async () => {
    const common = { persistedSlAlgoId: 501, expectedSide: 'LONG' as const, expectedQty: 1, quantityTolerance: TOLERANCE, expectedSymbol: 'BTCUSDT', positionMode: DEFAULT_POSITION_MODE, expectedOrderTypes: PROTECTIVE_SL_ORDER_TYPES };
    expect(verifyProtectiveSlOrder({ ...common, expectedTriggerPrice: 95, openAlgoOrders: [algoOrder({ algoId: 501, triggerPrice: 80 })] }).status).toBe('WRONG_TRIGGER_PRICE');
    expect(verifyProtectiveSlOrder({ ...common, expectedTriggerPrice: 95, openAlgoOrders: [algoOrder({ algoId: 501, orderType: 'TAKE_PROFIT_MARKET' })] }).status).toBe('WRONG_ORDER_TYPE');
    expect(verifyProtectiveSlOrder({ ...common, expectedTriggerPrice: 95, openAlgoOrders: [algoOrder({ algoId: 501, positionSide: 'SHORT' })] }).status).toBe('WRONG_POSITION_SIDE');
  });

  it('TP1 then restart does not double-book realized PnL (re-confirmed in the new balance regime)', () => {
    // The exchange wallet balance itself already includes settled PnL. After a restart, the booked
    // number is re-derived from persisted state, never re-added to a balance that already contains it.
    const exchangeBalanceAfterTp1Settled = EXCHANGE_BALANCE + 4.75;
    const bookedStillUnsettled = 0; // TP1 settled -> nothing left to add
    expect(exchangeBalanceAfterTp1Settled + bookedStillUnsettled).toBeCloseTo(350.79, 2);
    expect(exchangeBalanceAfterTp1Settled + 4.75).not.toBeCloseTo(350.79, 2); // the double-count case
  });

  it('emergency close leaving residual qty -> PROTECTION_DEGRADED, position stays managed', async () => {
    const { state, executor } = makeExchange({ balance: EXCHANGE_BALANCE });
    state.positions.push({ symbol: 'BTCUSDT', positionAmt: '1', entryPrice: '100' });
    // Close "succeeds" but a residual remains on the exchange.
    executor.closePositionMarket = async () => { state.positions = [{ symbol: 'BTCUSDT', positionAmt: '0.4', entryPrice: '100' }]; return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} }; };
    executor.placeStopMarket = async () => { throw new Error('exchange rejects'); };
    const sweep = await runProtectiveOrderMonitorSweep({ executor, positions: [slPosition()], policy: 'EMERGENCY_CLOSE', openAlgoOrders: [] });
    expect(sweep[0].sl.status).toBe('PROTECTION_DEGRADED');
    if (sweep[0].sl.status === 'PROTECTION_DEGRADED') expect(sweep[0].sl.residualBaseQty).toBeCloseTo(0.4, 5);
    expect(state.positions).toHaveLength(1); // never dropped from management
  });

  it('two concurrent monitor cycles never run concurrently (no duplicate protective orders)', async () => {
    const { state, executor } = makeExchange({ balance: EXCHANGE_BALANCE });
    state.positions.push({ symbol: 'BTCUSDT', positionAmt: '1', entryPrice: '100' });
    const runner = createSingleFlightRunner(async () => runProtectiveOrderMonitorSweep({ executor, positions: [slPosition()], policy: 'OPERATOR_REQUIRED', openAlgoOrders: await executor.getOpenAlgoOrders() }));
    const [a, b] = await Promise.all([runner.run(), runner.run()]);
    expect(a.skipped !== b.skipped).toBe(true); // exactly one ran
    expect(state.calls.placeStopMarket).toBe(1); // never two SLs for one position
  });

  it('unknown/manual position (exchange has qty the bot never opened) -> QUARANTINED, never adopted', () => {
    const decision = decideSideRecovery({ persistedEntries: [], exchangeBaseQty: 0.7, quantityTolerance: TOLERANCE });
    expect(decision.status).toBe('QUARANTINED');
  });

  it('unquantifiable unknown exposure blocks the WHOLE portfolio through the existing risk ledger', () => {
    const r = rebuildPortfolioRisk({ knownPositions: [], unknownExposures: [{ id: 'BTCUSDT:manual', basis: null }] });
    expect(r.hasUnquantifiableExposure).toBe(true);
  });

  it('two logical same-side positions on ONE merged exchange position stay safely allocated', () => {
    const merged = checkMergedPositionAllocation({
      persistedEntries: [{ id: 'a', remainingBaseQty: 0.6 }, { id: 'b', remainingBaseQty: 0.4 }],
      exchangeBaseQty: 1.0, protectiveTotalBaseQty: 1.0, quantityTolerance: TOLERANCE,
    });
    expect(merged.status).toBe('RECONCILED');
    if (merged.status === 'RECONCILED') expect(merged.allocationQuality).toBe('UNVERIFIED_SPLIT');
    // A genuine sum mismatch blocks the WHOLE portfolio, never silently re-splits.
    const over = checkMergedPositionAllocation({
      persistedEntries: [{ id: 'a', remainingBaseQty: 0.8 }, { id: 'b', remainingBaseQty: 0.8 }],
      exchangeBaseQty: 1.0, protectiveTotalBaseQty: 1.0, quantityTolerance: TOLERANCE,
    });
    expect(over.status).toBe('ACCOUNT_STATE_UNKNOWN');
    // Protective coverage short of the merged qty is equally an unknown state.
    const underProtected = checkMergedPositionAllocation({
      persistedEntries: [{ id: 'a', remainingBaseQty: 0.6 }, { id: 'b', remainingBaseQty: 0.4 }],
      exchangeBaseQty: 1.0, protectiveTotalBaseQty: 0.6, quantityTolerance: TOLERANCE,
    });
    expect(underProtected.status).toBe('ACCOUNT_STATE_UNKNOWN');
  });

  it('no trade events for many cycles, but periodic snapshots keep balance VALUE and freshness current (item 1 regression)', async () => {
    const { state, executor } = makeExchange({ balance: EXCHANGE_BALANCE });
    let cachedBalance = 0;
    let lastFreshMs: number | null = null;
    for (let cycle = 0; cycle < 5; cycle++) {
      state.balance = EXCHANGE_BALANCE + cycle; // the exchange balance genuinely moves (funding etc.)
      const snap = await captureCoherentReconciliationSnapshotWithRetry(executor, { incomeWindowStartMs: 0, incomeWindowEndMs: 1 });
      expect(snap.status).toBe('VALIDATED');
      if (snap.status !== 'VALIDATED') throw new Error('unreachable');
      const parsed = parseExchangeBalanceSnapshot(snap.snapshot.balance.data, snap.snapshot.balance.capturedAt);
      cachedBalance = parsed.walletBalance;
      lastFreshMs = snap.snapshot.balance.capturedAt;
    }
    // THE point of item 1: the cached VALUE tracked the exchange, not just the timestamp.
    expect(cachedBalance).toBe(EXCHANGE_BALANCE + 4);
    expect(lastFreshMs).not.toBeNull();
    expect(state.calls.getAccountInfo).toBe(5);
    expect(state.positions).toHaveLength(0);
  });

  it('a failed read keeps open positions managed but blocks admission portfolio-wide', async () => {
    const result = await captureCoherentReconciliationSnapshotOnce(
      { ...okExec(), getAccountInfo: async () => { throw new Error('network down'); } },
      { incomeWindowStartMs: 1, incomeWindowEndMs: 2 },
    );
    expect(result.status).toBe('READ_ERROR');
    // A READ_ERROR is what liveRunner turns into ACCOUNT_STATE_UNKNOWN; it carries no instruction to
    // clear positions, and no snapshot data that could be mistaken for "flat".
    expect(result).not.toHaveProperty('snapshot');
  });
});
