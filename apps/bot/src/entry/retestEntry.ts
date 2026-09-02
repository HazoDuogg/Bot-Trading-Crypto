import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import { detectNoChaseExtension } from '../structure/extension.js';

// Single-pass M1 retest window: exactly one M15 candle's worth of real time (15 minutes),
// evaluated at M1 granularity, starting the instant the trigger M15 candle closes.
const M15_WINDOW_MS = 15 * 60 * 1000;
const MAX_M1_CANDLES_PER_WINDOW = 15;

export interface M1RetestWindowInput {
  signal: SetupSignal;
  m1Candles: readonly Candle[];
  windowStartTimestamp: number;
  frozenAtrAtTrigger: number;
  tickSize: number;
}

export type M1RetestWindowResult =
  | { status: 'FILLED'; fillTimestamp: number; fillPrice: number }
  | { status: 'CANCELLED_OVER_EXTENDED'; cancelTimestamp: number }
  | { status: 'EXPIRED_15M'; expiryTimestamp: number };

export function evaluateM1RetestWindow(input: M1RetestWindowInput): M1RetestWindowResult {
  if (!Number.isFinite(input.signal.reasonTrace.d2.level)) {
    throw new Error('signal.reasonTrace.d2.level must be finite');
  }
  if (!Number.isFinite(input.frozenAtrAtTrigger) || input.frozenAtrAtTrigger <= 0) {
    throw new Error('frozenAtrAtTrigger must be finite and greater than zero');
  }
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    throw new Error('tickSize must be finite and greater than zero');
  }
  if (!Number.isSafeInteger(input.windowStartTimestamp) || input.windowStartTimestamp < 0) {
    throw new Error('windowStartTimestamp must be a non-negative integer');
  }

  const breakLevel = input.signal.reasonTrace.d2.level;
  const limitPrice =
    input.signal.direction === 'BULL' ? breakLevel - input.tickSize : breakLevel + input.tickSize;
  const windowEndTimestamp = input.windowStartTimestamp + M15_WINDOW_MS;

  // Manual index walk (not filter/slice) so a resolved fill/cancel stops before ever touching
  // a later M1 candle — required for causal safety, since array methods aren't lazy.
  let scannedInWindow = 0;
  for (let index = 0; index < input.m1Candles.length; index += 1) {
    const current = input.m1Candles[index];
    if (current.openTime < input.windowStartTimestamp) continue;
    if (current.openTime >= windowEndTimestamp || scannedInWindow >= MAX_M1_CANDLES_PER_WINDOW) break;
    scannedInWindow += 1;
    if (current.low <= limitPrice && limitPrice <= current.high) {
      return { status: 'FILLED', fillTimestamp: current.openTime, fillPrice: limitPrice };
    }
    const extension = detectNoChaseExtension({
      currentClose: current.close,
      breakLevel,
      frozenAtr: input.frozenAtrAtTrigger,
    });
    if (extension.isOverExtended) {
      return { status: 'CANCELLED_OVER_EXTENDED', cancelTimestamp: current.openTime };
    }
  }

  // Nothing resolved from the candles we have; only expire once the feed has actually closed
  // this window (a real gap inside an already-closed window is not the same as "still waiting").
  const lastKnownCandle = input.m1Candles.at(-1);
  if (lastKnownCandle === undefined || lastKnownCandle.openTime < windowEndTimestamp - 60_000) {
    throw new Error('m1Candles must cover the full 15-minute retest window before it can be evaluated');
  }
  return { status: 'EXPIRED_15M', expiryTimestamp: windowEndTimestamp };
}
