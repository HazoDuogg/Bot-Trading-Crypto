import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';
import {
  BINANCE_USDM_REGULAR_USER_MAKER_FEE_RATE,
  calculateExecutionCosts,
  SPREAD_PROXY_M1_RANGE_FRACTION,
} from './costModel.js';

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
  it('charges maker on both legs of a take-profit exit, reducing the old all-taker fee by 60%', () => {
    const result = calculateExecutionCosts({
      tradePlan: plan,
      exitPrice: 120,
      exitReason: 'TAKE_PROFIT',
      entryM1Candle: candle(100, 100),
      exitM1Candle: candle(120, 120),
      adverseSlippageRate: 0,
    });

    expect(BINANCE_USDM_REGULAR_USER_MAKER_FEE_RATE).toBe(0.0002);
    expect(result.feeR).toBeCloseTo(0.0044);
    expect(result.feeR / 0.011).toBeCloseTo(0.4);
  });

  it('charges maker entry plus taker stop exit, reducing the old all-taker fee by about 30%', () => {
    const result = calculateExecutionCosts({
      tradePlan: plan,
      exitPrice: 90,
      exitReason: 'STOP_LOSS',
      entryM1Candle: candle(100, 100),
      exitM1Candle: candle(90, 90),
      adverseSlippageRate: 0,
    });

    expect(result.feeR).toBeCloseTo(0.0065);
    expect(result.feeR / 0.0095).toBeCloseTo(0.68421, 4);
  });

  it('uses 10% of each M1 range, exactly one fifth of the former half-range proxy', () => {
    const result = calculateExecutionCosts({
      tradePlan: plan,
      exitPrice: 120,
      exitReason: 'TAKE_PROFIT',
      entryM1Candle: candle(98, 102),
      exitM1Candle: candle(117, 123),
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      adverseSlippageRate: 0.002,
    });

    expect(result.grossR).toBeCloseTo(2);
    expect(result.feeR).toBeCloseTo(0.022);
    expect(SPREAD_PROXY_M1_RANGE_FRACTION).toBe(0.1);
    expect(result.spreadR).toBeCloseTo(0.5 / 5);
    expect(result.slippageR).toBeCloseTo(0.044);
    expect(result.netR).toBeCloseTo(1.834);
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
      exitReason: 'STOP_LOSS',
      entryM1Candle: candle(99, 101),
      exitM1Candle: candle(109, 111),
      entryFeeRate: 0,
      exitFeeRate: 0,
      adverseSlippageRate: 0,
    });

    expect(result).toEqual({ grossR: -1, feeR: 0, spreadR: 0.04, slippageR: 0, netR: -1.04 });
  });
});
