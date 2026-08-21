import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDeterministicEntryClientOrderId,
  classifySubmissionError,
  classifyMarketEntryOutcome,
  determineFillFromStatus,
  submitAndClassifyMarketEntry,
  establishProtectiveStopLoss,
  isSlGeometryValidForFill,
  recoverMissingProtectiveSl,
  quarantineRecordToRiskExposure,
  type MarketSubmissionAttempt,
  type MarketEntryCorroboration,
} from './liveStateSync.js';
import { OrderSubmissionError, type BinanceOrderExecutor, type OpenAlgoOrder } from './binanceOrderExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveRunnerSrc = readFileSync(path.resolve(__dirname, '../../scripts/liveRunner.ts'), 'utf8').replace(/\r\n/g, '\n');
const liveLifecycleSrc = readFileSync(path.resolve(__dirname, './liveLifecycle.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('quarantine restart risk evidence', () => {
  it('never treats a planned but unconfirmed SL as a finite risk boundary', () => {
    const exposure = quarantineRecordToRiskExposure(
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        phase: 'FILLED_UNPROTECTED',
        clientOrderId: 'entry-1',
        orderId: 42,
        executedQty: 1,
        averageFillPrice: 100,
        plannedEntryPrice: 100,
        plannedSlPrice: 95,
        reconciledEntryPrice: 100,
        reconciledPositionSize: 100,
        protectionOutcome: 'FAILED',
        actualRiskDollar: 5,
        marginRequired: 10,
        protectionStatus: 'PROTECTION_DEGRADED',
        recoveryStatus: 'EXHAUSTED_OPERATOR_REQUIRED',
        recoveryDetail: 'not protected',
        exposureBasis: { side: 'LONG', qty: 1, entryPrice: 100 },
        entryTimestamp: 1,
        reason: 'SL absent',
        detectedAtMs: 2,
      },
      0,
    );
    expect(exposure.basis).toBeNull();
  });
});

function makeOrder(overrides: Partial<OpenAlgoOrder>): OpenAlgoOrder {
  return { algoId: 1, symbol: 'BTCUSDT', side: 'SELL', origQty: 1, triggerPrice: 95, algoStatus: 'NEW', positionSide: 'BOTH', orderType: 'STOP_MARKET', reduceOnly: true, closePosition: false, algoType: 'CONDITIONAL', raw: {}, ...overrides };
}

describe('buildDeterministicEntryClientOrderId', () => {
  it('is deterministic and reproducible for the same symbol+side+entryTimestamp', () => {
    const a = buildDeterministicEntryClientOrderId('BTCUSDT', 'LONG', 1700000000000);
    const b = buildDeterministicEntryClientOrderId('BTCUSDT', 'LONG', 1700000000000);
    expect(a).toBe(b);
  });
  it('differs by symbol, side, and entryTimestamp', () => {
    const base = buildDeterministicEntryClientOrderId('BTCUSDT', 'LONG', 1);
    expect(buildDeterministicEntryClientOrderId('ETHUSDT', 'LONG', 1)).not.toBe(base);
    expect(buildDeterministicEntryClientOrderId('BTCUSDT', 'SHORT', 1)).not.toBe(base);
    expect(buildDeterministicEntryClientOrderId('BTCUSDT', 'LONG', 2)).not.toBe(base);
  });
  it('stays well under Binance newClientOrderId length limits', () => {
    const id = buildDeterministicEntryClientOrderId('BTCUSDT', 'LONG', 1700000000000);
    expect(id.length).toBeLessThanOrEqual(36);
  });
});

describe('classifySubmissionError', () => {
  it('reads deliveryStatus off an OrderSubmissionError instead of string-sniffing the message', () => {
    expect(classifySubmissionError(new OrderSubmissionError('[ctx] roundQtyToStepSize failed', 'CONFIRMED_NOT_SUBMITTED')).kind).toBe('CONFIRMED_NOT_SUBMITTED');
    expect(classifySubmissionError(new OrderSubmissionError('[ctx] HTTP 500 Internal Server Error: not json', 'DELIVERY_UNKNOWN', 500)).kind).toBe('DELIVERY_UNKNOWN');
    expect(classifySubmissionError(new OrderSubmissionError('[ctx] TIMEOUT', 'DELIVERY_UNKNOWN')).kind).toBe('DELIVERY_UNKNOWN');
  });
  it('a non-OrderSubmissionError Error fails safe to DELIVERY_UNKNOWN, never CONFIRMED_NOT_SUBMITTED', () => {
    expect(classifySubmissionError(new Error('some unrelated crash')).kind).toBe('DELIVERY_UNKNOWN');
  });
});

