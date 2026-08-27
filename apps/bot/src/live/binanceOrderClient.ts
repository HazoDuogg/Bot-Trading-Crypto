import { createHmac } from 'node:crypto';
import type { Direction } from '../entry/types.js';
import type { ExchangeOrderClient, OrderInfo, OrderStatus, SymbolFilters } from './exchangeOrderClient.js';
import { retryWithBackoff, BinanceHttpError, type RetryOptions } from './binanceRestPollingFeed.js';

// TICKET-RT-068: Binance Futures implementation of ExchangeOrderClient — signed (HMAC-SHA256)
// requests for balance/leverage/orders, alongside the existing public (unsigned)
// BinanceRestPollingFeed for market data. First code in this repo that places real orders (even
// though every current caller only ever points it at testnet).
//
// SAFETY GUARD (defense-in-depth beyond "the env var happens to say testnet"): by default this
// class REFUSES to construct against a baseUrl that doesn't contain "testnet" — a deliberate,
// explicit opt-out (`allowNonTestnet: true`) is required to ever point it elsewhere, so a
// misconfigured env var alone can never silently enable real trading. Per the ticket: "Khong tu
// dong chuyen sang mainnet — van dung LIVE_EXCHANGE_BASE_URL tro testnet."
export class TestnetSafetyError extends Error {}

export interface BinanceOrderClientOptions extends RetryOptions {
  allowNonTestnet?: boolean;
}

