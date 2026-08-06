import { describe, expect, it } from 'vitest';
import { applySafetyState5mHysteresis, classifySafetyState5mCandidate, type SafetyHysteresisState } from './safetyState5m.js';
import { SafetyState5m } from './htfSafetyTypes.js';
import type { ComputedMetrics } from './types.js';
import { RegimeConfig } from './config.js';

function metrics(overrides: Partial<ComputedMetrics>): ComputedMetrics {
  return {
    adx1h: 15,
    adxDirection1h: 'FLAT',
    bbWidthPercentile15m: 50,
    atrPercentile5m: 30,
    volumeZScore5m: 0,
    ...overrides,
  };
}

describe('classifySafetyState5mCandidate', () => {
  it('returns NORMAL when atrPercentile5m/volumeZScore5m undefined', () => {
    expect(classifySafetyState5mCandidate(metrics({ atrPercentile5m: undefined }))).toBe(SafetyState5m.NORMAL);
  });

  it('returns SHOCK when ATR pct + volume z-score both clear DANGER thresholds', () => {
    const m = metrics({ atrPercentile5m: RegimeConfig.DANGER_ATR_PCT_THRESHOLD.enter, volumeZScore5m: RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter });
    expect(classifySafetyState5mCandidate(m)).toBe(SafetyState5m.SHOCK);
  });

  it('returns MANIPULATED when both-side sweeps clear threshold and volume z-score stays low', () => {
    const m = metrics({
      upperSweepCount5m: RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE,
      lowerSweepCount5m: RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE,
      volumeZScore5m: RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter - 0.1,
      atrPercentile5m: 10,
    });
    expect(classifySafetyState5mCandidate(m)).toBe(SafetyState5m.MANIPULATED);
  });

  it('returns VOLATILE_CHOP when atrPercentile5m clears CHOP threshold (no MANIPULATED/SHOCK match)', () => {
    const m = metrics({ atrPercentile5m: RegimeConfig.CHOP_ATR_PCT_THRESHOLD.enter, volumeZScore5m: 0 });
    expect(classifySafetyState5mCandidate(m)).toBe(SafetyState5m.VOLATILE_CHOP);
  });

  it('VOLATILE_CHOP is not affected by adx1h (deliberately excluded — pure 5m safety signal)', () => {
    const highAdx = metrics({ atrPercentile5m: RegimeConfig.CHOP_ATR_PCT_THRESHOLD.enter, adx1h: 90 });
    const lowAdx = metrics({ atrPercentile5m: RegimeConfig.CHOP_ATR_PCT_THRESHOLD.enter, adx1h: 1 });
    expect(classifySafetyState5mCandidate(highAdx)).toBe(SafetyState5m.VOLATILE_CHOP);
    expect(classifySafetyState5mCandidate(lowAdx)).toBe(SafetyState5m.VOLATILE_CHOP);
  });

  it('returns LOW_LIQUIDITY when ratio below threshold and nothing worse matched', () => {
    const m = metrics({ lowLiquidityRatio: RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD.enter - 0.01 });
    expect(classifySafetyState5mCandidate(m)).toBe(SafetyState5m.LOW_LIQUIDITY);
  });

  it('returns NORMAL as fallback', () => {
    expect(classifySafetyState5mCandidate(metrics({}))).toBe(SafetyState5m.NORMAL);
  });
});

