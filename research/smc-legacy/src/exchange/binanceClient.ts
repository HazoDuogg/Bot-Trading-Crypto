import type { Candle } from "../core/types.js";
import { env } from "../config/env.js";

const MAX_KLINES_LIMIT = 1500;
const MAX_AGG_TRADES_LIMIT = 1000;

export interface AggTrade {
  id: number;
  timestamp: number;
  quantity: number;
  isBuyerMaker: boolean;
}

export interface ExchangeClient {
  getCandles(
    symbol: string,
    interval: string,
    options?: { limit?: number; startTime?: number; endTime?: number },
  ): Promise<Candle[]>;
  getAggTrades(
    symbol: string,
    options?: { limit?: number; startTime?: number; endTime?: number; fromId?: number },
  ): Promise<AggTrade[]>;
  placeOrder(params: { symbol: string; side: "BUY" | "SELL"; quantity: number }): Promise<unknown>;
}

export function createBinanceClient(baseUrl: string = env.binance.url()): ExchangeClient {
  return {
    async getCandles(symbol, interval, options = {}) {
      const { limit = MAX_KLINES_LIMIT, startTime, endTime } = options;
      const url = new URL("/fapi/v1/klines", baseUrl);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", String(limit));
      if (startTime !== undefined) url.searchParams.set("startTime", String(startTime));
      if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));

      const res = await fetchWithRetry(url);
      const raw = (await res.json()) as unknown[][];
      return raw.map(toCandle);
    },
    async getAggTrades(symbol, options = {}) {
      const { limit = MAX_AGG_TRADES_LIMIT, startTime, endTime, fromId } = options;
      const url = new URL("/fapi/v1/aggTrades", baseUrl);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("limit", String(limit));
      if (fromId !== undefined) url.searchParams.set("fromId", String(fromId));
      if (startTime !== undefined) url.searchParams.set("startTime", String(startTime));
      if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));

      const res = await fetchWithRetry(url);
      const raw = (await res.json()) as Array<{ a: number; q: string; T: number; m: boolean }>;
      return raw.map((t) => ({
        id: t.a,
        timestamp: t.T,
        quantity: Number(t.q),
        isBuyerMaker: t.m,
      }));
    },
    async placeOrder() {
      throw new Error("not implemented");
    },
  };
}

function toCandle(raw: unknown[]): Candle {
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
}

async function fetchWithRetry(url: URL, attempt = 0): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429 || res.status === 418) {
    if (attempt >= 5) {
      throw new Error(`Binance rate-limited after ${attempt} retries (${res.status}): ${url.toString()}`);
    }
    const retryAfterSec = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await sleep(retryAfterSec * 1000);
    return fetchWithRetry(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance request failed ${res.status} ${res.statusText}: ${url.toString()} ${body}`);
  }
  return res;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
