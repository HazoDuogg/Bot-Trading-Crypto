/** TICKET-07X-B v1 — structure confirmation only, no pre-limit (that's a later ticket). */
import type { Candle } from "../core/types.js";
import { computeAdxDi } from "../regime/adxDiCompare.js";
import { detectDirectionBias } from "../direction/directionFilter.js";
import { buildInitialRegistry, type Zone } from "./zoneRegistry.js";
import { computeConfluenceScore } from "./confluenceScore.js";
import { detectSwingPoints } from "./liquidity.js";

export interface EntrySetup {
  zone: Zone;
  direction: "UP" | "DOWN";
  confirmedAtIndex: number; // index into m5Candles of the structure-break candle
}

/** Highest confluenceScore among live (VALID/TESTED) zones matching bias direction; ties go to the most recent zone. */
function pickBestZone(registry: Zone[], wantType: "demand" | "supply"): Zone | null {
  const candidates = registry.filter((z) => (z.state === "VALID" || z.state === "TESTED") && z.type === wantType);
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

export function detectEntry(dailyCandles: Candle[], m15Candles: Candle[], m5Candles: Candle[]): EntrySetup | null {
  const bias = detectDirectionBias(dailyCandles);
  if (bias === "NONE") return null;

  const { atr: atr15 } = computeAdxDi(m15Candles);
  const registry = buildInitialRegistry(m15Candles, atr15);
  const zone = pickBestZone(registry, bias === "UP" ? "demand" : "supply");
  if (!zone) return null;

  const confirmedAtIndex = findM5Confirmation(m5Candles, zone, bias);
  if (confirmedAtIndex === null) return null;

  return { zone, direction: bias, confirmedAtIndex };
}
