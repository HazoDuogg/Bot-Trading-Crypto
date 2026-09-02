import type { Candle } from '../noTradeZone/types.js';
import { computeSetupBConfirmationCandleFingerprint } from '../orchestrator/fingerprint.js';
import {
  D6_RECLAIM_WINDOW,
  evaluateDominance,
  type BreakResult,
} from '../structure/breakDetector.js';
import type { BreakoutStrengthResult } from '../structure/breakoutStrength.js';
import type { QualityComposite } from '../structure/quality.js';
import { evaluateRejectionCandle } from '../structure/rejectionCandle.js';
import type { SetupSignal } from './setupDetectorA.js';

export interface SetupBInput {
  closedCandles: readonly Candle[];
  quality: QualityComposite;
  breakout: BreakResult | null;
  breakoutStrength: BreakoutStrengthResult;
  minimumTestOccurrence?: number;
  // Class D — EXPERIMENTAL (TICKET-028): additional single-test quality gate requiring the
  // counter-test candle itself to show rejection (opposite wick + biased close) before
  // Setup B may trigger. Default false preserves the exact current (source-backed) behavior.
  confirmationCandleEnabled?: boolean;
}

// Setup family B — source-backed break/pullback/failure ordering; D1-D8 evidence values remain conventions.
export function detectSetupB(input: SetupBInput): SetupSignal | null {
  if (input.quality.label !== 'CLEAN' || input.breakout === null) return null;
  if (!input.breakoutStrength.isStrong) return null;
  const dominance = evaluateDominance(input.closedCandles, input.breakout, {
    minimumTestOccurrence: input.minimumTestOccurrence,
  });
  const expectedSide = input.breakout.direction === 'up' ? 'BULL' : 'BEAR';
  if (
    dominance.side !== expectedSide ||
    !dominance.counterTestFailed ||
    dominance.counterTestIndex === null
  ) {
    return null;
  }

  let classD: SetupSignal['reasonTrace']['classD'];
  if (input.confirmationCandleEnabled === true) {
    const confirmationCandle = input.closedCandles[dominance.counterTestIndex];
    const rejection = evaluateRejectionCandle(confirmationCandle, expectedSide);
    if (!rejection.passes) return null;
    classD = {
      provenance: 'CLASS_D_EXPERIMENTAL',
      feature: 'setupBConfirmationCandle',
      fingerprint: computeSetupBConfirmationCandleFingerprint().hash,
      oppositeWickRatio: rejection.oppositeWickRatio,
      closeBias: rejection.closeBias,
    };
  }

  return {
    setupFamily: 'B_BREAK_PULLBACK_FAILURE',
    direction: expectedSide,
    triggerIndex: dominance.counterTestIndex + D6_RECLAIM_WINDOW,
    reasonTrace: {
      quality: { ...input.quality },
      dominance: {
        side: dominance.side,
        brokeLevel: dominance.brokeLevel,
        counterTestFailed: dominance.counterTestFailed,
        counterTestIndex: dominance.counterTestIndex,
      },
      d2: { brokeAt: input.breakout.brokeAt, level: input.breakout.level },
      d7: {
        bodyRatio: input.breakoutStrength.bodyRatio,
        rangeAtrRatio: input.breakoutStrength.rangeAtrRatio,
        isStrong: true,
      },
      ...(classD === undefined ? {} : { classD }),
    },
  };
}
