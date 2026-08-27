import type { Candle } from '../noTradeZone/types.js';
import type { MarketDataFeed, Interval } from './marketDataFeed.js';

// TICKET-RT-067 Part B: REST-polling implementation of MarketDataFeed against Binance Futures
// (works against either BINANCE_TESTNET_URL or BINANCE_URL — caller passes the base URL, this
// class has no opinion about which environment it's talking to). No WebSocket here (deliberately
// out of scope per the ticket).

const INTERVAL_MS: Record<Interval, number> = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 };
const SERVER_TIME_RESYNC_MS = 10 * 60 * 1000; // Part B point 1: resync every ~10 minutes
const DEFAULT_POLL_DELAY_MS = 3000; // Part B point 2: poll a few seconds AFTER the expected close, never at the boundary
// Part B point 6: catch-up window on startup/restart. 300 covers both intervals' real needs with
// margin: H1 needs >=200 candles for classifyTrendH1's EMA200 (300 gives 100 candles of warmup
// beyond the minimum, past which an EMA200's tail weight is negligible); M15 only needs a handful
// (detectFvg's 3-candle pattern, checkNoTradeZone's internal ~20-35-candle lookback,
// maxWaitCandles=20) so 300 M15 candles (~3 days) is comfortably more than enough. One constant
// keeps the call site simple; callers needing a different value can still pass their own.
const DEFAULT_LOOKBACK_CANDLES = 300;

interface RawKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

// Part B point 2: computes the next candle-close boundary strictly after `nowServerMs`, using
// SERVER time (never Date.now() directly) — pure, unit-testable without any network access.
export function nextCandleCloseMs(interval: Interval, nowServerMs: number): number {
  const intervalMs = INTERVAL_MS[interval];
  const currentBoundary = Math.floor(nowServerMs / intervalMs) * intervalMs;
  return currentBoundary + intervalMs;
}

// Part B point 2: ms to wait before the next poll — the next close boundary, plus a small delay
// (default 3s) so the poll never races the candle actually closing on the exchange.
export function msUntilNextPoll(interval: Interval, nowServerMs: number, pollDelayMs: number = DEFAULT_POLL_DELAY_MS): number {
  return nextCandleCloseMs(interval, nowServerMs) + pollDelayMs - nowServerMs;
}

// Part B point 4: retry helper — exponential backoff with jitter for network errors; honors
// Binance's Retry-After header on 429 (rate limit)/418 (IP ban) when present. Throws (does not
// swallow) once retries are exhausted — the CALLER (liveRunner's poll loop) decides how to
// recover from a fully-failed poll, so one bad cycle never silently produces wrong data.
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}
// A 4xx status means the REQUEST ITSELF was rejected (bad params, unknown order, auth failure) —
// retrying it will never succeed, unlike a network blip or Binance's own rate-limit/ban codes.
// 429 (rate limited) and 418 (IP auto-banned for excessive requests) are Binance's explicit
// "back off and try again" signals, so those two 4xx codes ARE retried; every other 4xx is not.
// Anything that isn't a BinanceHttpError at all (a plain network failure) is always retried.
function isRetryable(err: unknown): boolean {
  if (!(err instanceof BinanceHttpError)) return true;
  if (err.status === 429 || err.status === 418) return true;
  if (err.status >= 500) return true;
  return false;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryable(err)) throw err;
      if (attempt > maxRetries) throw err;
      let delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const retryAfterSec = err instanceof BinanceHttpError ? err.retryAfterSec : undefined;
      if (retryAfterSec !== undefined) delayMs = Math.max(delayMs, retryAfterSec * 1000);
      delayMs += Math.floor(Math.random() * 250); // jitter, avoids thundering-herd on shared rate limits
      options.onRetry?.(attempt, err, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export class BinanceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'BinanceHttpError';
  }
}

export class BinanceRestPollingFeed implements MarketDataFeed {
  private serverTimeOffsetMs: number | null = null;
  private lastSyncAtMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly retryOptions: RetryOptions = {},
  ) {}

  // Part B point 1: server time - local time offset, resynced at most every 10 minutes; every
  // other call reuses the cached offset (cheap, no network round-trip on every decision).
  async getServerTimeMs(): Promise<number> {
    const nowLocal = Date.now();
    if (this.serverTimeOffsetMs === null || nowLocal - this.lastSyncAtMs > SERVER_TIME_RESYNC_MS) {
      const serverTime = await retryWithBackoff(() => this.fetchServerTime(), this.retryOptions);
      const afterFetchLocal = Date.now();
      this.serverTimeOffsetMs = serverTime - afterFetchLocal;
      this.lastSyncAtMs = afterFetchLocal;
    }
    return Date.now() + this.serverTimeOffsetMs;
  }

  private async fetchServerTime(): Promise<number> {
    const url = new URL('/fapi/v1/time', this.baseUrl);
    const res = await fetch(url);
    await throwIfNotOk(res);
    const body = (await res.json()) as { serverTime: number };
    return body.serverTime;
  }

  async getClosedCandlesSince(symbol: string, interval: Interval, sinceOpenTimeExclusive: number | null, lookback = DEFAULT_LOOKBACK_CANDLES): Promise<Candle[]> {
    const serverTimeMs = await this.getServerTimeMs();
    const intervalMs = INTERVAL_MS[interval];
    const startTime = sinceOpenTimeExclusive !== null ? sinceOpenTimeExclusive + 1 : serverTimeMs - lookback * intervalMs;

    // No possible closed candle can exist with openTime >= serverTimeMs — short-circuit instead of
    // making a doomed API call (Binance rejects startTime > endTime with a 400, which would just
    // burn through retryWithBackoff's retries for nothing). A poll firing at/near a boundary can
    // legitimately land here.
    if (startTime >= serverTimeMs) return [];

    const raw = await retryWithBackoff(() => this.fetchKlines(symbol, interval, startTime, serverTimeMs), this.retryOptions);

    // Part B point 3: a candle is only "closed" once its own closeTime has actually passed on the
    // exchange server clock — Binance's klines endpoint includes the still-forming candle when its
    // openTime <= the requested endTime (the exact RT-054 bug this guards against).
    const closedOnly = raw.filter((k) => k.closeTime < serverTimeMs);

    // Part B point 5: dedupe by openTime (defensive — startTime/endTime pagination shouldn't
    // produce duplicates, but this makes the guarantee explicit rather than assumed) and enforce
    // the exclusive cursor again client-side, since Binance's startTime filter is >=, not >.
    const seen = new Set<number>();
    const deduped: Candle[] = [];
    for (const k of closedOnly) {
      if (sinceOpenTimeExclusive !== null && k.openTime <= sinceOpenTimeExclusive) continue;
      if (seen.has(k.openTime)) continue;
      seen.add(k.openTime);
      deduped.push({ openTime: k.openTime, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) });
    }
    deduped.sort((a, b) => a.openTime - b.openTime);
    return deduped;
  }

  private async fetchKlines(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<RawKline[]> {
    const url = new URL('/fapi/v1/klines', this.baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', '1500');
    const res = await fetch(url);
    await throwIfNotOk(res);
    const raw = (await res.json()) as unknown[][];
    return raw.map((row) => ({
      openTime: row[0] as number,
      open: row[1] as string,
      high: row[2] as string,
      low: row[3] as string,
      close: row[4] as string,
      volume: row[5] as string,
      closeTime: row[6] as number,
    }));
  }
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const body = await res.text().catch(() => '');
  throw new BinanceHttpError(`Binance REST request failed: ${res.status} ${body}`, res.status, Number.isFinite(retryAfterSec) ? retryAfterSec : undefined);
}