describe('determineFillFromStatus', () => {
  it('FILLED with executedQty > 0 -> FILLED', () => {
    expect(determineFillFromStatus('FILLED', '0.01')).toBe('FILLED');
  });
  it('PARTIALLY_FILLED with executedQty > 0 -> FILLED (a MARKET order sitting PARTIALLY_FILLED must not be misread as NOT_FILLED)', () => {
    expect(determineFillFromStatus('PARTIALLY_FILLED', 0.005)).toBe('FILLED');
  });
  it('REJECTED/CANCELED/EXPIRED with executedQty === 0 -> NOT_FILLED', () => {
    expect(determineFillFromStatus('REJECTED', 0)).toBe('NOT_FILLED');
    expect(determineFillFromStatus('CANCELED', '0')).toBe('NOT_FILLED');
    expect(determineFillFromStatus('EXPIRED', 0)).toBe('NOT_FILLED');
  });
  it('NEW with executedQty === 0 -> INCONCLUSIVE, never NOT_FILLED', () => {
    expect(determineFillFromStatus('NEW', 0)).toBe('INCONCLUSIVE');
  });
  it('an unrecognized status -> INCONCLUSIVE', () => {
    expect(determineFillFromStatus('SOME_FUTURE_STATUS', 1)).toBe('INCONCLUSIVE');
  });
  it('a missing/non-finite executedQty on an otherwise-FILLED-looking status -> INCONCLUSIVE', () => {
    expect(determineFillFromStatus('FILLED', undefined)).toBe('INCONCLUSIVE');
    expect(determineFillFromStatus('FILLED', 'not-a-number')).toBe('INCONCLUSIVE');
    expect(determineFillFromStatus('FILLED', NaN)).toBe('INCONCLUSIVE');
  });
});

describe('classifyMarketEntryOutcome', () => {
  it('CONFIRMED_SUBMITTED with status FILLED and executedQty > 0 -> CONFIRMED_FILLED', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'CONFIRMED_SUBMITTED', orderId: 1, status: 'FILLED', executedQty: '0.01', avgPrice: '50000' };
    const r = classifyMarketEntryOutcome(attempt, null);
    expect(r).toMatchObject({ outcome: 'CONFIRMED_FILLED', executedQty: 0.01, orderId: 1 });
  });
  it('CONFIRMED_NOT_SUBMITTED -> CONFIRMED_NOT_FILLED, zero phantom state', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'CONFIRMED_NOT_SUBMITTED', detail: 'HTTP 400: insufficient margin' };
    const r = classifyMarketEntryOutcome(attempt, null);
    expect(r).toMatchObject({ outcome: 'CONFIRMED_NOT_FILLED', executedQty: 0, orderId: null });
  });
  it('CONFIRMED_SUBMITTED with status NEW and no corroboration -> AMBIGUOUS, never NOT_FILLED, and retains the known orderId/avgPrice evidence', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'CONFIRMED_SUBMITTED', orderId: 2, status: 'NEW', executedQty: '0', avgPrice: '0' };
    const r = classifyMarketEntryOutcome(attempt, null);
    expect(r.outcome).toBe('AMBIGUOUS');
    expect(r.orderId).toBe(2);
    expect(r.avgPrice).toBe('0');
  });
  it('a -2013 (NOT_FOUND) order lookup is never by itself sufficient to conclude NOT_FILLED -> AMBIGUOUS regardless of positionRisk', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'DELIVERY_UNKNOWN', detail: 'TIMEOUT' };
    const corroboration: MarketEntryCorroboration = { orderLookup: { status: 'NOT_FOUND' }, positionRisk: { status: 'CONFIRMED_NO_EXPOSURE' } };
    const r = classifyMarketEntryOutcome(attempt, corroboration);
    expect(r.outcome).toBe('AMBIGUOUS');
  });
  it('order-lookup finds a genuinely terminal REJECTED order AND positionRisk agrees (no exposure) -> CONFIRMED_NOT_FILLED', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'DELIVERY_UNKNOWN', detail: 'TIMEOUT' };
    const corroboration: MarketEntryCorroboration = { orderLookup: { status: 'FOUND', orderId: 9, orderStatus: 'REJECTED', executedQty: '0', avgPrice: '0' }, positionRisk: { status: 'CONFIRMED_NO_EXPOSURE' } };
    const r = classifyMarketEntryOutcome(attempt, corroboration);
    expect(r).toMatchObject({ outcome: 'CONFIRMED_NOT_FILLED', executedQty: 0 });
  });
  it('order-lookup and positionRisk AGREE FILLED -> CONFIRMED_FILLED, definitive', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'CONFIRMED_SUBMITTED', orderId: 3, status: 'NEW', executedQty: '0', avgPrice: '0' };
    const corroboration: MarketEntryCorroboration = { orderLookup: { status: 'FOUND', orderId: 3, orderStatus: 'FILLED', executedQty: '0.02', avgPrice: '51000' }, positionRisk: { status: 'CONFIRMED_EXPOSURE', qty: 0.02 } };
    const r = classifyMarketEntryOutcome(attempt, corroboration);
    expect(r).toMatchObject({ outcome: 'CONFIRMED_FILLED', executedQty: 0.02, orderId: 3 });
  });
  it('order-lookup and positionRisk DISAGREE -> AMBIGUOUS, never guessed either way, but retains the order-lookup evidence (orderId/executedQty/avgPrice) that IS known', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'DELIVERY_UNKNOWN', detail: 'TIMEOUT' };
    const corroboration: MarketEntryCorroboration = { orderLookup: { status: 'FOUND', orderId: 4, orderStatus: 'FILLED', executedQty: '0.01', avgPrice: '50000' }, positionRisk: { status: 'CONFIRMED_NO_EXPOSURE' } };
    const r = classifyMarketEntryOutcome(attempt, corroboration);
    expect(r.outcome).toBe('AMBIGUOUS');
    expect(r.orderId).toBe(4);
    expect(r.executedQty).toBe(0.01);
    expect(r.avgPrice).toBe('50000');
  });
  it('positionRisk itself errored -> AMBIGUOUS even if the order-lookup alone looks terminal, but retains the order-lookup evidence', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'DELIVERY_UNKNOWN', detail: 'TIMEOUT' };
    const corroboration: MarketEntryCorroboration = { orderLookup: { status: 'FOUND', orderId: 5, orderStatus: 'FILLED', executedQty: '0.01', avgPrice: '50000' }, positionRisk: { status: 'LOOKUP_ERROR', detail: 'network down' } };
    const r = classifyMarketEntryOutcome(attempt, corroboration);
    expect(r.outcome).toBe('AMBIGUOUS');
    expect(r.orderId).toBe(5);
    expect(r.executedQty).toBe(0.01);
    expect(r.avgPrice).toBe('50000');
  });
  it('DELIVERY_UNKNOWN with no corroboration at all -> AMBIGUOUS', () => {
    const attempt: MarketSubmissionAttempt = { kind: 'DELIVERY_UNKNOWN', detail: 'TIMEOUT' };
    const r = classifyMarketEntryOutcome(attempt, null);
    expect(r.outcome).toBe('AMBIGUOUS');
  });
});

