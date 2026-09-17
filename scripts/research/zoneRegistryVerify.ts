/**
 * TICKET-06X-C verify — hand-built candle sequences with known expected states.
 * Run: tsx scripts/research/zoneRegistryVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { advanceRegistry, buildInitialRegistry, type Zone } from "../../src/entry/zoneRegistry.js";

const BAR_MS = 15 * 60 * 1000;
// Large flat ATR so none of the price moves below accidentally satisfy base+displacement and spawn a stray zone.
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

function runDemand(name: string, candles: Candle[], expectState: Zone["state"], expectTouches: number) {
  const zoneSeed: Zone = {
    id: "z",
    type: "demand",
    high: 110,
    low: 100,
    createdAtIndex: 0,
    state: "VALID",
    touchCount: 0,
    imbalance: null,
    imbalanceMitigated: false,
    hasNearbyLiquidity: false,
    nearbyLiquidityLevel: null,
    liquiditySwept: false,
  };
  const atr = Array(candles.length).fill(FLAT_ATR);
  let zones: Zone[] = [zoneSeed];
  for (let i = 1; i < candles.length; i++) zones = advanceRegistry(zones, candles, atr, i);
  const z = zones.find((x) => x.id === "z")!;
  check(`${name} (state)`, z.state, expectState);
  check(`${name} (touchCount)`, z.touchCount, expectTouches);
}

// Scenario 1: price stays well clear of [100,110] for several candles -> stays VALID.
runDemand(
  "never touched stays VALID",
  [candle(0, 200, 205, 195, 200), candle(1, 200, 206, 194, 201), candle(2, 201, 207, 195, 202), candle(3, 202, 208, 196, 203)],
  "VALID",
  0,
);

// Scenario 2: wick dips into [100,110], close holds above low -> TESTED, touchCount 1.
runDemand("wick touch, close holds -> TESTED", [candle(0, 200, 205, 195, 200), candle(1, 150, 155, 105, 140)], "TESTED", 1);

// Scenario 3: candle closes below the zone's low -> INVALIDATED.
runDemand("close breaks below -> INVALIDATED", [candle(0, 200, 205, 195, 200), candle(1, 105, 108, 90, 95)], "INVALIDATED", 0);

// Scenario 4: after INVALIDATED, price fully re-enters [100,110] -> no recovery, stays INVALIDATED.
runDemand(
  "no recovery after INVALIDATED",
  [candle(0, 200, 205, 195, 200), candle(1, 105, 108, 90, 95), candle(2, 96, 112, 94, 105)],
  "INVALIDATED",
  0,
);

// Bonus: supply is the mirror of demand — close above the zone's high invalidates it permanently.
{
  const zoneSeed: Zone = {
    id: "s",
    type: "supply",
    high: 110,
    low: 100,
    createdAtIndex: 0,
    state: "VALID",
    touchCount: 0,
    imbalance: null,
    imbalanceMitigated: false,
    hasNearbyLiquidity: false,
    nearbyLiquidityLevel: null,
    liquiditySwept: false,
  };
  const candles = [candle(0, 50, 55, 45, 50), candle(1, 112, 120, 108, 115), candle(2, 105, 118, 95, 104)];
  const atr = Array(candles.length).fill(FLAT_ATR);
  let zones: Zone[] = [zoneSeed];
  for (let i = 1; i < candles.length; i++) zones = advanceRegistry(zones, candles, atr, i);
  const z = zones.find((x) => x.id === "s")!;
  check("supply mirror: close above -> INVALIDATED, no recovery", z.state, "INVALIDATED");
}

// TICKET-27X-F: liquiditySwept — same latch pattern as imbalanceMitigated, but gated on a CLOSE
// past nearbyLiquidityLevel (a wick alone must not count, per the method's false-signal filter).
function runLiquiditySweep(name: string, candles: Candle[], expectSweptSequence: boolean[]) {
  const zoneSeed: Zone = {
    id: "z",
    type: "demand",
    high: 110,
    low: 100,
    createdAtIndex: 0,
    state: "VALID",
    touchCount: 0,
    imbalance: null,
    imbalanceMitigated: false,
    hasNearbyLiquidity: true,
    nearbyLiquidityLevel: 95, // resting liquidity just below this demand zone's low
    liquiditySwept: false,
  };
  const atr = Array(candles.length).fill(FLAT_ATR);
  let zones: Zone[] = [zoneSeed];
  const observed: boolean[] = [];
  for (let i = 1; i < candles.length; i++) {
    zones = advanceRegistry(zones, candles, atr, i);
    observed.push(zones.find((z) => z.id === "z")!.liquiditySwept);
  }
  check(name, observed, expectSweptSequence);
}

// 2. Candle closes past the liquidity level (95) -> liquiditySwept flips true from that candle on.
runLiquiditySweep(
  "liquiditySwept: close past level -> true from that candle on",
  [candle(0, 200, 205, 195, 200), candle(1, 200, 202, 198, 199), candle(2, 97, 98, 90, 93)],
  [false, true],
);

// 3. Wick dips below the level but closes back above it -> liquiditySwept stays false (no wick-only trigger).
runLiquiditySweep(
  "liquiditySwept: wick-only dip below level -> stays false",
  [candle(0, 200, 205, 195, 200), candle(1, 200, 202, 90, 199)],
  [false],
);

// 4. Once swept, price closing back above the level -> liquiditySwept stays true (no reversal).
runLiquiditySweep(
  "liquiditySwept: latches true, no reversal on close back above",
  [candle(0, 200, 205, 195, 200), candle(1, 97, 98, 90, 93), candle(2, 96, 150, 95, 140)],
  [true, true],
);

// Smoke test: buildInitialRegistry over a real base+displacement pattern actually produces a zone.
{
  const candles = [
    candle(0, 100, 101, 99, 100), // 1-candle base, range 2 <= 1.5x50=75
    candle(1, 100, 200, 100, 195), // displacement: single-candle range 100 >= 2x50=100
  ];
  const atr = Array(candles.length).fill(50);
  const registry = buildInitialRegistry(candles, atr);
  check("buildInitialRegistry finds the seeded demand zone", registry.length, 1);
  check("buildInitialRegistry zone type", registry[0]?.type, "demand");
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
