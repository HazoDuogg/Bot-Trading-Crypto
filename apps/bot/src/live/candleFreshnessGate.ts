import { CandleData, Interval, INTERVAL_MS, isCandleClosed } from './liveCandleFeed.js';

export type CandleFreshnessReason = 'MISSING' | 'GAP' | 'FUTURE' | 'NOT_YET_CLOSED' | 'STALE_BEHIND';

export type CandleFreshnessVerdict =
  | { interval: Interval; fresh: true }
  | { interval: Interval; fresh: false; reason: CandleFreshnessReason };

export function assessCandleFreshness(
  interval: Interval,
  latestClosedCandleTimestamp: number | null,
  nowMs: number,
): CandleFreshnessVerdict {
  if (latestClosedCandleTimestamp === null) {
    return { interval, fresh: false, reason: 'MISSING' };
  }
  if (latestClosedCandleTimestamp > nowMs) {
    return { interval, fresh: false, reason: 'FUTURE' };
  }
  const intervalMs = INTERVAL_MS[interval];
  const candle: CandleData = { timestamp: latestClosedCandleTimestamp, open: 0, high: 0, low: 0, close: 0, volume: 0 };
  if (!isCandleClosed(candle, intervalMs, nowMs)) {
    return { interval, fresh: false, reason: 'NOT_YET_CLOSED' };
  }
  const nextCandle: CandleData = { ...candle, timestamp: latestClosedCandleTimestamp + intervalMs };
  if (isCandleClosed(nextCandle, intervalMs, nowMs)) {
    return { interval, fresh: false, reason: 'STALE_BEHIND' };
  }
  return { interval, fresh: true };
}

export function assessCandleFreshnessForSymbol(
  closedCandlesByInterval: Partial<Record<Interval, CandleData[]>>,
  requiredIntervals: Interval[],
  nowMs: number,
): CandleFreshnessVerdict[] {
  return requiredIntervals.map((interval) => {
    const candles = closedCandlesByInterval[interval] ?? [];
    if (candles.length === 0) return { interval, fresh: false, reason: 'MISSING' };
    const intervalMs = INTERVAL_MS[interval];
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].timestamp - candles[i - 1].timestamp !== intervalMs) {
        return { interval, fresh: false, reason: 'GAP' };
      }
    }
    return assessCandleFreshness(interval, candles[candles.length - 1].timestamp, nowMs);
  });
}

export function hasAnyStaleRequiredTimeframe(verdicts: CandleFreshnessVerdict[]): boolean {
  return verdicts.some((v) => !v.fresh);
}
