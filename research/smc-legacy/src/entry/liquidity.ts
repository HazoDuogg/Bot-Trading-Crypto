/**
 * TICKET-06X-A equal-high/low (resting liquidity) detection — locked 0.1x ATR,
 * do not retune. Moved out of the research script in TICKET-06X-F so
 * zoneRegistry.ts can reuse it for hasNearbyLiquidity.
 */
import type { Candle } from "../core/types.js";

export const EQUAL_ATR_MULT = 0.1;

// D1 — CONVENTION: strict five-candle fractal, confirmed only after both right-side candles close.
const SWING_WINDOW = 5;
const SWING_SIDE_CANDLES = 2;

export interface SwingPoint {
  index: number;
  type: "high" | "low";
  price: number;
}

export interface EqualPoint {
  type: "equal-high" | "equal-low";
  aIndex: number;
  bIndex: number;
  priceA: number;
  priceB: number;
}

// Reproduced unchanged from the manually-verified swingPoints.ts (pre-RESET) — same fractal, same offsets.
export function detectSwingPoints(candles: readonly Candle[]): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let confirmedAt = SWING_WINDOW - 1; confirmedAt < candles.length; confirmedAt += 1) {
    const window = candles.slice(confirmedAt - SWING_WINDOW + 1, confirmedAt + 1);
    const center = window[SWING_SIDE_CANDLES];
    const neighbors = window.filter((_, index) => index !== SWING_SIDE_CANDLES);
    const index = confirmedAt - SWING_SIDE_CANDLES;

    if (neighbors.every((item) => center.high > item.high)) {
      swings.push({ index, type: "high", price: center.high });
    }
    if (neighbors.every((item) => center.low < item.low)) {
      swings.push({ index, type: "low", price: center.low });
    }
  }
  return swings;
}

export function findEqualPoints(swings: SwingPoint[], atr: number[]): EqualPoint[] {
  const equals: EqualPoint[] = [];
  for (const kind of ["high", "low"] as const) {
    const ofKind = swings.filter((s) => s.type === kind);
    for (let i = 1; i < ofKind.length; i++) {
      const a = ofKind[i - 1];
      const b = ofKind[i];
      if (Math.abs(b.price - a.price) <= EQUAL_ATR_MULT * atr[b.index]) {
        equals.push({
          type: kind === "high" ? "equal-high" : "equal-low",
          aIndex: a.index,
          bIndex: b.index,
          priceA: a.price,
          priceB: b.price,
        });
      }
    }
  }
  return equals;
}
