import { describe, expect, it } from 'vitest';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import type { RetestEntryResult } from '../entry/retestEntry.js';
import { createTradePlan, MIN_STOP_DISTANCE_ATR_MULTIPLE } from './tradePlan.js';

function setupA(direction: 'BULL' | 'BEAR', low = 95, high = 105): SetupSignal {
  return {
    setupFamily: 'A_COMPRESSION_BREAKOUT',
    direction,
    triggerIndex: 8,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: direction,
        brokeLevel: direction === 'BULL' ? high : low,
        counterTestFailed: true,
        counterTestIndex: 4,
      },
      d3: { startIndex: 0, endIndex: 7, high, low },
      d5: { bandwidthAtrRatio: 1.5, isCompressed: true },
      d2: { brokeAt: 8, level: direction === 'BULL' ? high : low },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

function filled(atIndex: number, fillPrice: number): RetestEntryResult {
  return { status: 'FILLED', atIndex, fillPrice };
}

describe('createTradePlan', () => {
  it('uses an explicit take-profit R multiple while preserving the 2R default', () => {
    const input = {
      signal: setupA('BULL'),
      entry: { status: 'FILLED' as const, atIndex: 9, fillPrice: 106 },
      closedCandles: [],
      tickSize: 1,
      lotSize: 1,
      riskBudgetUsd: 120,
      leverage: 10,
      frozenAtrAtTrigger: 10,
    };

    expect(createTradePlan({ ...input, takeProfitRMultiple: 1.5 })?.takeProfit).toBe(124);
    expect(createTradePlan(input)?.takeProfit).toBe(130);
  });

  it.each([
    ['BULL' as const, 106, 94, 130],
    ['BEAR' as const, 94, 106, 70],
  ])('uses the opposite D3 boundary for Setup A %s', (direction, entryPrice, stopLoss, takeProfit) => {
    const result = createTradePlan({
      signal: setupA(direction),
      entry: filled(9, entryPrice),
      closedCandles: [],
      tickSize: 1,
      lotSize: 0.1,
      riskBudgetUsd: 120,
      leverage: 20,
      frozenAtrAtTrigger: 10,
    });

    expect(result).toMatchObject({ direction, entryPrice, stopLoss, takeProfit, riskPerUnit: 12 });
    expect(result.positionSize).toBe(10);
    expect(result.requiredMargin).toBeCloseTo((10 * entryPrice) / 20);
  });

  it('recalculates risk from the outward tick-rounded stop and rounds size down by lot', () => {
    const result = createTradePlan({
      signal: setupA('BULL', 95.13, 99),
      entry: filled(9, 100.1),
      closedCandles: [],
      tickSize: 0.1,
      lotSize: 0.1,
      riskBudgetUsd: 10.3,
      leverage: 20,
      frozenAtrAtTrigger: 4,
    });

    expect(result.stopLoss).toBe(95);
    expect(result.riskPerUnit).toBeCloseTo(5.1);
    expect(result.takeProfit).toBeCloseTo(110.3);
    expect(result.positionSize).toBe(2);
    expect(result.positionSize * result.riskPerUnit).toBeLessThanOrEqual(10.3);
  });

  it('caps rounded position size so required margin does not exceed optional available capital', () => {
    const result = createTradePlan({
      signal: setupA('BULL', 180, 199),
      entry: filled(9, 200),
      closedCandles: [],
      tickSize: 1,
      lotSize: 0.5,
      riskBudgetUsd: 1_000,
      leverage: 10,
      availableCapitalUsd: 100,
      frozenAtrAtTrigger: 10,
    });

    expect(result.positionSize).toBe(5);
    expect(result.requiredMargin).toBe(100);
  });

  it('rejects an entry result that is not FILLED', () => {
    expect(() =>
      createTradePlan({
        signal: setupA('BULL'),
        entry: { status: 'EXPIRED', atIndex: 16 },
        closedCandles: [],
        tickSize: 1,
        lotSize: 0.1,
        riskBudgetUsd: 100,
        leverage: 20,
        frozenAtrAtTrigger: 10,
      }),
    ).toThrow('Trade plan requires a FILLED retest entry');
  });

  it('returns null when the rounded stop distance is below 1.2 ATR', () => {
    expect(
      createTradePlan({
        signal: setupA('BULL', 99.8, 105),
        entry: filled(9, 100),
        closedCandles: [],
        tickSize: 0.1,
        lotSize: 0.1,
        riskBudgetUsd: 100,
        leverage: 20,
        frozenAtrAtTrigger: 2,
      }),
    ).toBeNull();
  });

  it('creates a plan when the rounded stop distance is above 1.2 ATR', () => {
    expect(
      createTradePlan({
        signal: setupA('BULL', 97, 105),
        entry: filled(9, 100),
        closedCandles: [],
        tickSize: 0.1,
        lotSize: 0.1,
        riskBudgetUsd: 100,
        leverage: 20,
        frozenAtrAtTrigger: 2,
      }),
    ).not.toBeNull();
  });

  it('accepts the exact 1.2 ATR boundary', () => {
    const result = createTradePlan({
      signal: setupA('BULL', 97.7, 105),
      entry: filled(9, 100),
      closedCandles: [],
      tickSize: 0.1,
      lotSize: 0.1,
      riskBudgetUsd: 100,
      leverage: 20,
      frozenAtrAtTrigger: 2,
    });

    expect(MIN_STOP_DISTANCE_ATR_MULTIPLE).toBe(1.2);
    expect(result?.riskPerUnit).toBeCloseTo(2.4);
  });
});
