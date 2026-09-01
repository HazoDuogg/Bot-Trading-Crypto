import { createHash } from 'node:crypto';
import {
  D3_BASE_V1_IMPULSE_RANGE_MULTIPLIER,
  D3_BASE_V1_MIN_CANDLES,
  D3_BASE_V1_REQUIRED_OVERLAP_RATIO,
} from '../structure/baseZone.js';
import {
  D2_BREAK_V1_ATR_BUFFER_MULTIPLIER,
  D2_BREAK_V1_ATR_PERIOD,
  D6_COUNTER_TEST_WINDOW,
  D6_RECLAIM_WINDOW,
} from '../structure/breakDetector.js';
import {
  D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO,
  D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO,
} from '../structure/breakoutStrength.js';
import {
  D5_COMPRESSION_V1_ATR_PERIOD,
  D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO,
  D5_COMPRESSION_V1_WINDOW,
} from '../structure/compression.js';
import { D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO } from '../structure/extension.js';
import {
  D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX,
  D4_QUALITY_V1_CHAOTIC_SWEEP_MIN,
  D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN,
  D4_QUALITY_V1_CLEAN_SWEEP_MAX,
  D4_QUALITY_V1_SWEEP_REJECTION_MIN,
  D4_QUALITY_V1_WINDOW,
} from '../structure/quality.js';
import { D1_SWING_V1_SIDE_CANDLES, D1_SWING_V1_WINDOW } from '../structure/swingPoints.js';

export interface StrategyConstantManifest {
  readonly D1: { readonly window: number; readonly sideCandles: number };
  readonly D2: { readonly atrPeriod: number; readonly atrBufferMultiplier: number };
  readonly D3: {
    readonly minCandles: number;
    readonly impulseRangeMultiplier: number;
    readonly requiredOverlapRatio: number;
  };
  readonly D4: {
    readonly window: number;
    readonly sweepRejectionMin: number;
    readonly cleanEfficiencyMin: number;
    readonly cleanSweepMax: number;
    readonly chaoticEfficiencyMax: number;
    readonly chaoticSweepMin: number;
  };
  readonly D5: {
    readonly window: number;
    readonly atrPeriod: number;
    readonly maxBandwidthAtrRatio: number;
  };
  readonly D6: { readonly counterTestWindow: number; readonly reclaimWindow: number };
  readonly D7: { readonly minBodyRatio: number; readonly minRangeAtrRatio: number };
  readonly D8: { readonly maxDistanceAtrRatio: number };
}

export const STRATEGY_CONSTANTS: StrategyConstantManifest = Object.freeze({
  D1: Object.freeze({ window: D1_SWING_V1_WINDOW, sideCandles: D1_SWING_V1_SIDE_CANDLES }),
  D2: Object.freeze({
    atrPeriod: D2_BREAK_V1_ATR_PERIOD,
    atrBufferMultiplier: D2_BREAK_V1_ATR_BUFFER_MULTIPLIER,
  }),
  D3: Object.freeze({
    minCandles: D3_BASE_V1_MIN_CANDLES,
    impulseRangeMultiplier: D3_BASE_V1_IMPULSE_RANGE_MULTIPLIER,
    requiredOverlapRatio: D3_BASE_V1_REQUIRED_OVERLAP_RATIO,
  }),
  D4: Object.freeze({
    window: D4_QUALITY_V1_WINDOW,
    sweepRejectionMin: D4_QUALITY_V1_SWEEP_REJECTION_MIN,
    cleanEfficiencyMin: D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN,
    cleanSweepMax: D4_QUALITY_V1_CLEAN_SWEEP_MAX,
    chaoticEfficiencyMax: D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX,
    chaoticSweepMin: D4_QUALITY_V1_CHAOTIC_SWEEP_MIN,
  }),
  D5: Object.freeze({
    window: D5_COMPRESSION_V1_WINDOW,
    atrPeriod: D5_COMPRESSION_V1_ATR_PERIOD,
    maxBandwidthAtrRatio: D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO,
  }),
  D6: Object.freeze({
    counterTestWindow: D6_COUNTER_TEST_WINDOW,
    reclaimWindow: D6_RECLAIM_WINDOW,
  }),
  D7: Object.freeze({
    minBodyRatio: D7_STRONG_BREAKOUT_V1_MIN_BODY_RATIO,
    minRangeAtrRatio: D7_STRONG_BREAKOUT_V1_MIN_RANGE_ATR_RATIO,
  }),
  D8: Object.freeze({ maxDistanceAtrRatio: D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO }),
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeStrategyFingerprint(constants = STRATEGY_CONSTANTS): {
  hash: string;
  constants: StrategyConstantManifest;
} {
  return {
    hash: createHash('sha256').update(stableStringify(constants)).digest('hex'),
    constants,
  };
}
