import type { Candle, EntrySignal } from "../core/types.js";

export function detectEntry(candles: Candle[]): EntrySignal | null {
  void candles;
  throw new Error("not implemented");
}