type MockEntryExecutor = Pick<BinanceOrderExecutor, 'openMarketPosition' | 'getOrderByClientOrderId' | 'getPositionRisk'>;

describe('submitAndClassifyMarketEntry — end-to-end submit+classify workflow', () => {
  it('a filled MARKET that is initially NOT_FOUND is recovered by bounded lookup polling without resubmitting', async () => {
    let submitCalls = 0;
    let lookupCalls = 0;
    const waits: number[] = [];
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        throw new OrderSubmissionError('[openMarketPosition(SOLUSDT,SHORT)] TIMEOUT', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => {
        lookupCalls++;
        if (lookupCalls === 1) return null;
        return { orderId: 77, status: 'FILLED', executedQty: '1.56', avgPrice: '90.86', raw: {} };
      },
      getPositionRisk: async () => [{ symbol: 'SOLUSDT', positionAmt: '-1.56', entryPrice: '90.86' }],
    };
    const result = await submitAndClassifyMarketEntry({
      executor,
      symbol: 'SOLUSDT',
      side: 'SHORT',
      quantity: 1.56,
      referencePrice: 90.86,
      clientOrderId: 'r2b-SOLUSDT-S-1787292000000',
      lookupRetryDelaysMs: [25],
      wait: async (delayMs) => { waits.push(delayMs); },
    });
    expect(result).toMatchObject({ outcome: 'CONFIRMED_FILLED', orderId: 77, executedQty: 1.56, avgPrice: '90.86' });
    expect(submitCalls).toBe(1);
    expect(lookupCalls).toBe(2);
    expect(waits).toEqual([25]);
  });

  it('a clean 4xx rejection (CONFIRMED_NOT_SUBMITTED) creates zero phantom internal state and issues no lookup call', async () => {
    let lookupCalls = 0;
    let positionRiskCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        throw new OrderSubmissionError('[openMarketPosition(BTCUSDT,LONG)] HTTP 400 Bad Request: {"code":-2019,"msg":"Margin is insufficient."}', 'CONFIRMED_NOT_SUBMITTED', 400);
      },
      getOrderByClientOrderId: async () => {
        lookupCalls++;
        throw new Error('should never be called for a confirmed rejection');
      },
      getPositionRisk: async () => {
        positionRiskCalls++;
        throw new Error('should never be called for a confirmed rejection');
      },
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-1', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('CONFIRMED_NOT_FILLED');
    expect(lookupCalls).toBe(0);
    expect(positionRiskCalls).toBe(0);
  });

  it('HTTP 5xx -> DELIVERY_UNKNOWN/AMBIGUOUS, never CONFIRMED_NOT_SUBMITTED/NOT_FILLED', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        throw new OrderSubmissionError('[openMarketPosition(BTCUSDT,LONG)] HTTP 500 Internal Server Error: <html>oops</html>', 'DELIVERY_UNKNOWN', 500);
      },
      getOrderByClientOrderId: async () => {
        throw new Error('lookup also unavailable');
      },
      getPositionRisk: async () => {
        throw new Error('positionRisk also unavailable');
      },
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-2', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(result.outcome).not.toBe('CONFIRMED_NOT_FILLED');
    expect(submitCalls).toBe(1);
  });

  it('timeout followed immediately by a -2013 (NOT_FOUND) lookup -> AMBIGUOUS, not NOT_FILLED, no retry submission', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        throw new OrderSubmissionError('[openMarketPosition(BTCUSDT,LONG)] TIMEOUT — trạng thái lệnh KHÔNG XÁC ĐỊNH', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => null,
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-3', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(submitCalls).toBe(1);
  });

  it('timeout followed by a lookup that finds a genuinely terminal REJECTED order (corroborated by positionRisk) -> NOT_FILLED, no retry submission', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        throw new OrderSubmissionError('[openMarketPosition(BTCUSDT,LONG)] TIMEOUT — trạng thái lệnh KHÔNG XÁC ĐỊNH', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => ({ orderId: 9, status: 'REJECTED', executedQty: '0', avgPrice: '0', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-4', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('CONFIRMED_NOT_FILLED');
    expect(submitCalls).toBe(1);
  });

  it('a direct NEW-status response with executedQty=0 needs more evidence -> AMBIGUOUS/needs-more-evidence, not NOT_FILLED', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        return { orderId: 10, symbol: 'BTCUSDT', status: 'NEW', raw: { executedQty: '0', avgPrice: '0' } };
      },
      getOrderByClientOrderId: async () => null,
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-5', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(submitCalls).toBe(1);
  });

  it('a direct PARTIALLY_FILLED response with executedQty > 0 -> CONFIRMED_FILLED with the correct actual quantity', async () => {
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => ({ orderId: 11, symbol: 'BTCUSDT', status: 'PARTIALLY_FILLED', raw: { executedQty: '0.007', avgPrice: '50005' } }),
      getOrderByClientOrderId: async () => {
        throw new Error('should never be called on a direct terminal-status success');
      },
      getPositionRisk: async () => {
        throw new Error('should never be called on a direct terminal-status success');
      },
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-6', lookupRetryDelaysMs: [] });
    expect(result).toMatchObject({ outcome: 'CONFIRMED_FILLED', executedQty: 0.007 });
  });

  it('a direct FILLED response with a missing/invalid executedQty needs corroboration and does not blindly assume FILLED', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        return { orderId: 12, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: undefined, avgPrice: '50000' } };
      },
      getOrderByClientOrderId: async () => null,
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-7', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(submitCalls).toBe(1);
  });

  it('a normal successful FILLED response with a valid executedQty classifies correctly without any lookup call', async () => {
    let lookupCalls = 0;
    let positionRiskCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => ({ orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: { executedQty: '0.01', avgPrice: '50000' } }),
      getOrderByClientOrderId: async () => {
        lookupCalls++;
        throw new Error('should never be called on a direct success');
      },
      getPositionRisk: async () => {
        positionRiskCalls++;
        throw new Error('should never be called on a direct success');
      },
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-8', lookupRetryDelaysMs: [] });
    expect(result).toMatchObject({ outcome: 'CONFIRMED_FILLED', executedQty: 0.01 });
    expect(lookupCalls).toBe(0);
    expect(positionRiskCalls).toBe(0);
  });

  it('order-lookup and positionRisk both available but DISAGREE -> AMBIGUOUS, exactly one submission attempt', async () => {
    let submitCalls = 0;
    const executor: MockEntryExecutor = {
      openMarketPosition: async () => {
        submitCalls++;
        throw new OrderSubmissionError('[openMarketPosition(BTCUSDT,LONG)] lỗi mạng: ECONNRESET', 'DELIVERY_UNKNOWN');
      },
      getOrderByClientOrderId: async () => ({ orderId: 13, status: 'FILLED', executedQty: '0.01', avgPrice: '50000', raw: {} }),
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await submitAndClassifyMarketEntry({ executor, symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, referencePrice: 50000, clientOrderId: 'r2br-BTCUSDT-L-9', lookupRetryDelaysMs: [] });
    expect(result.outcome).toBe('AMBIGUOUS');
    expect(submitCalls).toBe(1);
  });
});

