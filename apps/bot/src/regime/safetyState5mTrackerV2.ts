import { SafetyState5m } from './htfSafetyTypes.js';

/** TICKET-SCALP-005: inlined from the now-deleted safetyState5mTracker.ts (V1) — same shape, no behavior change. */
export interface SafetyState5mTrackerState {
  currentState: SafetyState5m;
  /** Candle timestamp (ms) when currentState was most recently entered. */
  stateEnteredAt: number;
  /** Consecutive candles currentState has been held, including this one. */
  dwellCandles: number;
  /** Candidate currently accumulating consecutive confirmations toward being ENTERED. Null when idle. */
  pendingCandidate: SafetyState5m | null;
  /** Consecutive-candle count for pendingCandidate. */
  pendingCandidateCount: number;
  /** Consecutive candles where candidate != currentState, counted only once minimum dwell (if any) is satisfied — drives EXIT confirmation. */
  cleanExitCount: number;
  /** State held immediately before currentState. Null before the first transition. */
  previousState: SafetyState5m | null;
}

/** Ticket §5: restart safely from NORMAL — never inferred from unloaded history. */
export const INITIAL_SAFETY_STATE_5M_TRACKER: SafetyState5mTrackerState = {
  currentState: SafetyState5m.NORMAL,
  stateEnteredAt: 0,
  dwellCandles: 0,
  pendingCandidate: null,
  pendingCandidateCount: 0,
  cleanExitCount: 0,
  previousState: null,
};

const GOVERNED = new Set<SafetyState5m>([SafetyState5m.MANIPULATED, SafetyState5m.VOLATILE_CHOP, SafetyState5m.LOW_LIQUIDITY]);
/** Ticket §1 (unchanged from T140): enter after 2 consecutive confirming candles. */
const ENTER_CONFIRM_CANDLES = 2;
/** Ticket §1: minimum dwell MANIPULATED/VOLATILE_CHOP 3->4 candles, LOW_LIQUIDITY stays 3. */
const MIN_DWELL_CANDLES: Partial<Record<SafetyState5m, number>> = {
  [SafetyState5m.MANIPULATED]: 4,
  [SafetyState5m.VOLATILE_CHOP]: 4,
  [SafetyState5m.LOW_LIQUIDITY]: 3,
};
function minDwellFor(state: SafetyState5m): number {
  return MIN_DWELL_CANDLES[state] ?? 3;
}
/** Ticket §3 (unchanged from T140): exit to NORMAL still needs only 2 consecutive candidate-confirming candles. */
const EXIT_CONFIRM_CANDLES = 2;
/** Ticket: SHOCK unchanged from T140 — enters immediately, exits after 2 consecutive non-SHOCK candles. */
const SHOCK_EXIT_CONFIRM_CANDLES = 2;

/**
 * TICKET-140B — final chattering reduction on top of TICKET-140's stabilized tracker (T140's own
 * applySafetyState5mStabilization() is left completely untouched — this is a copy-and-modify into a
 * new function/file so both can coexist and produce independently reproducible output for the 3-way
 * RAW/T140/T140B report comparison). Reuses TICKET-139's unchanged classifySafetyState5mCandidate().
 *
 * Behavioral differences vs T140's applySafetyState5mStabilization():
 *  1. Minimum dwell once entered: MANIPULATED 3->4 candles, VOLATILE_CHOP 3->4 candles, LOW_LIQUIDITY
 *     stays 3, SHOCK unchanged (enters immediately, no min-dwell gate at all).
 *  2. Exit mechanism for governed states (MANIPULATED/VOLATILE_CHOP/LOW_LIQUIDITY) once min dwell is
 *     satisfied is no longer T140's generic "candidate != currentState" counter. Instead it's a
 *     CANDIDATE-SPECIFIC confirmation (symmetric to how entry-from-NORMAL already works, reusing the
 *     same pendingCandidate/pendingCandidateCount fields): the SAME new candidate must be seen on 2
 *     CONSECUTIVE candles after min dwell before anything changes. While that 2-candle window is
 *     still open (0 or 1 confirming candle so far), currentState/dwellCandles do NOT change — the
 *     state machine holds the OLD state ("Trong thời gian chờ, giữ state hiện tại" — §2), and
 *     dwellCandles keeps incrementing on the CURRENT (not-yet-exited) state during the wait.
 *  3. Once the pending candidate is confirmed on its 2nd consecutive candle:
 *     - if it's NORMAL: transitions directly to NORMAL (§3, unchanged 2-candle NORMAL confirm).
 *     - if it's a DIFFERENT governed state: transitions DIRECTLY into that new governed state (no
 *       detour through NORMAL, no extra confirmation round) — this is §2's "chuyển trực tiếp giữa
 *       các state nguy hiểm" (MANIPULATED<->VOLATILE_CHOP, {MANIPULATED,VOLATILE_CHOP}<->LOW_LIQUIDITY).
 *       dwellCandles resets to 1 for the new state, stateEnteredAt/previousState update accordingly.
 *  4. SHOCK entry/exit logic is byte-identical to T140's (ticket §1 "SHOCK giữ nguyên, enter ngay" —
 *     no further change needed here).
 */
