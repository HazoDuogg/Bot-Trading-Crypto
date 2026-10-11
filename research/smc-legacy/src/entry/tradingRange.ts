/** TICKET-21X-A — H1 "today's trading range" per video 1, replacing the ad-hoc MAX_ZONE_DISTANCE_ATR_MULT. */
import type { Candle } from "../core/types.js";
import { detectSwingPoints } from "./liquidity.js";

export interface TradingRange {
  low: number;
  high: number;
}

/**
 * TICKET-23X-A — the range must be a real [low, high] pair: the most recent swing,
 * then the most recent swing of the OTHER type before it. Two same-type swings in a
 * row (e.g. two highs) no longer get paired together. No such opposite-type swing -> null.
 */
export function computeH1TradingRange(h1Candles: Candle[]): TradingRange | null {
  const swings = detectSwingPoints(h1Candles);
  if (swings.length === 0) return null;
  const last = swings[swings.length - 1];
  for (let i = swings.length - 2; i >= 0; i--) {
    if (swings[i].type !== last.type) {
      return { low: Math.min(last.price, swings[i].price), high: Math.max(last.price, swings[i].price) };
    }
  }
  return null;
}
