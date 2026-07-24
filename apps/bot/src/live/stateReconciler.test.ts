import { describe, it, expect, vi } from 'vitest';
import { StateReconciler, compareStates, type InternalStateSnapshot, type ExchangePositionSnapshot } from './stateReconciler.js';

function makeExecutor(accountInfo: unknown, positionRisk: unknown) {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(accountInfo),
    getPositionRisk: vi.fn().mockResolvedValue(positionRisk),
  };
}

describe('compareStates', () => {
  it('reports no mismatch when balance and positions match within tolerance', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }] };
    const exchangePositions: ExchangePositionSnapshot[] = [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }];
    const mismatches = compareStates(1000, exchangePositions, internal, 0.01, 1e-8);
    expect(mismatches).toEqual([]);
  });

  it('flags BALANCE_MISMATCH when the difference exceeds tolerance', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [] };
    const mismatches = compareStates(900, [], internal, 0.01, 1e-8); // 10% off, tolerance 1%
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].type).toBe('BALANCE_MISMATCH');
  });

  it('does NOT flag a balance difference within tolerance (floating PNL noise)', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [] };
    const mismatches = compareStates(1005, [], internal, 0.01, 1e-8); // 0.5% off, tolerance 1%
    expect(mismatches).toEqual([]);
  });

  it('flags POSITION_MISSING_INTERNALLY when the exchange has a position the bot does not know about', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [] };
    const exchangePositions: ExchangePositionSnapshot[] = [{ symbol: 'ETHUSDT', side: 'SHORT', quantity: 0.5 }];
    const mismatches = compareStates(1000, exchangePositions, internal, 0.01, 1e-8);
    expect(mismatches).toEqual([{ type: 'POSITION_MISSING_INTERNALLY', detail: expect.stringContaining('ETHUSDT') }]);
  });

  it('flags POSITION_MISSING_ON_EXCHANGE when the bot thinks it has a position the exchange does not have (likely SL/TP already filled)', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [{ symbol: 'SOLUSDT', side: 'LONG', quantity: 2 }] };
    const mismatches = compareStates(1000, [], internal, 0.01, 1e-8);
    expect(mismatches).toEqual([{ type: 'POSITION_MISSING_ON_EXCHANGE', detail: expect.stringContaining('SOLUSDT') }]);
  });

  it('flags POSITION_SIDE_MISMATCH when side disagrees', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [{ symbol: 'XRPUSDT', side: 'LONG', quantity: 100 }] };
    const exchangePositions: ExchangePositionSnapshot[] = [{ symbol: 'XRPUSDT', side: 'SHORT', quantity: 100 }];
    const mismatches = compareStates(1000, exchangePositions, internal, 0.01, 1e-8);
    expect(mismatches).toEqual([{ type: 'POSITION_SIDE_MISMATCH', detail: expect.stringContaining('XRPUSDT') }]);
  });

  it('flags POSITION_SIZE_MISMATCH when quantity disagrees beyond tolerance', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }] };
    const exchangePositions: ExchangePositionSnapshot[] = [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.02 }];
    const mismatches = compareStates(1000, exchangePositions, internal, 0.01, 1e-8);
    expect(mismatches).toEqual([{ type: 'POSITION_SIZE_MISMATCH', detail: expect.stringContaining('BTCUSDT') }]);
  });

  it('can report multiple mismatches at once', () => {
    const internal: InternalStateSnapshot = { balanceUsd: 1000, positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }] };
    const exchangePositions: ExchangePositionSnapshot[] = [{ symbol: 'ETHUSDT', side: 'SHORT', quantity: 0.5 }];
    const mismatches = compareStates(500, exchangePositions, internal, 0.01, 1e-8);
    const types = mismatches.map((m) => m.type).sort();
    expect(types).toEqual(['BALANCE_MISMATCH', 'POSITION_MISSING_INTERNALLY', 'POSITION_MISSING_ON_EXCHANGE'].sort());
  });
});

