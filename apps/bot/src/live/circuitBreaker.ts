// TICKET-RT-073 Part A: process-local (in-memory, non-persistent — resets to 0/untripped on every
// restart, per the ticket's own "khong can ben vung qua restart" instruction) circuit breaker.
// RT-AUDIT-001 found 13 consecutive identical LIFECYCLE_ERROR events over 3 hours with no mechanism
// to notice "something is systemically wrong" and pause — engine kept placing brand-new entries for
// OTHER symbols the whole time. This closes that gap: a GLOBAL counter (not per-symbol — any 3
// consecutive LIFECYCLE_ERROR events, even across different symbols, count) that trips a single
// process-wide flag blocking new-entry detection everywhere once tripped.
//
// Deliberately does NOT auto-resume: resolveSuccess() zeroes the counter (per the ticket: an
// ENTRY_FILLED/POSITION_CLOSED is evidence normal operation resumed) but leaves `tripped` as-is once
// set. The only way to clear `tripped` is a process restart (this state lives only in memory) — a
// human deliberately bringing the process back up, matching the ticket's explicit "khong tu dong
// resume, luon can con nguoi xac nhan" requirement. No separate "resume" command is implemented: a
// restart already satisfies that requirement with zero added surface area, and the ticket names
// restart as an acceptable mechanism.

export const CIRCUIT_BREAKER_THRESHOLD = 3;

export interface CircuitBreakerState {
  consecutiveErrors: number;
  tripped: boolean;
}

export function createCircuitBreakerState(): CircuitBreakerState {
  return { consecutiveErrors: 0, tripped: false };
}

// Call once per LIFECYCLE_ERROR event, of any symbol. Returns justTripped=true exactly once — the
// tick this call pushed consecutiveErrors to the threshold — so the caller can send the special
// alert exactly once instead of re-alerting on every subsequent error while already tripped.
export function recordLifecycleError(state: CircuitBreakerState): { justTripped: boolean } {
  if (state.tripped) return { justTripped: false };
  state.consecutiveErrors++;
  if (state.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
    state.tripped = true;
    return { justTripped: true };
  }
  return { justTripped: false };
}

// Call on ENTRY_FILLED or POSITION_CLOSED — evidence the system is functioning normally again.
// Resets the counter but deliberately does NOT clear `tripped` (see file comment above).
export function recordSuccess(state: CircuitBreakerState): void {
  state.consecutiveErrors = 0;
}
