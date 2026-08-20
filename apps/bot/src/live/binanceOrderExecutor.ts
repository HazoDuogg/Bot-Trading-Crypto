/**
 * TICKET-076 Phần B — Binance Futures order execution (REST, HMAC-SHA256 signed requests).
 *
 * SAFETY: `dryRun` defaults to `true`. While `dryRun` is true, every mutating call (open position,
 * place SL/TP, cancel, update) logs the exact request it WOULD have sent and returns without ever
 * calling the exchange — per TICKET-076's hard rule: no real order until PM confirms explicitly in
 * words. Flipping to live trading is a single explicit `dryRun: false` in the caller's config, never
 * a default.
 *
 * Retry policy (safety-driven, not just "retry N times"):
 *   - GET requests (account/position/server-time) are read-only and idempotent → retried with
 *     backoff on 429 and on network errors (same policy as scripts/fetchOhlcv.ts).
 *   - Mutating requests (place/cancel/replace order) are NEVER auto-retried once a response was
 *     received from Binance, even an error response — the caller must decide (a 400 might mean "bad
 *     params", but blindly retrying a MARKET order on an ambiguous failure risks a double fill).
 *     Only a network error that happened BEFORE any response was received (DNS/connection failure —
 *     the request never reached Binance) is safe to retry, bounded to MAX_MUTATING_RETRIES.
 *     A timeout is treated as UNKNOWN status, not retried — surfaced to the caller with an explicit
 *     warning to check getPositionRisk()/open orders before trying again.
 */
import { createHmac } from 'node:crypto';

export type PositionSide = 'LONG' | 'SHORT';

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
}

export interface BinanceOrderExecutorConfig {
  credentials: BinanceCredentials;
  dryRun?: boolean; // default true — see module doc above
  recvWindowMs?: number;
  requestTimeoutMs?: number;
  onOrderFailure?: (context: string, err: Error) => void;
  /** Fires whenever a mutating response includes the X-MBX-ORDER-COUNT-* headers — ground-truthed ORDERS rate-limit usage, separate from the REQUEST_WEIGHT tracked by liveCandleFeed.ts. */
  onOrderCountUpdate?: (count10s: number, limit10s: number, count1m: number, limit1m: number) => void;
  fetchFn?: typeof fetch;
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  status: string;
  raw: unknown;
}

/**
 * TICKET-077 1.3 — Binance bắt buộc (hiệu lực 09/12/2025, xác nhận qua error -4120
 * STOP_ORDER_SWITCH_ALGO) STOP_MARKET/TAKE_PROFIT_MARKET phải đi qua `/fapi/v1/algoOrder`, KHÔNG
 * còn qua `/fapi/v1/order` như MARKET/LIMIT. Đây là 2 KHÔNG GIAN ID HOÀN TOÀN KHÁC NHAU — `algoId`
 * không thể dùng lẫn với `orderId` ở bất kỳ đâu (cancel, tra cứu trạng thái...). Response shape xác
 * nhận thật qua test trên Testnet: `{algoId, clientAlgoId, algoType, algoStatus, ...}`.
 */
export interface AlgoOrderResult {
  algoId: number;
  symbol: string;
  algoStatus: string;
  raw: unknown;
}

/**
 * TICKET-G1R Final Closure item 2 — one currently-open SL/TP algo order as reported by
 * `getOpenAlgoOrders()` below. Field names follow the same `{algoId, algoStatus, raw}` shape
 * `AlgoOrderResult` above already uses for placement; `side`/`positionSide`/`origQty`/
 * `triggerPrice` are read defensively (see `getOpenAlgoOrders()` doc comment on the unverified
 * exact response envelope).
 */
/** Confirmed real values (see ALGO_ORDER_SCHEMA note on getOpenAlgoOrders()). Only NEW/TRIGGERING mean "still resting on the book". */
export const ACTIVE_ALGO_STATUSES = ['NEW', 'TRIGGERING'] as const;
/** Full known `algoStatus` union — the terminal ones must never appear on the open-orders endpoint; if one does, that is an anomaly, not "no order". */
export const KNOWN_ALGO_STATUSES = ['NEW', 'TRIGGERING', 'TRIGGERED', 'CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED'] as const;
export const KNOWN_ALGO_ORDER_TYPES = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'] as const;
export const KNOWN_POSITION_SIDES = ['BOTH', 'LONG', 'SHORT'] as const;
/** The two protective order types this bot actually places (placeStopMarket/placeTakeProfitMarket). */
export const PROTECTIVE_ALGO_ORDER_TYPES = ['STOP_MARKET', 'TAKE_PROFIT_MARKET'] as const;

export interface OpenAlgoOrder {
  algoId: number;
  /** TICKET-G1R-A item 2 — Binance's own client-supplied order ID, if the real schema carries one under this name; read defensively (see getOpenAlgoOrders() doc comment on the unconfirmed exact field name). Undefined when absent/unparseable — never fabricated. */
  clientAlgoId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: (typeof KNOWN_POSITION_SIDES)[number];
  /** Base-asset quantity. Real schema carries it as `quantity` (string); `origQty` is accepted as a fallback name but was NOT present in the confirmed testnet response. */
  origQty: number;
  triggerPrice: number;
  algoStatus: string;
  /** TICKET-G1R-A "Final Internal Closure" item 3 — confirmed present on the real response as `orderType` (STOP_MARKET/TAKE_PROFIT_MARKET/...). This is what lets item 4 tell an SL apart from a TP by evidence rather than by which local list the ID came from. */
  orderType: (typeof KNOWN_ALGO_ORDER_TYPES)[number];
  /** Confirmed present as `algoType` (only value observed/documented: 'CONDITIONAL'). */
  algoType: string;
  /** TICKET-G1R-A item 2 — reduce-only flag, read defensively from whichever of reduceOnly/closePosition the real response carries (schema unconfirmed, see doc comment below). Undefined when neither field is present/parseable. */
  reduceOnly?: boolean;
  /** TICKET-G1R-A item 2 — Binance Futures' "close entire position" flag (distinct from reduceOnly — closePosition ignores quantity and always closes 100%). Undefined when absent/unparseable. */
  closePosition?: boolean;
  raw: unknown;
}

