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
  it('walks phase A -> B -> C -> TP2 exit with no ambiguity', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [
        m1(1, 105, 108, 107), // reaches 0.75R (107.5) trigger -> phase B
        m1(2, 108, 111, 110), // reaches TP1 (110) -> 50% closed, phase C
        m1(3, 115, 121, 120), // reaches TP2 (120) -> remaining 50% closed
      ],
    });

    expect(result).toEqual({
      outcome: 'TAKE_PROFIT_2',
      exitLegs: [
        { reason: 'PARTIAL_EXIT', fraction: 0.5, exitPrice: 110, exitTimestamp: 120_000 },
        { reason: 'TAKE_PROFIT_2', fraction: 0.5, exitPrice: 120, exitTimestamp: 180_000 },
      ],
      grossR: 1.5,
      partialExitTriggered: true,
      m1CandlesConsumed: 3,
    });
  });

  it('keeps the phase A baseline (original stop) when price never reaches the breakeven trigger', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan('BEAR'),
      entryFillTimestamp: 0,
      m1Candles: [m1(1, 108, 111, 109)],
    });

    expect(result).toEqual({
      outcome: 'INITIAL_STOP',
      exitLegs: [{ reason: 'INITIAL_STOP', fraction: 1, exitPrice: 110, exitTimestamp: 60_000 }],
      grossR: -1,
      partialExitTriggered: false,
      m1CandlesConsumed: 1,
    });
  });

  it('forces a phase-A loss at the original stop when SL and TP1 collide in one candle', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [m1(1, 89, 111, 100)],
    });

    expect(result).toEqual({
      outcome: 'INITIAL_STOP',
      exitLegs: [
        {
          reason: 'INITIAL_STOP',
          fraction: 1,
          exitPrice: 90,
          exitTimestamp: 60_000,
          reasonCode: 'AMBIGUOUS_FORCED_LOSS',
        },
      ],
      grossR: -1,
      partialExitTriggered: false,
      m1CandlesConsumed: 1,
    });
  });

  it('prefers the original stop (no breakeven upgrade) when SL and the 0.75R trigger collide in one candle', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      // Touches both stopLoss (90) and the 0.75R breakeven trigger (107.5) in one wide candle,
      // without touching TP1 (110) — rule 2: SL wins, no breakeven upgrade, and not "ambiguous".
      m1Candles: [m1(1, 89, 108, 100)],
    });

    expect(result).toEqual({
      outcome: 'INITIAL_STOP',
      exitLegs: [{ reason: 'INITIAL_STOP', fraction: 1, exitPrice: 90, exitTimestamp: 60_000 }],
      grossR: -1,
      partialExitTriggered: false,
      m1CandlesConsumed: 1,
    });
  });

  it('forces a phase-B loss at the breakeven stop when it collides with TP1 in one candle', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [
        m1(1, 106, 108, 107), // reaches 0.75R trigger only -> phase B
        m1(2, 99, 111, 105), // breakeven stop (100.5) and TP1 (110) collide
      ],
    });

    expect(result).toEqual({
      outcome: 'BREAKEVEN_STOP',
      exitLegs: [
        {
          reason: 'BREAKEVEN_STOP',
          fraction: 1,
          exitPrice: 100.5,
          exitTimestamp: 120_000,
          reasonCode: 'AMBIGUOUS_FORCED_LOSS',
        },
      ],
      grossR: 0.05,
      partialExitTriggered: false,
      m1CandlesConsumed: 2,
    });
  });

  it('force-loses only the runner leg in phase C, keeping the TP1 leg a real win', () => {
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [
        m1(1, 95, 111, 110), // jumps straight through TP1 (110) -> 50% closed, phase C
        m1(2, 99, 121, 110), // runner stop (100.5) and TP2 (120) collide
      ],
    });

    expect(result).toEqual({
      outcome: 'BREAKEVEN_STOP',
      exitLegs: [
        { reason: 'PARTIAL_EXIT', fraction: 0.5, exitPrice: 110, exitTimestamp: 60_000 },
        {
          reason: 'BREAKEVEN_STOP',
          fraction: 0.5,
          exitPrice: 100.5,
          exitTimestamp: 120_000,
          reasonCode: 'AMBIGUOUS_FORCED_LOSS',
        },
      ],
      grossR: 0.525,
      partialExitTriggered: true,
      m1CandlesConsumed: 2,
    });
  });

  it('closes the runner on a trailing stop that arrives before TP2', () => {
    const warmup = Array.from({ length: 15 }, (_, index) => m1(index + 1, 99, 101, 100));
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: [...warmup, m1(16, 100, 116, 115), m1(17, 108, 112, 110)],
    });

    expect(result).toMatchObject({
      outcome: 'TRAILING_STOP',
      exitLegs: [
        { reason: 'PARTIAL_EXIT', fraction: 0.5, exitPrice: 110, exitTimestamp: 960_000 },
        { reason: 'TRAILING_STOP', fraction: 0.5, exitTimestamp: 1_020_000 },
      ],
      partialExitTriggered: true,
      m1CandlesConsumed: 17,
    });
    expect(result.exitLegs[1].exitPrice).toBeGreaterThan(100.5);
    expect(result.exitLegs[1].exitPrice).toBeLessThan(120);
  });

  it('force-closes every remaining unit after three days instead of dropping the trade', () => {
    const candles = Array.from({ length: 4_320 }, (_, index) => m1(index + 1, 99, 106, 105));
    const result = simulatePositionManagementV2({
      tradePlan: plan(),
      entryFillTimestamp: 0,
      m1Candles: candles,
    });

    expect(result).toMatchObject({
      outcome: 'FORCED_CLOSE_TIMEOUT',
      exitLegs: [{ reason: 'FORCED_CLOSE_TIMEOUT', fraction: 1, exitPrice: 105, exitTimestamp: 259_200_000 }],
      grossR: 0.5,
      partialExitTriggered: false,
      m1CandlesConsumed: 4_320,
    });
  });

  it('rejects an invalid entry fill timestamp before reading candles', () => {
    expect(() =>
      simulatePositionManagementV2({
        tradePlan: plan(),
        entryFillTimestamp: -1,
        m1Candles: [],
      }),
    ).toThrow('entryFillTimestamp');
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
      }).outcome,
    ).toBe('INITIAL_STOP');
  });
});
