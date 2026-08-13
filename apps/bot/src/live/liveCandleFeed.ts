/**
 * TICKET-076 Phần A (TICKET-050b) — REST polling live candle feed for 4 symbols × 5 timeframes.
 * WebSocket mainnet was confirmed not to deliver data (see ticket history) — REST polling only.
 * Uses the public klines endpoint (`GET /fapi/v1/klines`), no API key needed.
 */

import { RegimeConfig } from '../regime/config.js';

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

const CANDLES_PER_DAY_5M = 288; // 24h / 5min — same stride regime/indicators.ts's sessionRelativeVolumeRatio walks

/**
 * TICKET-G2R F-01: identical to scripts/backtest.ts's WINDOW_5M_SESSION_VOLUME (14 * 288 + 1),
 * derived from RegimeConfig here so the two can never drift. LOW_LIQUIDITY is unreachable without
 * a 5m buffer this deep, which is why the 5m window below is sized to it rather than to 320.
 */
export const SESSION_VOLUME_WINDOW_5M = RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS * CANDLES_PER_DAY_5M + 1;

// Mirrors scripts/backtest.ts's WINDOW_5M/WINDOW_15M/WINDOW_1H/WINDOW_1M/WINDOW_1D — same bounded
// lookback every indicator needs, kept in sync manually (backtest.ts's consts aren't exported).
// The extra slot keeps Binance's forming candle without evicting a required closed candle.
export const DEFAULT_WINDOW_SIZES: Record<Interval, number> = {
  '5m': SESSION_VOLUME_WINDOW_5M + 1,
  '15m': 325,
  '1h': 40,
  '1m': 200,
  '1d': 40,
};

// Poll cadence per timeframe — engineering/ops parameter (not a strategy threshold), chosen so a
// newly closed candle is picked up within a fraction of its own interval without hammering the API.
// TICKET-077 1.1: PM explicitly confirmed 1-2s is a reasonable interval for the 5m timeframe (this
// is the one that matters most for entry-decision freshness) — tightened from the original 20s.
// 15m/1h/1d unchanged (they close far less often; polling them this fast would only burn rate-limit
// budget for no benefit — 1.2 re-checks the total weight budget against this new cadence).
export const DEFAULT_POLL_INTERVALS_MS: Record<Interval, number> = {
  '1m': 10_000,
  '5m': 2_000,
  '15m': 30_000,
  '1h': 60_000,
  '1d': 300_000,
};

const KLINE_LIMIT = 3; // last closed candle(s) + the currently-forming one
const MAX_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on 429/network error, same policy as scripts/fetchOhlcv.ts
// TICKET-077 1.0: bare fetch() has no timeout — a hung TCP connection (common failure mode behind a
// flaky VPS network path) would block forever without ever reaching the catch/retry below, which
// looks identical to "no price data" from the outside. Same AbortController pattern as
// binanceOrderExecutor.ts's fetchWithTimeout().
const REQUEST_TIMEOUT_MS = 10_000;
// TICKET-077 1.1: a candle's nominal close time (timestamp + intervalMs) doesn't guarantee Binance's
// own kline aggregation has settled server-side yet — a small safety margin avoids treating a candle
// as final one tick too early (which would feed the orchestrator a value that still gets revised).
const CLOSE_SAFETY_BUFFER_MS = 2_000;
const BACKFILL_LIMIT = 1000;
// Binance's own hard per-request cap on GET /fapi/v1/klines. Anything deeper needs paging.
const BINANCE_MAX_KLINES_LIMIT = 1500;
// Bound on seed paging so a misbehaving/looping endpoint can never spin forever. 4033 candles need
// 3 pages; the margin absorbs short pages without allowing an unbounded loop.
const MAX_SEED_BACKFILL_PAGES = 12;
// TICKET-077 1.2: ground-truthed from GET /fapi/v1/exchangeInfo's `rateLimits` array (REQUEST_WEIGHT,
// 1 MINUTE) at time of writing — this is Binance's own published number for the IP, not a guess.
// Kept as a constant (not fetched at runtime) since re-deriving it on every poll would itself cost
// weight; if Binance changes it, WEIGHT_SAFETY_THRESHOLD_PCT's margin (see below) absorbs the drift.
const WEIGHT_LIMIT_PER_MINUTE = 2400;
// PM's rule: "dư ít nhất 30-40% margin an toàn" — 0.6 (60% used) leaves exactly that margin.
const WEIGHT_SAFETY_THRESHOLD_PCT = 0.6;

