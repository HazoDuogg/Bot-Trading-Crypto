import { RegimeConfig } from './config.js';
import type { ComputedMetrics } from './types.js';
import { HTFContext } from './htfSafetyTypes.js';

/**
 * TICKET-139: classifies HTFContext from slow HTF inputs only (1H ADX, 1H +DI/-DI direction,
 * 15m BB width) — reuses regime/config.ts's already-calibrated thresholds (TREND_ENTER_ADX,
 * SIDEWAY_ADX_THRESHOLD, COMPRESSION_BBW_PCT_THRESHOLD). Deliberately does NOT read any 5m
 * metric (atrPercentile5m, wick/sweep counts, volumeZScore5m) — that is the entire point of
 * this split (TICKET-139 brief): HTFContext must never move just because 5m volatility fluctuates.
 * 1H EMA/slope omitted: no existing calibrated 1H EMA period/threshold anywhere in this codebase
 * (ticket makes it conditional on availability — "nếu đã có"); adding one would require inventing
 * a new, unbacktested constant, which house rules forbid doing silently.
 * TODO_CONFIRM: if PM wants 1H EMA slope folded in later, needs its own period+threshold
 * calibrated against real 1H data first — not added here.
 */
export function classifyHtfContextCandidate(metrics: ComputedMetrics): HTFContext {
  const { adx1h, adxDirection1h, bbWidthPercentile15m } = metrics;
  if (adx1h === undefined || adxDirection1h === undefined || bbWidthPercentile15m === undefined) {
    return HTFContext.NEUTRAL;
  }

  const compressed = bbWidthPercentile15m <= RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter;
  const ranging = adx1h <= RegimeConfig.SIDEWAY_ADX_THRESHOLD.enter;
  if (ranging || compressed) {
    return HTFContext.RANGE;
  }

  const trending = adx1h >= RegimeConfig.TREND_ENTER_ADX.enter;
  if (trending && adxDirection1h === 'UP') return HTFContext.TREND_UP;
  if (trending && adxDirection1h === 'DOWN') return HTFContext.TREND_DOWN;

  return HTFContext.NEUTRAL;
}
