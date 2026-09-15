/** TICKET-21X-A — H1 "today's trading range" per video 1, replacing the ad-hoc MAX_ZONE_DISTANCE_ATR_MULT. */
import type { Candle } from "../core/types.js";
import { detectSwingPoints } from "./liquidity.js";

export interface TradingRange {
  low: number;
  high: number;
}

/** Current trading range = span between the 2 nearest H1 swing points (video 1: "low -> pushed up -> that's the trading range"). */
export function computeH1TradingRange(h1Candles: Candle[]): TradingRange | null {
  const swings = detectSwingPoints(h1Candles);
  if (swings.length < 2) return null;
  const last2 = swings.slice(-2);
  return { low: Math.min(last2[0].price, last2[1].price), high: Math.max(last2[0].price, last2[1].price) };
}
