import { describe, expect, it } from 'vitest';
import { applySafetyState5mStabilization, INITIAL_SAFETY_STATE_5M_TRACKER, type SafetyState5mTrackerState } from './safetyState5mTracker.js';
import { applySafetyState5mHysteresis, type SafetyHysteresisState } from './safetyState5m.js';
import { SafetyState5m } from './htfSafetyTypes.js';

const T0 = 1_700_000_000_000;
const STEP = 5 * 60_000;
const t = (i: number) => T0 + i * STEP;

function enterManipulated(): SafetyState5mTrackerState {
  let s: SafetyState5mTrackerState | null = null;
  s = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(0), s);
  s = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(1), s);
  expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
  expect(s.dwellCandles).toBe(1);
  return s;
}

describe('applySafetyState5mStabilization', () => {
  it('restarts safely from NORMAL on cold start (null previous)', () => {
    const s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
    expect(s.previousState).toBeNull();
  });

  it('SHOCK enters immediately, interrupting an in-progress MANIPULATED dwell (min-dwell=3 not yet satisfied)', () => {
    let s = enterManipulated(); // dwellCandles=1, well under MIN_DWELL of 3
    s = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(2), s);
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    expect(s.previousState).toBe(SafetyState5m.MANIPULATED);
    expect(s.dwellCandles).toBe(1);
  });

  it('SHOCK requires 2 consecutive non-SHOCK candles to exit (unlike TICKET-139 instant exit)', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(1), s); // 1st non-SHOCK candle
    expect(s.currentState).toBe(SafetyState5m.SHOCK); // still SHOCK — exit not yet confirmed
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(2), s); // 2nd non-SHOCK candle
    expect(s.currentState).toBe(SafetyState5m.NORMAL); // now confirmed exited
  });

  it('a single SHOCK candle mid-exit-confirm resets the exit clock back to 0', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(0), null);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(1), s); // 1st non-SHOCK
    s = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(2), s); // SHOCK again — resets
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    expect(s.cleanExitCount).toBe(0);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(3), s); // 1st non-SHOCK (again)
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
  });

  it('SHOCK exit transitions directly to the exit-confirming candle\'s own candidate, not forced to NORMAL', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(0), null);
    s = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(1), s); // 1st non-SHOCK candle, candidate=MANIPULATED
    s = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(2), s); // 2nd non-SHOCK candle, candidate=MANIPULATED -> exit confirmed
    // Lands DIRECTLY on MANIPULATED here (not routed back through NORMAL + its own fresh 2-candle enter-confirm).
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    expect(s.previousState).toBe(SafetyState5m.SHOCK);
    expect(s.dwellCandles).toBe(1);
  });

  it('SHOCK exit lands on NORMAL when the exit-confirming candle\'s candidate is NORMAL', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(0), null);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(1), s);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(2), s);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  it('LOW_LIQUIDITY now gets the same 2-in/3-dwell/2-out treatment as MANIPULATED (would FAIL against TICKET-139\'s instant-transition logic)', () => {
    // A single 1-candle LOW_LIQUIDITY blip must NOT enter under stabilization (needs 2 consecutive candles).
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.LOW_LIQUIDITY, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.NORMAL); // still pending — 1st confirming candle only

    // Prove the divergence from TICKET-139 directly: applySafetyState5mHysteresis() DOES enter instantly.
    const legacy: SafetyHysteresisState = applySafetyState5mHysteresis(SafetyState5m.LOW_LIQUIDITY, null);
    expect(legacy.state).toBe(SafetyState5m.LOW_LIQUIDITY); // TICKET-139 old behavior: instant transition

    s = applySafetyState5mStabilization(SafetyState5m.LOW_LIQUIDITY, t(1), s); // 2nd confirming candle -> entered
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.dwellCandles).toBe(1);

    // Minimum dwell of 3 forces it to persist even if candidate reverts immediately.
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(2), s);
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.dwellCandles).toBe(2);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(3), s);
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.dwellCandles).toBe(3);
    // Now min dwell satisfied — 2 consecutive non-LOW_LIQUIDITY candles required to exit.
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(4), s); // 1st exit-confirm
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(5), s); // 2nd exit-confirm -> exits
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  it('priority: SHOCK candidate overrides an active governed dwell (MANIPULATED) even mid-dwell', () => {
    let s: SafetyState5mTrackerState | null = enterManipulated();
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(2), s); // dwell=2, forced persist (min dwell=3)
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    s = applySafetyState5mStabilization(SafetyState5m.SHOCK, t(3), s); // SHOCK cuts in regardless
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
  });

  it('priority: a lower-priority candidate (VOLATILE_CHOP) never overrides an active MANIPULATED dwell without its own confirm', () => {
    let s: SafetyState5mTrackerState | null = enterManipulated(); // dwell=1
    s = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(2), s); // dwell 1<3, forced persist
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    s = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(3), s); // dwell 2<3, forced persist
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    s = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(4), s); // dwell=3, min dwell satisfied, 1st exit-confirm
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    s = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(5), s); // 2nd exit-confirm -> MANIPULATED exits...
    // ...but since candidate (VOLATILE_CHOP) is itself governed, it does NOT enter directly — must pass its own fresh enter-confirm.
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
    expect(s.pendingCandidate).toBe(SafetyState5m.VOLATILE_CHOP);
    expect(s.pendingCandidateCount).toBe(1);
    s = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(6), s); // 2nd confirming candle for VOLATILE_CHOP itself
    expect(s.currentState).toBe(SafetyState5m.VOLATILE_CHOP);
  });

  it('a 1-candle blip into MANIPULATED does not enter (needs 2 consecutive candles), same as TICKET-139', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
    s = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(1), s);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  it('INITIAL_SAFETY_STATE_5M_TRACKER is NORMAL with zeroed counters', () => {
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.currentState).toBe(SafetyState5m.NORMAL);
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.dwellCandles).toBe(0);
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.previousState).toBeNull();
  });
});