/**
 * TICKET-G1R-A "Final Internal Closure" item 3 — STRICT per-entry parser. Replaces the old lenient
 * mapping whose `side: o.side === 'SELL' ? 'SELL' : 'BUY'` silently turned `undefined`/`null`/a typo
 * into a valid-looking `'BUY'`, which could make verifyProtectiveSlOrder()/verifyProtectiveTpOrder()
 * accept a malformed order as correctly-sided and defeat the whole protective-order check.
 *
 * FAIL-CLOSED INVARIANT: anything unrecognised THROWS. The caller
 * (captureCoherentReconciliationSnapshotOnce) turns a throw into READ_ERROR ->
 * ACCOUNT_STATE_UNKNOWN -> portfolio-wide entry block. A malformed response must never be
 * indistinguishable from "this position has no protective orders".
 *
 * Fields required by the confirmed exchange schema are mandatory. Missing semantic fields are a
 * hard error; otherwise a malformed order could be accepted as protective by omission.
 */
export function parseOpenAlgoOrderEntry(entry: unknown, fallbackSymbol?: string): OpenAlgoOrder {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`getOpenAlgoOrders: algo order entry không phải object: ${JSON.stringify(entry)}`);
  }
  const o = entry as Record<string, unknown>;
  // Explicit annotation on the CONST (not just the arrow) — required for TS control-flow narrowing
  // to treat a `fail(...)` call as unreachable-after.
  const fail: (why: string) => never = (why) => {
    throw new Error(`getOpenAlgoOrders: ${why}: ${JSON.stringify(entry)}`);
  };

  const algoId = Number(o.algoId);
  if (!Number.isFinite(algoId) || algoId <= 0) fail(`algoId không hữu hạn hoặc <= 0`);

  const symbol = typeof o.symbol === 'string' && o.symbol !== '' ? o.symbol : fallbackSymbol;
  if (typeof symbol !== 'string' || symbol === '') fail(`symbol rỗng/thiếu và không có fallback symbol`);

  if (o.side !== 'BUY' && o.side !== 'SELL') fail(`side phải đúng 'BUY' hoặc 'SELL', nhận được ${JSON.stringify(o.side)}`);
  const side = o.side as 'BUY' | 'SELL';

  if (typeof o.positionSide !== 'string' || !(KNOWN_POSITION_SIDES as readonly string[]).includes(o.positionSide)) {
    fail(`positionSide thiếu/không hợp lệ (chỉ chấp nhận ${KNOWN_POSITION_SIDES.join('/')}), nhận được ${JSON.stringify(o.positionSide)}`);
  }
  const positionSide = o.positionSide as (typeof KNOWN_POSITION_SIDES)[number];

  const origQty = Number(o.quantity ?? o.origQty);
  if (!Number.isFinite(origQty) || origQty <= 0) fail(`quantity/origQty không hữu hạn hoặc <= 0`);

  const triggerPrice = Number(o.triggerPrice ?? o.stopPrice);
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) fail(`triggerPrice/stopPrice không hữu hạn hoặc <= 0`);

  const algoStatus = o.algoStatus ?? o.status;
  if (typeof algoStatus !== 'string' || !(KNOWN_ALGO_STATUSES as readonly string[]).includes(algoStatus)) {
    fail(`algoStatus lạ/không phải string (biết: ${KNOWN_ALGO_STATUSES.join('/')}), nhận được ${JSON.stringify(algoStatus)}`);
  }
  if (!(ACTIVE_ALGO_STATUSES as readonly string[]).includes(algoStatus as string)) {
    // A terminal status on the OPEN-orders endpoint is an anomaly. Reject rather than filter it out
    // silently — dropping it would look identical to "no protective order exists".
    fail(`algoStatus='${String(algoStatus)}' không còn active (chỉ chấp nhận ${ACTIVE_ALGO_STATUSES.join('/')}) trên endpoint open-orders`);
  }

  if (typeof o.orderType !== 'string' || !(KNOWN_ALGO_ORDER_TYPES as readonly string[]).includes(o.orderType)) {
    fail(`orderType thiếu/không hợp lệ (biết: ${KNOWN_ALGO_ORDER_TYPES.join('/')}), nhận được ${JSON.stringify(o.orderType)}`);
  }
  const orderType = o.orderType as (typeof KNOWN_ALGO_ORDER_TYPES)[number];

  if (typeof o.algoType !== 'string' || o.algoType === '') fail(`algoType thiếu hoặc không phải string non-empty`);
  const algoType = o.algoType as string;
  if (o.reduceOnly === undefined && o.closePosition === undefined) {
    fail(`thiếu cả reduceOnly và closePosition; không thể chứng minh semantics đóng vị thế`);
  }

  return {
    algoId,
    clientAlgoId: typeof o.clientAlgoId === 'string' ? o.clientAlgoId : undefined,
    symbol,
    side,
    positionSide,
    origQty,
    triggerPrice,
    algoStatus: algoStatus as string,
    orderType,
    algoType,
    reduceOnly: normalizeAlgoBoolean(o.reduceOnly, 'reduceOnly', fail),
    closePosition: normalizeAlgoBoolean(o.closePosition, 'closePosition', fail),
    raw: entry,
  };
}

