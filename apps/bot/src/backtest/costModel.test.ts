import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';
import { calculateExecutionCosts } from './costModel.js';

function candle(low: number, high: number): Candle {
  return { openTime: 0, open: low, high, low, close: high, volume: 1 };
}

const plan: TradePlan = {
  direction: 'BULL',
  entryPrice: 100,
  stopLoss: 90,
  takeProfit: 120,
  riskPerUnit: 10,
  positionSize: 2,
  requiredMargin: 10,
};

describe('calculateExecutionCosts', () => {
  it('converts gross PnL, two-sided fees, half-range spread proxies, and slippage to R', () => {
    const result = calculateExecutionCosts({
      tradePlan: plan,
      exitPrice: 120,
      entryM1Candle: candle(98, 102),
      exitM1Candle: candle(117, 123),
      takerFeeRate: 0.001,
      adverseSlippageRate: 0.002,
    });

    expect(result.grossR).toBeCloseTo(2);
    expect(result.feeR).toBeCloseTo(0.022);
    expect(result.spreadR).toBeCloseTo(0.5);
    expect(result.slippageR).toBeCloseTo(0.044);
    expect(result.netR).toBeCloseTo(1.434);
  });

  it('keeps a bearish loss negative before subtracting costs', () => {
    const bearish: TradePlan = {
      ...plan,
      direction: 'BEAR',
      stopLoss: 110,
      takeProfit: 80,
    };
    const result = calculateExecutionCosts({
      tradePlan: bearish,
      exitPrice: 110,
      entryM1Candle: candle(99, 101),
      exitM1Candle: candle(109, 111),
      takerFeeRate: 0,
      adverseSlippageRate: 0,
    });

    expect(result).toEqual({ grossR: -1, feeR: 0, spreadR: 0.2, slippageR: 0, netR: -1.2 });
  });
});
