import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from './tradePlan.js';
import { simulatePositionManagementV2 } from './positionManagementV2.js';

function plan(direction: 'BULL' | 'BEAR' = 'BULL'): TradePlan {
  return {
    direction,
    entryPrice: 100,
    stopLoss: direction === 'BULL' ? 90 : 110,
    takeProfit: direction === 'BULL' ? 120 : 80,
    riskPerUnit: 10,
    positionSize: 10,
    requiredMargin: 100,
  };
}

function m1(index: number, low: number, high: number, close = 100): Candle {
  return { openTime: index * 60_000, open: 100, high, low, close, volume: 10 };
}

describe('simulatePositionManagementV2', () => {
  it('takes the partial exit then closes the runner at breakeven', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [m1(1, 101, 116, 114), m1(2, 99, 102, 100)],
      partialExitRMultiple: 1.5,
      partialExitFraction: 0.5,
      breakevenBufferR: 0,
    });

    expect(result).toEqual({
      outcome: 'BREAKEVEN_STOP',
      exitLegs: [
        { reason: 'PARTIAL_EXIT', fraction: 0.5, exitPrice: 115, exitTimestamp: 60_000 },
        { reason: 'BREAKEVEN_STOP', fraction: 0.5, exitPrice: 100, exitTimestamp: 120_000 },
      ],
      grossR: 0.75,
      partialExitTriggered: true,
      m1CandlesConsumed: 2,
    });
  });

  it('advances a causal ATR trail and closes the runner without moving the stop backward', () => {
    const warmup = Array.from({ length: 15 }, (_, index) => m1(index + 1, 99, 101, 100));
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [...warmup, m1(16, 100, 116, 115), m1(17, 108, 112, 110)],
      partialExitRMultiple: 1.5,
      partialExitFraction: 0.5,
      breakevenBufferR: 0,
    });

    expect(result).toMatchObject({
      outcome: 'TRAILING_STOP',
      exitLegs: [
        { reason: 'PARTIAL_EXIT', fraction: 0.5, exitPrice: 115, exitTimestamp: 960_000 },
        { reason: 'TRAILING_STOP', fraction: 0.5, exitPrice: 109, exitTimestamp: 1_020_000 },
      ],
      grossR: 1.2,
      partialExitTriggered: true,
      m1CandlesConsumed: 17,
    });
  });

  it('keeps the baseline initial-stop behavior when price never reaches the partial target', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan('BEAR'),
      entryFillTimestamp: 0,
      m1Candles: [m1(1, 98, 111, 109)],
      partialExitRMultiple: 1.5,
      partialExitFraction: 0.7,
      breakevenBufferR: 0.1,
    });

    expect(result).toMatchObject({
      outcome: 'INITIAL_STOP',
      exitLegs: [
        { reason: 'INITIAL_STOP', fraction: 1, exitPrice: 110, exitTimestamp: 60_000 },
      ],
      grossR: -1,
      partialExitTriggered: false,
      m1CandlesConsumed: 1,
    });
  });

  it('force-closes every remaining unit after three days instead of dropping the trade', () => {
    const candles = Array.from({ length: 4_320 }, (_, index) => m1(index + 1, 99, 106, 105));
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: candles,
      partialExitRMultiple: 1.5,
      partialExitFraction: 0.7,
      breakevenBufferR: 0,
    });

    expect(result).toMatchObject({
      outcome: 'FORCED_CLOSE_TIMEOUT',
      exitLegs: [
        {
          reason: 'FORCED_CLOSE_TIMEOUT',
          fraction: 1,
          exitPrice: 105,
          exitTimestamp: 259_200_000,
        },
      ],
      grossR: 0.5,
      partialExitTriggered: false,
      m1CandlesConsumed: 4_320,
    });
  });

  it('does not invent an order when initial stop and partial target occur in one M1 candle', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [m1(1, 89, 116, 100)],
      partialExitRMultiple: 1.5,
      partialExitFraction: 0.5,
      breakevenBufferR: 0,
    });

    expect(result).toMatchObject({
      outcome: 'AMBIGUOUS',
      bestCase: { grossR: 0.75 },
      worstCase: { grossR: -1 },
      partialExitTriggered: false,
      m1CandlesConsumed: 1,
    });
  });

  it('rejects an invalid experimental configuration before reading candles', () => {
    expect(() =>
      simulatePositionManagementV2({
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: [],
        partialExitRMultiple: 0,
        partialExitFraction: 1,
        breakevenBufferR: -0.1,
      }),
    ).toThrow('partialExitRMultiple');
  });

  it('stops reading M1 data as soon as the position is closed', () => {
    const unreadFuture = {
      openTime: 120_000,
      open: 100,
      get high(): number {
        throw new Error('future candle was read');
      },
      low: 99,
      close: 100,
      volume: 10,
    } satisfies Candle;

    expect(
      simulatePositionManagementV2({
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: [m1(1, 89, 100, 90), unreadFuture],
        partialExitRMultiple: 1.5,
        partialExitFraction: 0.5,
        breakevenBufferR: 0,
      }).outcome,
    ).toBe('INITIAL_STOP');
  });
});
