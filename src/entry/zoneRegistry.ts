/**
 * TICKET-06X-C v1 — zone lifecycle only (VALID/TESTED/INVALIDATED). No
 * imbalance/MITIGATED, no scoring — those are later tickets.
 */
import type { Candle } from "../core/types.js";
import { findZoneCandidates, mergeZoneCandidates, DISPLACEMENT_MAX_CANDLES, type ZoneCandidate } from "./zoneDetection.js";

export type ZoneState = "VALID" | "TESTED" | "INVALIDATED";

export interface Zone {
  id: string;
  type: "demand" | "supply";
  high: number;
  low: number;
  createdAtIndex: number;
  state: ZoneState;
  touchCount: number;
}

function toZone(c: ZoneCandidate): Zone {
  return {
    id: `${c.type}-${c.baseEndIndex}`, // baseEndIndex is unique per merged candidate (1:1 with displacementOpenTime)
    type: c.type,
    high: c.high,
    low: c.low,
    createdAtIndex: c.confirmedIndex,
    state: "VALID",
    touchCount: 0,
  };
}

/** One-time full-history scan — every base+displacement pair found becomes a VALID zone. */
export function buildInitialRegistry(candles: Candle[], atr: number[]): Zone[] {
  return mergeZoneCandidates(findZoneCandidates(candles, atr, 0, candles.length)).map(toZone);
}

/** Demand/supply are symmetric: close through the far side invalidates permanently, a wick-only touch marks TESTED. */
function applyCandle(zone: Zone, candle: Candle): Zone {
  if (zone.state === "INVALIDATED") return zone;
  const overlaps = candle.low <= zone.high && candle.high >= zone.low;
  if (zone.type === "demand") {
    if (candle.close < zone.low) return { ...zone, state: "INVALIDATED" };
  } else {
    if (candle.close > zone.high) return { ...zone, state: "INVALIDATED" };
  }
  if (overlaps) return { ...zone, state: "TESTED", touchCount: zone.touchCount + 1 };
  return zone;
}

/**
 * Causal step for one new candle at `newIndex`: updates existing zones against
 * it, then detects any zone whose base+displacement resolves exactly here
 * (no lookahead — candles/atr beyond newIndex are never read for detection).
 */
export function advanceRegistry(zones: Zone[], candles: Candle[], atr: number[], newIndex: number): Zone[] {
  const candle = candles[newIndex];
  const updated = zones.map((zone) => applyCandle(zone, candle));

  const minBaseStart = Math.max(0, newIndex - DISPLACEMENT_MAX_CANDLES);
  const newZones = mergeZoneCandidates(findZoneCandidates(candles, atr, minBaseStart, newIndex + 1))
    .filter((c) => c.confirmedIndex === newIndex)
    .map(toZone);

  return [...updated, ...newZones];
}
