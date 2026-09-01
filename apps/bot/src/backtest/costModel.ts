import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';

// Binance USDⓈ-M Regular User USDT maker/taker rates, no BNB discount, checked 2026-09-01.
// Source: https://www.binance.com/en/fee/futureFee
export const BINANCE_USDM_REGULAR_USER_TAKER_FEE_RATE = 0.0005;
export const BINANCE_USDM_REGULAR_USER_MAKER_FEE_RATE = 0.0002;

// Conservative all-taker adverse slippage scenario: 2 bps on both entry and exit notionals.
export const DEFAULT_ADVERSE_SLIPPAGE_RATE = 0.0002;

// Temporary OHLC proxy: use 10% of each M1 range; replace with tick/order-book spread data later.
export const SPREAD_PROXY_M1_RANGE_FRACTION = 0.1;

export interface ExecutionCostInput {
  tradePlan: TradePlan;
  exitPrice: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS';
  entryM1Candle: Candle;
  exitM1Candle: Candle;
  entryFeeRate?: number;
  exitFeeRate?: number;
  adverseSlippageRate?: number;
}

export interface ExecutionCostResult {
  grossR: number;
  feeR: number;
  spreadR: number;
  slippageR: number;
  netR: number;
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
}

function candleRange(candle: Candle, name: string): number {
  if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || candle.high < candle.low) {
    throw new Error(`${name} must have finite high/low with high >= low`);
  }
  return candle.high - candle.low;
}

export function calculateExecutionCosts(input: ExecutionCostInput): ExecutionCostResult {
  const entryFeeRate = input.entryFeeRate ?? BINANCE_USDM_REGULAR_USER_MAKER_FEE_RATE;
  const exitFeeRate =
    input.exitFeeRate ??
    (input.exitReason === 'TAKE_PROFIT'
      ? BINANCE_USDM_REGULAR_USER_MAKER_FEE_RATE
      : BINANCE_USDM_REGULAR_USER_TAKER_FEE_RATE);
  const slippageRate = input.adverseSlippageRate ?? DEFAULT_ADVERSE_SLIPPAGE_RATE;
  requireNonNegativeFinite(entryFeeRate, 'entryFeeRate');
  requireNonNegativeFinite(exitFeeRate, 'exitFeeRate');
  requireNonNegativeFinite(slippageRate, 'adverseSlippageRate');
  if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0) {
    throw new Error('exitPrice must be finite and greater than zero');
  }
  if (
    !Number.isFinite(input.tradePlan.entryPrice) ||
    !Number.isFinite(input.tradePlan.riskPerUnit) ||
    !Number.isFinite(input.tradePlan.positionSize) ||
    input.tradePlan.entryPrice <= 0 ||
    input.tradePlan.riskPerUnit <= 0 ||
    input.tradePlan.positionSize <= 0
  ) {
    throw new Error('Trade plan entry, riskPerUnit, and positionSize must be positive and finite');
  }

  const riskUsd = input.tradePlan.riskPerUnit * input.tradePlan.positionSize;
  const direction = input.tradePlan.direction === 'BULL' ? 1 : -1;
  const grossPnlUsd =
    direction * (input.exitPrice - input.tradePlan.entryPrice) * input.tradePlan.positionSize;
  const entryNotionalUsd = input.tradePlan.entryPrice * input.tradePlan.positionSize;
  const exitNotionalUsd = input.exitPrice * input.tradePlan.positionSize;
  const roundTripNotionalUsd = entryNotionalUsd + exitNotionalUsd;
  const feeUsd = entryNotionalUsd * entryFeeRate + exitNotionalUsd * exitFeeRate;

  const spreadUsd =
    (candleRange(input.entryM1Candle, 'entryM1Candle') +
      candleRange(input.exitM1Candle, 'exitM1Candle')) *
    SPREAD_PROXY_M1_RANGE_FRACTION *
    input.tradePlan.positionSize;
  const slippageUsd = roundTripNotionalUsd * slippageRate;

  const grossR = grossPnlUsd / riskUsd;
  const feeR = feeUsd / riskUsd;
  const spreadR = spreadUsd / riskUsd;
  const slippageR = slippageUsd / riskUsd;
  return {
    grossR,
    feeR,
    spreadR,
    slippageR,
    netR: grossR - feeR - spreadR - slippageR,
  };
}
