import type { Candle } from '../noTradeZone/types.js';
import type { SetupSignal } from '../setup/setupDetectorA.js';
import { detectNoChaseExtension } from '../structure/extension.js';

// Single-pass M1 retest window: exactly one M15 candle's worth of real time (15 minutes),
// evaluated at M1 granularity, starting the instant the trigger M15 candle closes.
const M15_WINDOW_MS = 15 * 60 * 1000;
const MAX_M1_CANDLES_PER_WINDOW = 15;
const LIQUIDITY_SWEEP_VOLUME_MA_PERIOD = 20;
const LIQUIDITY_SWEEP_VOLUME_MULTIPLIER = 2.5;

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
  | { status: 'EXPIRED_15M'; expiryTimestamp: number; reason?: string };

// MA20 of the 20 M1 candles immediately before the trigger candle; any M1 candle from the
// trigger candle up to the retest window start with volume > MA20 * 2.5 is a liquidity sweep.
// Insufficient history to form the baseline is not "still waiting" (it never arrives), so it
// resolves to no-sweep rather than throwing — unlike the causal-safety throws below.
function detectLiquiditySweep(
  m1Candles: readonly Candle[],
  triggerCandleOpenTime: number,
  windowStartTimestamp: number,
): boolean {
  const recentVolumes: number[] = [];
  for (let index = 0; index < m1Candles.length; index += 1) {
    const current = m1Candles[index];
    if (current.openTime >= triggerCandleOpenTime) break;
    recentVolumes.push(current.volume);
    if (recentVolumes.length > LIQUIDITY_SWEEP_VOLUME_MA_PERIOD) recentVolumes.shift();
  }
  if (recentVolumes.length < LIQUIDITY_SWEEP_VOLUME_MA_PERIOD) {
    return false;
  }
  const volumeMa =
    recentVolumes.reduce((sum, volume) => sum + volume, 0) / LIQUIDITY_SWEEP_VOLUME_MA_PERIOD;
  const sweepThreshold = volumeMa * LIQUIDITY_SWEEP_VOLUME_MULTIPLIER;

  for (let index = 0; index < m1Candles.length; index += 1) {
    const current = m1Candles[index];
    if (current.openTime < triggerCandleOpenTime) continue;
    if (current.openTime >= windowStartTimestamp) break;
    if (current.volume > sweepThreshold) return true;
  }
  return false;
}

// Manual scan, stopping the instant a reclaim is found, mirroring the causal-safety discipline
// of scanRetestWindowFrom below.
function findReclaimCandle(
  m1Candles: readonly Candle[],
  windowStartTimestamp: number,
  breakLevel: number,
  direction: 'BULL' | 'BEAR',
): { found: true; reclaimTimestamp: number } | { found: false } {
  const scanEndTimestamp = windowStartTimestamp + MAX_M1_CANDLES_PER_WINDOW * 60_000;
  let scanned = 0;
  for (let index = 0; index < m1Candles.length; index += 1) {
    const current = m1Candles[index];
    if (current.openTime < windowStartTimestamp) continue;
    if (current.openTime >= scanEndTimestamp || scanned >= MAX_M1_CANDLES_PER_WINDOW) break;
    scanned += 1;
    const isReclaim =
      direction === 'BULL'
        ? current.high > breakLevel && current.close < breakLevel
        : current.low < breakLevel && current.close > breakLevel;
    if (isReclaim) return { found: true, reclaimTimestamp: current.openTime };
  }
  const lastKnownCandle = m1Candles.at(-1);
  if (lastKnownCandle === undefined || lastKnownCandle.openTime < scanEndTimestamp - 60_000) {
    throw new Error('m1Candles must cover the full 15-minute retest window before it can be evaluated');
  }
  return { found: false };
}

// Manual-pass fill/cancel/expiry scan over one M15-wide window; shared by the plain-window path
// and the post-reclaim window path so the causal-safety scan logic stays in exactly one place.
function scanRetestWindowFrom(
  windowStartTimestamp: number,
  m1Candles: readonly Candle[],
  limitPrice: number,
  breakLevel: number,
  frozenAtrAtTrigger: number,
): M1RetestWindowResult {
  const windowEndTimestamp = windowStartTimestamp + M15_WINDOW_MS;

  // Manual index walk (not filter/slice) so a resolved fill/cancel stops before ever touching
  // a later M1 candle — required for causal safety, since array methods aren't lazy.
  let scannedInWindow = 0;
  for (let index = 0; index < m1Candles.length; index += 1) {
    const current = m1Candles[index];
    if (current.openTime < windowStartTimestamp) continue;
    if (current.openTime >= windowEndTimestamp || scannedInWindow >= MAX_M1_CANDLES_PER_WINDOW) break;
    scannedInWindow += 1;
    if (current.low <= limitPrice && limitPrice <= current.high) {
      return { status: 'FILLED', fillTimestamp: current.openTime, fillPrice: limitPrice };
    }
    const extension = detectNoChaseExtension({
      currentClose: current.close,
      breakLevel,
      frozenAtr: frozenAtrAtTrigger,
    });
    if (extension.isOverExtended) {
      return { status: 'CANCELLED_OVER_EXTENDED', cancelTimestamp: current.openTime };
    }
  }

  // Nothing resolved from the candles we have; only expire once the feed has actually closed
  // this window (a real gap inside an already-closed window is not the same as "still waiting").
  const lastKnownCandle = m1Candles.at(-1);
  if (lastKnownCandle === undefined || lastKnownCandle.openTime < windowEndTimestamp - 60_000) {
    throw new Error('m1Candles must cover the full 15-minute retest window before it can be evaluated');
  }
  return { status: 'EXPIRED_15M', expiryTimestamp: windowEndTimestamp };
}

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
  const triggerCandleOpenTime = input.windowStartTimestamp - M15_WINDOW_MS;

  if (detectLiquiditySweep(input.m1Candles, triggerCandleOpenTime, input.windowStartTimestamp)) {
    const reclaim = findReclaimCandle(
      input.m1Candles,
      input.windowStartTimestamp,
      breakLevel,
      input.signal.direction,
    );
    if (!reclaim.found) {
      return {
        status: 'EXPIRED_15M',
        expiryTimestamp: input.windowStartTimestamp + M15_WINDOW_MS,
        reason: 'SWEEP_TIMEOUT',
      };
    }
    return scanRetestWindowFrom(
      reclaim.reclaimTimestamp,
      input.m1Candles,
      limitPrice,
      breakLevel,
      input.frozenAtrAtTrigger,
    );
  }
  return scanRetestWindowFrom(
    input.windowStartTimestamp,
    input.m1Candles,
    limitPrice,
    breakLevel,
    input.frozenAtrAtTrigger,
  );
}
