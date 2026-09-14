/**
 * TICKET-10X-A verify — SL formula and order sizing for both split modes.
 * Run: tsx scripts/research/positionSizerVerify.ts
 */
import type { Zone } from "../../src/entry/zoneRegistry.js";
import type { SplitDecision } from "../../src/entry/targets.js";
import { computeStopLoss, computeOrderSizes, RISK_PCT_PER_TRADE, SL_BUFFER_ATR_MULT } from "../../src/risk/positionSizer.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function zone(overrides: Partial<Zone>): Zone {
  return {
    id: "z",
    type: "demand",
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

const ATR = 10;

// 1. SL formula, both directions.
check("SL for UP", computeStopLoss("UP", zone({ type: "demand", high: 110, low: 100 }), ATR), 100 - SL_BUFFER_ATR_MULT * ATR);
check("SL for DOWN", computeStopLoss("DOWN", zone({ type: "supply", high: 110, low: 100 }), ATR), 110 + SL_BUFFER_ATR_MULT * ATR);

// 2. SINGLE: equity 10,000, risk 1%, entry 100, SL 95 -> distance 5 -> qty = 10000*0.01/5 = 20.
{
  const split: SplitDecision = { mode: "SINGLE", tp1: 120 };
  const orders = computeOrderSizes(split, "UP", 100, 95, 10_000);
  check("SINGLE sizing", orders, [{ entryPrice: 100, stopLoss: 95, takeProfit: 120, riskPct: RISK_PCT_PER_TRADE, quantity: 20 }]);
}

// 3. SPLIT: 2 orders, each 0.5% risk, own tp1/tp2. entry 100, SL 95 -> distance 5 -> qty = 10000*0.005/5 = 10 each.
{
  const split: SplitDecision = { mode: "SPLIT", tp1: 120, tp2: 160 };
  const orders = computeOrderSizes(split, "UP", 100, 95, 10_000);
  check("SPLIT sizing", orders, [
    { entryPrice: 100, stopLoss: 95, takeProfit: 120, riskPct: RISK_PCT_PER_TRADE / 2, quantity: 10 },
    { entryPrice: 100, stopLoss: 95, takeProfit: 160, riskPct: RISK_PCT_PER_TRADE / 2, quantity: 10 },
  ]);
}

// 4. INSUFFICIENT_DATA -> null.
{
  const split: SplitDecision = { mode: "INSUFFICIENT_DATA" };
  check("INSUFFICIENT_DATA -> null", computeOrderSizes(split, "UP", 100, 95, 10_000), null);
}

// 5. entryPrice === slPrice -> null, no crash.
{
  const split: SplitDecision = { mode: "SINGLE", tp1: 120 };
  check("entryPrice === slPrice -> null", computeOrderSizes(split, "UP", 100, 100, 10_000), null);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
