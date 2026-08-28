import type { Direction } from '../entry/types.js';

// TICKET-RT-068 Part A/B: the ExchangeOrderClient interface RT-067 deferred. Exchange-agnostic by
// design (same spirit as MarketDataFeed) — a future exchange swap only needs a new implementation.

export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';

export interface OrderInfo {
  orderId: number;
  symbol: string;
  status: OrderStatus;
  side: 'BUY' | 'SELL';
  type: string;
  avgPrice: number; // 0 until at least partially filled
  executedQty: number;
  origQty: number;
  price: number; // LIMIT price, 0 for market-family orders
  stopPrice: number; // STOP_MARKET/TAKE_PROFIT_MARKET trigger, 0 for LIMIT
  updateTime: number;
}

export interface SymbolFilters {
  stepSize: number; // LOT_SIZE — quantity must be a multiple of this
  tickSize: number; // PRICE_FILTER — price must be a multiple of this
  minNotional: number; // MIN_NOTIONAL/NOTIONAL — qty * price must be >= this
}

// TICKET-RT-068 Part A: balance MUST come from here, live, every time — never computed/cached
// internally. This is the entire point of Part A (avoiding the old system's mistake).
export interface ExchangeOrderClient {
  getAvailableBalanceUsdt(): Promise<number>;
  getSymbolLeverage(symbol: string): Promise<number>;
  // TICKET-RT-073 Part B: actually SET leverage on the exchange (getSymbolLeverage only ever read
  // it — RT-AUDIT-001 found nothing had ever called a leverage-set endpoint, so the exchange's real
  // leverage had silently drifted from the design). Called once per symbol at startup, before the
  // main loop — never mid-flight, so no caller needs to invalidate any cached leverage.
  setLeverage(symbol: string, leverage: number): Promise<void>;
  getSymbolFilters(symbol: string): Promise<SymbolFilters>;

  // Entry: real LIMIT order at the FVG's own price (Part B step 1 — no simulated-touch wait).
  placeLimitEntryOrder(symbol: string, direction: Direction, quantity: number, price: number): Promise<OrderInfo>;

  // SL/TP: STOP_MARKET / TAKE_PROFIT_MARKET, closePosition=true (reduce-only by construction —
  // closes whatever quantity is actually open, avoiding any partial-fill quantity mismatch).
  placeStopMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo>;
  placeTakeProfitMarketCloseOrder(symbol: string, direction: Direction, stopPrice: number): Promise<OrderInfo>;

  getOrder(symbol: string, orderId: number): Promise<OrderInfo>;
  cancelOrder(symbol: string, orderId: number): Promise<void>;

  // Part B step 4: real PnL from Binance's own income ledger, never computed by hand.
  getRealizedPnlSince(symbol: string, sinceMs: number): Promise<number>;

  // Startup reconciliation (see liveRunner.ts's file comment): a crash/restart resets this
  // process's in-memory lifecycle state to IDLE, but real orders/positions on the exchange from
  // before the crash do NOT reset — this lets the caller detect that mismatch before ever placing
  // a new order for that symbol.
  getOpenPosition(symbol: string): Promise<{ qty: number; entryPrice: number }>; // qty signed: positive=long, negative=short, 0=flat
  getOpenOrders(symbol: string): Promise<OrderInfo[]>;
}
