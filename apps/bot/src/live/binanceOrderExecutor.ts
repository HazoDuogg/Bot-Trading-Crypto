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
  fetchFn?: typeof fetch;
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  status: string;
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
  private readonly fetchFn: typeof fetch;
  // Binance rejects a signed request if `timestamp` drifts from the server's clock by more than
  // recvWindow (error -1021). The local machine's clock is not guaranteed to match Binance's —
  // syncClock() measures the offset once via the public (unsigned) /fapi/v1/time endpoint and every
  // signed request adds it to Date.now() from then on.
  private clockOffsetMs = 0;

  constructor(config: BinanceOrderExecutorConfig) {
    this.creds = config.credentials;
    this.dryRun = config.dryRun ?? true;
    this.recvWindowMs = config.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onOrderFailure = config.onOrderFailure;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  isDryRun(): boolean {
    return this.dryRun;
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
    const full = { ...params, timestamp: this.signedTimestamp(), recvWindow: this.recvWindowMs };
    const qs = buildQueryString(full);
    const signature = sign(qs, this.creds.apiSecret);
    const url = `${this.creds.baseUrl}${path}?${qs}&signature=${signature}`;

    for (let attempt = 0; attempt < MAX_MUTATING_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, { method, headers: { 'X-MBX-APIKEY': this.creds.apiKey } });
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

  async getServerTime(): Promise<number> {
    const res = await this.fetchWithTimeout(`${this.creds.baseUrl}/fapi/v1/time`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on /fapi/v1/time`);
    const body = (await res.json()) as { serverTime: number };
    return body.serverTime;
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

  async placeStopMarket(symbol: string, positionSide: PositionSide, stopPrice: number, quantity: number): Promise<OrderResult | DryRunResult> {
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', type: 'STOP_MARKET', stopPrice, quantity, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `placeStopMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `placeStopMarket(${symbol},${positionSide})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  async placeTakeProfitMarket(symbol: string, positionSide: PositionSide, stopPrice: number, quantity: number): Promise<OrderResult | DryRunResult> {
    const params = { symbol, side: positionSide === 'LONG' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice, quantity, reduceOnly: true };
    const dry = this.logOrDryRun('POST', '/fapi/v1/order', params, `placeTakeProfitMarket(${symbol},${positionSide})`);
    if (dry) return dry;
    const raw = (await this.signedMutate('POST', '/fapi/v1/order', params, `placeTakeProfitMarket(${symbol},${positionSide})`)) as { orderId: number; status: string };
    return { orderId: raw.orderId, symbol, status: raw.status, raw };
  }

  async cancelOrder(symbol: string, orderId: number): Promise<unknown | DryRunResult> {
    const params = { symbol, orderId };
    const dry = this.logOrDryRun('DELETE', '/fapi/v1/order', params, `cancelOrder(${symbol},${orderId})`);
    if (dry) return dry;
    return this.signedMutate('DELETE', '/fapi/v1/order', params, `cancelOrder(${symbol},${orderId})`);
  }

  /**
   * Binance Futures has no "amend order" endpoint for STOP_MARKET — breakeven/Runner trailing
   * updates are implemented as cancel-then-replace. If cancel succeeds but the replace fails, the
   * position is LEFT WITHOUT AN SL ON THE EXCHANGE — surfaced via onOrderFailure with a distinct
   * context tag so the caller can treat it as urgent (not a normal failed-order log line).
   */
  async updateStopOrder(symbol: string, oldOrderId: number, positionSide: PositionSide, newStopPrice: number, quantity: number): Promise<OrderResult | DryRunResult> {
    await this.cancelOrder(symbol, oldOrderId);
    try {
      return await this.placeStopMarket(symbol, positionSide, newStopPrice, quantity);
    } catch (err) {
      const urgentErr = new Error(`[updateStopOrder(${symbol})] SL CŨ ĐÃ HỦY NHƯNG SL MỚI ĐẶT LỖI — VỊ THẾ ĐANG KHÔNG CÓ SL TRÊN SÀN: ${(err as Error).message}`);
      this.onOrderFailure?.(`updateStopOrder(${symbol}) URGENT_NO_SL`, urgentErr);
      throw urgentErr;
    }
  }
}
