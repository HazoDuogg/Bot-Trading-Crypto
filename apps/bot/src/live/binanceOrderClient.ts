import { createHmac } from 'node:crypto';
import type { Direction } from '../entry/types.js';
import type { ExchangeOrderClient, OrderInfo, OrderStatus, SymbolFilters } from './exchangeOrderClient.js';
import { retryWithBackoff, BinanceHttpError, type RetryOptions } from './binanceRestPollingFeed.js';

export class TestnetSafetyError extends Error { }

export interface BinanceOrderClientOptions extends RetryOptions {
  allowNonTestnet?: boolean;
}

function parseAlgoOrderInfo(raw: unknown): OrderInfo {
  const r = raw as Record<string, unknown>;
  const actualPrice = Number(r.actualPrice ?? 0);
  const actualQty = Number(r.actualQty ?? 0);
  const algoStatus = String(r.algoStatus);
  return {
    orderId: Number(r.algoId),
    symbol: String(r.symbol),
    status: mapAlgoStatus(algoStatus, actualPrice),
    side: String(r.side) as 'BUY' | 'SELL',
    type: String(r.orderType ?? r.type ?? ''),
    avgPrice: actualPrice,
    executedQty: actualQty,
    origQty: Number(r.quantity ?? 0),
    price: Number(r.price ?? 0),
    stopPrice: Number(r.triggerPrice ?? 0),
    updateTime: Number(r.updateTime ?? Date.now()),
  };
}

// algoStatus -> the OrderStatus vocabulary the rest of the codebase (SymbolOrderLifecycle) already
// understands, so getOrder() stays a drop-in replacement regardless of which endpoint served it.
// TRIGGERED means the underlying market order was just fired but Binance's own actualPrice/actualQty
// fields (0 until at least partially filled) are the authoritative fill signal for that transitional
// state — a STOP_MARKET/TAKE_PROFIT_MARKET with closePosition=true is a market order once triggered,
// so in practice this resolves to FILLED almost immediately, but we don't assume that and instead
// read the same actualPrice signal Binance itself documents for "filled/partially filled".
function mapAlgoStatus(algoStatus: string, actualPrice: number): OrderStatus {
  switch (algoStatus) {
    case 'NEW':
      return 'NEW';
    case 'CANCELED':
      return 'CANCELED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'TRIGGERED':
      return actualPrice > 0 ? 'FILLED' : 'PARTIALLY_FILLED';
    case 'FINISHED':
      return 'FILLED';
    default:
      throw new Error(
        `CORRECTION_REQUIRED: algoStatus "${algoStatus}" tu /fapi/v1/algoOrder khong nam trong tap gia tri da xac minh (NEW/CANCELED/EXPIRED/TRIGGERED/FINISHED) — dung lai, doc lai tai lieu Binance truoc khi xu ly.`,
      );
  }
}

export class BinanceOrderClient implements ExchangeOrderClient {
  private readonly retryOptions: RetryOptions;
  // Populated by placeStopMarketCloseOrder/placeTakeProfitMarketCloseOrder (and, defensively, by
  // getOpenOrders — see the file comment above) — the ids this instance knows are algo orders.
  private readonly algoOrderIds = new Set<number>();

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
    const info = (await res.json()) as { symbols: { symbol: string; filters: { filterType: string;[k: string]: unknown }[] }[] };
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

  // TICKET-RT-071: moved to the Algo Order API — see the file comment above for why.
  async placeStopMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    // Closing a LONG = SELL; closing a SHORT = BUY.
    const side = direction === 'LONG' ? 'SELL' : 'BUY';
    const raw = await this.signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol,
      side,
      type: 'STOP_MARKET',
      triggerPrice: stopPrice,
      closePosition: 'true', // reduce-only by construction — closes whatever qty is actually open
    });
    const info = parseAlgoOrderInfo(raw);
    this.algoOrderIds.add(info.orderId);
    return info;
  }

  async placeTakeProfitMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo> {
    const side = direction === 'LONG' ? 'SELL' : 'BUY';
    const raw = await this.signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: stopPrice,
      closePosition: 'true',
    });
    const info = parseAlgoOrderInfo(raw);
    this.algoOrderIds.add(info.orderId);
    return info;
  }

  async getOrder(symbol: string, orderId: number): Promise<OrderInfo> {
    if (this.algoOrderIds.has(orderId)) {
      const raw = await this.signedRequest('GET', '/fapi/v1/algoOrder', { algoId: orderId });
      return parseAlgoOrderInfo(raw);
    }
    const raw = await this.signedRequest('GET', '/fapi/v1/order', { symbol, orderId });
    return parseOrderInfo(raw);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    if (this.algoOrderIds.has(orderId)) {
      try {
        await this.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: orderId });
      } catch (err) {
        // Same spirit as the -2011 tolerance below (already resolved/gone is not an error for a
        // caller just trying to cancel a possibly-already-resolved order) — but verified via real
        // testnet calls that the Algo Order API reports an already-gone algo order as -2013 "Order
        // does not exist" (not -2011). Tolerating both here in case behavior differs by order state.
        if (err instanceof BinanceHttpError && (err.message.includes('-2011') || err.message.includes('-2013'))) return;
        throw err;
      }
      return;
    }
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

  // TICKET-RT-071: open SL/TP orders no longer show up in /fapi/v1/openOrders post-migration — they
  // live in /fapi/v1/openAlgoOrders now, so both must be queried and merged for reconciliation
  // (liveRunner.ts) to see the true open-order count.
  async getOpenOrders(symbol: string): Promise<OrderInfo[]> {
    const [regularRaw, algoRaw] = await Promise.all([
      this.signedRequest('GET', '/fapi/v1/openOrders', { symbol }) as Promise<unknown[]>,
      this.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol, algoType: 'CONDITIONAL' }) as Promise<unknown[]>,
    ]);
    const algoOrders = algoRaw.map((r) => {
      const info = parseAlgoOrderInfo(r);
      this.algoOrderIds.add(info.orderId); // defensive: see the file comment above
      return info;
    });
    return [...regularRaw.map(parseOrderInfo), ...algoOrders];
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
