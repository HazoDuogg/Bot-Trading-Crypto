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
import {
  findZoneCandidates,
  mergeZoneCandidates,
  BASE_MAX_LEN,
  BASE_RANGE_ATR_MULT,
  DISPLACEMENT_MAX_CANDLES,
  DISPLACEMENT_ATR_MULT,
} from "../../src/entry/zoneDetection.js";

const DATA_PATH = resolve("data/ohlcv-BTCUSDT-15m-2021-2024.json");
const REPORT_OUT_PATH = resolve("data/ticket06x-zone-definition-visual-check.json");

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
    const zoneCandidates = mergeZoneCandidates(findZoneCandidates(candles, atr, seg.start, seg.end)).map(
      ({ type, openTime, closeTime, high, low }) => ({ type, openTime, closeTime, high, low }),
    );
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
