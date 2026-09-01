import type { Candle } from '../noTradeZone/types.js';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { TradePlan } from './tradePlan.js';

// Class D experimental runner constants; they are not part of D1-D8 or the source-backed baseline.
export const POSITION_MANAGEMENT_V2_ATR_PERIOD = 14;
export const POSITION_MANAGEMENT_V2_TRAILING_ATR_MULTIPLE = 2;
export const POSITION_MANAGEMENT_V2_MAX_M1_CANDLES = 4_320;

export interface PositionExitLeg {
  reason:
    | 'PARTIAL_EXIT'
    | 'INITIAL_STOP'
    | 'BREAKEVEN_STOP'
    | 'TRAILING_STOP'
    | 'FORCED_CLOSE_TIMEOUT';
  fraction: number;
  exitPrice: number;
  exitTimestamp: number;
}

export interface PositionManagementV2Input {
  tradePlan: TradePlan;
  entryFillTimestamp: number;
  m1Candles: readonly Candle[];
  partialExitRMultiple: number;
  partialExitFraction: number;
  breakevenBufferR: number;
}

export interface PositionManagementScenario {
  exitLegs: PositionExitLeg[];
  grossR: number;
}

export interface ResolvedPositionManagementV2Result extends PositionManagementScenario {
  outcome:
    | 'INITIAL_STOP'
    | 'BREAKEVEN_STOP'
    | 'TRAILING_STOP'
    | 'FORCED_CLOSE_TIMEOUT'
    | 'OPEN_DATA_END';
  partialExitTriggered: boolean;
  m1CandlesConsumed: number;
}

export interface AmbiguousPositionManagementV2Result {
  outcome: 'AMBIGUOUS';
  bestCase: PositionManagementScenario;
  worstCase: PositionManagementScenario;
  partialExitTriggered: false;
  m1CandlesConsumed: number;
}

export type PositionManagementV2Result =
  | ResolvedPositionManagementV2Result
  | AmbiguousPositionManagementV2Result;

function directionSign(plan: TradePlan): 1 | -1 {
  return plan.direction === 'BULL' ? 1 : -1;
}

function touches(candle: Candle, price: number): boolean {
  return candle.low <= price && candle.high >= price;
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}

function validateInput(input: PositionManagementV2Input): void {
  requirePositiveFinite(input.partialExitRMultiple, 'partialExitRMultiple');
  if (
    !Number.isFinite(input.partialExitFraction) ||
    input.partialExitFraction <= 0 ||
    input.partialExitFraction >= 1
  ) {
    throw new Error('partialExitFraction must be finite and strictly between zero and one');
  }
  if (!Number.isFinite(input.breakevenBufferR) || input.breakevenBufferR < 0) {
    throw new Error('breakevenBufferR must be finite and non-negative');
  }
  if (!Number.isSafeInteger(input.entryFillTimestamp) || input.entryFillTimestamp < 0) {
    throw new Error('entryFillTimestamp must be a non-negative UTC epoch millisecond timestamp');
  }
  requirePositiveFinite(input.tradePlan.entryPrice, 'tradePlan.entryPrice');
  requirePositiveFinite(input.tradePlan.riskPerUnit, 'tradePlan.riskPerUnit');
}

function grossR(plan: TradePlan, legs: readonly PositionExitLeg[]): number {
  const sign = directionSign(plan);
  return legs.reduce(
    (sum, leg) =>
      sum + leg.fraction * sign * (leg.exitPrice - plan.entryPrice) / plan.riskPerUnit,
    0,
  );
}

// Class D experiment: partial activation and stop changes are effective from the next M1 candle.
export function simulatePositionManagementV2(
  input: PositionManagementV2Input,
): PositionManagementV2Result {
  validateInput(input);
  const { tradePlan: plan } = input;
  const sign = directionSign(plan);
  const partialPrice = plan.entryPrice + sign * input.partialExitRMultiple * plan.riskPerUnit;
  const breakevenPrice = plan.entryPrice + sign * input.breakevenBufferR * plan.riskPerUnit;
  const legs: PositionExitLeg[] = [];
  let partialExitTriggered = false;
  let runnerStop = breakevenPrice;
  let trailingActive = false;
  let consumed = 0;
  const atrTracker = createAtrTracker(POSITION_MANAGEMENT_V2_ATR_PERIOD);

  for (const current of input.m1Candles) {
    if (current.openTime <= input.entryFillTimestamp) continue;
    consumed += 1;
    const activeStop = partialExitTriggered ? runnerStop : plan.stopLoss;
    const hitStop = touches(current, activeStop);
    const hitPartial = !partialExitTriggered && touches(current, partialPrice);
    if (!partialExitTriggered && hitStop && hitPartial) {
      const bestLegs: PositionExitLeg[] = [
        {
          reason: 'PARTIAL_EXIT',
          fraction: input.partialExitFraction,
          exitPrice: partialPrice,
          exitTimestamp: current.openTime,
        },
        {
          reason: 'BREAKEVEN_STOP',
          fraction: 1 - input.partialExitFraction,
          exitPrice: breakevenPrice,
          exitTimestamp: current.openTime,
        },
      ];
      const worstLegs: PositionExitLeg[] = [
        {
          reason: 'INITIAL_STOP',
          fraction: 1,
          exitPrice: plan.stopLoss,
          exitTimestamp: current.openTime,
        },
      ];
      return {
        outcome: 'AMBIGUOUS',
        bestCase: { exitLegs: bestLegs, grossR: grossR(plan, bestLegs) },
        worstCase: { exitLegs: worstLegs, grossR: grossR(plan, worstLegs) },
        partialExitTriggered: false,
        m1CandlesConsumed: consumed,
      };
    }
    if (hitStop) {
      const reason = partialExitTriggered
        ? trailingActive
          ? 'TRAILING_STOP'
          : 'BREAKEVEN_STOP'
        : 'INITIAL_STOP';
      legs.push({
        reason,
        fraction: partialExitTriggered ? 1 - input.partialExitFraction : 1,
        exitPrice: activeStop,
        exitTimestamp: current.openTime,
      });
      return {
        outcome: reason,
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered,
        m1CandlesConsumed: consumed,
      };
    }
    if (hitPartial) {
      partialExitTriggered = true;
      legs.push({
        reason: 'PARTIAL_EXIT',
        fraction: input.partialExitFraction,
        exitPrice: partialPrice,
        exitTimestamp: current.openTime,
      });
    }

    const atr = atrTracker.next(current);
    if (partialExitTriggered && atr !== null) {
      const candidate =
        current.close - sign * POSITION_MANAGEMENT_V2_TRAILING_ATR_MULTIPLE * atr;
      const improves = sign === 1 ? candidate > runnerStop : candidate < runnerStop;
      if (improves) {
        runnerStop = candidate;
        trailingActive = true;
      }
    }
    if (consumed === POSITION_MANAGEMENT_V2_MAX_M1_CANDLES) {
      legs.push({
        reason: 'FORCED_CLOSE_TIMEOUT',
        fraction: partialExitTriggered ? 1 - input.partialExitFraction : 1,
        exitPrice: current.close,
        exitTimestamp: current.openTime,
      });
      return {
        outcome: 'FORCED_CLOSE_TIMEOUT',
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered,
        m1CandlesConsumed: consumed,
      };
    }
  }

  return {
    outcome: 'OPEN_DATA_END',
    exitLegs: legs,
    grossR: grossR(plan, legs),
    partialExitTriggered,
    m1CandlesConsumed: consumed,
  };
}
