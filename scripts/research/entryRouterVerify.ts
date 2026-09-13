/**
 * TICKET-07X-B verify — synthetic D1/M15/M5 series with a known outcome each.
 * Run: tsx scripts/research/entryRouterVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { detectEntry } from "../../src/entry/entryRouter.js";

function mk(barMs: number, i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * barMs, closeTime: i * barMs + barMs - 1, open, high, low, close, volume: 1 };
}
const D1_MS = 24 * 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;

// Same D1 uptrend generator technique as TICKET-07X-A's directionFilterVerify.ts.
function strongUptrendD1(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const close = price + 2;
    candles.push(mk(D1_MS, i, price, close + 0.5, price - 0.5, close));
    price = close;
  }
  return candles;
}
function flatSidewayD1(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const close = i % 2 === 0 ? price + 1 : price - 1;
    candles.push(mk(D1_MS, i, price, Math.max(price, close) + 0.3, Math.min(price, close) - 0.3, close));
    price = close;
  }
  return candles;
}

// M15 base+displacement: 20 flat candles (ATR warm-up) then a 1-candle base and a big up displacement -> one demand zone [99,101].
function m15WithDemandZone(): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 20; i++) candles.push(mk(M15_MS, i, price, price + 1, price - 1, price));
  candles.push(mk(M15_MS, 20, 100, 101, 99, 100));
  candles.push(mk(M15_MS, 21, 100, 135, 100, 130));
  return candles;
}

// M5: swing high (160) at index 2, price drops to retest the [99,101] zone at index 6, then rallies back up.
function m5UpTo(lastIndex: number): Candle[] {
  const all = [
    mk(M5_MS, 0, 150, 152, 149, 151),
    mk(M5_MS, 1, 151, 156, 150, 155),
    mk(M5_MS, 2, 155, 160, 154, 158), // swing high, price 160
    mk(M5_MS, 3, 156, 157, 152, 153),
    mk(M5_MS, 4, 153, 154, 140, 142),
    mk(M5_MS, 5, 142, 143, 120, 122),
    mk(M5_MS, 6, 122, 123, 100, 101), // touches zone [99,101]
    mk(M5_MS, 7, 101, 140, 100, 135), // rallying but close still < 160
    mk(M5_MS, 8, 135, 165, 134, 162), // closes above the 160 structure level
  ];
  return all.slice(0, lastIndex + 1);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// 1. Clear UP bias + valid demand zone + M5 already confirmed -> entry.
{
  const result = detectEntry(strongUptrendD1(40), m15WithDemandZone(), m5UpTo(8));
  check("bias + zone + M5 confirmed -> entry", result && { direction: result.direction, confirmedAtIndex: result.confirmedAtIndex }, {
    direction: "UP",
    confirmedAtIndex: 8,
  });
}

// 2. Clear UP bias + valid demand zone, but M5 hasn't broken structure yet -> no entry.
{
  const result = detectEntry(strongUptrendD1(40), m15WithDemandZone(), m5UpTo(7));
  check("bias + zone, M5 not confirmed -> no entry", result, null);
}

// 3. Bias NONE -> no entry even with the same otherwise-good zone and confirmed M5.
{
  const result = detectEntry(flatSidewayD1(40), m15WithDemandZone(), m5UpTo(8));
  check("bias NONE -> no entry", result, null);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
