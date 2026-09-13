/**
 * TICKET-06X-E verify — hand-built candle sequences with known expected results.
 * Run: tsx scripts/research/imbalanceVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { findFvgInRange } from "../../src/entry/imbalance.js";
import { advanceRegistry, type Zone } from "../../src/entry/zoneRegistry.js";

const BAR_MS = 15 * 60 * 1000;
// Zone band (9900-10000) is far from every price used below, and ATR is large — so only imbalanceMitigated moves.
const FLAT_ATR = 1000;

function candle(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * BAR_MS, closeTime: i * BAR_MS + BAR_MS - 1, open, high, low, close, volume: 1 };
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Scenario 1: clear bullish FVG among 3 candles.
{
  const candles = [candle(0, 100, 105, 95, 102), candle(1, 103, 120, 102, 118), candle(2, 119, 130, 110, 125)];
  check("bullish FVG found", findFvgInRange(candles, 0, 2, "demand"), { high: 110, low: 105 });
}

// Scenario 2: no gap across 3 consecutive candles.
{
  const candles = [candle(0, 100, 105, 95, 102), candle(1, 103, 108, 100, 106), candle(2, 105, 109, 101, 107)];
  check("no gap -> null", findFvgInRange(candles, 0, 2, "demand"), null);
}

function runMitigation(name: string, imbalance: { high: number; low: number } | null, followUps: Candle[], expected: boolean[]) {
  const seed = candle(0, 9950, 9955, 9945, 9950); // filler candle 0, far from both the zone band and the gap
  const allCandles = [seed, ...followUps];
  const atr = Array(allCandles.length).fill(FLAT_ATR);
  let zones: Zone[] = [
    { id: "z", type: "demand", high: 10000, low: 9900, createdAtIndex: 0, state: "VALID", touchCount: 0, imbalance, imbalanceMitigated: false, hasNearbyLiquidity: false },
  ];
  const observed: boolean[] = [];
  for (let i = 1; i < allCandles.length; i++) {
    zones = advanceRegistry(zones, allCandles, atr, i);
    observed.push(zones.find((z) => z.id === "z")!.imbalanceMitigated);
  }
  check(name, observed, expected);
}

// Scenario 3: gap [100,110], next candle covers only part of it -> stays false.
runMitigation("partial coverage stays unmitigated", { high: 110, low: 100 }, [candle(1, 106, 108, 105, 107)], [false]);

// Scenario 4: next candle fully covers [100,110] -> true, and a later unrelated candle doesn't flip it back.
runMitigation(
  "full coverage mitigates, no recovery",
  { high: 110, low: 100 },
  [candle(1, 98, 115, 95, 112), candle(2, 9950, 9955, 9945, 9950)],
  [true, true],
);

// Scenario 5: no imbalance at all -> imbalanceMitigated can never become true, even with the same fully-covering candle.
runMitigation("no imbalance -> never mitigated", null, [candle(1, 98, 115, 95, 112)], [false]);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
