import { RegimeConfig } from './config.js';
import type { ComputedMetrics } from './types.js';
import { SafetyState5m } from './htfSafetyTypes.js';

/**
 * TICKET-139: classifies the raw SafetyState5m candidate from fast 5m inputs only (ATR percentile,
 * wick/sweep counts, volume z-score, liquidity ratio) — reuses regime/config.ts's calibrated
 * thresholds (DANGER_*, MANIPULATED_*, CHOP_ATR_PCT_THRESHOLD, LOW_LIQUIDITY_*). Deliberately does
 * NOT read adx1h: the old combined MarketRegime.VOLATILE_CHOP also gated on 1H ADX, but mixing an
 * HTF input back in here would defeat the entire point of TICKET-139 (5m safety state independent
 * of HTF context). Priority order mirrors regimeDetector.ts's classifyCandidate() style — worst
 * danger wins first: SHOCK > MANIPULATED > VOLATILE_CHOP > LOW_LIQUIDITY > NORMAL.
 */
export function classifySafetyState5mCandidate(metrics: ComputedMetrics): SafetyState5m {
  const { atrPercentile5m, volumeZScore5m, upperSweepCount5m, lowerSweepCount5m, lowLiquidityRatio } = metrics;

  if (atrPercentile5m === undefined || volumeZScore5m === undefined) {
    return SafetyState5m.NORMAL;
  }

  // 1. SHOCK — same formula as old MarketRegime.DANGER_ZONE (high ATR percentile + volume spike).
  if (
    atrPercentile5m >= RegimeConfig.DANGER_ATR_PCT_THRESHOLD.enter &&
    volumeZScore5m >= RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter
  ) {
    return SafetyState5m.SHOCK;
  }

  // 2. MANIPULATED — same formula as old MarketRegime.MANIPULATED (repeated 2-sided wick sweeps, no volume spike).
  if (
    upperSweepCount5m !== undefined &&
    lowerSweepCount5m !== undefined &&
    upperSweepCount5m >= RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE &&
    lowerSweepCount5m >= RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE &&
    volumeZScore5m < RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter
  ) {
    return SafetyState5m.MANIPULATED;
  }

  // 3. VOLATILE_CHOP — high 5m ATR percentile alone (no 1h ADX condition, see doc comment above).
  if (atrPercentile5m >= RegimeConfig.CHOP_ATR_PCT_THRESHOLD.enter) {
    return SafetyState5m.VOLATILE_CHOP;
  }

  // 4. LOW_LIQUIDITY — undefined/NaN ratio = not enough session history yet, skip (never NORMAL-by-error).
  if (
    lowLiquidityRatio !== undefined &&
    !Number.isNaN(lowLiquidityRatio) &&
    lowLiquidityRatio < RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD.enter
  ) {
    return SafetyState5m.LOW_LIQUIDITY;
  }

  return SafetyState5m.NORMAL;
}

export interface SafetyHysteresisState {
  state: SafetyState5m;
  /** Consecutive candles `state` has been held (only meaningful while state is hysteresis-governed). */
  dwellCount: number;
  pendingCandidate: SafetyState5m | null;
  pendingStreak: number;
}

const HYSTERESIS_GOVERNED = new Set<SafetyState5m>([SafetyState5m.MANIPULATED, SafetyState5m.VOLATILE_CHOP]);
/** TICKET-139 spec: enter after 2 consecutive confirming candles. */
const ENTER_CONFIRM_CANDLES = 2;
/** TICKET-139 spec: minimum dwell of 3 candles once entered, even if candidate reverts sooner. */
const MIN_DWELL_CANDLES = 3;
/** TICKET-139 spec: exit after 2 consecutive non-confirming candles. */
const EXIT_CONFIRM_CANDLES = 2;

/**
 * TICKET-139 hysteresis for SafetyState5m. SHOCK is immediate in both directions ("SHOCK/DANGER
 * nghiêm trọng được block ngay" — no confirm delay entering OR leaving, so a danger window is
 * never held stale once conditions clear, keeping SafetyState5m responsive to real danger).
 * NORMAL/LOW_LIQUIDITY transition immediately between each other — the ticket only specifies the
 * 2-in / 3-dwell / 2-out machine for MANIPULATED and VOLATILE_CHOP specifically.
 */
export function applySafetyState5mHysteresis(
  candidate: SafetyState5m,
  previous: SafetyHysteresisState | null,
): SafetyHysteresisState {
  if (candidate === SafetyState5m.SHOCK) {
    return {
      state: SafetyState5m.SHOCK,
      dwellCount: previous?.state === SafetyState5m.SHOCK ? previous.dwellCount + 1 : 1,
      pendingCandidate: null,
      pendingStreak: 0,
    };
  }

  if (previous === null) {
    if (!HYSTERESIS_GOVERNED.has(candidate)) {
      return { state: candidate, dwellCount: 1, pendingCandidate: null, pendingStreak: 0 };
    }
    // First-ever call and candidate needs enter-confirmation: start from NORMAL, same as any other enter.
    return { state: SafetyState5m.NORMAL, dwellCount: 1, pendingCandidate: candidate, pendingStreak: 1 };
  }

  const { state, dwellCount, pendingCandidate, pendingStreak } = previous;

  if (HYSTERESIS_GOVERNED.has(state)) {
    if (candidate === state) {
      return { state, dwellCount: dwellCount + 1, pendingCandidate: null, pendingStreak: 0 };
    }
    if (dwellCount < MIN_DWELL_CANDLES) {
      // Minimum dwell not yet satisfied — forced to persist regardless of candidate.
      return { state, dwellCount: dwellCount + 1, pendingCandidate: null, pendingStreak: 0 };
    }
    const newPendingStreak = pendingCandidate === candidate ? pendingStreak + 1 : 1;
    if (newPendingStreak >= EXIT_CONFIRM_CANDLES) {
      if (HYSTERESIS_GOVERNED.has(candidate)) {
        // Exiting straight into another hysteresis-governed state must restart its own enter-confirm.
        return { state: SafetyState5m.NORMAL, dwellCount: 1, pendingCandidate: candidate, pendingStreak: 1 };
      }
      return { state: candidate, dwellCount: 1, pendingCandidate: null, pendingStreak: 0 };
    }
    return { state, dwellCount: dwellCount + 1, pendingCandidate: candidate, pendingStreak: newPendingStreak };
  }

  if (!HYSTERESIS_GOVERNED.has(candidate)) {
    return { state: candidate, dwellCount: state === candidate ? dwellCount + 1 : 1, pendingCandidate: null, pendingStreak: 0 };
  }
  const newPendingStreak = pendingCandidate === candidate ? pendingStreak + 1 : 1;
  if (newPendingStreak >= ENTER_CONFIRM_CANDLES) {
    return { state: candidate, dwellCount: 1, pendingCandidate: null, pendingStreak: 0 };
  }
  return { state, dwellCount: dwellCount + 1, pendingCandidate: candidate, pendingStreak: newPendingStreak };
}
