/**
 * TICKET-06X-A diagnostic — visual check only, not a statistical verdict.
 * Dumps base+displacement zone candidates and equal-high/low pairs across 15
 * random 3-year BTC M15 segments so they can be checked by eye against a
 * real chart. Locked parameters (do not retune after seeing output):
 *   base range          <= 1.5 x ATR(14) at the base's last candle
 *   displacement (<=3c)  >= 2 x ATR(14) net move, or any single candle range >= 2 x ATR(14)
 *   equal high/low       <= 0.1 x ATR(14) at the later swing
 *
 * Run: tsx scripts/research/zoneDefinitionVisualCheck.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../../src/core/types.js";
import { computeAdxDi } from "../../src/regime/adxDiCompare.js";

const DATA_PATH = resolve("data/ohlcv-BTCUSDT-15m-2021-2024.json");
const REPORT_OUT_PATH = resolve("data/ticket06x-zone-definition-visual-check.json");

const BASE_MAX_LEN = 6;
const BASE_RANGE_ATR_MULT = 1.5;
const DISPLACEMENT_MAX_CANDLES = 3;
const DISPLACEMENT_ATR_MULT = 2;
const EQUAL_ATR_MULT = 0.1;

const SEGMENT_COUNT = 15;
const SEGMENT_LEN = 200;
const RANDOM_SEED = 0x06a5c3; // locked so segment picks are reproducible

// D1 — CONVENTION: strict five-candle fractal, confirmed only after both right-side candles close.
const SWING_WINDOW = 5;
const SWING_SIDE_CANDLES = 2;

interface SwingPoint {
  index: number;
  type: "high" | "low";
  price: number;
}

interface ZoneCandidate {
  type: "demand" | "supply";
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
}

// Raw candidate before merge: carries the displacement's start time (grouping key) and base length (tie-break).
interface RawZoneCandidate extends ZoneCandidate {
  displacementOpenTime: number;
  baseLen: number;
}

interface EqualPoint {
  type: "equal-high" | "equal-low";
  aIndex: number;
  bIndex: number;
  priceA: number;
  priceB: number;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

// Reproduced unchanged from the manually-verified swingPoints.ts (pre-RESET) — same fractal, same offsets.
function detectSwingPoints(candles: readonly Candle[]): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let confirmedAt = SWING_WINDOW - 1; confirmedAt < candles.length; confirmedAt += 1) {
    const window = candles.slice(confirmedAt - SWING_WINDOW + 1, confirmedAt + 1);
    const center = window[SWING_SIDE_CANDLES];
    const neighbors = window.filter((_, index) => index !== SWING_SIDE_CANDLES);
    const index = confirmedAt - SWING_SIDE_CANDLES;

    if (neighbors.every((item) => center.high > item.high)) {
      swings.push({ index, type: "high", price: center.high });
    }
    if (neighbors.every((item) => center.low < item.low)) {
      swings.push({ index, type: "low", price: center.low });
    }
  }
  return swings;
}

// mulberry32 — deterministic PRNG so segment picks don't change between runs.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSegments(candleCount: number): { start: number; end: number }[] {
  const rand = mulberry32(RANDOM_SEED);
  const segments: { start: number; end: number }[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const start = Math.floor(rand() * (candleCount - SEGMENT_LEN));
    segments.push({ start, end: start + SEGMENT_LEN });
  }
  return segments;
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

function findZoneCandidates(candles: Candle[], atr: number[], segStart: number, segEnd: number): RawZoneCandidate[] {
  const candidates: RawZoneCandidate[] = [];
  for (let i = segStart; i < segEnd; i++) {
    for (let baseLen = 1; baseLen <= BASE_MAX_LEN; baseLen++) {
      const baseStart = i - baseLen + 1;
      if (baseStart < segStart) continue;

      let baseHigh = -Infinity;
      let baseLow = Infinity;
      for (let k = baseStart; k <= i; k++) {
        baseHigh = Math.max(baseHigh, candles[k].high);
        baseLow = Math.min(baseLow, candles[k].low);
      }
      if (baseHigh - baseLow > BASE_RANGE_ATR_MULT * atr[i]) continue;

      const displacement = checkDisplacement(candles, atr[i], i + 1, segEnd);
      if (!displacement.valid) continue;

      candidates.push({
        type: displacement.direction === "up" ? "demand" : "supply",
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

// TICKET-06X-A2: candidates sharing the same displacement are the same real event — keep only the longest base.
function mergeZoneCandidates(candidates: RawZoneCandidate[]): ZoneCandidate[] {
  const byDisplacement = new Map<number, RawZoneCandidate>();
  for (const c of candidates) {
    const existing = byDisplacement.get(c.displacementOpenTime);
    if (!existing || c.baseLen > existing.baseLen) byDisplacement.set(c.displacementOpenTime, c);
  }
  return [...byDisplacement.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map(({ type, openTime, closeTime, high, low }) => ({ type, openTime, closeTime, high, low }));
}

function findEqualPoints(swings: SwingPoint[], atr: number[]): EqualPoint[] {
  const equals: EqualPoint[] = [];
  for (const kind of ["high", "low"] as const) {
    const ofKind = swings.filter((s) => s.type === kind);
    for (let i = 1; i < ofKind.length; i++) {
      const a = ofKind[i - 1];
      const b = ofKind[i];
      if (Math.abs(b.price - a.price) <= EQUAL_ATR_MULT * atr[b.index]) {
        equals.push({
          type: kind === "high" ? "equal-high" : "equal-low",
          aIndex: a.index,
          bIndex: b.index,
          priceA: a.price,
          priceB: b.price,
        });
      }
    }
  }
  return equals;
}

function main() {
  const candles = loadJson<Candle[]>(DATA_PATH);
  const { atr } = computeAdxDi(candles);
  const swings = detectSwingPoints(candles);
  const segments = pickSegments(candles.length);

  const results = segments.map((seg, segIdx) => {
    const zoneCandidates = mergeZoneCandidates(findZoneCandidates(candles, atr, seg.start, seg.end));
    const segSwings = swings.filter((s) => s.index >= seg.start && s.index < seg.end);
    const equalPoints = findEqualPoints(segSwings, atr).map((e) => ({
      type: e.type,
      openTime: candles[e.aIndex].openTime,
      closeTime: candles[e.bIndex].closeTime,
      priceA: e.priceA,
      priceB: e.priceB,
    }));

    return {
      segmentIndex: segIdx,
      segmentStartTime: candles[seg.start].openTime,
      segmentEndTime: candles[seg.end - 1].closeTime,
      zoneCandidates,
      equalPoints,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    params: {
      baseMaxLen: BASE_MAX_LEN,
      baseRangeAtrMult: BASE_RANGE_ATR_MULT,
      displacementMaxCandles: DISPLACEMENT_MAX_CANDLES,
      displacementAtrMult: DISPLACEMENT_ATR_MULT,
      equalAtrMult: EQUAL_ATR_MULT,
      segmentCount: SEGMENT_COUNT,
      segmentLen: SEGMENT_LEN,
      randomSeed: RANDOM_SEED,
    },
    segments: results,
  };
  writeFileSync(REPORT_OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`Saved ${SEGMENT_COUNT} segments to ${REPORT_OUT_PATH}`);
  for (const r of results) {
    console.log(
      `segment ${r.segmentIndex}: ${new Date(r.segmentStartTime).toISOString()} -> ${new Date(r.segmentEndTime).toISOString()}, zones=${r.zoneCandidates.length}, equalPoints=${r.equalPoints.length}`,
    );
  }
}

main();
