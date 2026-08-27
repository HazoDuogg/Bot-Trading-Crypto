import type { Candle } from '../noTradeZone/types.js';

// TICKET-RT-067 Part A: exchange-agnostic market data interface, so a future exchange swap only
// needs a new implementation of this interface — nothing calling it needs to change.
export type Interval = '15m' | '1h';

// Deliberate deviation from the ticket's literal "getLatestClosedCandle(symbol, interval):
// Promise<Candle>": a single-candle-return shape can't naturally serve BOTH normal polling AND
// the ticket's own Part B point 6 requirement ("fetch mot khoang nen gan day... de bat kip" on
// startup/after a crash — which needs a BATCH, not one candle). One method that returns
// zero-or-more CLOSED candles strictly after a cursor (or the most recent `lookback` closed
// candles when the cursor is null, for catch-up) covers both cases with one contract: normal
// polling calls it with the last-processed openTime as the cursor (usually returns 0 or 1
// candles); startup/catch-up calls it with cursor=null. This is the "tuong duong phu hop thiet
// ke" the ticket explicitly allows.
export interface MarketDataFeed {
  /**
   * Returns CLOSED candles (closeTime already passed, per checkpoint from RT-054) for
   * symbol/interval with openTime > sinceOpenTimeExclusive, oldest first. When
   * sinceOpenTimeExclusive is null, returns the most recent `lookback` closed candles instead
   * (used for startup/restart catch-up). Never returns a candle whose close hasn't happened yet.
   */
  getClosedCandlesSince(symbol: string, interval: Interval, sinceOpenTimeExclusive: number | null, lookback?: number): Promise<Candle[]>;

  /** Current exchange server time (ms since epoch) — NOT local machine time (see Part B point 1). */
  getServerTimeMs(): Promise<number>;
}
