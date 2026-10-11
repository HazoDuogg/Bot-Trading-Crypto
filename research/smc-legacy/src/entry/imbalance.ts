/** TICKET-06X-E — standard 3-candle FVG, no new locked parameters. */
import type { Candle } from "../core/types.js";

export interface Imbalance {
  high: number;
  low: number;
}

/** First FVG in the given direction within [fromIndex, toIndex] (the impulse that created the zone), or null. */
export function findFvgInRange(
  candles: Candle[],
  fromIndex: number,
  toIndex: number,
  direction: "demand" | "supply",
): Imbalance | null {
  for (let k = fromIndex + 1; k <= toIndex - 1; k++) {
    if (direction === "demand" && candles[k - 1].high < candles[k + 1].low) {
      return { high: candles[k + 1].low, low: candles[k - 1].high };
    }
    if (direction === "supply" && candles[k - 1].low > candles[k + 1].high) {
      return { high: candles[k - 1].low, low: candles[k + 1].high };
    }
  }
  return null;
}
