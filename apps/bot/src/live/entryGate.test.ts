import { describe, it, expect } from 'vitest';
import { createCircuitBreakerState, recordLifecycleError, recordSuccess } from './circuitBreaker.js';
import { isNewEntryAllowed } from './entryGate.js';

describe('isNewEntryAllowed', () => {
  it('allows entry when nothing blocks it', () => {
    const cb = createCircuitBreakerState();
    expect(isNewEntryAllowed({ symbolBlocked: false, lifecycleIsFree: true, circuitBreaker: cb })).toBe(true);
  });

  it('blocks when the symbol itself is blocked (RT-068 startup reconciliation), independent of the circuit breaker', () => {
    const cb = createCircuitBreakerState();
    expect(isNewEntryAllowed({ symbolBlocked: true, lifecycleIsFree: true, circuitBreaker: cb })).toBe(false);
  });

  it('blocks when the symbol already has an open/pending position (lifecycle not free)', () => {
    const cb = createCircuitBreakerState();
    expect(isNewEntryAllowed({ symbolBlocked: false, lifecycleIsFree: false, circuitBreaker: cb })).toBe(false);
  });

  // Ticket acceptance scenario: 3 consecutive LIFECYCLE_ERROR blocks entry at EVERY symbol.
  it('once the circuit breaker is tripped, blocks entry for every symbol regardless of that symbol\'s own state', () => {
    const cb = createCircuitBreakerState();
    recordLifecycleError(cb);
    recordLifecycleError(cb);
    recordLifecycleError(cb);
    expect(cb.tripped).toBe(true);

    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
    for (const symbol of symbols) {
      // Even a symbol that is otherwise perfectly free to trade (its own state has nothing to do
      // with which symbol tripped the breaker) must be blocked once tripped.
      expect(isNewEntryAllowed({ symbolBlocked: false, lifecycleIsFree: true, circuitBreaker: cb }), `expected ${symbol} to be blocked`).toBe(false);
    }
  });

  it('a success (ENTRY_FILLED/POSITION_CLOSED) resetting the counter does NOT un-block entry once tripped', () => {
    const cb = createCircuitBreakerState();
    recordLifecycleError(cb);
    recordLifecycleError(cb);
    recordLifecycleError(cb);
    recordSuccess(cb);
    expect(isNewEntryAllowed({ symbolBlocked: false, lifecycleIsFree: true, circuitBreaker: cb })).toBe(false);
  });
});
