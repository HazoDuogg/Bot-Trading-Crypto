import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import { detectNoChaseExtension } from '../structure/extension.js';

// Retest/limit mechanics are source-backed; the eight-candle expiry and one-tick buffer are conventions.
export const RETEST_ENTRY_EXPIRY_CANDLES = 8;

export interface RetestEntryInput {
  signal: SetupSignal;
  closedCandles: readonly Candle[];
  frozenAtrAtTrigger: number;
  tickSize: number;
}

export interface RetestEntryResult {
  status: 'FILLED' | 'EXPIRED' | 'CANCELLED_OVER_EXTENDED';
  atIndex: number;
  fillPrice?: number;
}

export function evaluateRetestEntry(input: RetestEntryInput): RetestEntryResult {
  if (!Number.isSafeInteger(input.signal.triggerIndex) || input.signal.triggerIndex < 0) {
    throw new Error('signal.triggerIndex must be a non-negative integer');
  }
  if (!Number.isFinite(input.signal.reasonTrace.d2.level)) {
    throw new Error('signal.reasonTrace.d2.level must be finite');
  }
  if (!Number.isFinite(input.frozenAtrAtTrigger) || input.frozenAtrAtTrigger <= 0) {
    throw new Error('frozenAtrAtTrigger must be finite and greater than zero');
  }
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    throw new Error('tickSize must be finite and greater than zero');
  }

  const breakLevel = input.signal.reasonTrace.d2.level;
  const limitPrice =
    input.signal.direction === 'BULL' ? breakLevel - input.tickSize : breakLevel + input.tickSize;
  const expiryIndex = input.signal.triggerIndex + RETEST_ENTRY_EXPIRY_CANDLES;
  const lastAvailableIndex = Math.min(expiryIndex, input.closedCandles.length - 1);

  for (let index = input.signal.triggerIndex + 1; index <= lastAvailableIndex; index += 1) {
    const current = input.closedCandles[index];
    const extension = detectNoChaseExtension({
      currentClose: current.close,
      breakLevel,
      frozenAtr: input.frozenAtrAtTrigger,
    });
    if (extension.isOverExtended) {
      return { status: 'CANCELLED_OVER_EXTENDED', atIndex: index };
    }
    if (current.low <= limitPrice && limitPrice <= current.high) {
      return { status: 'FILLED', atIndex: index, fillPrice: limitPrice };
    }
  }

  if (lastAvailableIndex < expiryIndex) {
    throw new Error('closedCandles must reach expiry unless the entry fills or cancels earlier');
  }
  return { status: 'EXPIRED', atIndex: expiryIndex };
}