describe('StateReconciler', () => {
  it('reconcileOnce() parses Binance raw shapes and calls onClean when everything matches', async () => {
    const executor = makeExecutor({ totalWalletBalance: '1000.00' }, [
      { symbol: 'BTCUSDT', positionAmt: '0.01' },
      { symbol: 'ETHUSDT', positionAmt: '0' }, // flat — should be filtered out
    ]);
    const getInternalState = () => ({ balanceUsd: 1000, positions: [{ symbol: 'BTCUSDT', side: 'LONG' as const, quantity: 0.01 }] });
    const onClean = vi.fn();
    const onMismatch = vi.fn();
    const reconciler = new StateReconciler({ executor, getInternalState, onClean, onMismatch });

    const result = await reconciler.reconcileOnce();
    expect(result.mismatches).toEqual([]);
    expect(onClean).toHaveBeenCalledTimes(1);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('reconcileOnce() parses a SHORT position (negative positionAmt) correctly', async () => {
    const executor = makeExecutor({ totalWalletBalance: '1000.00' }, [{ symbol: 'ETHUSDT', positionAmt: '-0.5' }]);
    const getInternalState = () => ({ balanceUsd: 1000, positions: [{ symbol: 'ETHUSDT', side: 'SHORT' as const, quantity: 0.5 }] });
    const reconciler = new StateReconciler({ executor, getInternalState });
    const result = await reconciler.reconcileOnce();
    expect(result.mismatches).toEqual([]);
    expect(result.exchangePositions).toEqual([{ symbol: 'ETHUSDT', side: 'SHORT', quantity: 0.5 }]);
  });

  it('calls onMismatch (not onClean) and logs when states disagree, without touching internal state', async () => {
    const executor = makeExecutor({ totalWalletBalance: '500.00' }, []);
    const getInternalState = () => ({ balanceUsd: 1000, positions: [] });
    const onMismatch = vi.fn();
    const onClean = vi.fn();
    const reconciler = new StateReconciler({ executor, getInternalState, onMismatch, onClean });

    const result = await reconciler.reconcileOnce();
    expect(result.mismatches).toHaveLength(1);
    expect(onMismatch).toHaveBeenCalledWith(result);
    expect(onClean).not.toHaveBeenCalled();
    // never mutates getInternalState's return value or calls any mutating executor method
    expect(Object.keys(executor)).toEqual(['getAccountInfo', 'getPositionRisk']);
  });

  it('start() reconciles immediately and again on each interval tick; stop() clears the timer', async () => {
    const executor = makeExecutor({ totalWalletBalance: '1000.00' }, []);
    const getInternalState = () => ({ balanceUsd: 1000, positions: [] });
    let tickFn: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      tickFn = fn;
      return 1 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;

    const reconciler = new StateReconciler({ executor, getInternalState, setIntervalFn, clearIntervalFn });
    reconciler.start();
    await vi.waitFor(() => expect(executor.getAccountInfo).toHaveBeenCalledTimes(1));

    tickFn?.();
    await vi.waitFor(() => expect(executor.getAccountInfo).toHaveBeenCalledTimes(2));

    reconciler.stop();
    expect(clearIntervalFn).toHaveBeenCalled();
  });

  it('reconcileOnce() surfaces a parse error instead of silently treating malformed data as "no mismatch"', async () => {
    const executor = makeExecutor({}, []); // missing totalWalletBalance
    const getInternalState = () => ({ balanceUsd: 1000, positions: [] });
    const reconciler = new StateReconciler({ executor, getInternalState });
    await expect(reconciler.reconcileOnce()).rejects.toThrow(/totalWalletBalance/);
  });

  it('start() catches a reconcileOnce() error via onError instead of crashing the timer loop', async () => {
    const executor = { getAccountInfo: vi.fn().mockRejectedValue(new Error('network down')), getPositionRisk: vi.fn().mockResolvedValue([]) };
    const getInternalState = () => ({ balanceUsd: 1000, positions: [] });
    const onError = vi.fn();
    const setIntervalFn = vi.fn(() => 1 as unknown as NodeJS.Timeout) as unknown as typeof setInterval;
    const reconciler = new StateReconciler({ executor, getInternalState, onError, setIntervalFn });

    reconciler.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toContain('network down');
  });
});