export class BinanceOrderClient implements ExchangeOrderClient {
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    options: BinanceOrderClientOptions = {},
  ) {
    if (!options.allowNonTestnet && !baseUrl.includes('testnet')) {
      throw new TestnetSafetyError(
        `CORRECTION_REQUIRED: BinanceOrderClient duoc khoi tao voi baseUrl="${baseUrl}", khong chua "testnet". ` +
          `Tu choi khoi tao de tranh vo tinh dat lenh that — truyen { allowNonTestnet: true } neu day THAT SU la chu y (chi khi da duoc xac nhan ro rang chuyen sang mainnet).`,
      );
    }
    this.retryOptions = options;
  }

  private sign(params: Record<string, string | number>): string {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const signature = createHmac('sha256', this.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  private async signedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    return retryWithBackoff(async () => {
      const qs = this.sign({ timestamp: Date.now(), recvWindow: 5000, ...params });
      const url = `${this.baseUrl}${path}?${qs}`;
      const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': this.apiKey } });
      if (!res.ok) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        const body = await res.text().catch(() => '');
        throw new BinanceHttpError(`Binance signed request failed: ${method} ${path} -> ${res.status} ${body}`, res.status, Number.isFinite(retryAfterSec) ? retryAfterSec : undefined);
      }
      return res.json();
    }, this.retryOptions);
  }

  async getAvailableBalanceUsdt(): Promise<number> {
    const balances = (await this.signedRequest('GET', '/fapi/v2/balance')) as { asset: string; availableBalance: string }[];
    const usdt = balances.find((b) => b.asset === 'USDT');
    if (!usdt) throw new Error('CORRECTION_REQUIRED: khong tim thay so du USDT trong phan hoi /fapi/v2/balance.');
    return Number(usdt.availableBalance);
  }

  async getSymbolLeverage(symbol: string): Promise<number> {
    const positions = (await this.signedRequest('GET', '/fapi/v2/positionRisk', { symbol })) as { symbol: string; leverage: string }[];
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) throw new Error(`CORRECTION_REQUIRED: khong tim thay leverage cho ${symbol} trong /fapi/v2/positionRisk.`);
    return Number(pos.leverage);
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    // Public endpoint (no signing needed) — reads from the SAME baseUrl this client is talking to,
    // so filters can never mismatch between testnet/mainnet.
    const res = await fetch(new URL('/fapi/v1/exchangeInfo', this.baseUrl));
    if (!res.ok) throw new Error(`Binance exchangeInfo request failed: ${res.status} ${await res.text()}`);
    const info = (await res.json()) as { symbols: { symbol: string; filters: { filterType: string; [k: string]: unknown }[] }[] };
    const symbolInfo = info.symbols.find((s) => s.symbol === symbol);
    if (!symbolInfo) throw new Error(`CORRECTION_REQUIRED: ${symbol} khong co trong exchangeInfo cua ${this.baseUrl}.`);
    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const notional = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    if (!lotSize || !priceFilter) throw new Error(`CORRECTION_REQUIRED: ${symbol} thieu LOT_SIZE hoac PRICE_FILTER trong exchangeInfo.`);
    return {
      stepSize: Number(lotSize.stepSize),
      tickSize: Number(priceFilter.tickSize),
      minNotional: notional ? Number(notional.minNotional ?? notional.notional) : 0,
    };
  }

  async placeLimitEntryOrder(symbol: string, direction: Direction, quantity: number, price: number): Promise<OrderInfo> {
    const side = direction === 'LONG' ? 'BUY' : 'SELL';
    const raw = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity,
      price,
    });
    return parseOrderInfo(raw);
  }

  async placeStopMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    // Closing a LONG = SELL; closing a SHORT = BUY.
    const side = direction === 'LONG' ? 'SELL' : 'BUY';
    const raw = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice,
      closePosition: 'true', // reduce-only by construction — closes whatever qty is actually open
    });
    return parseOrderInfo(raw);
  }

  async placeTakeProfitMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    const side = direction === 'LONG' ? 'SELL' : 'BUY';
    const raw = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice,
      closePosition: 'true',
    });
    return parseOrderInfo(raw);
  }

  async getOrder(symbol: string, orderId: number): Promise<OrderInfo> {
    const raw = await this.signedRequest('GET', '/fapi/v1/order', { symbol, orderId });
    return parseOrderInfo(raw);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    try {
      await this.signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId });
    } catch (err) {
      // -2011 "Unknown order sent" means it's already filled/canceled/expired — not an error for
      // our purposes (the caller was trying to cancel a possibly-already-resolved order).
      if (err instanceof BinanceHttpError && err.message.includes('-2011')) return;
      throw err;
    }
  }

  async getOpenPositionQty(symbol: string): Promise<number> {
    const positions = (await this.signedRequest('GET', '/fapi/v2/positionRisk', { symbol })) as { symbol: string; positionAmt: string }[];
    const pos = positions.find((p) => p.symbol === symbol);
    return pos ? Number(pos.positionAmt) : 0;
  }

  async getOpenOrders(symbol: string): Promise<OrderInfo[]> {
    const raw = (await this.signedRequest('GET', '/fapi/v1/openOrders', { symbol })) as unknown[];
    return raw.map(parseOrderInfo);
  }

  async getRealizedPnlSince(symbol: string, sinceMs: number): Promise<number> {
    const raw = (await this.signedRequest('GET', '/fapi/v1/income', {
      symbol,
      incomeType: 'REALIZED_PNL',
      startTime: sinceMs,
      limit: 50,
    })) as { income: string; time: number }[];
    return raw.reduce((sum, entry) => sum + Number(entry.income), 0);
  }
}

function parseOrderInfo(raw: unknown): OrderInfo {
  const r = raw as Record<string, unknown>;
  return {
    orderId: Number(r.orderId),
    symbol: String(r.symbol),
    status: String(r.status) as OrderStatus,
    side: String(r.side) as 'BUY' | 'SELL',
    type: String(r.type),
    avgPrice: Number(r.avgPrice ?? 0),
    executedQty: Number(r.executedQty ?? 0),
    origQty: Number(r.origQty ?? 0),
    price: Number(r.price ?? 0),
    stopPrice: Number(r.stopPrice ?? 0),
    updateTime: Number(r.updateTime ?? Date.now()),
  };
}

// --- Precision helpers (Part A/B: exchange rounding — calculatePositionSize deliberately doesn't
// do this, per its own doc comment: "LOT_SIZE/MIN_NOTIONAL normalization happens in a later step") ---

export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = decimalPlacesOf(step);
  const rounded = Math.floor(value / step) * step;
  return Number(rounded.toFixed(decimals));
}

export function roundToTick(value: number, tick: number): number {
  if (tick <= 0) return value;
  const decimals = decimalPlacesOf(tick);
  const rounded = Math.round(value / tick) * tick;
  return Number(rounded.toFixed(decimals));
}

function decimalPlacesOf(step: number): number {
  const s = step.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}
