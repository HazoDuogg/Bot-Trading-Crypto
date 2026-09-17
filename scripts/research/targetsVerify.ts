/**
 * TICKET-08X-A/B verify — hand-built zones/candles with known expected targets and split decisions.
 * Run: tsx scripts/research/targetsVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import type { Zone } from "../../src/entry/zoneRegistry.js";
import { computeTargets, decideTradeSplit } from "../../src/entry/targets.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const UNMITIGATED_IMBALANCE = { high: 1, low: 0 }; // placeholder gap, value doesn't matter for these tests

function zone(overrides: Partial<Zone>): Zone {
  return {
    id: "z",
    type: "supply",
    high: 0,
    low: 0,
    createdAtIndex: 0,
    state: "VALID",
    touchCount: 0,
    imbalance: UNMITIGATED_IMBALANCE, // TICKET-27X-A: findNearTarget now requires a live imbalance by default
    imbalanceMitigated: false,
    hasNearbyLiquidity: false,
    ...overrides,
  };
}

const D1_MS = 24 * 60 * 60 * 1000;
function d1(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * D1_MS, closeTime: i * D1_MS + D1_MS - 1, open, high, low, close, volume: 1 };
}

// A swing high at index 2 (price 130), confirmed by TICKET-07X-A's same 5-candle-fractal technique.
const dailyWithSwingHigh130: Candle[] = [
  d1(0, 100, 101, 99, 100),
  d1(1, 100, 110, 99, 108),
  d1(2, 108, 130, 107, 120),
  d1(3, 120, 115, 105, 110),
  d1(4, 110, 112, 100, 105),
];

// --- TICKET-08X-A: nearTarget (M15 zone) ---
{
  const entryPrice = 100;
  const registry = [
    zone({ id: "s1", type: "supply", high: 110, low: 108 }), // nearest supply above entry
    zone({ id: "s2", type: "supply", high: 140, low: 138 }), // farther supply above entry
    zone({ id: "d1", type: "demand", high: 90, low: 88 }), // wrong type, must be ignored
    zone({ id: "s3", type: "supply", high: 105, low: 103, state: "INVALIDATED" }), // closer but already broken
  ];
  const { nearTarget } = computeTargets("UP", entryPrice, registry, []);
  check("nearTarget: nearest live supply zone above entry", nearTarget?.id, "s1");
}

// --- TICKET-08X-A: nearTarget not found ---
{
  const registry = [zone({ id: "s1", type: "supply", high: 90, low: 88 })]; // below entry, doesn't count
  const { nearTarget } = computeTargets("UP", 100, registry, []);
  check("nearTarget: none above entry -> null", nearTarget, null);
}

// --- TICKET-08X-A: farTarget (D1 swing) ---
{
  const { farTarget } = computeTargets("UP", 100, [], dailyWithSwingHigh130);
  check("farTarget: nearest D1 swing high above entry", farTarget, { index: 2, price: 130 });
}

// --- TICKET-08X-A: farTarget not found ---
{
  const { farTarget } = computeTargets("UP", 200, [], dailyWithSwingHigh130);
  check("farTarget: no swing above entry -> null", farTarget, null);
}

// --- TICKET-27X-A #1: nearest zone already mitigated -> skipped, picks the further still-imbalanced zone. ---
{
  const entryPrice = 100;
  const registry = [
    zone({ id: "s1", type: "supply", high: 110, low: 108, imbalanceMitigated: true }), // nearest, but imbalance gone
    zone({ id: "s2", type: "supply", high: 140, low: 138 }), // further, still has imbalance
  ];
  const { nearTarget } = computeTargets("UP", entryPrice, registry, []);
  check("nearTarget: mitigated nearest zone skipped, further imbalanced zone picked", nearTarget?.id, "s2");
}

// --- TICKET-27X-A #2: no zone with a live imbalance -> nearTarget = null, same as no zone at all. ---
{
  const entryPrice = 100;
  const registry = [
    zone({ id: "s1", type: "supply", high: 110, low: 108, imbalance: null }),
    zone({ id: "s2", type: "supply", high: 140, low: 138, imbalanceMitigated: true }),
  ];
  const { nearTarget } = computeTargets("UP", entryPrice, registry, []);
  check("nearTarget: no live-imbalance zone -> null", nearTarget, null);
}

// --- TICKET-08X-B: far >= 2x near -> SPLIT (slPrice close enough that R:R gate passes [3,5]) ---
{
  // entry 100, SL 97 (distance 3), near edge 110 (distance 10, R:R=3.33, within [3,5]), far 130 (distance 30, >= 2x10) -> SPLIT
  const decision = decideTradeSplit("UP", 100, 97, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 130 } });
  check("far >= 2x near -> SPLIT", decision, { mode: "SPLIT", tp1: 110, tp2: 130 });
}

// --- TICKET-08X-B: far < 2x near -> SINGLE ---
{
  // entry 100, SL 97, near edge 110 (distance 10), far 115 (distance 15, < 2x10) -> SINGLE
  const decision = decideTradeSplit("UP", 100, 97, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 115 } });
  check("far < 2x near -> SINGLE", decision, { mode: "SINGLE", tp1: 110 });
}

// --- TICKET-08X-B: no nearTarget -> INSUFFICIENT_DATA ---
{
  const decision = decideTradeSplit("UP", 100, 97, { nearTarget: null, farTarget: { index: 2, price: 130 } });
  check("no nearTarget -> INSUFFICIENT_DATA", decision, { mode: "INSUFFICIENT_DATA" });
}

// --- TICKET-08X-B: nearTarget present, no farTarget -> SINGLE at nearTarget ---
{
  const decision = decideTradeSplit("UP", 100, 97, { nearTarget: zone({ high: 110, low: 110 }), farTarget: null });
  check("nearTarget only -> SINGLE", decision, { mode: "SINGLE", tp1: 110 });
}

// --- TICKET-27X-A #3: nearTarget exists but R:R < 3 -> INSUFFICIENT_DATA, regardless of SPLIT/SINGLE. ---
{
  // entry 100, SL 96 (distance 4, so 3x = 12), near edge 110 (distance 10 < 12) -> blocked
  const decision = decideTradeSplit("UP", 100, 96, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 130 } });
  check("R:R < 3 -> INSUFFICIENT_DATA", decision, { mode: "INSUFFICIENT_DATA" });
}

// --- TICKET-27X-A #4: R:R >= 3 (right at the boundary) -> normal SPLIT/SINGLE logic still applies. ---
{
  // entry 100, SL 97 (distance 3, so 3x = 9), near edge 110 (distance 10 >= 9) -> passes, far < 2x near -> SINGLE
  const decision = decideTradeSplit("UP", 100, 97, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 115 } });
  check("R:R >= 3 (boundary) -> SINGLE as usual", decision, { mode: "SINGLE", tp1: 110 });
}

// --- TICKET-27X-B #2: R:R = 3.5 (middle of the [3,5] window) -> enters normally. ---
{
  // entry 100, SL 98 (distance 2), near edge 107 (distance 7, ratio 3.5) -> passes both gates -> SINGLE
  const decision = decideTradeSplit("UP", 100, 98, { nearTarget: zone({ high: 107, low: 107 }), farTarget: null });
  check("R:R = 3.5 (mid-window) -> SINGLE as usual", decision, { mode: "SINGLE", tp1: 107 });
}

// --- TICKET-27X-B #3: R:R = 5.0 (right at the ceiling) -> closed boundary, still enters. ---
{
  // entry 100, SL 98 (distance 2), near edge 110 (distance 10, ratio 5.0) -> passes -> SINGLE
  const decision = decideTradeSplit("UP", 100, 98, { nearTarget: zone({ high: 110, low: 110 }), farTarget: null });
  check("R:R = 5.0 (ceiling boundary) -> SINGLE as usual", decision, { mode: "SINGLE", tp1: 110 });
}

// --- TICKET-27X-B #4: R:R = 8 (past the ceiling) -> INSUFFICIENT_DATA. ---
{
  // entry 100, SL 98 (distance 2), near edge 116 (distance 16, ratio 8) -> blocked
  const decision = decideTradeSplit("UP", 100, 98, { nearTarget: zone({ high: 116, low: 116 }), farTarget: null });
  check("R:R = 8 (past ceiling) -> INSUFFICIENT_DATA", decision, { mode: "INSUFFICIENT_DATA" });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