export interface LiveCandleFeedConfig {
  symbols: string[];
  baseUrl: string;
  windowSizes?: Partial<Record<Interval, number>>;
  pollIntervalsMs?: Partial<Record<Interval, number>>;
  klineLimit?: number;
  onError?: (err: Error, symbol: string, interval: Interval) => void;
  onPoll?: (symbol: string, interval: Interval, candles: CandleData[]) => void;
  /** Called whenever a gap is detected AND successfully backfilled. A gap that fails to backfill surfaces through onError instead. */
  onGapFilled?: (symbol: string, interval: Interval, gaps: CandleGap[]) => void;
  /** Fires whenever a response includes the X-MBX-USED-WEIGHT-1m header — lets a caller (or a live dashboard) observe real rate-limit consumption, ground-truthed from Binance itself rather than a locally-computed estimate. */
  onWeightUpdate?: (usedWeight1m: number, limitPerMinute: number) => void;
  /** Fires when a poll is SKIPPED because used weight crossed WEIGHT_SAFETY_THRESHOLD_PCT — the auto-widen-under-pressure behavior 1.2 asks for (skipping a tick has the same rate-reducing effect as lengthening the interval, without needing to touch the timer itself). */
  onThrottled?: (symbol: string, interval: Interval, usedWeight1m: number) => void;
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

/**
 * Merges by timestamp key (newBatch wins on overlap — the forming candle keeps updating), sorted
 * ascending, trimmed to windowSize.
 * TICKET-077 1.1: rewritten from a "drop everything at/after newBatch[0]" scheme to a keyed merge —
 * the old scheme silently deleted any buffered candle that fell in a poll's timestamp range but
 * wasn't itself returned (e.g. a transient gap on Binance's side), which is exactly the kind of
 * missing-candle case detectGaps()/backfill below needs to be able to see and repair.
 */
export function mergeCandles(buffer: CandleData[], newBatch: CandleData[], windowSize: number): CandleData[] {
  if (newBatch.length === 0) return buffer;
  const byTimestamp = new Map(buffer.map((c) => [c.timestamp, c]));
  for (const c of newBatch) byTimestamp.set(c.timestamp, c);
  const merged = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  return merged.length > windowSize ? merged.slice(merged.length - windowSize) : merged;
}

export interface CandleGap {
  afterTimestamp: number; // last known-good candle before the gap
  beforeTimestamp: number; // first known-good candle after the gap
  missingCount: number;
}

/** Finds gaps in an otherwise-ascending, evenly-spaced candle buffer (a candle missing entirely, not just stale). */
export function detectGaps(candles: CandleData[], intervalMs: number): CandleGap[] {
  const gaps: CandleGap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const expectedNext = candles[i - 1].timestamp + intervalMs;
    if (candles[i].timestamp > expectedNext) {
      const missingCount = Math.round((candles[i].timestamp - expectedNext) / intervalMs);
      gaps.push({ afterTimestamp: candles[i - 1].timestamp, beforeTimestamp: candles[i].timestamp, missingCount });
    }
  }
  return gaps;
}