describe('applySafetyState5mHysteresis', () => {
  it('SHOCK enters same-candle with no delay, from null or any prior state', () => {
    expect(applySafetyState5mHysteresis(SafetyState5m.SHOCK, null).state).toBe(SafetyState5m.SHOCK);
    const prior: SafetyHysteresisState = { state: SafetyState5m.NORMAL, dwellCount: 5, pendingCandidate: null, pendingStreak: 0 };
    expect(applySafetyState5mHysteresis(SafetyState5m.SHOCK, prior).state).toBe(SafetyState5m.SHOCK);
  });

  it('SHOCK exits immediately once candidate is no longer SHOCK', () => {
    const inShock: SafetyHysteresisState = { state: SafetyState5m.SHOCK, dwellCount: 1, pendingCandidate: null, pendingStreak: 0 };
    const result = applySafetyState5mHysteresis(SafetyState5m.NORMAL, inShock);
    expect(result.state).toBe(SafetyState5m.NORMAL);
  });

  it('NORMAL/LOW_LIQUIDITY transition instantly between each other (no hysteresis)', () => {
    const normal: SafetyHysteresisState = { state: SafetyState5m.NORMAL, dwellCount: 3, pendingCandidate: null, pendingStreak: 0 };
    const result = applySafetyState5mHysteresis(SafetyState5m.LOW_LIQUIDITY, normal);
    expect(result.state).toBe(SafetyState5m.LOW_LIQUIDITY);
  });

  it('a 1-candle blip into MANIPULATED does not enter (needs 2 consecutive candles)', () => {
    let state: SafetyHysteresisState | null = null;
    state = applySafetyState5mHysteresis(SafetyState5m.MANIPULATED, state);
    expect(state.state).toBe(SafetyState5m.NORMAL); // still pending, 1st confirming candle
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // reverts before 2nd confirm
    expect(state.state).toBe(SafetyState5m.NORMAL);
  });

  it('enters MANIPULATED on exactly the 2nd consecutive confirming candle', () => {
    let state: SafetyHysteresisState | null = null;
    state = applySafetyState5mHysteresis(SafetyState5m.MANIPULATED, state);
    expect(state.state).toBe(SafetyState5m.NORMAL);
    state = applySafetyState5mHysteresis(SafetyState5m.MANIPULATED, state);
    expect(state.state).toBe(SafetyState5m.MANIPULATED);
    expect(state.dwellCount).toBe(1);
  });

  it('minimum dwell of 3 candles forces MANIPULATED to persist even if candidate reverts to NORMAL right after entering', () => {
    let state: SafetyHysteresisState | null = null;
    state = applySafetyState5mHysteresis(SafetyState5m.MANIPULATED, state);
    state = applySafetyState5mHysteresis(SafetyState5m.MANIPULATED, state); // confirmed entered, dwellCount=1
    expect(state.state).toBe(SafetyState5m.MANIPULATED);
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // dwellCount=2, forced to persist
    expect(state.state).toBe(SafetyState5m.MANIPULATED);
    expect(state.dwellCount).toBe(2);
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // dwellCount=3, min dwell now satisfied — starts exit tracking
    expect(state.state).toBe(SafetyState5m.MANIPULATED);
    expect(state.dwellCount).toBe(3);
  });

  it('exits MANIPULATED after 2 consecutive non-confirming candles once min dwell satisfied', () => {
    let state: SafetyHysteresisState = { state: SafetyState5m.MANIPULATED, dwellCount: 3, pendingCandidate: null, pendingStreak: 0 };
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // 1st non-confirming candle
    expect(state.state).toBe(SafetyState5m.MANIPULATED);
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // 2nd non-confirming candle -> exit
    expect(state.state).toBe(SafetyState5m.NORMAL);
  });

  it('same MANIPULATED/VOLATILE_CHOP enter/dwell/exit rules apply to VOLATILE_CHOP', () => {
    let state: SafetyHysteresisState | null = null;
    state = applySafetyState5mHysteresis(SafetyState5m.VOLATILE_CHOP, state); // 1st confirm (pending)
    expect(state.state).toBe(SafetyState5m.NORMAL);
    state = applySafetyState5mHysteresis(SafetyState5m.VOLATILE_CHOP, state); // 2nd confirm -> entered
    expect(state.state).toBe(SafetyState5m.VOLATILE_CHOP);
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // dwellCount 1<3, forced -> dwell=2
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // dwellCount 2<3, forced -> dwell=3
    expect(state.state).toBe(SafetyState5m.VOLATILE_CHOP); // min dwell not yet satisfied
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // dwell=3 satisfied, 1st exit-confirm candle
    expect(state.state).toBe(SafetyState5m.VOLATILE_CHOP);
    state = applySafetyState5mHysteresis(SafetyState5m.NORMAL, state); // 2nd exit-confirm candle -> exits
    expect(state.state).toBe(SafetyState5m.NORMAL);
  });
});