/**
 * The confirmed testnet response returns REAL booleans here. Binance's REQUEST side documents these
 * as the strings "true"/"false", so both are normalized — but anything else throws rather than
 * defaulting to `false`, which would silently read as "this is not a reduce-only order".
 */
function normalizeAlgoBoolean(value: unknown, field: string, fail: (why: string) => never): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`${field} có mặt nhưng không phải boolean/"true"/"false", nhận được ${JSON.stringify(value)}`);
}

export interface DryRunResult {
  dryRun: true;
  method: string;
  path: string;
  params: Record<string, string | number | boolean>;
}

/**
 * TICKET-099 Phần A — real per-symbol precision/size limits from GET /fapi/v1/exchangeInfo (LOT_SIZE,
 * PRICE_FILTER, MIN_NOTIONAL). Fixes a real limitation liveRunner.ts's module doc had flagged since
 * TICKET-086: quantity/price were rounded to a fixed decimal count (3/2), not each symbol's actual
 * stepSize/tickSize — a real rejection risk once size/price magnitude differs enough across symbols
 * (e.g. XRP's price needs 4 decimals, BTC's quantity needs far fewer than 3).
 */
export interface SymbolFilters {
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
  /** Decimal digit count derived directly from Binance's raw string (e.g. "0.00100000" -> 3), not re-derived from the parsed float — avoids floating-point round-trip error. */
  stepSizeDecimals: number;
  tickSizeDecimals: number;
}

/** Counts decimal digits from Binance's own string representation (e.g. "0.00100000" -> 3) — avoids floating-point round-trip error from parsing then re-deriving decimals numerically. */
function decimalsFromFilterString(value: string): number {
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  const dotIndex = trimmed.indexOf('.');
  return dotIndex === -1 ? 0 : trimmed.length - dotIndex - 1;
}

