import type { Candle } from '../noTradeZone/types.js';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { TradePlan } from './tradePlan.js';

// Class D experimental runner constants; they are not part of D1-D8 or the source-backed baseline.
export const POSITION_MANAGEMENT_V2_ATR_PERIOD = 14;
export const POSITION_MANAGEMENT_V2_MAX_M1_CANDLES = 4_320;

// TICKET-041: fixed 3-phase policy constants (no longer caller-configurable inputs).
export const BREAKEVEN_TRIGGER_R = 0.75;
export const BREAKEVEN_BUFFER_R = 0.05;
export const TP1_R = 1.0;
export const TP1_FRACTION = 0.5;
export const TP2_R = 2.0;
export const TRAILING_ATR_MULTIPLE = 1.5;

export interface PositionExitLeg {
  reason:
    | 'PARTIAL_EXIT'
    | 'TAKE_PROFIT_2'
    | 'INITIAL_STOP'
    | 'BREAKEVEN_STOP'
    | 'TRAILING_STOP'
    | 'FORCED_CLOSE_TIMEOUT';
  fraction: number;
  exitPrice: number;
  exitTimestamp: number;
  // Same-candle SL+TP collision forced this leg to the loss side (see rule 1 in the ticket).
  reasonCode?: 'AMBIGUOUS_FORCED_LOSS';
}

export interface PositionManagementV2Input {
  tradePlan: TradePlan;
  entryFillTimestamp: number;
  m1Candles: readonly Candle[];
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
    | 'TAKE_PROFIT_2'
    | 'FORCED_CLOSE_TIMEOUT'
    | 'OPEN_DATA_END';
  partialExitTriggered: boolean;
  m1CandlesConsumed: number;
}

export type PositionManagementV2Result = ResolvedPositionManagementV2Result;

type Phase = 'A' | 'B' | 'C';

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
  if (!Number.isSafeInteger(input.entryFillTimestamp) || input.entryFillTimestamp < 0) {
    throw new Error('entryFillTimestamp must be a non-negative UTC epoch millisecond timestamp');
  }
  requirePositiveFinite(input.tradePlan.entryPrice, 'tradePlan.entryPrice');
  requirePositiveFinite(input.tradePlan.riskPerUnit, 'tradePlan.riskPerUnit');
}

function grossR(plan: TradePlan, legs: readonly PositionExitLeg[]): number {
  const sign = directionSign(plan);
  return legs.reduce(
    (sum, leg) => sum + (leg.fraction * sign * (leg.exitPrice - plan.entryPrice)) / plan.riskPerUnit,
    0,
  );
}

// TICKET-041: 3-phase state machine. A (MFE < 0.75R, original SL) -> B (MFE >= 0.75R, stop moves
// to entry + 0.05R, still 100%) -> C (TP1 @1.0R closes 50%, remainder rides TP2 @2.0R vs a 1.5x
// ATR14 trail seeded at the breakeven price). Stop/phase changes are effective from the next candle.
export function simulatePositionManagementV2(
  input: PositionManagementV2Input,
): PositionManagementV2Result {
  validateInput(input);
  const { tradePlan: plan } = input;
  const sign = directionSign(plan);
  const breakevenTriggerPrice = plan.entryPrice + sign * BREAKEVEN_TRIGGER_R * plan.riskPerUnit;
  const breakevenStopPrice = plan.entryPrice + sign * BREAKEVEN_BUFFER_R * plan.riskPerUnit;
  const tp1Price = plan.entryPrice + sign * TP1_R * plan.riskPerUnit;
  const tp2Price = plan.entryPrice + sign * TP2_R * plan.riskPerUnit;

  const legs: PositionExitLeg[] = [];
  let phase: Phase = 'A';
  let runnerStop = breakevenStopPrice;
  let trailingActive = false;
  let consumed = 0;
  const atrTracker = createAtrTracker(POSITION_MANAGEMENT_V2_ATR_PERIOD);

  for (const current of input.m1Candles) {
    if (current.openTime <= input.entryFillTimestamp) continue;
    consumed += 1;

    const activeStop = phase === 'A' ? plan.stopLoss : phase === 'B' ? breakevenStopPrice : runnerStop;
    const activeTP = phase === 'C' ? tp2Price : tp1Price;
    const hitStop = touches(current, activeStop);
    const hitTP = touches(current, activeTP);

    if (hitStop && hitTP) {
      // Rule 1: same-candle SL+TP collision forces a loss at the active stop for the active leg.
      const reason = phase === 'A' ? 'INITIAL_STOP' : trailingActive ? 'TRAILING_STOP' : 'BREAKEVEN_STOP';
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({
        reason,
        fraction,
        exitPrice: activeStop,
        exitTimestamp: current.openTime,
        reasonCode: 'AMBIGUOUS_FORCED_LOSS',
      });
      return {
        outcome: reason,
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }

    if (hitStop) {
      const reason = phase === 'A' ? 'INITIAL_STOP' : trailingActive ? 'TRAILING_STOP' : 'BREAKEVEN_STOP';
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({ reason, fraction, exitPrice: activeStop, exitTimestamp: current.openTime });
      return {
        outcome: reason,
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }

    if (hitTP) {
      if (phase !== 'C') {
        legs.push({
          reason: 'PARTIAL_EXIT',
          fraction: TP1_FRACTION,
          exitPrice: tp1Price,
          exitTimestamp: current.openTime,
        });
        phase = 'C';
        runnerStop = breakevenStopPrice;
        trailingActive = false;
      } else {
        legs.push({
          reason: 'TAKE_PROFIT_2',
          fraction: 1 - TP1_FRACTION,
          exitPrice: tp2Price,
          exitTimestamp: current.openTime,
        });
        return {
          outcome: 'TAKE_PROFIT_2',
          exitLegs: legs,
          grossR: grossR(plan, legs),
          partialExitTriggered: true,
          m1CandlesConsumed: consumed,
        };
      }
    }

    if (phase === 'A' && touches(current, breakevenTriggerPrice)) {
      phase = 'B';
    }

    const atr = atrTracker.next(current);
    if (phase === 'C' && atr !== null) {
      const candidate = current.close - sign * TRAILING_ATR_MULTIPLE * atr;
      const improves = sign === 1 ? candidate > runnerStop : candidate < runnerStop;
      if (improves) {
        runnerStop = candidate;
        trailingActive = true;
      }
    }

    if (consumed === POSITION_MANAGEMENT_V2_MAX_M1_CANDLES) {
      const fraction = phase === 'C' ? 1 - TP1_FRACTION : 1;
      legs.push({
        reason: 'FORCED_CLOSE_TIMEOUT',
        fraction,
        exitPrice: current.close,
        exitTimestamp: current.openTime,
      });
      return {
        outcome: 'FORCED_CLOSE_TIMEOUT',
        exitLegs: legs,
        grossR: grossR(plan, legs),
        partialExitTriggered: phase === 'C',
        m1CandlesConsumed: consumed,
      };
    }
  }

  return {
    outcome: 'OPEN_DATA_END',
    exitLegs: legs,
    grossR: grossR(plan, legs),
    partialExitTriggered: phase === 'C',
    m1CandlesConsumed: consumed,
  };
}
