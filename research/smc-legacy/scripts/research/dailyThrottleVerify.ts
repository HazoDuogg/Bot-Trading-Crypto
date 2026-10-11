/**
 * TICKET-09X-A verify — hand-built closed-trade sequences with known expected results.
 * Run: tsx scripts/research/dailyThrottleVerify.ts
 */
import { isDailyThrottled, isEntryAllowedGivenThrottle, type ClosedTrade } from "../../src/risk/dailyThrottle.js";

const DAY_MS = 86_400_000;
const TODAY_START = 20 * DAY_MS; // arbitrary UTC day boundary
const NOW = TODAY_START + 12 * 60 * 60 * 1000; // noon today
const EQUITY = 10_000;

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${actual}, expected ${expected}`);
}

// 1. No trades today -> not throttled.
check("no trades today -> not throttled", isDailyThrottled([], EQUITY, NOW), false);

// 2. Total profit exactly 5% -> throttled (boundary is >=).
{
  const trades: ClosedTrade[] = [{ closeTime: TODAY_START + 60_000, realizedPnl: 500 }];
  check("profit exactly 5% -> throttled", isDailyThrottled(trades, EQUITY, NOW), true);
}

// 3. Total profit below 5% -> not throttled.
{
  const trades: ClosedTrade[] = [{ closeTime: TODAY_START + 60_000, realizedPnl: 499 }];
  check("profit below 5% -> not throttled", isDailyThrottled(trades, EQUITY, NOW), false);
}

// 4. Trade closed yesterday with huge profit -> doesn't count today.
{
  const trades: ClosedTrade[] = [{ closeTime: TODAY_START - 60_000, realizedPnl: 5000 }];
  check("yesterday's huge profit -> not throttled today", isDailyThrottled(trades, EQUITY, NOW), false);
}

// 5. Trade opened yesterday, closed today -> counted for today (closeTime is what matters).
{
  const trades: ClosedTrade[] = [{ closeTime: TODAY_START + 60_000, realizedPnl: 500 }];
  check("opened yesterday, closed today -> counted today", isDailyThrottled(trades, EQUITY, NOW), true);
}

// 6. isEntryAllowedGivenThrottle gating.
check("throttled + score=2 -> allowed", isEntryAllowedGivenThrottle(2, true), true);
check("throttled + score=1 -> blocked", isEntryAllowedGivenThrottle(1, true), false);
check("not throttled + score=-1 -> allowed", isEntryAllowedGivenThrottle(-1, false), true);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