export function applySafetyState5mFinalStabilization(
  candidate: SafetyState5m,
  timestamp: number,
  previous: SafetyState5mTrackerState | null,
): SafetyState5mTrackerState {
  const prev = previous ?? { ...INITIAL_SAFETY_STATE_5M_TRACKER, stateEnteredAt: timestamp };
  const { currentState, dwellCandles, pendingCandidate, pendingCandidateCount, cleanExitCount, previousState } = prev;

  // ---- SHOCK: candidate SHOCK enters immediately, interrupting any in-progress dwell. Unchanged from T140. ----
  if (candidate === SafetyState5m.SHOCK) {
    if (currentState === SafetyState5m.SHOCK) {
      return { currentState: SafetyState5m.SHOCK, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    return { currentState: SafetyState5m.SHOCK, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
  }

  // ---- currently in SHOCK, candidate no longer SHOCK: 2-candle exit confirm. Unchanged from T140. ----
  if (currentState === SafetyState5m.SHOCK) {
    const newCleanExitCount = cleanExitCount + 1;
    if (newCleanExitCount >= SHOCK_EXIT_CONFIRM_CANDLES) {
      return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: SafetyState5m.SHOCK };
    }
    return { currentState: SafetyState5m.SHOCK, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: newCleanExitCount, previousState };
  }

  // ---- governed states: MANIPULATED / VOLATILE_CHOP / LOW_LIQUIDITY. ----
  if (GOVERNED.has(currentState)) {
    if (candidate === currentState) {
      return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    if (dwellCandles < minDwellFor(currentState)) {
      // Minimum dwell not yet satisfied — forced to persist regardless of candidate. No pending
      // accumulation starts yet (§2 explicitly gates the candidate-specific confirm on min dwell
      // already being satisfied), matching T140's forced-persist behavior below min dwell.
      return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    // Min dwell satisfied and candidate differs from currentState — candidate-specific 2-candle
    // confirm (§2). currentState/dwellCandles do NOT change while pending count < 2 ("giữ state
    // hiện tại" during the wait); dwellCandles keeps counting the CURRENT state's own dwell.
    const newPendingCount = pendingCandidate === candidate ? pendingCandidateCount + 1 : 1;
    if (newPendingCount >= EXIT_CONFIRM_CANDLES) {
      if (!GOVERNED.has(candidate)) {
        // §3: 2 consecutive NORMAL-confirming candles -> exit directly to NORMAL, unchanged threshold.
        return { currentState: SafetyState5m.NORMAL, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
      }
      // §2: candidate is a DIFFERENT governed state, confirmed 2 consecutive candles -> transition
      // DIRECTLY into it, no detour through NORMAL, no extra confirmation round required.
      return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
    }
    return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: candidate, pendingCandidateCount: newPendingCount, cleanExitCount: 0, previousState };
  }

  // ---- currentState is NORMAL. Unchanged from T140: 2-candle enter-confirm into a governed state. ----
  if (!GOVERNED.has(candidate)) {
    const samePrev = currentState === candidate;
    return {
      currentState: candidate,
      stateEnteredAt: samePrev ? prev.stateEnteredAt : timestamp,
      dwellCandles: samePrev ? dwellCandles + 1 : 1,
      pendingCandidate: null,
      pendingCandidateCount: 0,
      cleanExitCount: 0,
      previousState: samePrev ? previousState : currentState,
    };
  }
  const newPendingCount = pendingCandidate === candidate ? pendingCandidateCount + 1 : 1;
  if (newPendingCount >= ENTER_CONFIRM_CANDLES) {
    return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
  }
  return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: candidate, pendingCandidateCount: newPendingCount, cleanExitCount: 0, previousState };
}
