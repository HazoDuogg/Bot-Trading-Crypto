import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { SetupBInput } from './setupDetectorB.js';
import { detectSetupB } from './setupDetectorB.js';

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: index * 900_000, open, high, low, close, volume: 100 };
}

function validInput(): SetupBInput {
  const history = Array.from({ length: 15 }, (_, index) => candle(index, 99, 100, 98, 99));
  return {
    closedCandles: [
      ...history,
      candle(15, 99, 101, 99, 100.3),
      ...Array.from({ length: 6 }, (_, offset) => candle(16 + offset, 100.4, 100.9, 100.1, 100.6)),
      candle(22, 100.6, 100.7, 99.9, 100.2),
      candle(23, 100.2, 100.6, 100.05, 100.4),
      candle(24, 100.4, 100.7, 100.1, 100.5),
      candle(25, 100.5, 100.8, 100.2, 100.6),
    ],
    quality: { label: 'CLEAN', efficiency: 0.18, sweepCount: 1 },
    breakout: { brokeAt: 15, direction: 'up', level: 100 },
    breakoutStrength: { isStrong: true, bodyRatio: 0.7, rangeAtrRatio: 1.2 },
  };
}

describe('detectSetupB', () => {
  it('activates only after the three-candle reclaim window and preserves reason values', () => {
    expect(detectSetupB(validInput())).toEqual({
      setupFamily: 'B_BREAK_PULLBACK_FAILURE',
      direction: 'BULL',
      triggerIndex: 25,
      reasonTrace: {
        quality: { label: 'CLEAN', efficiency: 0.18, sweepCount: 1 },
        dominance: {
          side: 'BULL',
          brokeLevel: 100,
          counterTestFailed: true,
          counterTestIndex: 22,
        },
        d2: { brokeAt: 15, level: 100 },
        d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
      },
    });
  });

  it('does not activate when quality is not CLEAN', () => {
    const input = validInput();
    input.quality.label = 'CHAOTIC';
    expect(detectSetupB(input)).toBeNull();
  });

  it('does not activate without a D2 break', () => {
    const input = validInput();
    input.breakout = null;
    expect(detectSetupB(input)).toBeNull();
  });

  it('does not activate when the D7 breakout is not strong', () => {
    const input = validInput();
    input.breakoutStrength.isStrong = false;
    expect(detectSetupB(input)).toBeNull();
  });

  it('does not activate when no counter-test occurs within 10 candles', () => {
    const input = validInput();
    input.closedCandles = [
      ...input.closedCandles.slice(0, 16),
      ...Array.from({ length: 10 }, (_, offset) => candle(16 + offset, 100.4, 101, 100.1, 100.6)),
    ];
    expect(detectSetupB(input)).toBeNull();
  });

  it('waits for the second distinct test when minimumTestOccurrence is two', () => {
    const input = validInput();
    input.closedCandles[16] = candle(16, 100.3, 100.7, 99.9, 100.4);
    input.minimumTestOccurrence = 2;

    expect(detectSetupB(input)).toMatchObject({
      triggerIndex: 25,
      reasonTrace: { dominance: { counterTestIndex: 22 } },
    });

    input.closedCandles = input.closedCandles.slice(0, 22);
    expect(detectSetupB(input)).toBeNull();
  });

  it('does not activate when the counter side successfully reclaims', () => {
    const input = validInput();
    input.closedCandles[22] = candle(22, 100.6, 100.7, 97, 99.7);
    expect(detectSetupB(input)).toBeNull();
  });

  it('does not look ahead before all three post-counter-test candles have closed', () => {
    const input = validInput();
    input.closedCandles = input.closedCandles.slice(0, 25);
    expect(detectSetupB(input)).toBeNull();
  });

  it('Class D: does not activate when confirmationCandleEnabled and the counter-test candle misses the threshold', () => {
    const input = validInput();
    input.confirmationCandleEnabled = true;
    // Unmodified fixture candle 22 (100.6/100.7/99.9/100.2): oppositeWickRatio=0.375,
    // closeBias=0.375 — both below the calibrated thresholds (~0.396 / ~0.593).
    expect(detectSetupB(input)).toBeNull();
  });

  it('Class D: activates and stamps reasonTrace.classD when confirmationCandleEnabled and the counter-test candle clears the threshold', () => {
    const input = validInput();
    input.confirmationCandleEnabled = true;
    // oppositeWickRatio = (100.5-99.5)/1.2 = 0.833, closeBias = (100.5-99.5)/1.2 = 0.833.
    input.closedCandles[22] = candle(22, 100.6, 100.7, 99.5, 100.5);

    const signal = detectSetupB(input);
    expect(signal).not.toBeNull();
    expect(signal!.reasonTrace.classD).toMatchObject({
      provenance: 'CLASS_D_EXPERIMENTAL',
      feature: 'setupBConfirmationCandle',
    });
    expect(signal!.reasonTrace.classD!.oppositeWickRatio).toBeCloseTo(1 / 1.2);
    expect(signal!.reasonTrace.classD!.closeBias).toBeCloseTo(1 / 1.2);
    expect(signal!.reasonTrace.classD!.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('ignores every candle after the setup confirmation index', () => {
    const input = validInput();
    const confirmed = detectSetupB(input);
    input.closedCandles = [
      ...input.closedCandles,
      candle(26, 100.6, 120, 70, 75),
      candle(27, 75, 130, 60, 125),
    ];

    expect(detectSetupB(input)).toEqual(confirmed);
  });
});
