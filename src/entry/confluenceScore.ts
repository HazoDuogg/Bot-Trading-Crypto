/** TICKET-06X-F2 — locked formula, do not retune weights or the touchCount>=3 threshold. */
import type { Zone } from "./zoneRegistry.js";

export function computeConfluenceScore(zone: Zone): number {
  let score = 0;
  if (zone.imbalance !== null && !zone.imbalanceMitigated) score += 1;
  if (zone.hasNearbyLiquidity) score += 1;
  if (zone.touchCount >= 3) score -= 1;
  return score;
}
