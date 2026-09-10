import type { Candle, RegimeSnapshot } from "../core/types.js";

export function detectRegime(candles: Candle[]): RegimeSnapshot {
  void candles;
  throw new Error("not implemented");
}
