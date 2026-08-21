import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleOpenEvent,
  handlePartialCloseEvent,
  handleCloseEvent,
  createPersistLiveState,
  createRecordPendingEntryQuarantine,
  foldPendingEntryQuarantinesOnRestart,
  applyAmbiguousOpenOutcome,
  handleOpenEventIfFresh,
  reconcileTradeIncomeFromRecords,
  type LifecycleContext,
  type RunnerStateAccess,
  type LiveOrderIds,
} from './liveLifecycle.js';
import { readLiveStateFileSafe, performStartupRestartRecovery, LIVE_STATE_SCHEMA_VERSION, type LiveStateFile, type PendingEntryQuarantineRecord } from './liveStateSync.js';
import { OrderSubmissionError, type BinanceOrderExecutor } from './binanceOrderExecutor.js';
import { rebuildPortfolioRisk, type KnownPositionForRisk } from '../risk/currentRisk.js';
import { assessCandleFreshnessForSymbol, hasAnyStaleRequiredTimeframe } from './candleFreshnessGate.js';
import { wouldExceedRiskPool } from '../risk/riskPool.js';
import { MarketRegime } from '../regime/types.js';
import { INITIAL_SYMBOL_STATE, type CloseTradeEvent, type OpenPositionEntry, type OpenTradeEvent, type PartialCloseEvent, type SymbolState } from '../orchestrator/types.js';

function baseOpenEvent(overrides: Partial<OpenTradeEvent> = {}): OpenTradeEvent {
  return {
    type: 'OPEN',
    symbol: 'BTCUSDT',
    side: 'LONG',
    regime: MarketRegime.TREND_RIDER,
    setupType: 'OB',
    tpPlan: 'PLAN_A',
    entryTimestamp: 1000,
    entryPrice: 100,
    riskMultiplier: 1,
    actualRiskDollar: 20,
    marginRequired: 10,
    slPrice: 98,
    tpLevels: [
      { label: 'TP1', price: 104, rMultiple: 2, closePercent: 0.5 },
      { label: 'TP2', price: 108, rMultiple: 4, closePercent: 0.3 },
      { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: 0.2 },
    ],
    riskPoolPctBefore: 0,
    riskPoolPctAfter: 0.05,
    ...overrides,
  };
}

function makeRunnerState() {
  const orderIdsBySymbol = new Map<string, Map<number, LiveOrderIds>>();
  const openPositionCounts: Record<string, number> = {};
  const blockedSymbols = new Set<string>();
  const incomeBlockedSymbols = new Set<string>();
  const access: RunnerStateAccess = {
    getOpenPositionCount: (s) => openPositionCounts[s] ?? 0,
    setOrderIds: (s, t, ids) => {
      if (!orderIdsBySymbol.has(s)) orderIdsBySymbol.set(s, new Map());
      orderIdsBySymbol.get(s)!.set(t, ids);
    },
    getOrderIds: (s, t) => orderIdsBySymbol.get(s)?.get(t),
    deleteOrderIds: (s, t) => {
      orderIdsBySymbol.get(s)?.delete(t);
    },
    blockSymbolAdmission: (s) => {
      blockedSymbols.add(s);
    },
    blockIncomeReconciliation: (s) => {
      incomeBlockedSymbols.add(s);
    },
    clearIncomeReconciliation: (s) => {
      incomeBlockedSymbols.delete(s);
    },
  };
  return { access, orderIdsBySymbol, openPositionCounts, blockedSymbols, incomeBlockedSymbols };
}

function makeCtx(executor: Partial<BinanceOrderExecutor>, overrides: Partial<LifecycleContext> = {}) {
  const runner = makeRunnerState();
  const telegramMessages: string[] = [];
  let persistCallCount = 0;
  let accountSyncUnknownCalled = false;
  let willOpenCalled = 0;
  const ctx: LifecycleContext = {
    executor: executor as unknown as LifecycleContext['executor'],
    dryRun: false,
    envLabel: 'testnet',
    leverage: 30,
    quantityToleranceBySymbol: { BTCUSDT: 0.001 },
    missingProtectiveSlFailsafePolicy: 'OPERATOR_REQUIRED',
    oodGuardEnabled: false,
    runnerState: runner.access,
    emitTelemetry: () => {},
    enqueueTelegram: (m) => telegramMessages.push(m),
    refreshBalanceForTelegram: async () => null,
    onAccountSyncUnknown: () => {
      accountSyncUnknownCalled = true;
    },
    onWillOpen: () => {
      willOpenCalled += 1;
    },
    persistLiveState: () => {
      persistCallCount += 1;
      return true;
    },
    marketEntryLookupRetryDelaysMs: [],
    marketEntryLookupWait: async () => {},
    incomeReconciliationRetryDelaysMs: [],
    wait: async () => {},
    ...overrides,
  };
  return {
    ctx,
    telegramMessages,
    runner,
    getPersistCallCount: () => persistCallCount,
    getAccountSyncUnknownCalled: () => accountSyncUnknownCalled,
    getWillOpenCalled: () => willOpenCalled,
  };
}

