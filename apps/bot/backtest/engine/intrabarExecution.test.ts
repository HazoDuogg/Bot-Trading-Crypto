import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';
import {
  M15_CANDLE_DURATION_MS,
  mapM15ClosedCandleToExecutionStart,
  simulateIntrabarExecution,
} from './intrabarExecution.js';

function candle(openTime: number, low: number, high: number): Candle {
  return { openTime, open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 1 };
}

function plan(direction: 'BULL' | 'BEAR' = 'BULL'): TradePlan {
  return {
    direction,
    entryPrice: 100,
    stopLoss: direction === 'BULL' ? 90 : 110,
    takeProfit: direction === 'BULL' ? 120 : 80,
    riskPerUnit: 10,
    positionSize: 1,
    requiredMargin: 5,
  };
}

describe('simulateIntrabarExecution', () => {
  it('ignores pre-fill M1 candles and returns the first clear WIN', () => {
    const result = simulateIntrabarExecution({
      tradePlan: plan(),
      entryFillTimestamp: 120_000,
      m1Candles: [
        candle(60_000, 80, 130),
        candle(120_000, 80, 130),
        candle(180_000, 95, 110),
        candle(240_000, 99, 121),
        candle(300_000, 80, 130),
      ],
    });

    expect(result).toEqual({
      outcome: 'WIN',
      exitTimestamp: 240_000,
      exitPrice: 120,
      m1CandlesConsumed: 2,
    });
  });

  it('returns the first clear LOSS and does not read later candles', () => {
    const candles = [candle(60_000, 95, 105), candle(120_000, 89, 105), candle(180_000, 80, 130)];
    const guarded = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === '2') throw new Error('read after terminal outcome');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      simulateIntrabarExecution({
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: guarded,
      }),
    ).toEqual({ outcome: 'LOSS', exitTimestamp: 120_000, exitPrice: 90, m1CandlesConsumed: 2 });
  });

  it('keeps both scenarios when SL and TP occur in the same M1 candle', () => {
    expect(
      simulateIntrabarExecution({
        tradePlan: plan('BEAR'),
        entryFillTimestamp: 0,
        m1Candles: [candle(60_000, 79, 111)],
      }),
    ).toEqual({
      outcome: 'AMBIGUOUS',
      exitTimestamp: 60_000,
      bestCase: { outcome: 'WIN', exitPrice: 80 },
      worstCase: { outcome: 'LOSS', exitPrice: 110 },
      m1CandlesConsumed: 1,
    });
  });

  it('keeps an unfinished position as OPEN', () => {
    expect(
      simulateIntrabarExecution({
        tradePlan: plan(),
        entryFillTimestamp: 0,
        m1Candles: [candle(60_000, 95, 105), candle(120_000, 94, 110)],
      }),
    ).toEqual({ outcome: 'OPEN', m1CandlesConsumed: 2 });
  });

  it('maps a closed M15 candle to the first M1 open after its UTC close without timezone conversion', () => {
    const m15OpenTime = Date.UTC(2026, 1, 28, 14, 0, 0);
    expect(mapM15ClosedCandleToExecutionStart(m15OpenTime)).toBe(
      m15OpenTime + M15_CANDLE_DURATION_MS - 1,
    );
  });
});
