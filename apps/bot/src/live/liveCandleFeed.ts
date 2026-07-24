/**
 * TICKET-076 Phần A (TICKET-050b) — REST polling live candle feed for 4 symbols × 5 timeframes.
 * WebSocket mainnet was confirmed not to deliver data (see ticket history) — REST polling only.
 * Uses the public klines endpoint (`GET /fapi/v1/klines`), no API key needed.
 */

export interface CandleData {
  timestamp: number; // epoch ms UTC, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '1d';

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

// Mirrors scripts/backtest.ts's WINDOW_5M/WINDOW_15M/WINDOW_1H/WINDOW_1M/WINDOW_1D — same bounded
// lookback every indicator needs, kept in sync manually (backtest.ts's consts aren't exported).
export const DEFAULT_WINDOW_SIZES: Record<Interval, number> = {
  '5m': 320,
  '15m': 325,
  '1h': 40,
  '1m': 200,
  '1d': 40,
};

// Poll cadence per timeframe — engineering/ops parameter (not a strategy threshold), chosen so a
// newly closed candle is picked up within a fraction of its own interval without hammering the API.
export const DEFAULT_POLL_INTERVALS_MS: Record<Interval, number> = {
  '1m': 10_000,
  '5m': 20_000,
  '15m': 30_000,
  '1h': 60_000,
  '1d': 300_000,
};

const KLINE_LIMIT = 3; // last closed candle(s) + the currently-forming one
const MAX_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on 429/network error, same policy as scripts/fetchOhlcv.ts

export interface LiveCandleFeedConfig {
  symbols: string[];
  baseUrl: string;
  windowSizes?: Partial<Record<Interval, number>>;
  pollIntervalsMs?: Partial<Record<Interval, number>>;
  klineLimit?: number;
  onError?: (err: Error, symbol: string, interval: Interval) => void;
  onPoll?: (symbol: string, interval: Interval, candles: CandleData[]) => void;
  /** Injected for tests; defaults to setInterval/clearInterval. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

interface RawKline extends Array<string | number> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseKline(k: RawKline): CandleData {
  return { timestamp: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) };
}

/** Replaces any buffered candle at/after the new batch's first timestamp (the forming candle keeps updating), then trims to windowSize. */
export function mergeCandles(buffer: CandleData[], newBatch: CandleData[], windowSize: number): CandleData[] {
  if (newBatch.length === 0) return buffer;
  const cutoff = newBatch[0].timestamp;
  const kept = buffer.filter((c) => c.timestamp < cutoff);
  const merged = [...kept, ...newBatch];
  return merged.length > windowSize ? merged.slice(merged.length - windowSize) : merged;
}

async function fetchKlines(baseUrl: string, symbol: string, interval: Interval, limit: number): Promise<CandleData[]> {
  const url = `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        if (attempt === MAX_RETRIES - 1) throw new Error(`429 rate-limited after ${MAX_RETRIES} attempts: ${url}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      const raw = (await res.json()) as RawKline[];
      return raw.map(parseKline);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Maintains an in-memory rolling buffer of candles per symbol/interval, refreshed by REST polling on independent per-interval timers. */
export class LiveCandleFeed {
  private readonly config: Required<Omit<LiveCandleFeedConfig, 'onError' | 'onPoll'>> & Pick<LiveCandleFeedConfig, 'onError' | 'onPoll'>;
  private readonly buffers: Map<string, CandleData[]> = new Map(); // key = `${symbol}:${interval}`
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running = false;

  constructor(config: LiveCandleFeedConfig) {
    this.config = {
      symbols: config.symbols,
      baseUrl: config.baseUrl,
      windowSizes: { ...DEFAULT_WINDOW_SIZES, ...config.windowSizes },
      pollIntervalsMs: { ...DEFAULT_POLL_INTERVALS_MS, ...config.pollIntervalsMs },
      klineLimit: config.klineLimit ?? KLINE_LIMIT,
      onError: config.onError,
      onPoll: config.onPoll,
      setIntervalFn: config.setIntervalFn ?? setInterval,
      clearIntervalFn: config.clearIntervalFn ?? clearInterval,
    };
  }

  private key(symbol: string, interval: Interval): string {
    return `${symbol}:${interval}`;
  }

  getCandles(symbol: string, interval: Interval): CandleData[] {
    return this.buffers.get(this.key(symbol, interval)) ?? [];
  }

  private async pollOnce(symbol: string, interval: Interval): Promise<void> {
    try {
      const newBatch = await fetchKlines(this.config.baseUrl, symbol, interval, this.config.klineLimit);
      const key = this.key(symbol, interval);
      const windowSize = this.config.windowSizes[interval] ?? DEFAULT_WINDOW_SIZES[interval];
      const merged = mergeCandles(this.buffers.get(key) ?? [], newBatch, windowSize);
      this.buffers.set(key, merged);
      this.config.onPoll?.(symbol, interval, merged);
    } catch (err) {
      this.config.onError?.(err as Error, symbol, interval);
    }
  }

  /** Kicks off one immediate poll per symbol/interval (fills the buffer before start() returns), then starts the recurring timers. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const intervals = Object.keys(INTERVAL_MS) as Interval[];

    await Promise.all(this.config.symbols.flatMap((symbol) => intervals.map((interval) => this.pollOnce(symbol, interval))));

    for (const symbol of this.config.symbols) {
      for (const interval of intervals) {
        const ms = this.config.pollIntervalsMs[interval] ?? DEFAULT_POLL_INTERVALS_MS[interval];
        const timer = this.config.setIntervalFn(() => {
          void this.pollOnce(symbol, interval);
        }, ms);
        this.timers.push(timer);
      }
    }
  }

  stop(): void {
    for (const timer of this.timers) this.config.clearIntervalFn(timer);
    this.timers.length = 0;
    this.running = false;
  }
}
