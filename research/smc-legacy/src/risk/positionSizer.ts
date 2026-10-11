/**
 * TICKET-10X-A — SL off the entered zone's opposite edge, sizing off risk-per-trade.
 * RISK_PCT_PER_TRADE is cited from video 1; SL_BUFFER_ATR_MULT is a working
 * default like every other ATR multiplier in this project, not yet verified.
 */
import type { Zone } from "../entry/zoneRegistry.js";
import type { SplitDecision } from "../entry/targets.js";

export const RISK_PCT_PER_TRADE = 0.01;
export const SL_BUFFER_ATR_MULT = 0.25;

/** Stop hunt buffer: SL sits SL_BUFFER_ATR_MULT x ATR beyond the zone's far edge, not right on it. */
export function computeStopLoss(direction: "UP" | "DOWN", zone: Zone, atrAtEntry: number): number {
  return direction === "UP" ? zone.low - SL_BUFFER_ATR_MULT * atrAtEntry : zone.high + SL_BUFFER_ATR_MULT * atrAtEntry;
}

export interface OrderSize {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskPct: number;
  quantity: number;
}

export function computeOrderSizes(
  splitDecision: SplitDecision,
  direction: "UP" | "DOWN",
  entryPrice: number,
  slPrice: number,
  accountEquity: number,
): OrderSize[] | null {
  void direction; // SL/TP already carry the direction; kept for signature parity with computeStopLoss
  if (splitDecision.mode === "INSUFFICIENT_DATA") return null;

  const distance = Math.abs(entryPrice - slPrice);
  if (distance === 0) return null;

  const mkOrder = (riskPct: number, takeProfit: number): OrderSize => ({
    entryPrice,
    stopLoss: slPrice,
    takeProfit,
    riskPct,
    quantity: (accountEquity * riskPct) / distance,
  });

  if (splitDecision.mode === "SINGLE") return [mkOrder(RISK_PCT_PER_TRADE, splitDecision.tp1)];
  return [mkOrder(RISK_PCT_PER_TRADE / 2, splitDecision.tp1), mkOrder(RISK_PCT_PER_TRADE / 2, splitDecision.tp2)];
}
