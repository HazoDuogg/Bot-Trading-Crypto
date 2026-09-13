/**
 * TICKET-06X-A/A2 base+displacement zone detection — locked parameters, do not retune.
 * Shared by the research visual-check script and the Zone Registry (TICKET-06X-C).
 */
import type { Candle } from "../core/types.js";

export const BASE_MAX_LEN = 6;
export const BASE_RANGE_ATR_MULT = 1.5;
export const DISPLACEMENT_MAX_CANDLES = 3;
export const DISPLACEMENT_ATR_MULT = 2;

export interface ZoneCandidate {
  type: "demand" | "supply";
  baseStartIndex: number;
  baseEndIndex: number;
  confirmedIndex: number; // index of the candle whose close/range resolved the displacement
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
}

export interface RawZoneCandidate extends ZoneCandidate {
  displacementOpenTime: number; // dedup key: candidates from the same displacement are one real event
  baseLen: number;
}

/** Displacement check on up to 3 candles right after a valid base, using ATR at the base's last candle. */
function checkDisplacement(
  candles: Candle[],
  atrAtBaseEnd: number,
  from: number,
  maxExclusive: number,
): { valid: boolean; direction?: "up" | "down"; endIdx?: number } {
  const lastAvailable = Math.min(from + DISPLACEMENT_MAX_CANDLES - 1, maxExclusive - 1);
  for (let end = from; end <= lastAvailable; end++) {
    const netMove = candles[end].close - candles[from - 1].close;
    if (Math.abs(netMove) >= DISPLACEMENT_ATR_MULT * atrAtBaseEnd) {
      return { valid: true, direction: netMove > 0 ? "up" : "down", endIdx: end };
    }
    for (let k = from; k <= end; k++) {
      const range = candles[k].high - candles[k].low;
      if (range >= DISPLACEMENT_ATR_MULT * atrAtBaseEnd) {
        return { valid: true, direction: candles[k].close >= candles[k].open ? "up" : "down", endIdx: end };
      }
    }
  }
  return { valid: false };
}

/** Scans base-end indices in [minBaseStart, scanEnd) for valid base+displacement pairs; bases can't start before minBaseStart. */
export function findZoneCandidates(candles: Candle[], atr: number[], minBaseStart: number, scanEnd: number): RawZoneCandidate[] {
  const candidates: RawZoneCandidate[] = [];
  for (let i = minBaseStart; i < scanEnd; i++) {
    for (let baseLen = 1; baseLen <= BASE_MAX_LEN; baseLen++) {
      const baseStart = i - baseLen + 1;
      if (baseStart < minBaseStart) continue;

      let baseHigh = -Infinity;
      let baseLow = Infinity;
      for (let k = baseStart; k <= i; k++) {
        baseHigh = Math.max(baseHigh, candles[k].high);
        baseLow = Math.min(baseLow, candles[k].low);
      }
      if (baseHigh - baseLow > BASE_RANGE_ATR_MULT * atr[i]) continue;

      const displacement = checkDisplacement(candles, atr[i], i + 1, scanEnd);
      if (!displacement.valid) continue;

      candidates.push({
        type: displacement.direction === "up" ? "demand" : "supply",
        baseStartIndex: baseStart,
        baseEndIndex: i,
        confirmedIndex: displacement.endIdx!,
        openTime: candles[baseStart].openTime,
        closeTime: candles[i].closeTime,
        high: baseHigh,
        low: baseLow,
        displacementOpenTime: candles[i + 1].openTime,
        baseLen,
      });
    }
  }
  return candidates;
}

/** Candidates sharing the same displacement are the same real event — keep only the longest base. */
export function mergeZoneCandidates(candidates: RawZoneCandidate[]): ZoneCandidate[] {
  const byDisplacement = new Map<number, RawZoneCandidate>();
  for (const c of candidates) {
    const existing = byDisplacement.get(c.displacementOpenTime);
    if (!existing || c.baseLen > existing.baseLen) byDisplacement.set(c.displacementOpenTime, c);
  }
  return [...byDisplacement.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map(({ type, baseStartIndex, baseEndIndex, confirmedIndex, openTime, closeTime, high, low }) => ({
      type,
      baseStartIndex,
      baseEndIndex,
      confirmedIndex,
      openTime,
      closeTime,
      high,
      low,
    }));
}
