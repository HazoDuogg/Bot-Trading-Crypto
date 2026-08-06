import { describe, expect, it } from 'vitest';
import { applySafetyState5mFinalStabilization, INITIAL_SAFETY_STATE_5M_TRACKER, type SafetyState5mTrackerState } from './safetyState5mTrackerV2.js';
import { applySafetyState5mStabilization } from './safetyState5mTracker.js';
import { SafetyState5m } from './htfSafetyTypes.js';

const T0 = 1_700_000_000_000;
const STEP = 5 * 60_000;
const t = (i: number) => T0 + i * STEP;

/** Runs `candidate` from a cold start until it is ENTERED (2-candle confirm from NORMAL), i dwellCandles=1. */
function enter(candidate: SafetyState5m, startIdx = 0): { s: SafetyState5mTrackerState; nextIdx: number } {
  let s: SafetyState5mTrackerState | null = null;
  s = applySafetyState5mFinalStabilization(candidate, t(startIdx), s);
  s = applySafetyState5mFinalStabilization(candidate, t(startIdx + 1), s);
  expect(s.currentState).toBe(candidate);
  expect(s.dwellCandles).toBe(1);
  return { s, nextIdx: startIdx + 2 };
}

/** Advances `s` with the SAME candidate (dwell-holding) until dwellCandles reaches minDwell. */
function advanceToMinDwell(s: SafetyState5mTrackerState, candidate: SafetyState5m, startIdx: number, minDwell: number): { s: SafetyState5mTrackerState; nextIdx: number } {
  let cur = s;
  let idx = startIdx;
  while (cur.dwellCandles < minDwell) {
    cur = applySafetyState5mFinalStabilization(candidate, t(idx), cur);
    idx++;
  }
  expect(cur.dwellCandles).toBe(minDwell);
  return { s: cur, nextIdx: idx };
}