const DEFAULT_RECV_WINDOW_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MUTATING_RETRIES = 3; // only for pre-response network failures, see module doc
const MAX_READ_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on 429/network error, same policy as fetchOhlcv.ts
// TICKET-077 1.2 follow-up: ground-truthed from GET /fapi/v1/exchangeInfo's `rateLimits` array
// (ORDERS type) — a SEPARATE budget from REQUEST_WEIGHT (tracked in liveCandleFeed.ts). Order
// place/cancel/replace calls burn ORDERS budget, not REQUEST_WEIGHT budget, so they need their own
// tracking — this was missing entirely before, a real gap PM caught before Bước 1.3's rapid
// place→fill→move-SL→move-TP→partial-close sequences could exercise it.
const ORDER_COUNT_LIMIT_PER_10S = 300;
const ORDER_COUNT_LIMIT_PER_MINUTE = 1200;
// Same 40%-margin policy as liveCandleFeed.ts's WEIGHT_SAFETY_THRESHOLD_PCT.
const ORDER_SAFETY_THRESHOLD_PCT = 0.6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sign(queryString: string, secret: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

function buildQueryString(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** True when the error happened before any HTTP response was received (DNS/connection failure — request never reached Binance). Node's fetch throws a plain TypeError for these; anything else (including AbortError from our own timeout) is treated as ambiguous, not safe to retry. */
function isPreResponseNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export class BinanceOrderExecutor {
  private readonly creds: BinanceCredentials;
  private readonly dryRun: boolean;
  private readonly recvWindowMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onOrderFailure?: (context: string, err: Error) => void;
  private readonly onOrderCountUpdate?: (count10s: number, limit10s: number, count1m: number, limit1m: number) => void;
  private readonly fetchFn: typeof fetch;
  // Binance rejects a signed request if `timestamp` drifts from the server's clock by more than
  // recvWindow (error -1021). The local machine's clock is not guaranteed to match Binance's —
  // syncClock() measures the offset once via the public (unsigned) /fapi/v1/time endpoint and every
  // signed request adds it to Date.now() from then on.
  private clockOffsetMs = 0;
  // TICKET-077 1.2 follow-up: latest ground-truthed ORDERS usage from X-MBX-ORDER-COUNT-* headers.
  private lastKnownOrderCount10s = 0;
  private lastKnownOrderCount1m = 0;
  // TICKET-099 Phần A: loaded once via loadExchangeInfo() at startup, before any real order.
  private symbolFilters = new Map<string, SymbolFilters>();

  constructor(config: BinanceOrderExecutorConfig) {
    this.creds = config.credentials;
    this.dryRun = config.dryRun ?? true;
    this.recvWindowMs = config.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onOrderFailure = config.onOrderFailure;
    this.onOrderCountUpdate = config.onOrderCountUpdate;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  getLastKnownOrderCount10s(): number {
    return this.lastKnownOrderCount10s;
  }

  getLastKnownOrderCount1m(): number {
    return this.lastKnownOrderCount1m;
  }

  /** True when either ORDERS window is over the safety margin — the caller (Bước 1.3's rapid place→move-SL→move-TP→partial-close sequences) must check this explicitly before issuing another mutating call; this class never silently waits or retries on its own. */
  isOrderRateThrottled(): boolean {
    return this.lastKnownOrderCount10s / ORDER_COUNT_LIMIT_PER_10S > ORDER_SAFETY_THRESHOLD_PCT || this.lastKnownOrderCount1m / ORDER_COUNT_LIMIT_PER_MINUTE > ORDER_SAFETY_THRESHOLD_PCT;
  }

  private noteOrderCount(res: Response): void {
    const count10sHeader = res.headers.get('x-mbx-order-count-10s');
    const count1mHeader = res.headers.get('x-mbx-order-count-1m');
    if (count10sHeader === null && count1mHeader === null) return;
    if (count10sHeader !== null) this.lastKnownOrderCount10s = Number(count10sHeader);
    if (count1mHeader !== null) this.lastKnownOrderCount1m = Number(count1mHeader);
    this.onOrderCountUpdate?.(this.lastKnownOrderCount10s, ORDER_COUNT_LIMIT_PER_10S, this.lastKnownOrderCount1m, ORDER_COUNT_LIMIT_PER_MINUTE);
  }

  /** Measures local-clock vs Binance-server-clock offset and stores it for every subsequent signed request. Call once at startup before any signed (GET or mutating) call. Returns the offset in ms (serverTime − localTime; positive means the local clock is behind). */
  async syncClock(): Promise<number> {
    const before = Date.now();
    const serverTime = await this.getServerTime();
    const after = Date.now();
    const localAtResponse = Math.round((before + after) / 2);
    this.clockOffsetMs = serverTime - localAtResponse;
    return this.clockOffsetMs;
  }

  private signedTimestamp(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Signed GET — safe to retry (read-only, idempotent). */
  private async signedGet(path: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
    const full = { ...params, timestamp: this.signedTimestamp(), recvWindow: this.recvWindowMs };
    const qs = buildQueryString(full);
    const signature = sign(qs, this.creds.apiSecret);
    const url = `${this.creds.baseUrl}${path}?${qs}&signature=${signature}`;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, { method: 'GET', headers: { 'X-MBX-APIKEY': this.creds.apiKey } });
        if (res.status === 429) {
          if (attempt === MAX_READ_RETRIES - 1) throw new Error(`429 rate-limited after ${MAX_READ_RETRIES} attempts: ${path}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${path}: ${await res.text()}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt === MAX_READ_RETRIES - 1) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  /**
   * Signed mutating request (order place/cancel). NEVER retried once a response is received.
   * Only retries a pre-response network failure (request never reached Binance), bounded.
   * Throws with a clear message on every failure path — the caller (and onOrderFailure) always
   * finds out; nothing is swallowed.
   */
  private async signedMutate(method: 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean>, context: string): Promise<unknown> {
    // TICKET-077 1.2 follow-up: checked BEFORE sending, using the ORDERS usage observed from the
    // PREVIOUS mutating call — refuses outright rather than silently waiting/retrying (an order
    // action is time-sensitive; only the caller can decide whether waiting is safe right now).
    if (this.isOrderRateThrottled()) {
      const err = new Error(
        `[${context}] TỪ CHỐI GỬI — ORDERS rate limit gần chạm ngưỡng an toàn (10s: ${this.lastKnownOrderCount10s}/${ORDER_COUNT_LIMIT_PER_10S}, 1m: ${this.lastKnownOrderCount1m}/${ORDER_COUNT_LIMIT_PER_MINUTE}). Không tự động chờ/retry — caller phải quyết định.`,
      );
      this.onOrderFailure?.(context, err);
      throw err;
    }

    const full = { ...params, timestamp: this.signedTimestamp(), recvWindow: this.recvWindowMs };
    const qs = buildQueryString(full);
    const signature = sign(qs, this.creds.apiSecret);
    const url = `${this.creds.baseUrl}${path}?${qs}&signature=${signature}`;

    for (let attempt = 0; attempt < MAX_MUTATING_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, { method, headers: { 'X-MBX-APIKEY': this.creds.apiKey } });
        this.noteOrderCount(res);
        if (!res.ok) {
          const body = await res.text();
          const err = new Error(`[${context}] HTTP ${res.status} ${res.statusText}: ${body} (KHÔNG tự retry — lệnh có thể đã chạm sàn, cần kiểm tra trạng thái thủ công trước khi thử lại)`);
          this.onOrderFailure?.(context, err);
          throw err;
        }
        return await res.json();
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`[${context}]`)) throw err; // already logged above, an HTTP-response failure — never retry
        if (isPreResponseNetworkError(err) && attempt < MAX_MUTATING_RETRIES - 1) {
          console.warn(`[${context}] lỗi mạng trước khi gửi được request (thử lại ${attempt + 1}/${MAX_MUTATING_RETRIES}): ${(err as Error).message}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const finalErr = new Error(
          `[${context}] ${isTimeout ? 'TIMEOUT — trạng thái lệnh KHÔNG XÁC ĐỊNH, PHẢI kiểm tra getPositionRisk()/open orders trước khi thử lại' : `lỗi mạng: ${(err as Error).message}`}`,
        );
        this.onOrderFailure?.(context, finalErr);
        throw finalErr;
      }
    }
    throw new Error(`[${context}] unreachable retry exhaustion`); // MAX_MUTATING_RETRIES >= 1 always returns/throws above
  }

  private logOrDryRun(method: string, path: string, params: Record<string, string | number | boolean>, context: string): DryRunResult | null {
    if (!this.dryRun) return null;
    console.log(`[DRY_RUN] ${context}: ${method} ${path} ${JSON.stringify(params)}`);
    return { dryRun: true, method, path, params };
  }

  // --- Public read-only endpoints (never gated by dryRun — no money at risk) ---

  /**
   * TICKET-086 — found via a real dry-run soak test: a single transient network blip
   * (ECONNRESET) here killed the whole process at startup (syncClock() calls this first, before
   * anything else). This is a plain read-only GET, same retry policy as signedGet()'s own —
   * "GET requests... retried with backoff on 429 and on network errors" per this file's own doc
   * comment — just missed here since it predates signedGet()'s retry loop.
   */
  async getServerTime(): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(`${this.creds.baseUrl}/fapi/v1/time`, { method: 'GET' });
        if (res.status === 429) {
          if (attempt === MAX_READ_RETRIES - 1) throw new Error(`429 rate-limited after ${MAX_READ_RETRIES} attempts: /fapi/v1/time`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on /fapi/v1/time`);
        const body = (await res.json()) as { serverTime: number };
        return body.serverTime;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_READ_RETRIES - 1) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  /**
   * TICKET-099 Phần A — public (unsigned), read-only, same retry policy as getServerTime() above.
   * Caller MUST call this once at startup (for every symbol it will ever trade) BEFORE issuing any
   * real order — every mutating method below throws if a symbol's filters aren't loaded yet, rather
   * than silently falling back to a guessed precision.
   */
  async loadExchangeInfo(symbols: string[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(`${this.creds.baseUrl}/fapi/v1/exchangeInfo`, { method: 'GET' });
        if (res.status === 429) {
          if (attempt === MAX_READ_RETRIES - 1) throw new Error(`429 rate-limited after ${MAX_READ_RETRIES} attempts: /fapi/v1/exchangeInfo`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on /fapi/v1/exchangeInfo`);
        const body = (await res.json()) as { symbols: Array<{ symbol: string; filters: Array<Record<string, string>> }> };
        const wanted = new Set(symbols);
        for (const s of body.symbols) {
          if (!wanted.has(s.symbol)) continue;
          const lotSize = s.filters.find((f) => f.filterType === 'LOT_SIZE');
          const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
          // Binance Futures uses filterType='MIN_NOTIONAL' with field `notional` (not `minNotional` like Spot).
          const minNotionalFilter = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
          if (!lotSize || !priceFilter) {
            throw new Error(`loadExchangeInfo: thiếu LOT_SIZE/PRICE_FILTER cho ${s.symbol} trong response /fapi/v1/exchangeInfo`);
          }
          this.symbolFilters.set(s.symbol, {
            stepSize: Number(lotSize.stepSize),
            minQty: Number(lotSize.minQty),
            tickSize: Number(priceFilter.tickSize),
            minNotional: minNotionalFilter ? Number(minNotionalFilter.notional) : 0,
            stepSizeDecimals: decimalsFromFilterString(lotSize.stepSize),
            tickSizeDecimals: decimalsFromFilterString(priceFilter.tickSize),
          });
        }
        const missing = symbols.filter((sym) => !this.symbolFilters.has(sym));
        if (missing.length > 0) {
          throw new Error(`loadExchangeInfo: không tìm thấy symbol trong response: ${missing.join(', ')}`);
        }
        return;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_READ_RETRIES - 1) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  getSymbolFilters(symbol: string): SymbolFilters {
    const f = this.symbolFilters.get(symbol);
    if (f === undefined) {
      throw new Error(`getSymbolFilters(${symbol}): chưa load — gọi loadExchangeInfo([...]) một lần lúc khởi động trước khi đặt lệnh thật.`);
    }
    return f;
  }

  /** TICKET-099 Phần A: rounds DOWN to stepSize (never rounds up past the caller's intended size) and rejects below minQty rather than silently sending an invalid tiny order. */
  /** `enforceMinQty=false` for reduceOnly closes — a small leftover position remainder is legitimate to close even below the exchange's minQty for OPENING a new position. */
  private roundQtyToStepSize(symbol: string, qty: number, enforceMinQty = true): number {
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`roundQtyToStepSize(${symbol}): quantity ${qty} phải là số hữu hạn > 0 — không gửi lệnh.`);
    }
    const { stepSize, minQty, stepSizeDecimals } = this.getSymbolFilters(symbol);
    const steps = Math.floor(qty / stepSize + 1e-9); // +epsilon guards against qty/stepSize landing just under an integer due to float error
    const rounded = Number((steps * stepSize).toFixed(stepSizeDecimals));
    if (enforceMinQty && rounded < minQty) {
      throw new Error(`roundQtyToStepSize(${symbol}): quantity ${rounded} (từ ${qty}) < minQty ${minQty} — không gửi lệnh.`);
    }
    return rounded;
  }

  /** TICKET-099 Phần A: rounds to the nearest tickSize (Binance rejects any price not an exact multiple). */
  private roundPriceToTickSize(symbol: string, price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`roundPriceToTickSize(${symbol}): price ${price} phải là số hữu hạn > 0 — không gửi lệnh.`);
    }
    const { tickSize, tickSizeDecimals } = this.getSymbolFilters(symbol);
    const ticks = Math.round(price / tickSize);
    return Number((ticks * tickSize).toFixed(tickSizeDecimals));
  }

  private roundPriceDownToTickSize(symbol: string, price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`roundPriceDownToTickSize(${symbol}): price ${price} phải là số hữu hạn > 0 — không gửi lệnh.`);
    }
    const { tickSize, tickSizeDecimals } = this.getSymbolFilters(symbol);
    const ticks = Math.floor(price / tickSize + 1e-9);
    const rounded = Number((ticks * tickSize).toFixed(tickSizeDecimals));
    if (rounded <= 0) {
      throw new Error(`roundPriceDownToTickSize(${symbol}): price ${price} làm tròn xuống thành ${rounded} — không gửi lệnh.`);
    }
    return rounded;
  }

  /** TICKET-099 Phần A: MIN_NOTIONAL check — Binance rejects an order below this dollar value outright. */
  private checkMinNotional(symbol: string, price: number, qty: number): void {
    const { minNotional } = this.getSymbolFilters(symbol);
    const notional = price * qty;
    if (minNotional > 0 && notional < minNotional) {
      throw new Error(`checkMinNotional(${symbol}): giá trị lệnh $${notional.toFixed(2)} (price=${price} × qty=${qty}) < minNotional $${minNotional} — không gửi lệnh.`);
    }
  }

  async getAccountInfo(): Promise<unknown> {
    return this.signedGet('/fapi/v2/account');
  }

  async getPositionRisk(symbol?: string): Promise<unknown> {
    return this.signedGet('/fapi/v2/positionRisk', symbol ? { symbol } : {});
  }

  /**
   * TICKET-107 — GET /fapi/v1/income: real REALIZED_PNL/COMMISSION/FUNDING_FEE entries Binance
   * itself recorded, per symbol/time-window. Read-only, never gated by dryRun (same convention as
   * getAccountInfo/getPositionRisk). Building block for reconciling Telegram PNL/accountBalance
   * against the exchange's actual numbers instead of the hand-computed takerFeeRate-based estimate
   * in computeRealizedPnl()/computeTierNetPnl() — NOT wired into any automatic override yet (see
   * computeTierNetPnl's doc comment: attributing income entries to one specific logical position is
   * ambiguous when config.maxConcurrentPositionsPerSymbol > 1, needs PM to confirm position mode
   * first). `limit` caps the page size Binance returns (max 1000 per their docs).
   */
  /**
   * TICKET-G1R-A "Final Internal Closure" item 2 — `symbol` is now OPTIONAL and only ever added to the
   * query when non-empty. It used to be `symbol: string` spread unconditionally, so the whole-account
   * call site (liveStateSync.ts's coherent-snapshot "fills" leg) sent a literal `symbol=` to Binance
   * instead of omitting the filter. Same conditional-spread pattern as getPositionRisk()/
   * getOpenAlgoOrders() above. startTime/endTime/limit semantics unchanged.
   */
  async getIncome(symbol: string | undefined, startTime: number, endTime: number, limit = 1000): Promise<unknown> {
    const params: Record<string, string | number | boolean> = { startTime, endTime, limit };
    if (typeof symbol === 'string' && symbol.trim() !== '') params.symbol = symbol;
    return this.signedGet('/fapi/v1/income', params);
  }

  /**
   * TICKET-G1R Final Closure item 2 — reads currently-OPEN SL/TP algo orders (STOP_MARKET/
   * TAKE_PROFIT_MARKET, placed via `placeStopMarket()`/`placeTakeProfitMarket()` above) for
   * protective-order reconciliation after restart. Read-only, never gated by dryRun (same
   * convention as getAccountInfo/getPositionRisk/getIncome).
   *
   * TICKET-G1R-A "Final Internal Closure" item 5 — ENDPOINT **AND RESPONSE SCHEMA CONFIRMED**
   * (DQ-A). Path: `GET /fapi/v1/openAlgoOrders`. Two independent sources agree:
   * - Docs/typed connectors: Binance `New-Algo-Order` docs page + `tiagosiebler/binance`
   *   (`src/usdm-client.ts` `getOpenAlgoOrders() => Promise<FuturesAlgoOrderResponse[]>`, i.e. a
   *   BARE ARRAY, and `src/types/futures.ts` for the field/union definitions).
   * - One bounded, read-only, explicitly-authorized TESTNET GET performed 2026-08-11 against a
   *   testnet account holding 8 resting orders. Sanitized capture (no key/secret/signature/URL):
   *   `src/live/fixtures/openAlgoOrdersResponseFixture.json` + its `.md` provenance note.
   *
   * CONFIRMED FACTS the parser below now relies on:
   * - Envelope: BARE ARRAY (never `{orders:[...]}`). The `.orders` fallback is kept only as a
   *   defensive accept, not as an expectation.
   * - Quantity field is `quantity` (a STRING). `origQty` is ABSENT — the `?? o.quantity` fallback
   *   this parser already had is what made it work; the `origQty` name is now the fallback, not the
   *   primary.
   * - Trigger field is `triggerPrice` (STRING). `stopPrice` is ABSENT.
   * - Status field is `algoStatus` (STRING). `status` is ABSENT.
   * - `reduceOnly`/`closePosition`/`priceProtect` are REAL BOOLEANS, not "true"/"false" strings
   *   (the request side takes BooleanString; the response side does not). Both spellings are still
   *   normalized below so a future response-format change fails loudly rather than reading false.
   * - `orderType` distinguishes STOP_MARKET vs TAKE_PROFIT_MARKET; `algoType` was always
   *   `CONDITIONAL`; `positionSide` was `BOTH` (One-Way account).
   *
   * HONEST LIMITATION: every one of the 8 observed orders was TAKE_PROFIT_MARKET / BOTH / NEW /
   * reduceOnly=true. STOP_MARKET, LONG/SHORT positionSide, and the TRIGGERING status are taken from
   * the typed-connector unions (same endpoint, same `CONDITIONAL` algoType), not from a directly
   * observed row.
   */
  async getOpenAlgoOrders(symbol?: string): Promise<OpenAlgoOrder[]> {
    const raw = await this.signedGet('/fapi/v1/openAlgoOrders', symbol ? { symbol } : {});
    const list: unknown[] | undefined = Array.isArray(raw) ? raw : (raw as { orders?: unknown[] } | null | undefined)?.orders;
    if (!Array.isArray(list)) {
      throw new Error(`getOpenAlgoOrders: response shape không như dự kiến (không phải mảng, không có field .orders là mảng) — endpoint path/response envelope CHƯA được xác nhận thật, cần kiểm tra thủ công: ${JSON.stringify(raw)}`);
    }
    return list.map((entry) => parseOpenAlgoOrderEntry(entry, symbol));
  }

  // --- Mutating endpoints (gated by dryRun) ---

  /**
   * TICKET-100 — PHÁT HIỆN: code trước đây KHÔNG BAO GIỜ gọi POST /fapi/v1/leverage — chỉ GIẢ ĐỊNH
   * tài khoản đã sẵn đúng đòn bẩy cấu hình (30x), lấy nguyên từ setting có sẵn trên sàn (có thể bị
   * đổi tay, đổi nhầm, hoặc chưa từng set cho symbol đó — sàn mặc định 20x cho tài khoản mới). Nếu
   * đòn bẩy thật trên sàn khác CONFIG.leverage, mọi phép tính size/risk$ (DynamicRMarginSizer) đều
   * SAI mà không có cách nào tự phát hiện. Hàm này CHỦ ĐỘNG đặt đúng đòn bẩy, gọi 1 lần/symbol lúc
   * khởi động — same dryRun-gated convention như mọi mutating call khác trong class này.
   */
  async setLeverage(symbol: string, leverage: number): Promise<{ leverage: number; symbol: string; raw: unknown } | DryRunResult> {
    const params = { symbol, leverage };
    const dry = this.logOrDryRun('POST', '/fapi/v1/leverage', params, `setLeverage(${symbol},${leverage})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/leverage', params, `setLeverage(${symbol},${leverage})`)) as { leverage: number; symbol: string };
    return { leverage: raw.leverage, symbol, raw };
  }

  async openMarketPosition(symbol: string, side: PositionSide, quantity: number, referencePrice: number): Promise<OrderResult | DryRunResult> {
    const roundedPrice = this.roundPriceDownToTickSize(symbol, referencePrice);
    const roundedQty = this.roundQtyToStepSize(symbol, quantity);
    this.checkMinNotional(symbol, roundedPrice, roundedQty);
    const params = { symbol, side: side === 'LONG' ? 'BUY' : 'SELL', type: 'MARKET', quantity: roundedQty };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `openMarketPosition(${symbol},${side})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `openMarketPosition(${symbol},${side})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: LIMIT order to open a position (GTC — stays on the book until filled or cancelled). */
  async placeLimitOrder(symbol: string, side: PositionSide, price: number, quantity: number): Promise<OrderResult | DryRunResult> {
    const roundedPrice = this.roundPriceToTickSize(symbol, price);
    const roundedQty = this.roundQtyToStepSize(symbol, quantity);
    this.checkMinNotional(symbol, roundedPrice, roundedQty);
    const params = { symbol, side: side === 'LONG' ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'GTC', price: roundedPrice, quantity: roundedQty };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `placeLimitOrder(${symbol},${side})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `placeLimitOrder(${symbol},${side})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: MARKET close (full or partial via `quantity`) — reduceOnly so it can never accidentally open/flip a position. */
  async closePositionMarket(symbol: string, positionSide: PositionSide, quantity: number): Promise<OrderResult | DryRunResult> {
    const roundedQty = this.roundQtyToStepSize(symbol, quantity, false); // reduceOnly close — don't reject a small dust remainder
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: roundedQty, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `closePositionMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `closePositionMarket(${symbol},${positionSide})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: đi qua `/fapi/v1/algoOrder` (bắt buộc từ 09/12/2025) — trả về `algoId`, KHÔNG PHẢI `orderId`. */
  async placeStopMarket(symbol: string, positionSide: PositionSide, triggerPrice: number, quantity: number): Promise<AlgoOrderResult | DryRunResult> {
    const roundedPrice = this.roundPriceToTickSize(symbol, triggerPrice);
    const roundedQty = this.roundQtyToStepSize(symbol, quantity, false); // reduceOnly (SL) — don't reject a small dust remainder
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice: roundedPrice, quantity: roundedQty, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/algoOrder', params, `placeStopMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/algoOrder', params, `placeStopMarket(${symbol},${positionSide})`)) as { algoId: number; algoStatus: string };
    return { algoId: raw.algoId, symbol, algoStatus: raw.algoStatus, raw };
  }

  /** TICKET-077 1.3: đi qua `/fapi/v1/algoOrder` (bắt buộc từ 09/12/2025) — trả về `algoId`, KHÔNG PHẢI `orderId`. */
  async placeTakeProfitMarket(symbol: string, positionSide: PositionSide, triggerPrice: number, quantity: number): Promise<AlgoOrderResult | DryRunResult> {
    const roundedPrice = this.roundPriceToTickSize(symbol, triggerPrice);
    const roundedQty = this.roundQtyToStepSize(symbol, quantity, false); // reduceOnly (TP) — don't reject a small dust remainder
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', algoType: 'CONDITIONAL', type: 'TAKE_PROFIT_MARKET', triggerPrice: roundedPrice, quantity: roundedQty, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/algoOrder', params, `placeTakeProfitMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/algoOrder', params, `placeTakeProfitMarket(${symbol},${positionSide})`)) as { algoId: number; algoStatus: string };
    return { algoId: raw.algoId, symbol, algoStatus: raw.algoStatus, raw };
  }

  /** Hủy lệnh MARKET/LIMIT thường (`/fapi/v1/order`, dùng `orderId`) — KHÔNG dùng cho SL/TP, xem `cancelAlgoOrder()`. */
  async cancelOrder(symbol: string, orderId: number): Promise<unknown | DryRunResult> {
    const params = { symbol, orderId };
    const dry = this.logOrDryRun('DELETE', '/fapi/v1/order', params, `cancelOrder(${symbol},${orderId})`);
    if (dry) return dry;
    return this.signedMutate('DELETE', '/fapi/v1/order', params, `cancelOrder(${symbol},${orderId})`);
  }

  /**
   * Hủy lệnh SL/TP (`/fapi/v1/algoOrder`, dùng `algoId` — KHÔNG PHẢI `orderId`, 2 không gian ID
   * khác nhau).
   *
   * TICKET-077 1.3 Bước D — PHÁT HIỆN THẬT trên mainnet: Binance KHÔNG tự hủy Algo Order (SL/TP)
   * còn treo sau khi vị thế đã đóng hết — chúng vẫn NẰM TRÊN SÀN chờ trigger dù vị thế đã về 0.
   * CỐ Ý KHÔNG cung cấp API "hủy tất cả theo symbol" (`DELETE /fapi/v1/algoOpenOrders`) — đã thử
   * ban đầu nhưng PM chỉ ra đúng: với tối đa 2 vị thế/coin (TICKET-056), hủy theo symbol sẽ XÓA NHẦM
   * SL/TP của vị thế KHÁC đang mở cùng coin. Caller (orchestrator sau này) PHẢI tự lưu đúng `algoId`
   * của SL/TP thuộc về TỪNG vị thế cụ thể lúc đặt, và khi đóng đúng vị thế đó thì gọi hàm này —
   * CHỈ 2 lần, đúng 2 `algoId` đã lưu, không hủy hàng loạt.
   */
  async cancelAlgoOrder(symbol: string, algoId: number): Promise<unknown | DryRunResult> {
    const params = { symbol, algoId };
    const dry = this.logOrDryRun('DELETE', '/fapi/v1/algoOrder', params, `cancelAlgoOrder(${symbol},${algoId})`);
    if (dry) return dry;
    return this.signedMutate('DELETE', '/fapi/v1/algoOrder', params, `cancelAlgoOrder(${symbol},${algoId})`);
  }

  /**
   * Binance Futures có API "algo order" nhưng vẫn không có "amend" — breakeven/Runner trailing vẫn
   * làm cancel-rồi-đặt-lại, giờ dùng `algoId`/`cancelAlgoOrder()` thay vì `orderId`/`cancelOrder()`.
   * Nếu cancel thành công nhưng đặt lại lỗi, vị thế LEFT WITHOUT AN SL ON THE EXCHANGE — surfaced qua
   * onOrderFailure với tag riêng để caller coi là khẩn cấp (không phải log lỗi thường).
   */
  async updateStopOrder(symbol: string, oldAlgoId: number, positionSide: PositionSide, newTriggerPrice: number, quantity: number): Promise<AlgoOrderResult | DryRunResult> {
    await this.cancelAlgoOrder(symbol, oldAlgoId);
    try {
      return await this.placeStopMarket(symbol, positionSide, newTriggerPrice, quantity);
    } catch (err) {
      const urgentErr = new Error(`[updateStopOrder(${symbol})] SL CŨ ĐÃ HỦY NHƯNG SL MỚI ĐẶT LỖI — VỊ THẾ ĐANG KHÔNG CÓ SL TRÊN SÀN: ${(err as Error).message}`);
      this.onOrderFailure?.(`updateStopOrder(${symbol}) URGENT_NO_SL`, urgentErr);
      throw urgentErr;
    }
  }
}

/**
 * TICKET-100 — gọi setLeverage() 1 lần cho MỖI symbol lúc khởi động (liveRunner.ts, sau
 * loadExchangeInfo(), trước vòng lặp chính). Binance từ chối đổi đòn bẩy khi đang có vị thế mở trên
 * symbol đó (thông báo lỗi luôn chứa từ "position") — trường hợp này KHÔNG được coi là lỗi khởi động:
 * log cảnh báo, coi như đòn bẩy hiện tại đã đúng (không ép buộc), tiếp tục sang symbol tiếp theo. Bất
 * kỳ lỗi nào KHÁC (mạng/auth/không xác định — signedMutate() đã tự retry-bounded phần lỗi mạng
 * trước-khi-có-response) KHÔNG được âm thầm bỏ qua — ném lại để dừng khởi động, cùng nguyên tắc "an
 * toàn" (không bao giờ mặc định coi 1 lỗi mơ hồ là "chắc ổn") đã dùng xuyên suốt codebase này.
 */
export async function initializeLeverageForSymbols(
  executor: BinanceOrderExecutor,
  symbols: string[],
  leverage: number,
  logger: { log: (msg: string) => void; warn: (msg: string) => void } = console,
): Promise<void> {
  for (const symbol of symbols) {
    try {
      await executor.setLeverage(symbol, leverage);
      logger.log(`Đã đặt đòn bẩy ${leverage}x cho ${symbol} — OK`);
    } catch (err) {
      const message = (err as Error).message;
      if (/position/i.test(message)) {
        logger.warn(
          `[CẢNH BÁO] Không đổi được đòn bẩy cho ${symbol} — sàn từ chối vì đang có vị thế mở. Coi như đòn bẩy hiện tại đã đúng, không ép buộc, tiếp tục khởi động. Chi tiết: ${message}`,
        );
        continue;
      }
      throw new Error(`initializeLeverageForSymbols(${symbol}): đặt đòn bẩy thất bại (không phải do vị thế mở) — dừng khởi động: ${message}`);
    }
  }
}