type MockSlExecutor = Pick<BinanceOrderExecutor, 'placeStopMarket' | 'getOpenAlgoOrders' | 'closePositionMarket' | 'getPositionRisk'>;

describe('establishProtectiveStopLoss', () => {
  it('MARKET filled + SL placed + SL verified -> PROTECTED, exactly one placeStopMarket call', async () => {
    let placeCalls = 0;
    const executor: MockSlExecutor = {
      placeStopMarket: async () => {
        placeCalls++;
        return { algoId: 1, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      getOpenAlgoOrders: async () => [makeOrder({ algoId: 1, side: 'SELL', origQty: 1, triggerPrice: 95 })],
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const result = await establishProtectiveStopLoss({ executor, symbol: 'BTCUSDT', side: 'LONG', slPrice: 95, quantity: 1, quantityTolerance: 0.001, policy: 'OPERATOR_REQUIRED' });
    expect(result).toMatchObject({ status: 'PROTECTED', slAlgoId: 1 });
    expect(placeCalls).toBe(1);
  });

  it('SL placement throws -> immediate recovery invoked (not deferred), recovery succeeds -> PROTECTED', async () => {
    let placeCalls = 0;
    let getOpenOrdersCalls = 0;
    const executor: MockSlExecutor = {
      placeStopMarket: async () => {
        placeCalls++;
        if (placeCalls === 1) throw new Error('first attempt: network error');
        return { algoId: 2, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      getOpenAlgoOrders: async () => {
        getOpenOrdersCalls++;
        return getOpenOrdersCalls === 1 ? [] : [makeOrder({ algoId: 2, side: 'SELL', origQty: 1, triggerPrice: 95 })];
      },
      closePositionMarket: async () => {
        throw new Error('should never be called — recovery succeeds before exhaustion');
      },
      getPositionRisk: async () => [],
    };
    const result = await establishProtectiveStopLoss({ executor, symbol: 'BTCUSDT', side: 'LONG', slPrice: 95, quantity: 1, quantityTolerance: 0.001, policy: 'OPERATOR_REQUIRED' });
    expect(result).toMatchObject({ status: 'PROTECTED', slAlgoId: 2 });
    expect(placeCalls).toBe(2);
  });

  it('SL placed but verification fails (wrong side resting order) -> same immediate-recovery path, recovery succeeds -> PROTECTED', async () => {
    let placeCalls = 0;
    const executor: MockSlExecutor = {
      placeStopMarket: async () => {
        placeCalls++;
        return { algoId: placeCalls, symbol: 'BTCUSDT', algoStatus: 'NEW', raw: {} };
      },
      getOpenAlgoOrders: async () => {
        if (placeCalls <= 1) return [makeOrder({ algoId: 1, side: 'BUY', origQty: 1, triggerPrice: 95 })];
        return [makeOrder({ algoId: placeCalls, side: 'SELL', origQty: 1, triggerPrice: 95 })];
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const result = await establishProtectiveStopLoss({ executor, symbol: 'BTCUSDT', side: 'LONG', slPrice: 95, quantity: 1, quantityTolerance: 0.001, policy: 'OPERATOR_REQUIRED' });
    expect(result.status).toBe('PROTECTED');
  });

  it('SL recovery exhausted with policy=OPERATOR_REQUIRED -> PROTECTION_DEGRADED, never calls closePositionMarket', async () => {
    let closeCalls = 0;
    const executor: MockSlExecutor = {
      placeStopMarket: async () => {
        throw new Error('every attempt fails');
      },
      getOpenAlgoOrders: async () => [],
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [],
    };
    const result = await establishProtectiveStopLoss({ executor, symbol: 'BTCUSDT', side: 'LONG', slPrice: 95, quantity: 1, quantityTolerance: 0.001, policy: 'OPERATOR_REQUIRED' });
    expect(result.status).toBe('PROTECTION_DEGRADED');
    if (result.status === 'PROTECTION_DEGRADED') expect(result.recovery.status).toBe('EXHAUSTED_OPERATOR_REQUIRED');
    expect(closeCalls).toBe(0);
  });

  it('SL recovery exhausted with policy=EMERGENCY_CLOSE -> PROTECTION_DEGRADED with EXHAUSTED_EMERGENCY_CLOSED, closePositionMarket called exactly once', async () => {
    let closeCalls = 0;
    const executor: MockSlExecutor = {
      placeStopMarket: async () => {
        throw new Error('every attempt fails');
      },
      getOpenAlgoOrders: async () => [],
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await establishProtectiveStopLoss({ executor, symbol: 'BTCUSDT', side: 'LONG', slPrice: 95, quantity: 1, quantityTolerance: 0.001, policy: 'EMERGENCY_CLOSE' });
    expect(result.status).toBe('PROTECTION_DEGRADED');
    if (result.status === 'PROTECTION_DEGRADED') expect(result.recovery.status).toBe('EXHAUSTED_EMERGENCY_CLOSED');
    expect(closeCalls).toBe(1);
  });
});

describe('isSlGeometryValidForFill', () => {
  it('LONG requires slPrice < entryPrice', () => {
    expect(isSlGeometryValidForFill('LONG', 100, 95)).toBe(true);
    expect(isSlGeometryValidForFill('LONG', 100, 105)).toBe(false);
    expect(isSlGeometryValidForFill('LONG', 100, 100)).toBe(false);
  });
  it('SHORT requires slPrice > entryPrice', () => {
    expect(isSlGeometryValidForFill('SHORT', 100, 105)).toBe(true);
    expect(isSlGeometryValidForFill('SHORT', 100, 95)).toBe(false);
  });
  it('rejects non-finite or non-positive inputs', () => {
    expect(isSlGeometryValidForFill('LONG', NaN, 95)).toBe(false);
    expect(isSlGeometryValidForFill('LONG', 100, -5)).toBe(false);
    expect(isSlGeometryValidForFill('LONG', 0, 95)).toBe(false);
  });
});

type MockRecoveryExecutor = Pick<BinanceOrderExecutor, 'getOpenAlgoOrders' | 'placeStopMarket' | 'closePositionMarket' | 'getPositionRisk'>;

describe('recoverMissingProtectiveSl — skipPlacementAttempts (wrong-side-geometry SL must never be sent)', () => {
  it('with skipPlacementAttempts=true and policy=OPERATOR_REQUIRED, zero placeStopMarket calls occur and the known-bad slTriggerPrice is never used', async () => {
    let placeStopMarketCalls = 0;
    const executor: MockRecoveryExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => {
        placeStopMarketCalls++;
        throw new Error('should never be called');
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const result = await recoverMissingProtectiveSl({
      executor,
      symbol: 'BTCUSDT',
      expectedSide: 'LONG',
      expectedQty: 0.01,
      quantityTolerance: 0.001,
      slTriggerPrice: 999999,
      policy: 'OPERATOR_REQUIRED',
      skipPlacementAttempts: true,
    });
    expect(placeStopMarketCalls).toBe(0);
    expect(result.status).toBe('EXHAUSTED_OPERATOR_REQUIRED');
    expect(result.attemptsUsed).toBe(0);
  });

  it('with skipPlacementAttempts=true and policy=EMERGENCY_CLOSE, zero placeStopMarket calls occur but the existing EMERGENCY_CLOSE policy still applies (closePositionMarket is called)', async () => {
    let placeStopMarketCalls = 0;
    let closeCalls = 0;
    const executor: MockRecoveryExecutor = {
      getOpenAlgoOrders: async () => [],
      placeStopMarket: async () => {
        placeStopMarketCalls++;
        throw new Error('should never be called');
      },
      closePositionMarket: async () => {
        closeCalls++;
        return { orderId: 1, symbol: 'BTCUSDT', status: 'FILLED', raw: {} };
      },
      getPositionRisk: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
    };
    const result = await recoverMissingProtectiveSl({
      executor,
      symbol: 'BTCUSDT',
      expectedSide: 'LONG',
      expectedQty: 0.01,
      quantityTolerance: 0.001,
      slTriggerPrice: 999999,
      policy: 'EMERGENCY_CLOSE',
      skipPlacementAttempts: true,
    });
    expect(placeStopMarketCalls).toBe(0);
    expect(closeCalls).toBe(1);
    expect(result.status).toBe('EXHAUSTED_EMERGENCY_CLOSED');
  });

  it('with skipPlacementAttempts=true, an order matching only side and quantity is not adopted without validated trigger geometry', async () => {
    let placeStopMarketCalls = 0;
    const executor: MockRecoveryExecutor = {
      getOpenAlgoOrders: async () => [makeOrder({ algoId: 77, side: 'SELL', origQty: 0.01 })],
      placeStopMarket: async () => {
        placeStopMarketCalls++;
        throw new Error('should never be called');
      },
      closePositionMarket: async () => {
        throw new Error('should never be called');
      },
      getPositionRisk: async () => [],
    };
    const result = await recoverMissingProtectiveSl({
      executor,
      symbol: 'BTCUSDT',
      expectedSide: 'LONG',
      expectedQty: 0.01,
      quantityTolerance: 0.001,
      slTriggerPrice: 999999,
      policy: 'OPERATOR_REQUIRED',
      skipPlacementAttempts: true,
    });
    expect(placeStopMarketCalls).toBe(0);
    expect(result.status).toBe('EXHAUSTED_OPERATOR_REQUIRED');
  });
});

describe('liveRunner.ts wiring — TICKET-LIVE-R2BR', () => {
  it('Checkpoint 1: LIVE_FIXED_RISK_USD is parsed via parseLiveFixedRiskUsd before the tick loop', () => {
    expect(liveRunnerSrc).toContain('parseLiveFixedRiskUsd(process.env.LIVE_FIXED_RISK_USD)');
  });
  it('Checkpoint 2: LIVE maxConcurrentPositionsPerSymbol is 1 (one-way, at most one position per symbol total)', () => {
    expect(liveRunnerSrc).toContain('maxConcurrentPositionsPerSymbol: 1,');
    expect(liveRunnerSrc).not.toContain('maxConcurrentPositionsPerSymbol: 2,');
  });
  it('Checkpoint 3: handleOpenEvent uses submitAndClassifyMarketEntry (never a bare openMarketPosition + blind catch)', () => {
    expect(liveLifecycleSrc).toContain('const classification = await submitAndClassifyMarketEntry(');
  });
  it('Checkpoint 4: reconcileExecutedOpenState runs, and geometry is checked, BEFORE either establishProtectiveStopLoss or recoverMissingProtectiveSl is called', () => {
    const fnStart = liveLifecycleSrc.indexOf('async function establishReconciledProtectedPosition(');
    const fnEnd = liveLifecycleSrc.indexOf('export async function handleOpenEvent(');
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const block = liveLifecycleSrc.slice(fnStart, fnEnd);
    const reconcileIdx = block.indexOf('reconcileExecutedOpenState(');
    const geometryIdx = block.indexOf('isSlGeometryValidForFill(');
    const slIdx = block.indexOf('establishProtectiveStopLoss(');
    const recoverIdx = block.indexOf('recoverMissingProtectiveSl(');
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(geometryIdx).toBeGreaterThan(reconcileIdx);
    expect(slIdx).toBeGreaterThan(geometryIdx);
    expect(recoverIdx).toBeGreaterThan(geometryIdx);
  });
  it('Checkpoint 4: TP is only placed when both reconciliation succeeded and geometry is valid', () => {
    const fnStart = liveLifecycleSrc.indexOf('async function establishReconciledProtectedPosition(');
    const fnEnd = liveLifecycleSrc.indexOf('export async function handleOpenEvent(');
    const block = liveLifecycleSrc.slice(fnStart, fnEnd);
    expect(block).toContain('if (reconciled.ok && geometryValid) {');
    expect(block).toContain('ctx.executor.placeTakeProfitMarket(');
  });
  it('Checkpoint 4: a reconciliation or geometry failure never leaves TP placed, and routes through the same recovery path as an SL-placement failure', () => {
    const fnStart = liveLifecycleSrc.indexOf('async function establishReconciledProtectedPosition(');
    const fnEnd = liveLifecycleSrc.indexOf('export async function handleOpenEvent(');
    const block = liveLifecycleSrc.slice(fnStart, fnEnd);
    expect(block).toContain('if (!reconciled.ok) {');
    expect(block).toContain('} else if (!geometryValid) {');
    expect(block).toContain('skipPlacementAttempts: true,');
    expect(block).toContain('await recoverMissingProtectiveSl(');
  });
  it('Checkpoint 5: the partial-close SL-replace call site invokes recoverMissingProtectiveSl synchronously on failure, checks persistLiveState()\'s return value', () => {
    const start = liveLifecycleSrc.indexOf('export async function handlePartialCloseEvent');
    const end = liveLifecycleSrc.indexOf('export async function handleCloseEvent');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = liveLifecycleSrc.slice(start, end);
    expect(block).toContain('catch (err) {');
    expect(block).toContain('await recoverMissingProtectiveSl(');
    expect(block).toContain('ctx.runnerState.blockSymbolAdmission(symbol);');
    expect(block).toContain('const persisted = ctx.persistLiveState();');
  });
  it('Item 5: the FILLED_UNPROTECTED quarantine record is built with actualRiskDollar/marginRequired/protectionStatus/recoveryStatus/recoveryDetail/exposureBasis populated from known evidence, not left null', () => {
    const phaseIdx = liveRunnerSrc.indexOf("phase: 'FILLED_UNPROTECTED',");
    expect(phaseIdx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(phaseIdx, phaseIdx + 1400);
    expect(block).toContain('actualRiskDollar: reconciled.actualRiskDollar,');
    expect(block).toContain('marginRequired: reconciled.marginRequired,');
    expect(block).toContain('protectionStatus: outcome.protection.status,');
    expect(block).toContain("recoveryStatus: outcome.protection.status === 'PROTECTION_DEGRADED' ? outcome.protection.recovery.status : null,");
    expect(block).toContain('exposureBasis: { side: event.side, qty: outcome.executedQty, entryPrice: reconciled.entryPrice },');
  });
  it('Checkpoint 6: a non-FILLED outcome removes the optimistic entry from result.symbolState.openPositions before it is ever committed to runnerState', () => {
    expect(liveRunnerSrc).toContain("if (outcome.kind === 'NOT_FILLED') {");
    expect(liveRunnerSrc).toContain('openPositions: result.symbolState.openPositions.filter((e) => e.meta.entryTimestamp !== event.entryTimestamp)');
  });
  it('Checkpoint 6: all 4 quarantine phases exist and every write site goes through recordPendingEntryQuarantine, which persists before continuing', () => {
    expect(liveLifecycleSrc).toContain("phase: 'AMBIGUOUS_SUBMISSION',");
    expect(liveRunnerSrc).toContain("phase: 'FILLED_UNPROTECTED',");
    expect(liveRunnerSrc).toContain("phase: 'FILLED_INTERNAL_STATE_MISSING',");
    expect(liveRunnerSrc).toContain("phase: 'RECONCILIATION_FAILED',");
    expect(liveRunnerSrc.match(/recordPendingEntryQuarantine\(record\);/g)?.length).toBe(3);
    expect(liveLifecycleSrc).toContain('input.recordPendingEntryQuarantine({');
    const fnIdx = liveLifecycleSrc.indexOf('return function recordPendingEntryQuarantine(record: PendingEntryQuarantineRecord): boolean {');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBlock = liveLifecycleSrc.slice(fnIdx, fnIdx + 500);
    expect(fnBlock).toContain('const persisted = deps.persistLiveState();');
  });
  it('Checkpoint 6: a confirmed fill with no matching openedEntry quarantines immediately as FILLED_INTERNAL_STATE_MISSING and sends a CRITICAL Telegram alert, not just a log line', () => {
    const idx = liveRunnerSrc.indexOf('if (!openedEntry) {');
    expect(idx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(idx, idx + 3200);
    expect(block).toContain("phase: 'FILLED_INTERNAL_STATE_MISSING',");
    expect(block).toContain('recordPendingEntryQuarantine(record);');
    expect(block).toContain('🚨🚨 [CRITICAL');
  });
  it('Checkpoint 6: restart recovery reads pendingEntryQuarantines and blocks new entries on any symbol still carrying one of ANY phase, without touching openPositions', () => {
    const idx = liveLifecycleSrc.indexOf('for (const [symbol, records] of Object.entries(pendingEntryQuarantinesBySymbol)) {');
    expect(idx).toBeGreaterThan(-1);
    const block = liveLifecycleSrc.slice(idx, idx + 500);
    expect(block).toContain('blockedSymbols.push({ symbol, recordCount: records.length });');
  });
  it('Item 5: a persistLiveState() failure sets onPersistFailure(true) and the caller feeds the SAME portfolio-wide admission sentinel, plus sends a CRITICAL Telegram alert', () => {
    const fnIdx = liveLifecycleSrc.indexOf('return function persistLiveState(): boolean {');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBlock = liveLifecycleSrc.slice(fnIdx, fnIdx + 1300);
    expect(fnBlock).toContain('deps.onPersistFailure(true);');
    expect(fnBlock).toContain('🚨🚨 [CRITICAL');
    expect(liveRunnerSrc).toContain('livePersistFailureBlockingAdmission ||');
  });
  it('Item 6: the top-level catch around handleOpenEvent is a narrow last-resort backstop; post-fill errors are caught INSIDE handleOpenEvent and preserve known fill evidence instead of a generic empty-evidence AMBIGUOUS record', () => {
    const tryIdx = liveLifecycleSrc.indexOf('return await establishReconciledProtectedPosition(');
    expect(tryIdx).toBeGreaterThan(-1);
    const catchIdx = liveLifecycleSrc.indexOf('} catch (err) {', tryIdx);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    const block = liveLifecycleSrc.slice(catchIdx, catchIdx + 800);
    expect(block).toContain('orderId: classification.orderId');
    expect(block).toContain('executedQty: canonicalQty');
    expect(block).toContain('avgPrice: classification.avgPrice');
  });
});

describe('liveRunner.ts wiring — TICKET-LIVE-R5T requirement 1/2', () => {
  it('Requirement 1: mainnet+dryRun=false requires EXECUTION_TELEMETRY_ENABLED before anything else can start', () => {
    const idx = liveRunnerSrc.indexOf("if (envConfig.env === 'mainnet' && dryRun === false) {");
    expect(idx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(idx, idx + 900);
    expect(block).toContain('if (!EXECUTION_TELEMETRY_ENABLED) {');
    expect(block).toContain('throw new Error(');
    expect(liveRunnerSrc.indexOf("if (envConfig.env === 'mainnet' && dryRun === false) {")).toBeLessThan(liveRunnerSrc.indexOf('new ExecutionTelemetry({'));
  });

  it('Requirement 1: the mandatory-telemetry gate performs a real write-probe against the telemetry root dir, not just existsSync', () => {
    const idx = liveRunnerSrc.indexOf("if (envConfig.env === 'mainnet' && dryRun === false) {");
    const block = liveRunnerSrc.slice(idx, idx + 900);
    expect(block).toContain('mkdirSync(EXECUTION_TELEMETRY_ROOT_DIR');
    expect(block).toContain('openSync(probePath');
    expect(block).toContain('writeSync(probeFd');
    expect(block).toContain('unlinkSync(probePath)');
    expect(block).not.toContain('existsSync(EXECUTION_TELEMETRY_ROOT_DIR)');
  });

  it('Requirement 2: onHealthAlert sets the portfolio-wide telemetry-failure sentinel and dispatches a CRITICAL Telegram alert', () => {
    const idx = liveRunnerSrc.indexOf('onHealthAlert: (message) => {');
    expect(idx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(idx, idx + 400);
    expect(block).toContain('telemetryFailureBlockingAdmission = true;');
    expect(block).toContain('dispatchTelemetryAlert(');
    expect(block).toContain('CRITICAL');
  });

  it('Requirement 2: telemetryFailureBlockingAdmission joins the SAME portfolio-wide admission sentinel as every other unquantifiable-exposure trigger', () => {
    const idx = liveRunnerSrc.indexOf('const hasUnquantifiableExposureBlockingAdmission =');
    expect(idx).toBeGreaterThan(-1);
    const block = liveRunnerSrc.slice(idx, idx + 700);
    expect(block).toContain('telemetryFailureBlockingAdmission ||');
  });

  it('Requirement 2: a mandatory-mainnet telemetry becoming unavailable at runtime is also caught defensively inside the tick loop', () => {
    const idx = liveRunnerSrc.indexOf("if (envLabel === 'mainnet' && dryRun === false && !telemetry.isEnabled()");
    expect(idx).toBeGreaterThan(-1);
  });
});
