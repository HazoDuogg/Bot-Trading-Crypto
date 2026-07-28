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

export interface DryRunResult {
  dryRun: true;
  method: string;
  path: string;
  params: Record<string, string | number | boolean>;
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

  async getAccountInfo(): Promise<unknown> {
    return this.signedGet('/fapi/v2/account');
  }

  async getPositionRisk(symbol?: string): Promise<unknown> {
    return this.signedGet('/fapi/v2/positionRisk', symbol ? { symbol } : {});
  }

  // --- Mutating endpoints (gated by dryRun) ---

  async openMarketPosition(symbol: string, side: PositionSide, quantity: number): Promise<OrderResult | DryRunResult> {
    const params = { symbol, side: side === 'LONG' ? 'BUY' : 'SELL', type: 'MARKET', quantity };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `openMarketPosition(${symbol},${side})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `openMarketPosition(${symbol},${side})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: LIMIT order to open a position (GTC — stays on the book until filled or cancelled). */
  async placeLimitOrder(symbol: string, side: PositionSide, price: number, quantity: number): Promise<OrderResult | DryRunResult> {
    const params = { symbol, side: side === 'LONG' ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'GTC', price, quantity };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `placeLimitOrder(${symbol},${side})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `placeLimitOrder(${symbol},${side})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: MARKET close (full or partial via `quantity`) — reduceOnly so it can never accidentally open/flip a position. */
  async closePositionMarket(symbol: string, positionSide: PositionSide, quantity: number): Promise<OrderResult | DryRunResult> {
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `closePositionMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `closePositionMarket(${symbol},${positionSide})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  /** TICKET-077 1.3: đi qua `/fapi/v1/algoOrder` (bắt buộc từ 09/12/2025) — trả về `algoId`, KHÔNG PHẢI `orderId`. */
  async placeStopMarket(symbol: string, positionSide: PositionSide, triggerPrice: number, quantity: number): Promise<AlgoOrderResult | DryRunResult> {
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice, quantity, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/algoOrder', params, `placeStopMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/algoOrder', params, `placeStopMarket(${symbol},${positionSide})`)) as { algoId: number; algoStatus: string };
    return { algoId: raw.algoId, symbol, algoStatus: raw.algoStatus, raw };
  }

  /** TICKET-077 1.3: đi qua `/fapi/v1/algoOrder` (bắt buộc từ 09/12/2025) — trả về `algoId`, KHÔNG PHẢI `orderId`. */
  async placeTakeProfitMarket(symbol: string, positionSide: PositionSide, triggerPrice: number, quantity: number): Promise<AlgoOrderResult | DryRunResult> {
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', algoType: 'CONDITIONAL', type: 'TAKE_PROFIT_MARKET', triggerPrice, quantity, reduceOnly: true };
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
