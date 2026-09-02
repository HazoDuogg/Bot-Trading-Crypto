import type { Candle } from '../noTradeZone/types.js';
import { M15_CANDLE_DURATION_MS } from './intrabarExecution.js';

export interface CausalFillInput {
  m15Candles: readonly Candle[];
  m1Candles: readonly Candle[];
  triggerIndex: number;
  fillIndex: number;
  limitPrice: number;
}

export interface CausalFillResult {
  signalTime: number;
  orderActiveTime: number;
  firstTouchFillTimestamp: number;
  firstTouchFillPrice: number;
}

export function findCausalM1Fill(input: CausalFillInput): CausalFillResult {
  if (!Number.isSafeInteger(input.triggerIndex) || input.triggerIndex < 0) {
    throw new Error('triggerIndex must be a non-negative integer');
  }
  if (
    !Number.isSafeInteger(input.fillIndex) ||
    input.fillIndex <= input.triggerIndex ||
    input.fillIndex >= input.m15Candles.length
  ) {
    throw new Error('fillIndex must reference a post-trigger M15 candle');
  }
  if (input.triggerIndex + 1 >= input.m15Candles.length) {
    throw new Error('m15Candles must contain the first retest candle');
  }
  if (!Number.isFinite(input.limitPrice)) throw new Error('limitPrice must be finite');

  const signalTime = input.m15Candles[input.triggerIndex].openTime + M15_CANDLE_DURATION_MS;
  const orderActiveTime = input.m15Candles[input.triggerIndex + 1].openTime;
  const fillCandleOpenTime = input.m15Candles[input.fillIndex].openTime;
  const scanStart = Math.max(orderActiveTime, fillCandleOpenTime);
  const scanEnd = fillCandleOpenTime + M15_CANDLE_DURATION_MS;
  let left = 0;
  let right = input.m1Candles.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (input.m1Candles[middle].openTime < scanStart) left = middle + 1;
    else right = middle;
  }
  let firstTouch: Candle | undefined;
  for (let index = left; index < input.m1Candles.length; index += 1) {
    const candle = input.m1Candles[index];
    if (candle.openTime >= scanEnd) break;
    if (candle.low <= input.limitPrice && input.limitPrice <= candle.high) {
      firstTouch = candle;
      break;
    }
  }
  if (firstTouch === undefined) {
    throw new Error(
      `Confirmed M15 fill at index ${input.fillIndex} has no observable M1 touch at ${input.limitPrice}`,
    );
  }

  return {
    signalTime,
    orderActiveTime,
    firstTouchFillTimestamp: firstTouch.openTime,
    firstTouchFillPrice: input.limitPrice,
  };
}