/** A candle is only trustworthy as "final" once its nominal close time has passed by a small safety margin. */
export function isCandleClosed(candle: CandleData, intervalMs: number, nowMs: number): boolean {
  return nowMs >= candle.timestamp + intervalMs + CLOSE_SAFETY_BUFFER_MS;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface KlinesResult {
  candles: CandleData[];
  usedWeight1m?: number; // parsed from X-MBX-USED-WEIGHT-1m, undefined if the header is missing
}

/** Reads the mandatory Retry-After header on a 429/418 response — Binance says how long to wait, so a fixed exponential guess is never used when the exchange tells us explicitly. Falls back to exponential backoff only if the header is absent. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header !== null ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
}

async function fetchKlinesFromUrl(url: string): Promise<KlinesResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      const usedWeight1m = res.headers.get('x-mbx-used-weight-1m');
      // TICKET-077 1.2: 418 = IP auto-banned by Binance for ignoring 429s — treated identically to
      // 429 here (honor Retry-After, never retry immediately) but is the more severe of the two.
      if (res.status === 429 || res.status === 418) {
        const waitMs = retryAfterMs(res, attempt);
        if (attempt === MAX_RETRIES - 1) throw new Error(`HTTP ${res.status} sau ${MAX_RETRIES} lần thử (Retry-After tôn trọng mỗi lần): ${url}`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      const raw = (await res.json()) as RawKline[];
      return { candles: raw.map(parseKline), usedWeight1m: usedWeight1m !== null ? Number(usedWeight1m) : undefined };
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

function fetchKlines(baseUrl: string, symbol: string, interval: Interval, limit: number): Promise<KlinesResult> {
  return fetchKlinesFromUrl(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
}

/** TICKET-077 1.1: fetches an explicit [startTime, endTime] range to backfill a detected gap — same retry policy as the regular poll. */
function fetchKlinesRange(baseUrl: string, symbol: string, interval: Interval, startTime: number, endTime: number, limit: number = BACKFILL_LIMIT): Promise<KlinesResult> {
  return fetchKlinesFromUrl(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`);
}

/**
 * TICKET-G2R F-01 — explicit readiness state for the deep 5m session-volume window.
 * `INSUFFICIENT_WARMUP` is NOT "volume looks normal": the caller must withhold
 * `candles5mSessionVolume` AND block any decision that depends on LOW_LIQUIDITY, never silently
 * treat the absent field as "no low liquidity".
 */
export type SessionVolumeStatus = 'READY' | 'INSUFFICIENT_WARMUP';

export interface SessionVolumeWindow {
  status: SessionVolumeStatus;
  /** Defined ONLY when status === 'READY'. Exactly `required` contiguous closed 5m candles. */
  candles?: CandleData[];
  closedCount: number;
  required: number;
  reason?: 'NOT_ENOUGH_CANDLES' | 'GAP_IN_WINDOW';
}

/** Maintains an in-memory rolling buffer of candles per symbol/interval, refreshed by REST polling on independent per-interval timers. */
export class LiveCandleFeed {
  private readonly config: Required<Omit<LiveCandleFeedConfig, 'onError' | 'onPoll' | 'onGapFilled' | 'onWeightUpdate' | 'onThrottled'>> &
    Pick<LiveCandleFeedConfig, 'onError' | 'onPoll' | 'onGapFilled' | 'onWeightUpdate' | 'onThrottled'>;
  private readonly buffers: Map<string, CandleData[]> = new Map(); // key = `${symbol}:${interval}`
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  // TICKET-077 1.2: latest ground-truthed weight usage observed from ANY response's
  // X-MBX-USED-WEIGHT-1m header — shared across all symbols/intervals since Binance's limit is
  // per-IP, not per-endpoint.
  private lastKnownUsedWeight1m = 0;

  constructor(config: LiveCandleFeedConfig) {
    this.config = {
      symbols: config.symbols,
      baseUrl: config.baseUrl,
      windowSizes: { ...DEFAULT_WINDOW_SIZES, ...config.windowSizes },
      pollIntervalsMs: { ...DEFAULT_POLL_INTERVALS_MS, ...config.pollIntervalsMs },
      klineLimit: config.klineLimit ?? KLINE_LIMIT,
      onError: config.onError,
      onPoll: config.onPoll,
      onGapFilled: config.onGapFilled,
      onWeightUpdate: config.onWeightUpdate,
      onThrottled: config.onThrottled,
      setIntervalFn: config.setIntervalFn ?? setInterval,
      clearIntervalFn: config.clearIntervalFn ?? clearInterval,
    };
  }

  /** Most recent ground-truthed X-MBX-USED-WEIGHT-1m seen from any response so far (0 before the first poll). */
  getLastKnownUsedWeight1m(): number {
    return this.lastKnownUsedWeight1m;
  }

  private key(symbol: string, interval: Interval): string {
    return `${symbol}:${interval}`;
  }

  getCandles(symbol: string, interval: Interval): CandleData[] {
    return this.buffers.get(this.key(symbol, interval)) ?? [];
  }

  /** Only the candles safe to treat as final (nominal close time + safety buffer already elapsed) — the last 1-2 entries of getCandles() may still be excluded if they haven't settled yet. */
  getClosedCandles(symbol: string, interval: Interval, nowMs: number = Date.now()): CandleData[] {
    const intervalMs = INTERVAL_MS[interval];
    return this.getCandles(symbol, interval).filter((c) => isCandleClosed(c, intervalMs, nowMs));
  }

  /**
   * TICKET-G2R F-01 — the 5m window `sessionRelativeVolumeRatio` needs, or an explicit
   * INSUFFICIENT_WARMUP state. Contiguity is required, not just count: the metric addresses
   * i-288*k by INDEX, so a hole inside the window would silently compare the wrong time-of-day slot.
   */
  getSessionVolumeWindow(symbol: string, nowMs: number = Date.now()): SessionVolumeWindow {
    const required = SESSION_VOLUME_WINDOW_5M;
    const closed = this.getClosedCandles(symbol, '5m', nowMs);
    if (closed.length < required) return { status: 'INSUFFICIENT_WARMUP', closedCount: closed.length, required, reason: 'NOT_ENOUGH_CANDLES' };
    const window = closed.slice(closed.length - required);
    if (detectGaps(window, INTERVAL_MS['5m']).length > 0) {
      return { status: 'INSUFFICIENT_WARMUP', closedCount: closed.length, required, reason: 'GAP_IN_WINDOW' };
    }
    return { status: 'READY', candles: window, closedCount: closed.length, required };
  }

  private noteWeight(result: KlinesResult): void {
    if (result.usedWeight1m === undefined) return;
    this.lastKnownUsedWeight1m = result.usedWeight1m;
    this.config.onWeightUpdate?.(result.usedWeight1m, WEIGHT_LIMIT_PER_MINUTE);
  }

  /** TICKET-077 1.1: after every regular merge, checks the buffer for gaps and backfills them via an explicit [startTime, endTime] range request — a gap that fails to backfill surfaces through onError, never silently left in the buffer. */
  private async backfillGaps(symbol: string, interval: Interval): Promise<void> {
    const key = this.key(symbol, interval);
    const intervalMs = INTERVAL_MS[interval];
    const buffer = this.buffers.get(key) ?? [];
    const gaps = detectGaps(buffer, intervalMs);
    if (gaps.length === 0) return;

    try {
      for (const gap of gaps) {
        const backfill = await fetchKlinesRange(this.config.baseUrl, symbol, interval, gap.afterTimestamp + intervalMs, gap.beforeTimestamp - intervalMs);
        this.noteWeight(backfill);
        const windowSize = this.config.windowSizes[interval] ?? DEFAULT_WINDOW_SIZES[interval];
        this.buffers.set(key, mergeCandles(this.buffers.get(key) ?? [], backfill.candles, windowSize));
      }
      this.config.onGapFilled?.(symbol, interval, gaps);
    } catch (err) {
      this.config.onError?.(new Error(`backfillGaps(${symbol},${interval}) thất bại: ${(err as Error).message}`), symbol, interval);
    }
  }

  private async pollOnce(symbol: string, interval: Interval, limitOverride?: number, skipGapBackfill = false): Promise<void> {
    // TICKET-077 1.2: "tự động giãn interval khi gần chạm ngưỡng" — skipping this tick has the same
    // rate-reducing effect as widening the interval, without needing a scheduling refactor (weight
    // resets every rolling minute on Binance's side, so the next tick re-checks fresh).
    if (this.lastKnownUsedWeight1m / WEIGHT_LIMIT_PER_MINUTE > WEIGHT_SAFETY_THRESHOLD_PCT) {
      this.config.onThrottled?.(symbol, interval, this.lastKnownUsedWeight1m);
      return;
    }
    try {
      const result = await fetchKlines(this.config.baseUrl, symbol, interval, limitOverride ?? this.config.klineLimit);
      this.noteWeight(result);
      const key = this.key(symbol, interval);
      const windowSize = this.config.windowSizes[interval] ?? DEFAULT_WINDOW_SIZES[interval];
      const merged = mergeCandles(this.buffers.get(key) ?? [], result.candles, windowSize);
      this.buffers.set(key, merged);
      this.config.onPoll?.(symbol, interval, merged);
      // During a paged seed the older pages haven't arrived yet, so a "gap" here is just the part
      // still being paged in — start() runs one repair sweep after all pages instead.
      if (!skipGapBackfill) await this.backfillGaps(symbol, interval);
    } catch (err) {
      this.config.onError?.(err as Error, symbol, interval);
    }
  }

  /**
   * TICKET-G2R F-01 — seeds a FULL windowSize buffer at startup, paging backwards when windowSize
   * exceeds Binance's per-request cap (the 5m window needs 4 033 candles = 3 pages). Deliberately
   * uptime-independent: the buffer must be complete the moment start() returns, never accumulated
   * over hours of running, so a restart reproduces the same downstream state from the same data.
   * Idempotent — mergeCandles() is keyed by timestamp, so overlapping/duplicated pages collapse.
   */
  private async seedBackfill(symbol: string, interval: Interval, targetCount: number, requiredClosedCount: number = targetCount): Promise<void> {
    await this.pollOnce(symbol, interval, Math.min(targetCount, BINANCE_MAX_KLINES_LIMIT), true);
    if (targetCount <= BINANCE_MAX_KLINES_LIMIT) return;

    const key = this.key(symbol, interval);
    const intervalMs = INTERVAL_MS[interval];
    const windowSize = this.config.windowSizes[interval] ?? DEFAULT_WINDOW_SIZES[interval];

    for (let page = 1; page < MAX_SEED_BACKFILL_PAGES; page++) {
      const buffer = this.buffers.get(key) ?? [];
      if (buffer.length === 0) return; // first page failed — onError already fired inside pollOnce
      const closedCount = buffer.filter((c) => isCandleClosed(c, intervalMs, Date.now())).length;
      if (buffer.length >= targetCount && closedCount >= requiredClosedCount) return;

      const endTime = buffer[0].timestamp - 1; // strictly older than everything held
      if (endTime <= 0) return; // nothing can exist before the epoch — no further page to ask for
      const limit = Math.min(Math.max(targetCount - buffer.length, requiredClosedCount - closedCount), BINANCE_MAX_KLINES_LIMIT);
      const startTime = Math.max(0, endTime - limit * intervalMs);
      try {
        const older = await fetchKlinesRange(this.config.baseUrl, symbol, interval, startTime, endTime, limit);
        this.noteWeight(older);
        if (older.candles.length === 0) return; // exchange has no older history — nothing more to page
        this.buffers.set(key, mergeCandles(buffer, older.candles, windowSize));
        // A page that adds nothing new (all duplicates) would otherwise loop forever on the same endTime.
        if ((this.buffers.get(key) ?? []).length === buffer.length) return;
      } catch (err) {
        this.config.onError?.(new Error(`seedBackfill(${symbol},${interval}) trang ${page} thất bại: ${(err as Error).message}`), symbol, interval);
        return;
      }
    }
  }

  /**
   * Kicks off one immediate seed per symbol/interval BEFORE start() returns, requesting each
   * interval's FULL configured windowSize (not the regular per-poll klineLimit, default 3) — so a
   * caller has a complete history buffer immediately, instead of waiting real-time (potentially
   * hours, for a 320-candle 5m window at the default 2s poll) for the rolling poll to build it up
   * one batch at a time. Then starts the recurring timers at the regular klineLimit.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const intervals = Object.keys(INTERVAL_MS) as Interval[];

    await Promise.all(
      this.config.symbols.flatMap((symbol) =>
        intervals.map((interval) => {
          const windowSize = this.config.windowSizes[interval] ?? DEFAULT_WINDOW_SIZES[interval];
          const requiredClosedCount = interval === '5m' ? Math.min(SESSION_VOLUME_WINDOW_5M, windowSize) : windowSize;
          return this.seedBackfill(symbol, interval, windowSize, requiredClosedCount);
        }),
      ),
    );

    // A short/missing page leaves a hole; repair it through the same range-request path a runtime
    // gap uses, so the seeded buffer is contiguous before any decision reads it.
    await Promise.all(this.config.symbols.flatMap((symbol) => intervals.map((interval) => this.backfillGaps(symbol, interval))));

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
