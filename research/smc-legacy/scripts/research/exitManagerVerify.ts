/**
 * TICKET-11X-A verify — hand-built candles against known SL/TP outcomes.
 * Run: tsx scripts/research/exitManagerVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import type { OrderSize } from "../../src/risk/positionSizer.js";
import { checkExit } from "../../src/exit/exitManager.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function order(stopLoss: number, takeProfit: number): OrderSize {
  return { entryPrice: 100, stopLoss, takeProfit, riskPct: 0.01, quantity: 1 };
}
function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, closeTime: 899_999, open, high, low, close, volume: 1 };
}

// UP: SL=90, TP=120.
const upOrder = order(90, 120);
check("UP: TP hit, SL not -> TP_HIT", checkExit(upOrder, "UP", candle(100, 121, 99, 121)), { reason: "TP_HIT", exitPrice: 120 });
check("UP: SL hit, TP not -> SL_HIT", checkExit(upOrder, "UP", candle(100, 101, 89, 91)), { reason: "SL_HIT", exitPrice: 90 });
check("UP: both hit -> SL_HIT wins", checkExit(upOrder, "UP", candle(100, 121, 89, 100)), { reason: "SL_HIT", exitPrice: 90 });
check("UP: neither hit -> NONE", checkExit(upOrder, "UP", candle(100, 105, 95, 100)), { reason: "NONE", exitPrice: null });

// DOWN: SL=110, TP=80 (mirrored).
const downOrder = order(110, 80);
check("DOWN: TP hit, SL not -> TP_HIT", checkExit(downOrder, "DOWN", candle(100, 101, 79, 79)), { reason: "TP_HIT", exitPrice: 80 });
check("DOWN: SL hit, TP not -> SL_HIT", checkExit(downOrder, "DOWN", candle(100, 111, 99, 109)), { reason: "SL_HIT", exitPrice: 110 });
check("DOWN: both hit -> SL_HIT wins", checkExit(downOrder, "DOWN", candle(100, 111, 79, 100)), { reason: "SL_HIT", exitPrice: 110 });
check("DOWN: neither hit -> NONE", checkExit(downOrder, "DOWN", candle(100, 105, 95, 100)), { reason: "NONE", exitPrice: null });

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