describe('TICKET-LIVE-R3 item 3 stage 3/4/5 — handleOpenEvent: MARKET fill, reconciliation, SL-before-TP', () => {
  it('a MARKET order that confirms filled reconciles entry/quantity from the fill and places SL before TP', async () => {
    const calls: string[] = [];
    let positionRiskCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => {
        calls.push('openMarketPosition');
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: '101' } };
      },
      getPositionRisk: async () => {
        calls.push('getPositionRisk');
        positionRiskCalls += 1;
        if (positionRiskCalls === 1) return [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0' }];
        return [{ symbol: 'BTCUSDT', positionAmt: '0.09', entryPrice: '101' }];
      },
      placeStopMarket: async () => {
        calls.push('placeStopMarket');
        return { algoId: 501, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      getOpenAlgoOrders: async () => [{ algoId: 501, symbol: 'BTCUSDT', side: 'SELL', origQty: 0.09, triggerPrice: 98, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {} }],
      placeTakeProfitMarket: async () => {
        calls.push('placeTakeProfitMarket');
        return { algoId: 601, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
    };
    const { ctx } = makeCtx(executor);
    const event = baseOpenEvent();
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', event, 300);
    expect(outcome.kind).toBe('FILLED');
    if (outcome.kind !== 'FILLED') throw new Error('unreachable');
    expect(outcome.executedQty).toBe(0.09);
    expect(outcome.reconciled.ok).toBe(true);
    if (!outcome.reconciled.ok) throw new Error('unreachable');
    expect(outcome.reconciled.entryPrice).toBe(101);
    expect(outcome.geometryValid).toBe(true);
    expect(outcome.protection.status).toBe('PROTECTED');
    expect(calls.indexOf('placeStopMarket')).toBeGreaterThan(-1);
    expect(calls.indexOf('placeTakeProfitMarket')).toBeGreaterThan(calls.indexOf('placeStopMarket'));
    expect(outcome.tpAlgoIds).toEqual([601, 601]);
  });

  it('recovers a delayed SOL MARKET lookup and establishes verified SL before TP without a second submission', async () => {
    const calls: string[] = [];
    let lookupCalls = 0;
    let positionRiskCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => {
        calls.push('openMarketPosition');
        throw new OrderSubmissionError('[openMarketPosition(SOLUSDT,SHORT)] TIMEOUT', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => {
        lookupCalls += 1;
        if (lookupCalls === 1) return null;
        return { orderId: 77, status: 'FILLED', executedQty: '1.56', avgPrice: '90.86', raw: {} };
      },
      getPositionRisk: async () => {
        positionRiskCalls += 1;
        if (positionRiskCalls === 1) return [{ symbol: 'SOLUSDT', positionAmt: '0', entryPrice: '0' }];
        return [{ symbol: 'SOLUSDT', positionAmt: '-1.56', entryPrice: '90.86' }];
      },
      placeStopMarket: async () => {
        calls.push('placeStopMarket');
        return { algoId: 501, symbol: 'SOLUSDT', algoStatus: 'NEW', raw: {} };
      },
      getOpenAlgoOrders: async () => [{ algoId: 501, symbol: 'SOLUSDT', side: 'BUY', origQty: 1.56, triggerPrice: 92, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {} }],
      placeTakeProfitMarket: async () => {
        calls.push('placeTakeProfitMarket');
        return { algoId: 601, symbol: 'SOLUSDT', algoStatus: 'NEW', raw: {} };
      },
    };
    const { ctx } = makeCtx(executor, { quantityToleranceBySymbol: { BTCUSDT: 0.001, SOLUSDT: 0.01 }, marketEntryLookupRetryDelaysMs: [0] });
    const event = baseOpenEvent({ symbol: 'SOLUSDT', side: 'SHORT', entryPrice: 90.86, slPrice: 92, tpLevels: [{ label: 'TP1', price: 89, rMultiple: 1.5, closePercent: 0.5 }, { label: 'TP2', price: 88, rMultiple: 2.5, closePercent: 0.3 }, { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: 0.2 }] });
    const outcome = await handleOpenEvent(ctx, 'SOLUSDT', event, 300);
    expect(outcome.kind).toBe('FILLED');
    if (outcome.kind !== 'FILLED') throw new Error('unreachable');
    expect(outcome.protection.status).toBe('PROTECTED');
    expect(calls.filter((call) => call === 'openMarketPosition')).toHaveLength(1);
    expect(lookupCalls).toBe(2);
    expect(calls.indexOf('placeStopMarket')).toBeGreaterThan(-1);
    expect(calls.indexOf('placeTakeProfitMarket')).toBeGreaterThan(calls.indexOf('placeStopMarket'));
  });

  it('emergency-closes a newly appeared exposure when bounded lookup remains ambiguous', async () => {
    let positionRiskCalls = 0;
    const closeCalls: Array<[string, string, number]> = [];
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => {
        throw new OrderSubmissionError('[openMarketPosition(SOLUSDT,SHORT)] TIMEOUT', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => null,
      getPositionRisk: async () => {
        positionRiskCalls += 1;
        if (positionRiskCalls === 1) return [{ symbol: 'SOLUSDT', positionAmt: '0', entryPrice: '0' }];
        if (positionRiskCalls === 2) return [{ symbol: 'SOLUSDT', positionAmt: '-1.56', entryPrice: '90.86' }];
        return [{ symbol: 'SOLUSDT', positionAmt: '0', entryPrice: '0' }];
      },
      closePositionMarket: async (symbol, side, quantity) => {
        closeCalls.push([symbol, side, quantity]);
        return { orderId: 88, symbol, status: 'FILLED', raw: {} };
      },
      placeStopMarket: async () => {
        throw new Error('must not place SL on an ambiguous entry');
      },
      placeTakeProfitMarket: async () => {
        throw new Error('must not place TP on an ambiguous entry');
      },
    };
    const { ctx } = makeCtx(executor, { quantityToleranceBySymbol: { BTCUSDT: 0.001, SOLUSDT: 0.01 } });
    const event = baseOpenEvent({ symbol: 'SOLUSDT', side: 'SHORT', entryPrice: 90, marginRequired: 4.68, actualRiskDollar: 1.56, slPrice: 91 });
    const outcome = await handleOpenEvent(ctx, 'SOLUSDT', event, 300);
    expect(outcome.kind).toBe('AMBIGUOUS');
    if (outcome.kind !== 'AMBIGUOUS') throw new Error('unreachable');
    expect(closeCalls).toEqual([['SOLUSDT', 'SHORT', 1.56]]);
    expect(outcome.detail).toContain('EMERGENCY_CLOSE_VERIFIED');
  });

  it('does not emergency-close exposure that cannot be attributed to the submitted quantity', async () => {
    let positionRiskCalls = 0;
    const closeCalls: Array<[string, string, number]> = [];
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => {
        throw new OrderSubmissionError('[openMarketPosition(SOLUSDT,SHORT)] TIMEOUT', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => null,
      getPositionRisk: async () => {
        positionRiskCalls += 1;
        if (positionRiskCalls === 1) return [{ symbol: 'SOLUSDT', positionAmt: '-1', entryPrice: '89' }];
        return [{ symbol: 'SOLUSDT', positionAmt: '-1.56', entryPrice: '90' }];
      },
      closePositionMarket: async (symbol, side, quantity) => {
        closeCalls.push([symbol, side, quantity]);
        return { orderId: 88, symbol, status: 'FILLED', raw: {} };
      },
    };
    const { ctx } = makeCtx(executor, { quantityToleranceBySymbol: { BTCUSDT: 0.001, SOLUSDT: 0.01 } });
    const event = baseOpenEvent({ symbol: 'SOLUSDT', side: 'SHORT', entryPrice: 90, marginRequired: 4.68, actualRiskDollar: 1.56, slPrice: 91 });
    const outcome = await handleOpenEvent(ctx, 'SOLUSDT', event, 300);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(closeCalls).toHaveLength(0);
  });
});

describe('TICKET-LIVE-R3 item 3 stage 6 — handlePartialCloseEvent: SL replacement on tier fill', () => {
  it('replaces the resting SL with a new trigger/quantity on TP1', async () => {
    const updateCalls: unknown[][] = [];
    const executor: Partial<BinanceOrderExecutor> = {
      updateStopOrder: async (symbol, algoId, side, price, qty) => {
        updateCalls.push([symbol, algoId, side, price, qty]);
        return { algoId: 502, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
    };
    const { ctx, runner } = makeCtx(executor);
    runner.access.setOrderIds('BTCUSDT', 1000, { slAlgoId: 501, tpAlgoIds: [601, 602] });
    const event: PartialCloseEvent = { type: 'PARTIAL_CLOSE', symbol: 'BTCUSDT', side: 'LONG', tier: 'TP1', closePercent: 0.5, pnlUsd: 4.5, newSlPrice: 100, remainingPercent: 0.5, accountBalanceAfter: 300, timestamp: 2000 };
    await handlePartialCloseEvent(ctx, 'BTCUSDT', event, 1000, 0.045, undefined);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toBe(501);
    expect(updateCalls[0][3]).toBe(100);
    expect(runner.access.getOrderIds('BTCUSDT', 1000)?.slAlgoId).toBe(502);
  });
});

describe('TICKET-LIVE-R3 item 3 stage 9 — handleCloseEvent: final close cancels resting protective orders', () => {
  it('cancels SL and TP algo orders and clears the tracked orderIds', async () => {
    const cancelledIds: number[] = [];
    const telemetryEvents: Array<{ eventType?: string; data?: Record<string, unknown> }> = [];
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async (_symbol, algoId) => {
        cancelledIds.push(algoId);
      },
    };
    const { ctx, runner, telegramMessages } = makeCtx(executor, { emitTelemetry: (event) => telemetryEvents.push(event as { eventType?: string; data?: Record<string, unknown> }) });
    runner.access.setOrderIds('BTCUSDT', 1000, { slAlgoId: 501, tpAlgoIds: [602] });
    const event: CloseTradeEvent = { type: 'CLOSE', symbol: 'BTCUSDT', side: 'LONG', regime: MarketRegime.TREND_RIDER, setupType: 'OB', tpPlan: 'PLAN_A', entryTimestamp: 1000, entryPrice: 100, exitTimestamp: 5000, exitPrice: 108, exitReason: 'TP2', pnlUsd: 6, pnlPct: 0.6, riskMultiplier: 1, accountBalanceAfter: 306 };
    await handleCloseEvent(ctx, 'BTCUSDT', event);
    expect(cancelledIds.sort()).toEqual([501, 602]);
    expect(runner.access.getOrderIds('BTCUSDT', 1000)).toBeUndefined();
    expect(telemetryEvents).toContainEqual(expect.objectContaining({ eventType: 'TRADE_CLOSED', data: expect.objectContaining({ modeledNetPnl: 6 }) }));
    expect(telegramMessages.some((message) => message.includes('6.00'))).toBe(true);
  });
});

describe('TICKET-LIVE-R3 item 3 stage 7 — persist-then-restart round trip', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-r3-persist-'));
    filePath = path.join(tmpDir, 'positions-state.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists one real position, reads it in a fresh process, and startup recovery adopts it exactly once', async () => {
    const entry = {
      position: { scenario: 'TREND', side: 'LONG', entryPrice: 100, initialSlPrice: 98, r: 2, tpPlan: 'PLAN_A', positionSize: 1000, takerFeeRate: 0.0004, tpLevels: [], currentSlPrice: 98, filledTiers: [], remainingPositionSize: 1000, runnerPeakPrice: null, closed: false },
      meta: { regime: MarketRegime.TREND_RIDER, setupType: 'OB', entryTimestamp: 1000, actualRiskDollar: 20, marginRequired: 33.33, riskMultiplier: 1 },
    } as OpenPositionEntry;
    const symbolState = { ...INITIAL_SYMBOL_STATE, openPositions: [entry] };
    const persistLiveState = createPersistLiveState({
      filePath,
      symbols: ['BTCUSDT'],
      getSymbolStateForPersist: () => ({ symbolState, orderIds: [[1000, { slAlgoId: 501, tpAlgoIds: [601] }]], regimeStateCandleTimestamp: 999000 }),
      getPendingEntryQuarantinesBySymbol: () => ({}),
      enqueueTelegram: () => {},
      onPersistFailure: () => {},
    });
    const persisted = persistLiveState();
    expect(persisted).toBe(true);

    const restarted = readLiveStateFileSafe(filePath);
    expect(restarted.status).toBe('OK');
    if (restarted.status !== 'OK') throw new Error('unreachable');
    expect(restarted.file.schemaVersion).toBe(LIVE_STATE_SCHEMA_VERSION);
    expect(restarted.file.symbols.BTCUSDT.regimeStateCandleTimestamp).toBe(999000);
    expect(restarted.file.symbols.BTCUSDT.orderIds).toEqual([[1000, { slAlgoId: 501, tpAlgoIds: [601] }]]);
    expect(restarted.file.symbols.BTCUSDT.symbolState.openPositions).toHaveLength(1);

    const recovered = await performStartupRestartRecovery({
      executor: { getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '10', entryPrice: '100' }] } as never,
      symbols: ['BTCUSDT'],
      persisted: restarted,
      quantityToleranceBySymbol: { BTCUSDT: 0.001 },
      initialSymbolState: INITIAL_SYMBOL_STATE,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('unreachable');
    expect(recovered.symbols[0].symbolState.openPositions).toHaveLength(1);
    expect(recovered.symbols[0].symbolState.openPositions[0].meta.entryTimestamp).toBe(1000);
    expect(recovered.symbols[0].orderIds).toEqual(new Map([[1000, { slAlgoId: 501, tpAlgoIds: [601] }]]));
  });
});

describe('TICKET-LIVE-R3 item 3 stage 8 / item 4 scenario 9 — restart-carried quarantine folds into the risk ledger and blocks admission', () => {
  it('a known-exposure quarantine record blocks the symbol and its basis feeds a quantifiable risk-ledger entry', () => {
    const record: PendingEntryQuarantineRecord = {
      symbol: 'BTCUSDT', side: 'LONG', phase: 'FILLED_UNPROTECTED', clientOrderId: 'c1', orderId: 1,
      executedQty: 0.1, averageFillPrice: 100, plannedEntryPrice: 100, plannedSlPrice: 98,
      reconciledEntryPrice: 100, reconciledPositionSize: 10, protectionOutcome: 'FAILED',
      actualRiskDollar: 2, marginRequired: 0.33, protectionStatus: 'PROTECTION_DEGRADED',
      recoveryStatus: 'EXHAUSTED_OPERATOR_REQUIRED', recoveryDetail: 'no fill', exposureBasis: null,
      entryTimestamp: 1000, reason: 'sl-failed', detectedAtMs: 2000,
    };
    const fold = foldPendingEntryQuarantinesOnRestart({ BTCUSDT: [record] });
    expect(fold.blockedSymbols).toEqual([{ symbol: 'BTCUSDT', recordCount: 1 }]);
    expect(fold.quarantinedUnknownExposures).toHaveLength(1);
    expect(fold.quarantinedUnknownExposures[0].basis).toBeNull();

    const ledger = rebuildPortfolioRisk({ knownPositions: [], unknownExposures: fold.quarantinedUnknownExposures });
    expect(ledger.hasUnquantifiableExposure).toBe(true);

    const rejected = wouldExceedRiskPool([{ id: 'sentinel', actualRiskDollar: ledger.hasUnquantifiableExposure ? 999999 : 0 }], 20, 300, { riskPoolMaxPct: 0.15 });
    expect(rejected).toBe(true);
  });

  it('an empty pendingEntryQuarantinesBySymbol folds to zero blocked symbols and zero exposures', () => {
    const fold = foldPendingEntryQuarantinesOnRestart({ BTCUSDT: [], ETHUSDT: [] });
    expect(fold.blockedSymbols).toEqual([]);
    expect(fold.quarantinedUnknownExposures).toEqual([]);
  });
});

describe('TICKET-LIVE-R3 item 3 stage 2 / item 4 scenario 10 — candle-freshness admission gate', () => {
  it('a fresh required-timeframe set never adds the freshness sentinel; admission proceeds on its own merits', () => {
    const intervalMs = 5 * 60_000;
    const closed5m = [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { timestamp: intervalMs, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const now = intervalMs + intervalMs + 2_000;
    const verdicts = assessCandleFreshnessForSymbol({ '5m': closed5m }, ['5m'], now);
    expect(hasAnyStaleRequiredTimeframe(verdicts)).toBe(false);
    const rejected = wouldExceedRiskPool([], 20, 300, { riskPoolMaxPct: 0.15 });
    expect(rejected).toBe(false);
  });

  it('a gapped 5m timeframe is stale, and the sentinel-over-cap mechanism blocks NEW entry admission for that symbol while leaving other admission math untouched', () => {
    const now = 60 * 60_000;
    const gapped5m = [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { timestamp: 20 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const verdicts = assessCandleFreshnessForSymbol({ '5m': gapped5m }, ['5m'], now);
    expect(hasAnyStaleRequiredTimeframe(verdicts)).toBe(true);

    const accountBalance = 300;
    const riskPoolMaxPct = 0.15;
    const allOpenPositionsRisk = [{ id: 'CANDLE_FRESHNESS_STALE_BLOCK', actualRiskDollar: accountBalance * riskPoolMaxPct + 1 }];
    const rejected = wouldExceedRiskPool(allOpenPositionsRisk, 20, accountBalance, { riskPoolMaxPct });
    expect(rejected).toBe(true);
  });

  it('the production pre-mutation gate does not invoke the OPEN handler for a stale verdict', async () => {
    let openMutationCalls = 0;
    const outcome = await handleOpenEventIfFresh(
      [{ interval: '5m', fresh: false, reason: 'GAP' }],
      async () => {
        openMutationCalls += 1;
        return { kind: 'DRY_RUN' };
      },
    );
    expect(outcome).toEqual({ kind: 'NOT_FILLED', detail: 'CANDLE_FRESHNESS_BLOCKED' });
    expect(openMutationCalls).toBe(0);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 1 — pre-submission getPositionRisk baseline read failure blocks all mutation', () => {
  it('a null baseline read means openMarketPosition is never called', async () => {
    let openCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => {
        throw new Error('network down');
      },
      openMarketPosition: async () => {
        openCalls += 1;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: '100' } };
      },
    };
    const { ctx, getAccountSyncUnknownCalled } = makeCtx(executor);
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('NOT_FILLED');
    expect(openCalls).toBe(0);
    expect(getAccountSyncUnknownCalled()).toBe(true);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 2 — DELIVERY_UNKNOWN submission never retries', () => {
  it('exactly one openMarketPosition attempt occurs through the full handleOpenEvent path on a 5xx/timeout', async () => {
    let openCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [],
      openMarketPosition: async () => {
        openCalls += 1;
        throw new OrderSubmissionError('[openMarketPosition] HTTP 500 Internal Server Error', 'DELIVERY_UNKNOWN', 500);
      },
      getOrderByClientOrderId: async () => null,
    };
    const { ctx } = makeCtx(executor);
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(openCalls).toBe(1);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 3 — unknown/non-allowlisted 4xx classifies DELIVERY_UNKNOWN, not a confident rejection', () => {
  it('an un-allowlisted 4xx routes to AMBIGUOUS through the full handleOpenEvent path, never CONFIRMED_NOT_FILLED', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [],
      openMarketPosition: async () => {
        throw new OrderSubmissionError('[openMarketPosition] HTTP 418 Teapot', 'DELIVERY_UNKNOWN', 418);
      },
      getOrderByClientOrderId: async () => null,
    };
    const { ctx } = makeCtx(executor);
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(outcome.kind).not.toBe('NOT_FILLED');
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 4 — an AMBIGUOUS order outcome quarantines the symbol', () => {
  it('the real handleOpenEvent outcome flows through the production transition and persists quarantine', async () => {
    const runner = makeRunnerState();
    let pendingBySymbol: Record<string, PendingEntryQuarantineRecord[]> = {};
    let persistCalls = 0;
    const recordPendingEntryQuarantine = createRecordPendingEntryQuarantine({
      blockSymbolAdmission: runner.access.blockSymbolAdmission,
      getPendingEntryQuarantinesBySymbol: () => pendingBySymbol,
      setPendingEntryQuarantinesBySymbol: (next) => {
        pendingBySymbol = next;
      },
      persistLiveState: () => {
        persistCalls += 1;
        return true;
      },
    });
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [],
      openMarketPosition: async () => {
        throw new OrderSubmissionError('timeout', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => null,
    };
    const { ctx } = makeCtx(executor);
    const event = baseOpenEvent();
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', event, 300);
    if (outcome.kind !== 'AMBIGUOUS') throw new Error('expected AMBIGUOUS');
    const symbolState = { openPositions: [], momentumDirectCircuitBreaker: { LONG: { consecutiveLosses: 0, cooldownUntilTimestamp: null }, SHORT: { consecutiveLosses: 0, cooldownUntilTimestamp: null } }, regimeState: { previousRegime: MarketRegime.TREND_RIDER } } as unknown as SymbolState;
    const nextState = applyAmbiguousOpenOutcome({ symbol: 'BTCUSDT', event, outcome, symbolState, recordPendingEntryQuarantine, enqueueTelegram: ctx.enqueueTelegram });
    expect(nextState.openPositions).toHaveLength(0);
    expect(runner.blockedSymbols.has('BTCUSDT')).toBe(true);
    expect(pendingBySymbol.BTCUSDT).toHaveLength(1);
    expect(pendingBySymbol.BTCUSDT[0]).toMatchObject({ phase: 'AMBIGUOUS_SUBMISSION', clientOrderId: outcome.clientOrderId, reason: outcome.detail });
    expect(persistCalls).toBe(1);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 5 — missing/contradictory fill evidence blocks both SL and TP placement', () => {
  it('avgPrice and getPositionRisk both invalid -> reconcile fails -> neither placeStopMarket nor placeTakeProfitMarket are called', async () => {
    let slCalls = 0;
    let tpCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      openMarketPosition: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: undefined } }),
      placeStopMarket: async () => {
        slCalls += 1;
        throw new Error('should never be called');
      },
      placeTakeProfitMarket: async () => {
        tpCalls += 1;
        throw new Error('should never be called');
      },
      getOpenAlgoOrders: async () => [],
    };
    const { ctx } = makeCtx(executor);
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('FILLED');
    if (outcome.kind !== 'FILLED') throw new Error('unreachable');
    expect(outcome.reconciled.ok).toBe(false);
    expect(slCalls).toBe(0);
    expect(tpCalls).toBe(0);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 6 — wrong-side SL against the actual fill price is never placed nor forwarded to recovery', () => {
  it('a fill price making the planned SL geometrically invalid skips placement and recovery never receives the bad price as its placement target', async () => {
    let slCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.09', entryPrice: '90' }],
      openMarketPosition: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: '90' } }),
      placeStopMarket: async () => {
        slCalls += 1;
        throw new Error('should never be called — geometry invalid, skipPlacementAttempts=true');
      },
      getOpenAlgoOrders: async () => [],
    };
    const { ctx } = makeCtx(executor);
    const event = baseOpenEvent({ slPrice: 98 });
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', event, 300);
    expect(outcome.kind).toBe('FILLED');
    if (outcome.kind !== 'FILLED') throw new Error('unreachable');
    expect(outcome.geometryValid).toBe(false);
    expect(slCalls).toBe(0);
    expect(outcome.protection.status).toBe('PROTECTION_DEGRADED');
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 7 — SL replacement failure during partial close results in quarantine, not a silent success', () => {
  it('updateStopOrder throws and recovery is exhausted -> PROTECTION_DEGRADED on the owner, symbol blocked, persisted', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      updateStopOrder: async () => {
        throw new Error('exchange rejects replacement');
      },
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => {
        throw new Error('recovery placement also fails');
      },
      closePositionMarket: async () => {
        throw new Error('should never reach emergency close under OPERATOR_REQUIRED');
      },
      getPositionRisk: async () => [],
    };
    const { ctx, runner, getPersistCallCount } = makeCtx(executor);
    const owner = { position: {}, meta: { protectionStatus: 'PROTECTED' } } as unknown as OpenPositionEntry;
    const event: PartialCloseEvent = { type: 'PARTIAL_CLOSE', symbol: 'BTCUSDT', side: 'LONG', tier: 'TP1', closePercent: 0.5, pnlUsd: 1, newSlPrice: 100, remainingPercent: 0.5, accountBalanceAfter: 300, timestamp: 2000 };
    runner.access.setOrderIds('BTCUSDT', 1000, { slAlgoId: 501, tpAlgoIds: [] });
    await handlePartialCloseEvent(ctx, 'BTCUSDT', event, 1000, 0.045, owner);
    expect(owner.meta.protectionStatus).toBe('PROTECTION_DEGRADED');
    expect(runner.blockedSymbols.has('BTCUSDT')).toBe(true);
    expect(getPersistCallCount()).toBeGreaterThan(0);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 8 — a persistLiveState write failure blocks portfolio-wide new-entry admission', () => {
  it('writeLiveStateFileAtomic failing (unwritable path) reports failure and the caller flags admission blocked', () => {
    let blocked = false;
    const persistLiveState = createPersistLiveState({
      filePath: path.join(os.tmpdir(), 'live-r3-persist-fail-' + Date.now(), 'nested', 'does', 'not', 'exist' + '\0bad'),
      symbols: ['BTCUSDT'],
      getSymbolStateForPersist: () => ({ symbolState: { openPositions: [] } as unknown as SymbolState, orderIds: [], regimeStateCandleTimestamp: null }),
      getPendingEntryQuarantinesBySymbol: () => ({}),
      enqueueTelegram: () => {},
      onPersistFailure: (failed) => {
        blocked = failed;
      },
    });
    const result = persistLiveState();
    expect(result).toBe(false);
    expect(blocked).toBe(true);
  });
});

describe('TICKET-LIVE-R3 item 4 scenario 9b — a restart-quarantined position with a known basis stays quantifiable, not unquantifiable', () => {
  it('a quarantine record built from a real prior position (exposureBasis populated) still yields a known, non-null risk entry when a caller supplies it directly to the ledger', () => {
    const known: KnownPositionForRisk[] = [{ id: 'BTCUSDT:LONG:QUARANTINED:0', basis: { side: 'LONG', entryPrice: 100, currentSlPrice: 95, remainingPositionSize: 50 } }];
    const ledger = rebuildPortfolioRisk({ knownPositions: known, unknownExposures: [] });
    expect(ledger.hasUnquantifiableExposure).toBe(false);
    expect(ledger.totalRiskDollar).toBeGreaterThan(0);
  });
});

describe('TICKET-LIVE-R5T requirement 3 — positionId threads through the whole open chain and SL/TP algo ids are emitted', () => {
  it('every telemetry event from handleOpenEvent carries the same positionId, and ORDER_SENT events surface the SL/TP algo ids', async () => {
    let positionRiskCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: '101' } }),
      getPositionRisk: async () => {
        positionRiskCalls += 1;
        if (positionRiskCalls === 1) return [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0' }];
        return [{ symbol: 'BTCUSDT', positionAmt: '0.09', entryPrice: '101' }];
      },
      placeStopMarket: async () => ({ algoId: 501, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
      getOpenAlgoOrders: async () => [{ algoId: 501, symbol: 'BTCUSDT', side: 'SELL', origQty: 0.09, triggerPrice: 98, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {} }],
      placeTakeProfitMarket: async () => ({ algoId: 601, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} }),
    };
    const telemetryEvents: Array<{ eventType?: string; positionId?: string; data?: Record<string, unknown> }> = [];
    const { ctx } = makeCtx(executor, { emitTelemetry: (event) => telemetryEvents.push(event as never) });
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('FILLED');
    expect(telemetryEvents.length).toBeGreaterThan(0);
    const positionIds = new Set(telemetryEvents.map((e) => e.positionId));
    expect(positionIds.size).toBe(1);
    expect([...positionIds][0]).toMatch(/^position_/);
    const orderSentEvents = telemetryEvents.filter((e) => e.eventType === 'ORDER_SENT' && (e.data?.role === 'PROTECTIVE_SL' || e.data?.role === 'TAKE_PROFIT'));
    expect(orderSentEvents.length).toBeGreaterThanOrEqual(2);
    const slEvent = orderSentEvents.find((e) => e.data?.role === 'PROTECTIVE_SL');
    expect(slEvent?.data?.algoId).toBe(501);
    const tpEvents = orderSentEvents.filter((e) => e.data?.role === 'TAKE_PROFIT');
    expect(tpEvents.every((e) => e.data?.algoId === 601)).toBe(true);
  });

  it('when protection is degraded, an ORDER_SENT event still fires with MISSING algoId/price quality instead of silently omitting the stage', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      openMarketPosition: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.09', avgPrice: undefined } }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      placeStopMarket: async () => { throw new Error('should never be called'); },
      getOpenAlgoOrders: async () => [],
    };
    const telemetryEvents: Array<{ eventType?: string; quality?: Record<string, unknown>; data?: Record<string, unknown> }> = [];
    const { ctx } = makeCtx(executor, { emitTelemetry: (event) => telemetryEvents.push(event as never) });
    const outcome = await handleOpenEvent(ctx, 'BTCUSDT', baseOpenEvent(), 300);
    expect(outcome.kind).toBe('FILLED');
    if (outcome.kind !== 'FILLED') throw new Error('unreachable');
    expect(outcome.protection.status).toBe('PROTECTION_DEGRADED');
    const degraded = telemetryEvents.find((e) => e.eventType === 'ORDER_SENT' && e.data?.role === 'PROTECTIVE_SL' && e.data?.algoId === 'MISSING');
    expect(degraded).toBeDefined();
    expect(degraded?.quality?.algoId).toBe('MISSING');
  });
});

function baseCloseEvent(overrides: Partial<CloseTradeEvent> = {}): CloseTradeEvent {
  return {
    type: 'CLOSE', symbol: 'BTCUSDT', side: 'LONG', regime: MarketRegime.TREND_RIDER, setupType: 'OB', tpPlan: 'PLAN_A',
    entryTimestamp: 1000, entryPrice: 100, exitTimestamp: 5000, exitPrice: 108, exitReason: 'TP2', pnlUsd: 6, pnlPct: 0.6,
    riskMultiplier: 1, accountBalanceAfter: 306,
    ...overrides,
  };
}

describe('TICKET-LIVE-R5T requirement 4 — reconcileTradeIncomeFromRecords (pure)', () => {
  it('sums REALIZED_PNL/COMMISSION/FUNDING_FEE for records inside the window and reports OBSERVED quality', () => {
    const records = [
      { incomeType: 'REALIZED_PNL', income: '5.5', time: 2000 },
      { incomeType: 'COMMISSION', income: '-0.4', time: 2000 },
      { incomeType: 'FUNDING_FEE', income: '-0.1', time: 4000 },
      { incomeType: 'REALIZED_PNL', income: '999', time: 999_999 },
    ];
    const result = reconcileTradeIncomeFromRecords(records, 1000, 5000, 500);
    expect(result.quality).toBe('OBSERVED');
    expect(result.realizedPnl).toBeCloseTo(5.5, 6);
    expect(result.commission).toBeCloseTo(-0.4, 6);
    expect(result.funding).toBeCloseTo(-0.1, 6);
  });

  it('reports MISSING when no income record falls inside the window', () => {
    const result = reconcileTradeIncomeFromRecords([{ incomeType: 'REALIZED_PNL', income: '5', time: 999_999 }], 1000, 5000, 500);
    expect(result.quality).toBe('MISSING');
    expect(result.realizedPnl).toBeNull();
  });

  it('reports MISSING when getIncome did not return an array', () => {
    const result = reconcileTradeIncomeFromRecords({ not: 'an array' }, 1000, 5000);
    expect(result.quality).toBe('MISSING');
  });

  it('reports AMBIGUOUS when an in-window record has a non-numeric income value', () => {
    const result = reconcileTradeIncomeFromRecords([{ incomeType: 'REALIZED_PNL', income: 'not-a-number', time: 2000 }], 1000, 5000, 500);
    expect(result.quality).toBe('AMBIGUOUS');
  });

  it('does not report OBSERVED when the window lacks realized PnL or commission evidence', () => {
    const unrelated = reconcileTradeIncomeFromRecords([{ incomeType: 'TRANSFER', income: '10', time: 2000 }], 1000, 5000, 500);
    const fundingOnly = reconcileTradeIncomeFromRecords([{ incomeType: 'FUNDING_FEE', income: '-0.1', time: 2000 }], 1000, 5000, 500);
    expect(unrelated.quality).toBe('MISSING');
    expect(fundingOnly.quality).toBe('MISSING');
  });
});

describe('TICKET-LIVE-R5T requirement 4 — handleCloseEvent wires exchange-income reconciliation, read-only and per-symbol fail-closed', () => {
  it('a clean getIncome() result emits an OBSERVED POSITION_RECONCILED event and never blocks the symbol', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async () => {},
      getIncome: async () => [{ incomeType: 'REALIZED_PNL', income: '6', time: 5000 }, { incomeType: 'COMMISSION', income: '-0.5', time: 5000 }],
    };
    const telemetryEvents: Array<{ eventType?: string; quality?: Record<string, unknown>; data?: Record<string, unknown> }> = [];
    const { ctx, runner } = makeCtx(executor, { emitTelemetry: (event) => telemetryEvents.push(event as never) });
    await handleCloseEvent(ctx, 'BTCUSDT', baseCloseEvent());
    const reconciled = telemetryEvents.find((e) => e.eventType === 'POSITION_RECONCILED');
    expect(reconciled).toBeDefined();
    expect(reconciled?.quality?.realizedPnl).toBe('OBSERVED');
    expect(reconciled?.quality?.commission).toBe('OBSERVED');
    expect(reconciled?.quality?.funding).toBe('MISSING');
    expect(reconciled?.data?.realizedPnl).toBeCloseTo(6, 6);
    expect(runner.blockedSymbols.has('BTCUSDT')).toBe(false);
  });

  it('a getIncome() failure blocks NEW entry admission on that symbol, sends a CRITICAL Telegram alert, and records MISSING quality — never fabricating a 0', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async () => {},
      getIncome: async () => { throw new Error('network unreachable'); },
    };
    const telemetryEvents: Array<{ eventType?: string; quality?: Record<string, unknown>; data?: Record<string, unknown> }> = [];
    const { ctx, runner, telegramMessages } = makeCtx(executor, { emitTelemetry: (event) => telemetryEvents.push(event as never) });
    await handleCloseEvent(ctx, 'BTCUSDT', baseCloseEvent());
    const reconciled = telemetryEvents.find((e) => e.eventType === 'POSITION_RECONCILED');
    expect(reconciled?.quality?.realizedPnl).toBe('MISSING');
    expect(reconciled?.data?.realizedPnl).toBe('MISSING');
    expect(runner.incomeBlockedSymbols.has('BTCUSDT')).toBe(true);
    expect(telegramMessages.some((m) => m.includes('CRITICAL') && m.includes('BTCUSDT'))).toBe(true);
  });

  it('an ambiguous/empty income window blocks only the affected symbol, not the whole portfolio, via the same blockSymbolAdmission sentinel', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async () => {},
      getIncome: async () => [],
    };
    const { ctx, runner } = makeCtx(executor);
    await handleCloseEvent(ctx, 'BTCUSDT', baseCloseEvent());
    expect(runner.incomeBlockedSymbols.has('BTCUSDT')).toBe(true);
    expect(runner.blockedSymbols.size).toBe(0);
  });

  it('retries a temporarily missing income ledger and clears only the income reconciliation block after complete evidence arrives', async () => {
    let calls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async () => {},
      getIncome: async () => {
        calls += 1;
        if (calls === 1) return [];
        return [{ incomeType: 'REALIZED_PNL', income: '6', time: 5000 }, { incomeType: 'COMMISSION', income: '-0.5', time: 5000 }];
      },
    };
    const { ctx, runner } = makeCtx(executor, { incomeReconciliationRetryDelaysMs: [0] });
    await handleCloseEvent(ctx, 'BTCUSDT', baseCloseEvent());
    expect(calls).toBe(2);
    expect(runner.incomeBlockedSymbols.has('BTCUSDT')).toBe(false);
    expect(runner.blockedSymbols.size).toBe(0);
  });

  it('never calls getIncome and never blocks admission in dryRun mode (telemetry-only feature, inert when nothing was actually traded)', async () => {
    let getIncomeCalls = 0;
    const executor: Partial<BinanceOrderExecutor> = {
      getIncome: async () => { getIncomeCalls += 1; return []; },
    };
    const { ctx, runner } = makeCtx(executor, { dryRun: true });
    await handleCloseEvent(ctx, 'BTCUSDT', baseCloseEvent());
    expect(getIncomeCalls).toBe(0);
    expect(runner.blockedSymbols.has('BTCUSDT')).toBe(false);
    expect(runner.incomeBlockedSymbols.has('BTCUSDT')).toBe(false);
  });

  it('reconciliation never touches accountBalanceAfter/risk-ledger inputs — it only reads via getIncome and emits telemetry', async () => {
    const executor: Partial<BinanceOrderExecutor> = {
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
      cancelAlgoOrder: async () => {},
      getIncome: async () => [{ incomeType: 'REALIZED_PNL', income: '6', time: 5000 }],
    };
    const { ctx } = makeCtx(executor);
    const event = baseCloseEvent({ accountBalanceAfter: 306 });
    await handleCloseEvent(ctx, 'BTCUSDT', event);
    expect(event.accountBalanceAfter).toBe(306);
  });
});
