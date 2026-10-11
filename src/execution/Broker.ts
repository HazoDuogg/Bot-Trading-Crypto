/**
 * A Broker is the only thing in the pipeline allowed to place, modify,
 * or cancel orders - real or simulated. See src/pipeline.ts. Risk's
 * decision has already been made by the time anything here is called;
 * a Broker implementation does not re-decide whether a trade should
 * happen, it only executes what it's told.
 *
 * Interface only - no implementation (no Binance/exchange SDK import
 * here; see src/exchange/ for the prior implementation's adapter
 * pattern, which this interface is deliberately similar in spirit to).
 */

import type { Side } from "../strategy/Strategy.js";

export interface OrderRequest {
  symbol: string;
  side: Side;
  /** Position size in base-asset units. Already risk-sized by the time it reaches here. */
  quantity: number;
  /** undefined = market order */
  limitPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
}

export interface OrderResult {
  orderId: string;
  filledPrice: number;
  filledQuantity: number;
  filledAtMs: number;
}

export interface Broker {
  readonly mode: "sim" | "paper" | "testnet" | "live";

  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenPosition(symbol: string): Promise<OrderResult | null>;
}
