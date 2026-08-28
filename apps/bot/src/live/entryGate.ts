import type { CircuitBreakerState } from './circuitBreaker.js';

// TICKET-RT-073 Part A: the single gating decision liveRunner.ts's poll loop uses to decide whether
// a symbol may detect+place a NEW entry this tick. Combines the two block reasons that already
// existed (per-symbol `blocked`, from RT-068's startup reconciliation; `lifecycleIsFree`, from
// SymbolOrderLifecycle already having an open/pending position) with the new GLOBAL circuit breaker
// (RT-AUDIT-001: 3 consecutive LIFECYCLE_ERROR events blocks entry detection at EVERY symbol, not
// just the one that errored). Existing open positions are never affected by any of these three
// conditions — this function only gates checkForNewSignal/onSignalDetected, never
// onNewM15Candle's SL/TP management, which liveRunner.ts always calls regardless.
export function isNewEntryAllowed(input: { symbolBlocked: boolean; lifecycleIsFree: boolean; circuitBreaker: CircuitBreakerState }): boolean {
  return !input.circuitBreaker.tripped && !input.symbolBlocked && input.lifecycleIsFree;
}
