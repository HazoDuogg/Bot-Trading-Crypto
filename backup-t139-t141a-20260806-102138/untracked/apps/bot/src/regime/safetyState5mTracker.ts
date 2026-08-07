import { SafetyState5m } from './htfSafetyTypes.js';

/**
 * TICKET-140 — stabilized SafetyState5m tracker state, per symbol (persisted the same way
 * SymbolState.htfSafetyDiagnostic is — see orchestrator/types.ts). Field names match ticket §5
 * exactly: currentState, stateEnteredAt, dwellCandles, pendingCandidate, pendingCandidateCount,
 * cleanExitCount, previousState.
 */
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

const GOVERNED = new Set<SafetyState5m>([SafetyState5m.MANIPULATED, SafetyState5m.VOLATILE_CHOP, SafetyState5m.LOW_LIQUIDITY]);
/** Ticket §3.2/3.3/3.4: enter after 2 consecutive confirming candles. */
const ENTER_CONFIRM_CANDLES = 2;
/** Ticket §3.2/3.3/3.4: minimum dwell of 3 candles once entered. */
const MIN_DWELL_CANDLES = 3;
/** Ticket §3.2/3.3/3.4: exit after 2 consecutive non-confirming candles (once min dwell satisfied). */
const EXIT_CONFIRM_CANDLES = 2;
/** Ticket §3.1: SHOCK exit needs 2 consecutive non-SHOCK candles (no min-dwell gate — SHOCK can interrupt anything). */
const SHOCK_EXIT_CONFIRM_CANDLES = 2;

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

/**
 * TICKET-140 — stabilizes SafetyState5m transitions on top of TICKET-139's raw candidate
 * classification (classifySafetyState5mCandidate() — unchanged, reused as-is). Pure function: one
 * closed 5m candle in, one new tracker state out. Only ever called on CLOSED 5m candles, never
 * looks ahead, never shares state across symbols (caller owns per-symbol persistence).
 *
 * Behavioral differences vs TICKET-139's applySafetyState5mHysteresis():
 *  1. LOW_LIQUIDITY now gets the SAME 2-in/3-dwell/2-out treatment as MANIPULATED/VOLATILE_CHOP
 *     (TICKET-139 treated it like NORMAL — instant transition, no hysteresis at all).
 *  2. SHOCK exit requires 2 consecutive non-SHOCK candidate candles (TICKET-139 exited SHOCK
 *     instantly, same candle candidate flips).
 *  3. On SHOCK exit-confirm, the resulting state is set DIRECTLY to the exit-confirming candle's
 *     candidate (§3.1 "không bắt buộc về NORMAL") — it does NOT get routed back through a governed
 *     candidate's own 2-candle enter-confirm the way a normal MANIPULATED/VOLATILE_CHOP/LOW_LIQUIDITY
 *     exit does. Interpretation: the 2 SHOCK-exit-confirm candles already spent their "confirmation
 *     budget" — re-imposing another 2-candle gate on top would mean up to 4 candles of continued
 *     SHOCK-adjacent exposure before any other safety state can register, which contradicts SHOCK
 *     being the ticket's own top-priority, fastest-reacting state. This is documented and covered by
 *     a dedicated test below (`SHOCK exit transitions directly to candidate...`).
 *
 * Exit-confirmation for MANIPULATED/VOLATILE_CHOP/LOW_LIQUIDITY is intentionally a generic "2
 * consecutive candles where candidate != currentState" counter (cleanExitCount) — NOT requiring the
 * two candles to carry the SAME candidate value as each other. This matches the ticket's literal
 * wording ("candidate != MANIPULATED trong 2 nến liên tiếp" — candidate not-equal, not "candidate
 * equals some other specific state twice"). Once that generic exit is confirmed, the destination is
 * decided by the LAST (2nd) exit-confirm candle's own candidate: if it's NORMAL, we land on NORMAL
 * directly (satisfies §3.5's "2 nến liên tiếp candidate là NORMAL" whenever both exit-confirm candles
 * happened to be NORMAL, the overwhelmingly common real case); if it's itself a governed state, it is
 * NEVER entered directly — it must pass its own fresh 2-candle enter-confirm from a NORMAL baseline
 * (§4 priority: a lower/other-priority state never overrides without its own confirmation).
 */
export function applySafetyState5mStabilization(
  candidate: SafetyState5m,
  timestamp: number,
  previous: SafetyState5mTrackerState | null,
): SafetyState5mTrackerState {
  const prev = previous ?? { ...INITIAL_SAFETY_STATE_5M_TRACKER, stateEnteredAt: timestamp };
  const { currentState, dwellCandles, pendingCandidate, pendingCandidateCount, cleanExitCount, previousState } = prev;

  // ---- §3.1 SHOCK: candidate SHOCK enters immediately, interrupting any in-progress dwell. ----
  if (candidate === SafetyState5m.SHOCK) {
    if (currentState === SafetyState5m.SHOCK) {
      return { currentState: SafetyState5m.SHOCK, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    return { currentState: SafetyState5m.SHOCK, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
  }

  // ---- currently in SHOCK, candidate no longer SHOCK: 2-candle exit confirm (§3.1). ----
  if (currentState === SafetyState5m.SHOCK) {
    const newCleanExitCount = cleanExitCount + 1;
    if (newCleanExitCount >= SHOCK_EXIT_CONFIRM_CANDLES) {
      // Exit confirmed THIS candle — land directly on this candle's own candidate, no re-confirm gate.
      return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: SafetyState5m.SHOCK };
    }
    return { currentState: SafetyState5m.SHOCK, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: newCleanExitCount, previousState };
  }

  // ---- governed states: MANIPULATED / VOLATILE_CHOP / LOW_LIQUIDITY (§3.2/3.3/3.4). ----
  if (GOVERNED.has(currentState)) {
    if (candidate === currentState) {
      return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    if (dwellCandles < MIN_DWELL_CANDLES) {
      // Minimum dwell not yet satisfied — forced to persist regardless of candidate.
      return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState };
    }
    const newCleanExitCount = cleanExitCount + 1;
    if (newCleanExitCount >= EXIT_CONFIRM_CANDLES) {
      if (GOVERNED.has(candidate)) {
        // Never enter another governed state directly off an exit — it needs its own fresh enter-confirm.
        return { currentState: SafetyState5m.NORMAL, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: candidate, pendingCandidateCount: 1, cleanExitCount: 0, previousState: currentState };
      }
      return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
    }
    return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: newCleanExitCount, previousState };
  }

  // ---- currentState is NORMAL (or the direct-landing baseline). ----
  if (!GOVERNED.has(candidate)) {
    // candidate is NORMAL — stays/confirms NORMAL directly.
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
  // candidate is governed, currentState is NORMAL — enter-confirm tracking (§3.2/3.3/3.4 "liên tiếp 2 nến").
  const newPendingCount = pendingCandidate === candidate ? pendingCandidateCount + 1 : 1;
  if (newPendingCount >= ENTER_CONFIRM_CANDLES) {
    return { currentState: candidate, stateEnteredAt: timestamp, dwellCandles: 1, pendingCandidate: null, pendingCandidateCount: 0, cleanExitCount: 0, previousState: currentState };
  }
  return { currentState, stateEnteredAt: prev.stateEnteredAt, dwellCandles: dwellCandles + 1, pendingCandidate: candidate, pendingCandidateCount: newPendingCount, cleanExitCount: 0, previousState };
}
