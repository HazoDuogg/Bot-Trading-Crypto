import { describe, it, expect } from 'vitest';
import { createCircuitBreakerState, recordLifecycleError, recordSuccess, CIRCUIT_BREAKER_THRESHOLD } from './circuitBreaker.js';
import { fromCircuitBreakerTripped } from './eventRecord.js';
import { formatEventMessage } from './telegram.js';
import { isNewEntryAllowed } from './entryGate.js';
import type { LiveEventRecord } from './eventRecord.js';

describe('circuit breaker', () => {
  it('starts untripped with a zero counter', () => {
    const state = createCircuitBreakerState();
    expect(state.tripped).toBe(false);
    expect(state.consecutiveErrors).toBe(0);
  });

  it('does not trip on 1 or 2 consecutive errors (below threshold=3)', () => {
    const state = createCircuitBreakerState();
    expect(recordLifecycleError(state).justTripped).toBe(false);
    expect(state.tripped).toBe(false);
    expect(recordLifecycleError(state).justTripped).toBe(false);
    expect(state.tripped).toBe(false);
    expect(state.consecutiveErrors).toBe(2);
  });

  it('trips on exactly the 3rd consecutive error, reporting justTripped=true only on that call', () => {
    const state = createCircuitBreakerState();
    expect(recordLifecycleError(state).justTripped).toBe(false);
    expect(recordLifecycleError(state).justTripped).toBe(false);
    expect(recordLifecycleError(state).justTripped).toBe(true);
    expect(state.tripped).toBe(true);
    expect(state.consecutiveErrors).toBe(CIRCUIT_BREAKER_THRESHOLD);
  });

  it('counts errors across DIFFERENT symbols the same as the same symbol (global, not per-symbol)', () => {
    // The caller doesn't pass a symbol at all — this is a structural guarantee, not a runtime check,
    // but the test documents the intended usage: one shared state instance for every symbol.
    const state = createCircuitBreakerState();
    recordLifecycleError(state); // e.g. BTCUSDT
    recordLifecycleError(state); // e.g. SOLUSDT
    const third = recordLifecycleError(state); // e.g. DOGEUSDT
    expect(third.justTripped).toBe(true);
  });

  it('further errors after tripping stay tripped and never report justTripped again (no duplicate alerts)', () => {
    const state = createCircuitBreakerState();
    recordLifecycleError(state);
    recordLifecycleError(state);
    recordLifecycleError(state);
    expect(state.tripped).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(recordLifecycleError(state).justTripped).toBe(false);
      expect(state.tripped).toBe(true);
    }
  });

  it('recordSuccess resets the counter to 0 before tripping', () => {
    const state = createCircuitBreakerState();
    recordLifecycleError(state);
    recordLifecycleError(state);
    expect(state.consecutiveErrors).toBe(2);
    recordSuccess(state);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.tripped).toBe(false);
    // Confirms the streak actually reset — 2 more errors after a success should NOT trip (would
    // need a 3rd on top of these 2, not on top of the pre-reset streak).
    expect(recordLifecycleError(state).justTripped).toBe(false);
    expect(recordLifecycleError(state).justTripped).toBe(false);
  });

  it('recordSuccess does NOT clear tripped once already tripped — no auto-resume', () => {
    const state = createCircuitBreakerState();
    recordLifecycleError(state);
    recordLifecycleError(state);
    recordLifecycleError(state);
    expect(state.tripped).toBe(true);
    recordSuccess(state);
    expect(state.tripped).toBe(true); // still tripped — only a process restart clears this
    expect(state.consecutiveErrors).toBe(0);
  });
});

// TICKET-RT-073 acceptance scenario, as specced in the ticket's "Cach xac nhan": simulate 3
// consecutive LIFECYCLE_ERROR -> confirm entry is blocked at every symbol + a distinct Telegram
// alert is sent. Composes the real production functions end-to-end (no mocking of liveRunner.ts
// itself, which is a script entrypoint with real network/env dependencies not worth mocking here —
// this proves the same behavior at the level of the reusable functions liveRunner.ts wires together).
describe('circuit breaker end-to-end (RT-073 acceptance scenario)', () => {
  it('3 consecutive LIFECYCLE_ERROR (even across different symbols) trips the breaker exactly once, blocks new-entry detection at every symbol, and produces a visibly distinct Telegram alert', () => {
    const cb = createCircuitBreakerState();
    const alerts: LiveEventRecord[] = [];

    function simulateLifecycleErrorEvent() {
      const { justTripped } = recordLifecycleError(cb);
      if (justTripped) alerts.push(fromCircuitBreakerTripped({ consecutiveErrors: cb.consecutiveErrors }));
    }

    // Different symbols on purpose — the counter is global, not per-symbol.
    simulateLifecycleErrorEvent(); // e.g. BTCUSDT
    expect(cb.tripped).toBe(false);
    simulateLifecycleErrorEvent(); // e.g. SOLUSDT
    expect(cb.tripped).toBe(false);
    simulateLifecycleErrorEvent(); // e.g. DOGEUSDT — 3rd, trips
    expect(cb.tripped).toBe(true);

    // Exactly one alert — not one per subsequent error.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].eventKind).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(alerts[0].symbol).toBe('ALL');

    // Entry detection must now be blocked at EVERY symbol, regardless of that symbol's own state.
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT']) {
      expect(isNewEntryAllowed({ symbolBlocked: false, lifecycleIsFree: true, circuitBreaker: cb }), symbol).toBe(false);
    }

    // The alert renders as a visibly different Telegram message from a routine LIFECYCLE_ERROR.
    const breakerMsg = formatEventMessage(alerts[0]);
    const routineErrorMsg = formatEventMessage({ timestampUtc: alerts[0].timestampUtc, symbol: 'DOGEUSDT', strategy: 'FVG H1+M15', eventKind: 'LIFECYCLE_ERROR', note: 'mot loi don le', raw: {} });
    expect(breakerMsg).toContain('🛑');
    expect(breakerMsg).toContain('CIRCUIT BREAKER');
    expect(breakerMsg.split('\n')[0]).not.toBe(routineErrorMsg.split('\n')[0]);

    // Existing positions are unaffected — this scenario only ever gates NEW entry detection
    // (isNewEntryAllowed), never SymbolOrderLifecycle.onNewM15Candle's own SL/TP management, which
    // liveRunner.ts's poll loop always calls unconditionally regardless of circuit-breaker state.
  });
});