describe('applySafetyState5mFinalStabilization', () => {
  it('restarts safely from NORMAL on cold start (null previous)', () => {
    const s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
    expect(s.previousState).toBeNull();
  });

  it('INITIAL_SAFETY_STATE_5M_TRACKER is NORMAL with zeroed counters', () => {
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.currentState).toBe(SafetyState5m.NORMAL);
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.dwellCandles).toBe(0);
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.previousState).toBeNull();
  });

  // ---- §1: min dwell MANIPULATED/VOLATILE_CHOP 3->4, LOW_LIQUIDITY stays 3. ----

  it('MANIPULATED now requires 4-candle min dwell before ANY exit is even considered (T140 with the same candle count already exits at min-dwell 3)', () => {
    let { s, nextIdx } = enter(SafetyState5m.MANIPULATED); // dwell=1
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.MANIPULATED, nextIdx, 4)); // dwell=4, still zero exit-confirm progress
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 1st exit-confirm candle
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 2nd exit-confirm candle -> exits
    expect(s.currentState).toBe(SafetyState5m.NORMAL);

    // Prove the divergence directly against T140's OWN unchanged function on an equivalent candle
    // count: T140's min dwell is 3, so it only needs 2 forced-persist candles to reach it, then 2
    // exit-confirm candles — exits after 4 total non-matching candles, one fewer than T140B's 5.
    let legacy: SafetyState5mTrackerState | null = null;
    legacy = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(0), legacy);
    legacy = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(1), legacy); // dwell=1
    legacy = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(2), legacy); // dwell=1<3, forced persist -> dwell=2
    legacy = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(3), legacy); // dwell=2<3, forced persist -> dwell=3
    legacy = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(4), legacy); // dwell=3, min dwell satisfied, 1st exit-confirm (cleanExitCount=1)
    legacy = applySafetyState5mStabilization(SafetyState5m.NORMAL, t(5), legacy); // 2nd exit-confirm (cleanExitCount=2) -> T140 exits HERE
    expect(legacy.currentState).toBe(SafetyState5m.NORMAL); // T140: already exited after only 4 non-matching candles total
  });

  it('VOLATILE_CHOP now requires 4-candle min dwell before ANY exit is considered', () => {
    let { s, nextIdx } = enter(SafetyState5m.VOLATILE_CHOP); // dwell=1
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.VOLATILE_CHOP, nextIdx, 4));
    expect(s.currentState).toBe(SafetyState5m.VOLATILE_CHOP);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 1st exit-confirm
    expect(s.currentState).toBe(SafetyState5m.VOLATILE_CHOP);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 2nd exit-confirm -> exits
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  it('LOW_LIQUIDITY still only requires 3-candle min dwell (unchanged from T140)', () => {
    let { s, nextIdx } = enter(SafetyState5m.LOW_LIQUIDITY); // dwell=1
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.LOW_LIQUIDITY, nextIdx, 3)); // dwell=3, min dwell satisfied
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 1st exit-confirm
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 2nd exit-confirm -> exits
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  // ---- §2: direct transitions between danger states. ----

  it('MANIPULATED -> VOLATILE_CHOP transitions DIRECTLY (no detour through NORMAL) after 2 consecutive VOLATILE_CHOP candidates post min-dwell — would FAIL against T140', () => {
    let { s, nextIdx } = enter(SafetyState5m.MANIPULATED);
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.MANIPULATED, nextIdx, 4));
    s = applySafetyState5mFinalStabilization(SafetyState5m.VOLATILE_CHOP, t(nextIdx), s); // 1st confirm candle
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED); // §2: "giữ state hiện tại" during the wait
    expect(s.dwellCandles).toBe(5); // dwell keeps counting the CURRENT (not-yet-exited) state
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.VOLATILE_CHOP, t(nextIdx), s); // 2nd confirm candle -> direct transition
    expect(s.currentState).toBe(SafetyState5m.VOLATILE_CHOP);
    expect(s.previousState).toBe(SafetyState5m.MANIPULATED);
    expect(s.dwellCandles).toBe(1);

    // Prove this would NOT happen under T140's old logic: it detours through NORMAL with a pending candidate instead.
    let legacy: SafetyState5mTrackerState | null = null;
    legacy = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(0), legacy);
    legacy = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(1), legacy);
    legacy = applySafetyState5mStabilization(SafetyState5m.MANIPULATED, t(2), legacy); // dwell=2
    legacy = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(3), legacy); // dwell=2<3, still forced persist -> dwell=3
    legacy = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(4), legacy); // dwell=4, cleanExitCount=1 (generic counter, not yet 2)
    legacy = applySafetyState5mStabilization(SafetyState5m.VOLATILE_CHOP, t(5), legacy); // cleanExitCount=2 -> exits to NORMAL with pendingCandidate=VOLATILE_CHOP, NOT directly to VOLATILE_CHOP
    expect(legacy.currentState).toBe(SafetyState5m.NORMAL);
    expect(legacy.pendingCandidate).toBe(SafetyState5m.VOLATILE_CHOP);
  });

  it('VOLATILE_CHOP -> LOW_LIQUIDITY transitions directly after min dwell + 2 consecutive LOW_LIQUIDITY candidates', () => {
    let { s, nextIdx } = enter(SafetyState5m.VOLATILE_CHOP);
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.VOLATILE_CHOP, nextIdx, 4));
    s = applySafetyState5mFinalStabilization(SafetyState5m.LOW_LIQUIDITY, t(nextIdx), s);
    expect(s.currentState).toBe(SafetyState5m.VOLATILE_CHOP);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.LOW_LIQUIDITY, t(nextIdx), s);
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.previousState).toBe(SafetyState5m.VOLATILE_CHOP);
    expect(s.dwellCandles).toBe(1);
  });

  it('LOW_LIQUIDITY -> MANIPULATED transitions directly after min dwell + 2 consecutive MANIPULATED candidates', () => {
    let { s, nextIdx } = enter(SafetyState5m.LOW_LIQUIDITY);
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.LOW_LIQUIDITY, nextIdx, 3));
    s = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, t(nextIdx), s);
    expect(s.currentState).toBe(SafetyState5m.LOW_LIQUIDITY);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, t(nextIdx), s);
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    expect(s.previousState).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.dwellCandles).toBe(1);
  });

  // ---- §3: exit to NORMAL still only needs 2 consecutive candles (not increased). ----

  it('exit to NORMAL still needs exactly 2 consecutive NORMAL candles after min dwell, not increased', () => {
    let { s, nextIdx } = enter(SafetyState5m.MANIPULATED);
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.MANIPULATED, nextIdx, 4));
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 1st NORMAL confirm
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(nextIdx), s); // 2nd NORMAL confirm -> exits (not 3rd)
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  // ---- hold-state-during-1-candle-wait behavior. ----

  it('holds currentState unchanged during the 1-candle wait, and a DIFFERENT candidate on the 2nd candle resets the pending confirm (no premature transition)', () => {
    let { s, nextIdx } = enter(SafetyState5m.MANIPULATED);
    ({ s, nextIdx } = advanceToMinDwell(s, SafetyState5m.MANIPULATED, nextIdx, 4));
    const dwellBefore = s.dwellCandles;
    s = applySafetyState5mFinalStabilization(SafetyState5m.VOLATILE_CHOP, t(nextIdx), s); // 1st confirm candle for VOLATILE_CHOP
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED); // unchanged during the wait
    expect(s.dwellCandles).toBe(dwellBefore + 1);
    nextIdx++;
    s = applySafetyState5mFinalStabilization(SafetyState5m.LOW_LIQUIDITY, t(nextIdx), s); // different candidate -> pending resets to 1, still holds
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    expect(s.pendingCandidate).toBe(SafetyState5m.LOW_LIQUIDITY);
    expect(s.pendingCandidateCount).toBe(1);
  });

  // ---- SHOCK: byte-identical behavior to T140 (adapted from T140's own tests). ----

  it('SHOCK enters immediately, interrupting an in-progress MANIPULATED dwell', () => {
    const { s: entered } = enter(SafetyState5m.MANIPULATED);
    const s = applySafetyState5mFinalStabilization(SafetyState5m.SHOCK, t(2), entered);
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    expect(s.previousState).toBe(SafetyState5m.MANIPULATED);
    expect(s.dwellCandles).toBe(1);
  });

  it('SHOCK requires 2 consecutive non-SHOCK candles to exit', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mFinalStabilization(SafetyState5m.SHOCK, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(1), s);
    expect(s.currentState).toBe(SafetyState5m.SHOCK);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(2), s);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });

  it('SHOCK exit transitions directly to the exit-confirming candle\'s own candidate', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mFinalStabilization(SafetyState5m.SHOCK, t(0), null);
    s = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, t(1), s);
    s = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, t(2), s);
    expect(s.currentState).toBe(SafetyState5m.MANIPULATED);
    expect(s.previousState).toBe(SafetyState5m.SHOCK);
    expect(s.dwellCandles).toBe(1);
  });

  it('a 1-candle blip into MANIPULATED does not enter (needs 2 consecutive candles), same as T140', () => {
    let s: SafetyState5mTrackerState | null = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, t(0), null);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
    s = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, t(1), s);
    expect(s.currentState).toBe(SafetyState5m.NORMAL);
  });
});
