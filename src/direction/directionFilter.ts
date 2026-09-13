import type { Candle } from "../core/types.js";
import { detectRegime } from "../regime/regimeDetector.js";

/** D1-only v1 (TICKET-07X-A) — Weekly confirmation from video 1 is a later ticket. Needs >=28 closed D1 candles (detectRegime warm-up). */
export function detectDirectionBias(dailyCandles: Candle[]): "UP" | "DOWN" | "NONE" {
  const regime = detectRegime(dailyCandles); // reused unchanged, already verified
  if (regime.state === "UPTREND") return "UP";
  if (regime.state === "DOWNTREND") return "DOWN";
  return "NONE"; // SIDEWAY or DANGER_ZONE -> not clear enough to favor a side
}
