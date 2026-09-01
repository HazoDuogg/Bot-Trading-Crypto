import type { RetestEntryResult } from '../entry/retestEntry.js';
import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';

export interface TradePlanInput {
  signal: SetupSignal;
  entry: RetestEntryResult;
  closedCandles: readonly Candle[];
  tickSize: number;
  lotSize: number;
  riskBudgetUsd: number;
  leverage: number;
  frozenAtrAtTrigger: number;
  takeProfitRMultiple?: number;
  availableCapitalUsd?: number;
}

// Class C engineering safeguard; 0.3 ATR is a convention below typical one-candle range/ATR.
export const MIN_STOP_DISTANCE_ATR_MULTIPLE = 0.3;

export interface TradePlan {
  direction: 'BULL' | 'BEAR';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskPerUnit: number;
  positionSize: number;
  requiredMargin: number;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent);
}

function normalizeToStep(value: number, step: number): number {
  return Number(value.toFixed(Math.min(12, decimalPlaces(step))));
}

function floorToStep(value: number, step: number): number {
  return normalizeToStep(Math.floor(value / step + 1e-10) * step, step);
}

function ceilToStep(value: number, step: number): number {
  return normalizeToStep(Math.ceil(value / step - 1e-10) * step, step);
}

function nearestToStep(value: number, step: number): number {
  return normalizeToStep(Math.round(value / step) * step, step);
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and greater than zero`);
  }
}

function setupBExtreme(input: TradePlanInput): number {
  const counterTestIndex = input.signal.reasonTrace.dominance.counterTestIndex;
  if (counterTestIndex === null || !Number.isSafeInteger(counterTestIndex) || counterTestIndex < 0) {
    throw new Error('Setup B requires a valid counterTestIndex');
  }
  if (input.entry.atIndex < counterTestIndex || input.entry.atIndex >= input.closedCandles.length) {
    throw new Error('Setup B candle range must contain counter-test through entry fill');
  }

  let extreme = input.signal.direction === 'BULL' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let index = counterTestIndex; index <= input.entry.atIndex; index += 1) {
    const current = input.closedCandles[index];
    extreme =
      input.signal.direction === 'BULL'
        ? Math.min(extreme, current.low)
        : Math.max(extreme, current.high);
  }
  return extreme;
}

// Structural-invalidation SL and baseline 2R TP are source-backed; alternate TP multiples are Class D experiments.
export function createTradePlan(input: TradePlanInput): TradePlan | null {
  if (input.entry.status !== 'FILLED' || input.entry.fillPrice === undefined) {
    throw new Error('Trade plan requires a FILLED retest entry');
  }
  requirePositiveFinite(input.entry.fillPrice, 'entry.fillPrice');
  if (!Number.isSafeInteger(input.entry.atIndex) || input.entry.atIndex <= input.signal.triggerIndex) {
    throw new Error('entry.atIndex must be after signal.triggerIndex');
  }
  requirePositiveFinite(input.tickSize, 'tickSize');
  requirePositiveFinite(input.lotSize, 'lotSize');
  requirePositiveFinite(input.riskBudgetUsd, 'riskBudgetUsd');
  requirePositiveFinite(input.leverage, 'leverage');
  requirePositiveFinite(input.frozenAtrAtTrigger, 'frozenAtrAtTrigger');
  const takeProfitRMultiple = input.takeProfitRMultiple ?? 2;
  requirePositiveFinite(takeProfitRMultiple, 'takeProfitRMultiple');
  if (input.availableCapitalUsd !== undefined) {
    requirePositiveFinite(input.availableCapitalUsd, 'availableCapitalUsd');
  }

  const entryPrice = nearestToStep(input.entry.fillPrice, input.tickSize);
  if (Math.abs(entryPrice - input.entry.fillPrice) > input.tickSize * 1e-8) {
    throw new Error('entry.fillPrice must align with tickSize');
  }

  let invalidationBoundary: number;
  if (input.signal.setupFamily === 'A_COMPRESSION_BREAKOUT') {
    const baseZone = input.signal.reasonTrace.d3;
    if (baseZone === undefined) throw new Error('Setup A requires D3 base-zone evidence');
    invalidationBoundary = input.signal.direction === 'BULL' ? baseZone.low : baseZone.high;
  } else {
    invalidationBoundary = setupBExtreme(input);
  }
  if (!Number.isFinite(invalidationBoundary)) {
    throw new Error('Structural invalidation boundary must be finite');
  }

  const rawStop =
    input.signal.direction === 'BULL'
      ? invalidationBoundary - input.tickSize
      : invalidationBoundary + input.tickSize;
  const stopLoss =
    input.signal.direction === 'BULL'
      ? floorToStep(rawStop, input.tickSize)
      : ceilToStep(rawStop, input.tickSize);
  if (
    (input.signal.direction === 'BULL' && stopLoss >= entryPrice) ||
    (input.signal.direction === 'BEAR' && stopLoss <= entryPrice)
  ) {
    throw new Error('Structural stop must be on the loss side of entry');
  }

  const riskPerUnit = normalizeToStep(Math.abs(entryPrice - stopLoss), input.tickSize);
  if (riskPerUnit < input.frozenAtrAtTrigger * MIN_STOP_DISTANCE_ATR_MULTIPLE) return null;
  const rawTakeProfit =
    input.signal.direction === 'BULL'
      ? entryPrice + takeProfitRMultiple * riskPerUnit
      : entryPrice - takeProfitRMultiple * riskPerUnit;
  const takeProfit = nearestToStep(rawTakeProfit, input.tickSize);

  const riskSizedPosition = floorToStep(input.riskBudgetUsd / riskPerUnit, input.lotSize);
  let positionSize = riskSizedPosition;
  if (input.availableCapitalUsd !== undefined) {
    const marginSizedPosition = floorToStep(
      (input.availableCapitalUsd * input.leverage) / entryPrice,
      input.lotSize,
    );
    positionSize = Math.min(positionSize, marginSizedPosition);
  }
  if (positionSize <= 0) throw new Error('Position size rounds below one lot');

  return {
    direction: input.signal.direction,
    entryPrice,
    stopLoss,
    takeProfit,
    riskPerUnit,
    positionSize,
    requiredMargin: (positionSize * entryPrice) / input.leverage,
  };
}
