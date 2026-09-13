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

function zone(overrides: Partial<Zone>): Zone {
  return {
    id: "z",
    type: "supply",
    high: 0,
    low: 0,
    createdAtIndex: 0,
    state: "VALID",
    touchCount: 0,
    imbalance: null,
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

// --- TICKET-08X-B: far >= 2x near -> SPLIT ---
{
  // entry 100, near edge 110 (distance 10), far 130 (distance 30, >= 2x10) -> SPLIT
  const decision = decideTradeSplit("UP", 100, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 130 } });
  check("far >= 2x near -> SPLIT", decision, { mode: "SPLIT", tp1: 110, tp2: 130 });
}

// --- TICKET-08X-B: far < 2x near -> SINGLE ---
{
  // entry 100, near edge 110 (distance 10), far 115 (distance 15, < 2x10) -> SINGLE
  const decision = decideTradeSplit("UP", 100, { nearTarget: zone({ high: 110, low: 110 }), farTarget: { index: 2, price: 115 } });
  check("far < 2x near -> SINGLE", decision, { mode: "SINGLE", tp1: 110 });
}

// --- TICKET-08X-B: no nearTarget -> INSUFFICIENT_DATA ---
{
  const decision = decideTradeSplit("UP", 100, { nearTarget: null, farTarget: { index: 2, price: 130 } });
  check("no nearTarget -> INSUFFICIENT_DATA", decision, { mode: "INSUFFICIENT_DATA" });
}

// --- TICKET-08X-B: nearTarget present, no farTarget -> SINGLE at nearTarget ---
{
  const decision = decideTradeSplit("UP", 100, { nearTarget: zone({ high: 110, low: 110 }), farTarget: null });
  check("nearTarget only -> SINGLE", decision, { mode: "SINGLE", tp1: 110 });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
