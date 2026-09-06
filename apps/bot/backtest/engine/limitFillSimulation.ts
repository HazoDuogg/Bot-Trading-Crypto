import type { Candle } from './noTradeZone/types.js';

// TICKET-04X-M: standalone limit/post-only fill model, independent of positionManagementV2.ts /
// intrabarExecution.ts — measures fill behavior only, no PnL/exit logic of any kind.
export interface LimitFillSimulationInput {
  limitPrice: number;
  direction: 'BULL' | 'BEAR';
  m1Candles: readonly Candle[];
  tickSize: number;
  n: number;
}

export interface LimitFillSimulationResult {
  filled: boolean;
  filledAtIndex: number | null;
  filledAtTimestamp: number | null;
  fillPrice: number | null;
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}

// BULL: limit rests below price, fills once low has pushed at least N ticks past it.
// BEAR: limit rests above price, fills once high has pushed at least N ticks past it.
// A touch alone (0 <= penetration < N*tickSize) does not fill and does not cancel the order —
// the loop simply continues to the next candle with the limit still resting.
export function simulateLimitFill(input: LimitFillSimulationInput): LimitFillSimulationResult {
  requirePositiveFinite(input.limitPrice, 'limitPrice');
  requirePositiveFinite(input.tickSize, 'tickSize');
  if (!Number.isFinite(input.n) || input.n < 0) throw new Error('n must be non-negative and finite');

  const threshold = input.n * input.tickSize;
  for (let i = 0; i < input.m1Candles.length; i += 1) {
    const candle = input.m1Candles[i];
    const penetration = input.direction === 'BULL' ? input.limitPrice - candle.low : candle.high - input.limitPrice;
    if (penetration >= threshold) {
      return { filled: true, filledAtIndex: i, filledAtTimestamp: candle.openTime, fillPrice: input.limitPrice };
    }
  }
  return { filled: false, filledAtIndex: null, filledAtTimestamp: null, fillPrice: null };
}
