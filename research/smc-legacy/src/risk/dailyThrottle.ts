/**
 * TICKET-09X-A — pure calculation only, not wired into entryRouter.ts yet.
 * Both constants below are working defaults, not verified against real data.
 */
export const DAILY_PROFIT_THROTTLE_PCT = 0.05;
export const THROTTLED_MIN_CONFLUENCE_SCORE = 2;

export interface ClosedTrade {
  closeTime: number;
  realizedPnl: number;
}

export function startOfUtcDay(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

/** Sums realizedPnl for trades whose closeTime falls in [startOfUtcDay(now), now] — keyed by close, not open. */
export function computeDailyRealizedPnl(closedTrades: ClosedTrade[], now: number): number {
  const dayStart = startOfUtcDay(now);
  return closedTrades.filter((t) => t.closeTime >= dayStart && t.closeTime <= now).reduce((sum, t) => sum + t.realizedPnl, 0);
}

export function isDailyThrottled(closedTrades: ClosedTrade[], startOfDayEquity: number, now: number): boolean {
  return computeDailyRealizedPnl(closedTrades, now) >= DAILY_PROFIT_THROTTLE_PCT * startOfDayEquity;
}

export function isEntryAllowedGivenThrottle(confluenceScore: number, throttled: boolean): boolean {
  return throttled ? confluenceScore >= THROTTLED_MIN_CONFLUENCE_SCORE : true;
}
