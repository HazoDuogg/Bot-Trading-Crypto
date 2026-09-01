import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import type { RetestEntryResult } from '../entry/retestEntry.js';
import { createTradePlan } from './tradePlan.js';

function candle(index: number, low: number, high: number): Candle {
  return { openTime: index * 900_000, open: 100, high, low, close: 100, volume: 100 };
}

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

function setupB(direction: 'BULL' | 'BEAR'): SetupSignal {
  return {
    setupFamily: 'B_BREAK_PULLBACK_FAILURE',
    direction,
    triggerIndex: 5,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: direction,
        brokeLevel: 100,
        counterTestFailed: true,
        counterTestIndex: 2,
      },
      d2: { brokeAt: 1, level: 100 },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

function filled(atIndex: number, fillPrice: number): RetestEntryResult {
  return { status: 'FILLED', atIndex, fillPrice };
}

describe('createTradePlan', () => {
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
    });

    expect(result).toMatchObject({ direction, entryPrice, stopLoss, takeProfit, riskPerUnit: 12 });
    expect(result.positionSize).toBe(10);
    expect(result.requiredMargin).toBeCloseTo((10 * entryPrice) / 20);
  });

  it.each([
    ['BULL' as const, 101, 94, 115],
    ['BEAR' as const, 99, 106, 85],
  ])('uses the counter-test-to-fill extreme for Setup B %s', (direction, entryPrice, stopLoss, takeProfit) => {
    const candles = [
      candle(0, 1, 1_000),
      candle(1, 1, 1_000),
      candle(2, 98, 102),
      candle(3, 96, 104),
      candle(4, 97, 103),
      candle(5, 95, 105),
      candle(6, 96, 104),
    ];

    const result = createTradePlan({
      signal: setupB(direction),
      entry: filled(6, entryPrice),
      closedCandles: candles,
      tickSize: 1,
      lotSize: 1,
      riskBudgetUsd: 70,
      leverage: 10,
    });

    expect(result).toMatchObject({ direction, entryPrice, stopLoss, takeProfit, riskPerUnit: 7 });
    expect(result.positionSize).toBe(10);
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
      }),
    ).toThrow('Trade plan requires a FILLED retest entry');
  });

  it('reads Setup B candles only from counter-test through fill', () => {
    const candles = [
      candle(0, 1, 1_000),
      candle(1, 1, 1_000),
      candle(2, 98, 102),
      candle(3, 96, 104),
      candle(4, 97, 103),
      candle(5, 95, 105),
      candle(6, 96, 104),
      candle(7, 1, 1_000),
    ];
    const guarded = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === '0' || property === '1') throw new Error('read before counter-test');
        if (property === '7') throw new Error('read after fill');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      createTradePlan({
        signal: setupB('BULL'),
        entry: filled(6, 101),
        closedCandles: guarded,
        tickSize: 1,
        lotSize: 1,
        riskBudgetUsd: 70,
        leverage: 10,
      }).stopLoss,
    ).toBe(94);
  });
});
