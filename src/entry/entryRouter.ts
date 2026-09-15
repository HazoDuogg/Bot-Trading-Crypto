/**
 * TICKET-07X-B v1 — structure confirmation only, no pre-limit (that's a later ticket).
 * TICKET-15X-A — takes a pre-built registry/atr15 instead of rebuilding one from
 * raw M15 candles, so a caller maintaining its own registry (orchestrator.ts,
 * via advanceRegistry) isn't forced to pay for a full rescan on every call.
 */
import type { Candle } from "../core/types.js";
import { detectDirectionBias } from "../direction/directionFilter.js";
import type { Zone } from "./zoneRegistry.js";
import { computeConfluenceScore } from "./confluenceScore.js";
import { detectSwingPoints } from "./liquidity.js";
import { isDailyThrottled, isEntryAllowedGivenThrottle, type ClosedTrade } from "../risk/dailyThrottle.js";

export interface EntrySetup {
  zone: Zone;
  direction: "UP" | "DOWN";
  confirmedAtIndex: number; // index into m5Candles of the structure-break candle
}

// TICKET-13X-A — rough stand-in for a real H1/M30 "today's trading range" (video 1), not derived from those timeframes.
export const MAX_ZONE_DISTANCE_ATR_MULT = 10;

// TICKET-19X-A — one-shot experiment: real backtest showed DOWN, score<2 trades lose (PF 0.819)
// while DOWN, score=2 trades are on par with UP (PF 1.234). UP stays unfiltered.
export const MIN_CONFLUENCE_SCORE_DOWN = 1;

/** Distance from currentPrice to the zone's nearest edge; 0 if price is already inside [low, high]. */
function distanceToZone(currentPrice: number, zone: Zone): number {
  if (currentPrice > zone.high) return currentPrice - zone.high;
  if (currentPrice < zone.low) return zone.low - currentPrice;
  return 0;
}

/** Highest confluenceScore among live (VALID/TESTED), in-range zones matching bias direction; ties go to the most recent zone. */
function pickBestZone(registry: Zone[], bias: "UP" | "DOWN", currentPrice: number, atrAtNow: number): Zone | null {
  const wantType = bias === "UP" ? "demand" : "supply";
  const candidates = registry.filter(
    (z) =>
      (z.state === "VALID" || z.state === "TESTED") &&
      z.type === wantType &&
      distanceToZone(currentPrice, z) <= MAX_ZONE_DISTANCE_ATR_MULT * atrAtNow &&
      (bias === "UP" || computeConfluenceScore(z) >= MIN_CONFLUENCE_SCORE_DOWN),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, z) => {
    const score = computeConfluenceScore(z);
    const bestScore = computeConfluenceScore(best);
    if (score > bestScore) return z;
    if (score === bestScore && z.createdAtIndex > best.createdAtIndex) return z;
    return best;
  });
}

/** Retest the zone on M5, then look for the nearest M5 swing (formed before the retest) breaking in the bias direction. */
function findM5Confirmation(m5Candles: Candle[], zone: Zone, direction: "UP" | "DOWN"): number | null {
  const touchIndex = m5Candles.findIndex((c) => c.low <= zone.high && c.high >= zone.low);
  if (touchIndex === -1) return null;

  const wantKind = direction === "UP" ? "high" : "low";
  const structureSwings = detectSwingPoints(m5Candles.slice(0, touchIndex + 1)).filter((s) => s.type === wantKind);
  if (structureSwings.length === 0) return null;
  const structureLevel = structureSwings[structureSwings.length - 1].price;

  for (let i = touchIndex + 1; i < m5Candles.length; i++) {
    const brokeThrough = direction === "UP" ? m5Candles[i].close > structureLevel : m5Candles[i].close < structureLevel;
    if (brokeThrough) return i;
  }
  return null;
}

export function detectEntry(
  dailyCandles: Candle[],
  registry: Zone[],
  atr15: number[],
  currentPrice: number,
  m5Candles: Candle[],
  closedTrades: ClosedTrade[],
  startOfDayEquity: number,
): EntrySetup | null {
  const bias = detectDirectionBias(dailyCandles);
  if (bias === "NONE") return null;

  const atrAtNow = atr15[atr15.length - 1];
  const zone = pickBestZone(registry, bias, currentPrice, atrAtNow);
  if (!zone) return null;

  const confirmedAtIndex = findM5Confirmation(m5Candles, zone, bias);
  if (confirmedAtIndex === null) return null;

  // Only check the throttle right before confirming an entry — not earlier, since
  // confluenceScore only matters for comparison once this is known to be a real setup.
  const now = m5Candles[confirmedAtIndex].closeTime;
  const throttled = isDailyThrottled(closedTrades, startOfDayEquity, now);
  if (!isEntryAllowedGivenThrottle(computeConfluenceScore(zone), throttled)) return null;

  return { zone, direction: bias, confirmedAtIndex };
}
