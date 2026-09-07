import type { Candle } from './noTradeZone/types.js';
import type { TradePlan } from '../../core/risk/tradePlan.js';

// Binance USDⓈ-M VIP0 USDT maker/taker rates after the 10% BNB fee discount (TICKET-033).
// Per technical spec V2; base VIP0 rates 0.0005/0.0002 x 0.9 discount, checked 2026-09-01.
export const BINANCE_USDM_VIP0_BNB_DISCOUNT_TAKER_FEE_RATE = 0.00045;
export const BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE = 0.00018;

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
  const entryFeeRate = input.entryFeeRate ?? BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE;
  const exitFeeRate =
    input.exitFeeRate ??
    (input.exitReason === 'TAKE_PROFIT'
      ? BINANCE_USDM_VIP0_BNB_DISCOUNT_MAKER_FEE_RATE
      : BINANCE_USDM_VIP0_BNB_DISCOUNT_TAKER_FEE_RATE);
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
  const feeUsd = entryNotionalUsd * entryFeeRate + exitNotionalUsd * exitFeeRate;

  const spreadUsd =
    (candleRange(input.entryM1Candle, 'entryM1Candle') +
      candleRange(input.exitM1Candle, 'exitM1Candle')) *
    SPREAD_PROXY_M1_RANGE_FRACTION *
    input.tradePlan.positionSize;
  // Entry is always a resting limit order (fills at the quoted price, no slippage) and a
  // TAKE_PROFIT exit is also a resting limit order — neither leg can slip. Only a STOP_LOSS
  // exit is a market/taker order sent to flatten the position, so adverse slippage applies
  // solely to that leg's notional, per the confirmed execution mechanics (TICKET-027).
  const slippageUsd = input.exitReason === 'STOP_LOSS' ? exitNotionalUsd * slippageRate : 0;

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

// TICKET-04X-S: a held perpetual-futures position pays/receives funding at each funding timestamp
// (00:00/08:00/16:00 UTC) it is open across — separate from the fee/spread/slippage costs above,
// which are one-time execution costs at entry/exit only.
export interface FundingRateEvent {
  fundingTime: number;
  fundingRate: number;
  markPrice: number;
}

export interface FundingCostInput {
  direction: 'BULL' | 'BEAR';
  positionSize: number;
  entryFillTime: number;
  exitTime: number;
  fundingEvents: readonly FundingRateEvent[];
}

export interface FundingCostResult {
  // Positive = net cost paid by the position over its lifetime; negative = net credit received.
  fundingUsd: number;
  eventsApplied: number;
}

// Binance convention: a positive fundingRate means longs pay shorts (and vice versa for
// negative), each event settled against the position's notional at that event's own markPrice —
// not the trade's entry/exit price, since funding is computed off mark price at the funding
// instant regardless of where the position's own entry/exit sit.
export function calculateFundingCost(input: FundingCostInput): FundingCostResult {
  requireNonNegativeFinite(input.positionSize, 'positionSize');
  if (!Number.isFinite(input.entryFillTime) || !Number.isFinite(input.exitTime) || input.exitTime < input.entryFillTime) {
    throw new Error('entryFillTime and exitTime must be finite with exitTime >= entryFillTime');
  }
  const sign = input.direction === 'BULL' ? 1 : -1;
  let fundingUsd = 0;
  let eventsApplied = 0;
  for (const event of input.fundingEvents) {
    if (event.fundingTime < input.entryFillTime || event.fundingTime > input.exitTime) continue;
    fundingUsd += sign * input.positionSize * event.markPrice * event.fundingRate;
    eventsApplied += 1;
  }
  return { fundingUsd, eventsApplied };
}
