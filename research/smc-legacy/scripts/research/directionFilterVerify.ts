/**
 * TICKET-07X-A verify — synthetic D1 sequences with known regimes.
 * Run: tsx scripts/research/directionFilterVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { detectDirectionBias } from "../../src/direction/directionFilter.js";

const BAR_MS = 24 * 60 * 60 * 1000;
const N = 40; // > 28-candle detectRegime warm-up

function candle(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * BAR_MS, closeTime: i * BAR_MS + BAR_MS - 1, open, high, low, close, volume: 1 };
}

function strongUptrend(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const close = price + 2;
    candles.push(candle(i, price, close + 0.5, price - 0.5, close));
    price = close;
  }
  return candles;
}

function strongDowntrend(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 200;
  for (let i = 0; i < n; i++) {
    const close = price - 2;
    candles.push(candle(i, price, price + 0.5, close - 0.5, close));
    price = close;
  }
  return candles;
}

function flatSideway(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const close = i % 2 === 0 ? price + 1 : price - 1;
    candles.push(candle(i, price, Math.max(price, close) + 0.3, Math.min(price, close) - 0.3, close));
    price = close;
  }
  return candles;
}

let failures = 0;
function check(name: string, actual: string, expected: string) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${actual}, expected ${expected}`);
}

check("strong uptrend -> UP", detectDirectionBias(strongUptrend(N)), "UP");
check("strong downtrend -> DOWN", detectDirectionBias(strongDowntrend(N)), "DOWN");
check("flat sideway -> NONE", detectDirectionBias(flatSideway(N)), "NONE");

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
