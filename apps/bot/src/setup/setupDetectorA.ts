import type { BaseZone } from '../structure/baseZone.js';
import type { BreakResult, DominanceEvidence } from '../structure/breakDetector.js';
import { D6_RECLAIM_WINDOW } from '../structure/breakDetector.js';
import type { BreakoutStrengthResult } from '../structure/breakoutStrength.js';
import type { CompressionResult } from '../structure/compression.js';
import type { QualityComposite } from '../structure/quality.js';

export interface SetupSignal {
  setupFamily: 'A_COMPRESSION_BREAKOUT';
  direction: 'BULL' | 'BEAR';
  triggerIndex: number;
  reasonTrace: {
    quality: { label: string; efficiency: number; sweepCount: number };
    dominance: {
      side: string;
      brokeLevel: number;
      counterTestFailed: boolean;
      counterTestIndex: number | null;
    };
    d3?: { startIndex: number; endIndex: number; high: number; low: number };
    d5?: { bandwidthAtrRatio: number; isCompressed: boolean };
    d2: { brokeAt: number; level: number };
    d7: { bodyRatio: number; rangeAtrRatio: number; isStrong: true };
  };
}

export interface SetupAInput {
  baseZone: BaseZone;
  quality: QualityComposite;
  compression: CompressionResult;
  dominance: DominanceEvidence;
  breakout: BreakResult | null;
  breakoutStrength: BreakoutStrengthResult;
}

function traceDominance(dominance: DominanceEvidence): SetupSignal['reasonTrace']['dominance'] {
  return {
    side: dominance.side,
    brokeLevel: dominance.brokeLevel,
    counterTestFailed: dominance.counterTestFailed,
    counterTestIndex: dominance.counterTestIndex,
  };
}

// Setup family A — source-backed state ordering; D1-D8 evidence values remain conventions.
// TICKET-045: disabledConditions is ablation-only (always treats that D-check as satisfied);
// omitted keeps current behavior exactly.
export function detectSetupA(
  input: SetupAInput,
  disabledConditions?: ReadonlySet<string>,
): SetupSignal | null {
  if ((!disabledConditions?.has('D4') && input.quality.label !== 'CLEAN') || input.breakout === null) {
    return null;
  }
  if (!disabledConditions?.has('D7') && !input.breakoutStrength.isStrong) return null;
  if (
    input.dominance.side === 'NEUTRAL' ||
    !input.dominance.counterTestFailed ||
    input.dominance.counterTestIndex === null
  ) {
    return null;
  }
  if (!disabledConditions?.has('D5') && !input.compression.isCompressed) return null;

  const baseLength = input.baseZone.end_index - input.baseZone.start_index + 1;
  const expectedWindowStart = input.baseZone.end_index - 7;
  if (
    (!disabledConditions?.has('D3') && baseLength < 8) ||
    input.compression.windowStartIndex !== expectedWindowStart ||
    input.compression.windowEndIndex !== input.baseZone.end_index ||
    input.compression.windowStartIndex < input.baseZone.start_index
  ) {
    return null;
  }

  const direction = input.dominance.side;
  const expectedBreakDirection = direction === 'BULL' ? 'up' : 'down';
  const expectedBreakLevel = direction === 'BULL' ? input.baseZone.high : input.baseZone.low;
  const dominanceConfirmedAt = input.dominance.counterTestIndex + D6_RECLAIM_WINDOW;
  if (
    input.breakout.direction !== expectedBreakDirection ||
    input.breakout.level !== expectedBreakLevel ||
    input.breakout.brokeAt <= input.baseZone.end_index ||
    dominanceConfirmedAt > input.breakout.brokeAt
  ) {
    return null;
  }

  return {
    setupFamily: 'A_COMPRESSION_BREAKOUT',
    direction,
    triggerIndex: input.breakout.brokeAt,
    reasonTrace: {
      quality: { ...input.quality },
      dominance: traceDominance(input.dominance),
      d3: {
        startIndex: input.baseZone.start_index,
        endIndex: input.baseZone.end_index,
        high: input.baseZone.high,
        low: input.baseZone.low,
      },
      d5: {
        bandwidthAtrRatio: input.compression.bandwidthAtrRatio,
        isCompressed: input.compression.isCompressed,
      },
      d2: { brokeAt: input.breakout.brokeAt, level: input.breakout.level },
      d7: {
        bodyRatio: input.breakoutStrength.bodyRatio,
        rangeAtrRatio: input.breakoutStrength.rangeAtrRatio,
        isStrong: true,
      },
    },
  };
}
