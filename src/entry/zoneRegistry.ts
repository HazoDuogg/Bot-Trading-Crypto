/**
 * TICKET-06X-C v1 — zone lifecycle (VALID/TESTED/INVALIDATED). TICKET-06X-E
 * adds imbalance/imbalanceMitigated as an independent axis. No scoring yet.
 */
import type { Candle } from "../core/types.js";
import { findZoneCandidates, mergeZoneCandidates, DISPLACEMENT_MAX_CANDLES, type ZoneCandidate } from "./zoneDetection.js";
import { findFvgInRange, type Imbalance } from "./imbalance.js";

export type ZoneState = "VALID" | "TESTED" | "INVALIDATED";

export interface Zone {
  id: string;
  type: "demand" | "supply";
  high: number;
  low: number;
  createdAtIndex: number;
  state: ZoneState;
  touchCount: number;
  imbalance: Imbalance | null;
  imbalanceMitigated: boolean;
}

function toZone(c: ZoneCandidate, candles: Candle[]): Zone {
  return {
    id: `${c.type}-${c.confirmedIndex}`, // confirmedIndex is the merge key, so it's unique per merged candidate
    type: c.type,
    high: c.high,
    low: c.low,
    createdAtIndex: c.confirmedIndex,
    state: "VALID",
    touchCount: 0,
    imbalance: findFvgInRange(candles, c.baseEndIndex, c.confirmedIndex, c.type),
    imbalanceMitigated: false,
  };
}

/** One-time full-history scan — every base+displacement pair found becomes a VALID zone. */
export function buildInitialRegistry(candles: Candle[], atr: number[]): Zone[] {
  return mergeZoneCandidates(findZoneCandidates(candles, atr, 0, candles.length)).map((c) => toZone(c, candles));
}

/** Demand/supply are symmetric: close through the far side invalidates permanently, a wick-only touch marks TESTED. */
function applyCandle(zone: Zone, candle: Candle): Zone {
  let next = zone;
  if (zone.state !== "INVALIDATED") {
    const overlaps = candle.low <= zone.high && candle.high >= zone.low;
    const brokenThrough = zone.type === "demand" ? candle.close < zone.low : candle.close > zone.high;
    if (brokenThrough) next = { ...next, state: "INVALIDATED" };
    else if (overlaps) next = { ...next, state: "TESTED", touchCount: zone.touchCount + 1 };
  }
  // Independent axis from state/touchCount: latches true once the gap candle range is fully covered.
  if (next.imbalance && !next.imbalanceMitigated) {
    const filled = candle.low <= next.imbalance.low && candle.high >= next.imbalance.high;
    if (filled) next = { ...next, imbalanceMitigated: true };
  }
  return next;
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
    .map((c) => toZone(c, candles));

  return [...updated, ...newZones];
}
