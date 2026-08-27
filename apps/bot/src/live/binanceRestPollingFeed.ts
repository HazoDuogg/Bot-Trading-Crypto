import type { Candle } from '../noTradeZone/types.js';
import type { MarketDataFeed, Interval } from './marketDataFeed.js';

const INTERVAL_MS: Record<Interval, number> = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 };
const SERVER_TIME_RESYNC_MS = 10 * 60 * 1000; // Part B point 1: resync every ~10 minutes
const DEFAULT_POLL_DELAY_MS = 3000; // Part B point 2: poll a few seconds AFTER the expected close, never at the boundary
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

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

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
  for (; ;) {
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
  ) { }

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

    if (startTime >= serverTimeMs) return [];

    const raw = await retryWithBackoff(() => this.fetchKlines(symbol, interval, startTime, serverTimeMs), this.retryOptions);
    const closedOnly = raw.filter((k) => k.closeTime < serverTimeMs);
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
