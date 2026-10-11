/** TICKET-11X-A v1 — fixed SL/TP only, no breakeven/trailing (later ticket). */
import type { Candle } from "../core/types.js";
import type { OrderSize } from "../risk/positionSizer.js";

export type ExitReason = "SL_HIT" | "TP_HIT" | "NONE";

export interface ExitResult {
  reason: ExitReason;
  exitPrice: number | null;
}

/** Both SL and TP touched in the same candle -> SL_HIT wins (conservative, no optimistic ordering assumed). */
export function checkExit(order: OrderSize, direction: "UP" | "DOWN", candle: Candle): ExitResult {
  const slHit = direction === "UP" ? candle.low <= order.stopLoss : candle.high >= order.stopLoss;
  const tpHit = direction === "UP" ? candle.high >= order.takeProfit : candle.low <= order.takeProfit;

  if (slHit) return { reason: "SL_HIT", exitPrice: order.stopLoss };
  if (tpHit) return { reason: "TP_HIT", exitPrice: order.takeProfit };
  return { reason: "NONE", exitPrice: null };
}
