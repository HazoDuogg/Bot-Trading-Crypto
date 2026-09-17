/** TICKET-06X-F2 — locked formula, do not retune weights or the touchCount>=3 threshold. */
import type { Zone } from "./zoneRegistry.js";

export function computeConfluenceScore(zone: Zone): number {
  let score = 0;
  if (zone.imbalance !== null && !zone.imbalanceMitigated) score += 1;
  // TICKET-27X-F: nearby liquidity is a trap until it's actually been swept — only reward it
  // once liquiditySwept is true. Nearby-but-unswept scores neither +1 nor -1 (locked, not tuned).
  if (zone.hasNearbyLiquidity && zone.liquiditySwept) score += 1;
  if (zone.touchCount >= 3) score -= 1;
  return score;
}
