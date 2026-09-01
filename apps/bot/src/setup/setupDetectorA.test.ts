import { describe, expect, it } from 'vitest';
import type { SetupAInput } from './setupDetectorA.js';
import { detectSetupA } from './setupDetectorA.js';

function validInput(): SetupAInput {
  return {
    baseZone: { start_index: 0, end_index: 7, high: 105, low: 95 },
    quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
    compression: {
      isCompressed: true,
      bandwidthAtrRatio: 1.5,
      windowStartIndex: 0,
      windowEndIndex: 7,
    },
    dominance: {
      side: 'BULL',
      brokeLevel: 90,
      counterTestFailed: true,
      counterTestIndex: 4,
    },
    breakout: { brokeAt: 8, direction: 'up', level: 105 },
    breakoutStrength: { isStrong: true, bodyRatio: 0.7, rangeAtrRatio: 1.2 },
  };
}

describe('detectSetupA', () => {
  it('activates compression-to-breakout and preserves every reason value', () => {
    expect(detectSetupA(validInput())).toEqual({
      setupFamily: 'A_COMPRESSION_BREAKOUT',
      direction: 'BULL',
      triggerIndex: 8,
      reasonTrace: {
        quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
        dominance: {
          side: 'BULL',
          brokeLevel: 90,
          counterTestFailed: true,
          counterTestIndex: 4,
        },
        d3: { startIndex: 0, endIndex: 7, high: 105, low: 95 },
        d5: { bandwidthAtrRatio: 1.5, isCompressed: true },
        d2: { brokeAt: 8, level: 105 },
        d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
      },
    });
  });

  it.each([
    ['quality is not CLEAN', (input: SetupAInput) => { input.quality.label = 'UNCLEAR'; }],
    ['dominance is NEUTRAL', (input: SetupAInput) => { input.dominance = { ...input.dominance, side: 'NEUTRAL', counterTestFailed: false }; }],
    ['dominance has no failed counter-test', (input: SetupAInput) => { input.dominance.counterTestFailed = false; }],
    ['D5 is not compressed', (input: SetupAInput) => { input.compression.isCompressed = false; }],
    ['D5 is not the final eight candles of D3', (input: SetupAInput) => { input.compression.windowStartIndex = 1; }],
    ['D3 has fewer than eight candles', (input: SetupAInput) => { input.baseZone.start_index = 2; }],
    ['D2 break is missing', (input: SetupAInput) => { input.breakout = null; }],
    ['D7 breakout is not strong', (input: SetupAInput) => { input.breakoutStrength.isStrong = false; }],
    ['D2 direction opposes dominance', (input: SetupAInput) => { input.breakout = { brokeAt: 8, direction: 'down', level: 95 }; }],
    ['D2 level is not the dominant base boundary', (input: SetupAInput) => { input.breakout = { brokeAt: 8, direction: 'up', level: 104 }; }],
    ['dominance is confirmed only after the breakout', (input: SetupAInput) => { input.dominance.counterTestIndex = 6; }],
  ])('does not activate when %s', (_name, mutate) => {
    const input = validInput();
    mutate(input);
    expect(detectSetupA(input)).toBeNull();
  });
});
