/**
 * TICKET-06X-F2 verify — 5 hand-built zones covering the locked formula's combinations.
 * Run: tsx scripts/research/confluenceScoreVerify.ts
 */
import { computeConfluenceScore } from "../../src/entry/confluenceScore.js";
import type { Zone } from "../../src/entry/zoneRegistry.js";

let failures = 0;
function check(name: string, actual: number, expected: number) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${actual}, expected ${expected}`);
}

function zone(overrides: Partial<Zone>): Zone {
  return {
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
    ...overrides,
  };
}

// 1. Unmitigated imbalance + nearby liquidity + touchCount<3 -> 2.
check(
  "imbalance + liquidity, touchCount<3 -> 2",
  computeConfluenceScore(zone({ imbalance: { high: 105, low: 102 }, imbalanceMitigated: false, hasNearbyLiquidity: true, touchCount: 1 })),
  2,
);

// 2. Unmitigated imbalance, no liquidity, touchCount<3 -> 1.
check(
  "imbalance only, touchCount<3 -> 1",
  computeConfluenceScore(zone({ imbalance: { high: 105, low: 102 }, imbalanceMitigated: false, hasNearbyLiquidity: false, touchCount: 1 })),
  1,
);

// 3. No imbalance (mitigated), nearby liquidity, touchCount<3 -> 1.
check(
  "mitigated imbalance + liquidity, touchCount<3 -> 1",
  computeConfluenceScore(zone({ imbalance: { high: 105, low: 102 }, imbalanceMitigated: true, hasNearbyLiquidity: true, touchCount: 1 })),
  1,
);

// 4. Both bonus factors but touchCount>=3 -> 2-1=1.
check(
  "imbalance + liquidity, touchCount>=3 -> 1",
  computeConfluenceScore(zone({ imbalance: { high: 105, low: 102 }, imbalanceMitigated: false, hasNearbyLiquidity: true, touchCount: 3 })),
  1,
);

// 5. No bonus factors, touchCount>=3 -> -1.
check(
  "no bonuses, touchCount>=3 -> -1",
  computeConfluenceScore(zone({ imbalance: null, imbalanceMitigated: false, hasNearbyLiquidity: false, touchCount: 4 })),
  -1,
);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
