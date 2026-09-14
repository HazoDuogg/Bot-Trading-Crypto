/**
 * TICKET-14X-A verify — one synthetic lifecycle: no setup -> setup -> entry ->
 * price runs to TP -> close -> equity updates -> a later entry sees the right startOfDayEquity.
 * Run: tsx scripts/research/orchestratorVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { createOrchestrator, equityAtStartOfDay } from "../../src/core/orchestrator.js";

const D1_MS = 24 * 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const DAY_IN_M5_STEPS = 288; // 24h / 5min

function mk(barMs: number, i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * barMs, closeTime: i * barMs + barMs - 1, open, high, low, close, volume: 1 };
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// D1: strong uptrend (same technique as TICKET-07X-A's directionFilterVerify.ts) -> bias UP, no D1 swing highs -> SINGLE order.
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
const dailyCandles = strongUptrendD1(40);

// M15: a demand zone [99,101] (entry) plus a supply zone [219,221] above it (nearTarget) -> reused for every call, unchanged.
const m15Candles: Candle[] = [];
{
  let price = 100;
  for (let i = 0; i < 20; i++) m15Candles.push(mk(M15_MS, i, price, price + 1, price - 1, price));
  m15Candles.push(mk(M15_MS, 20, 100, 101, 99, 100)); // base
  m15Candles.push(mk(M15_MS, 21, 100, 135, 100, 130)); // displacement -> demand zone [99,101]
  m15Candles.push(mk(M15_MS, 22, 220, 221, 219, 220)); // base
  m15Candles.push(mk(M15_MS, 23, 220, 221, 180, 185)); // displacement down -> supply zone [219,221]
}

// M5 retest+confirmation recipe, reused for both trades (day-shifted for the second). Confirms at local index 8, entryPrice 162.
function confirmationM5(dayOffsetSteps: number): Candle[] {
  return [
    mk(M5_MS, dayOffsetSteps + 0, 150, 152, 149, 151),
    mk(M5_MS, dayOffsetSteps + 1, 151, 156, 150, 155),
    mk(M5_MS, dayOffsetSteps + 2, 155, 160, 154, 158), // swing high, price 160
    mk(M5_MS, dayOffsetSteps + 3, 156, 157, 152, 153),
    mk(M5_MS, dayOffsetSteps + 4, 153, 154, 140, 142),
    mk(M5_MS, dayOffsetSteps + 5, 142, 143, 120, 122),
    mk(M5_MS, dayOffsetSteps + 6, 122, 123, 100, 101), // touches zone [99,101]
    mk(M5_MS, dayOffsetSteps + 7, 101, 140, 100, 135), // rallying but close still < 160
    mk(M5_MS, dayOffsetSteps + 8, 135, 165, 134, 162), // closes above the 160 structure level -> entry at 162
  ];
}

const orchestrator = createOrchestrator(10_000);

// --- Trade 1, day 0 ---
const trade1M5 = confirmationM5(0);
for (let k = 1; k < 9; k++) {
  const result = orchestrator.onCandle(dailyCandles, m15Candles, trade1M5.slice(0, k));
  check(`no setup yet at M5 step ${k}`, result.action, "NONE");
}
{
  const result = orchestrator.onCandle(dailyCandles, m15Candles, trade1M5.slice(0, 9));
  check("setup confirmed -> entry opened", result.action, "ENTRY_OPENED");
}

const afterEntry = orchestrator.getState();
check("one order open, SINGLE mode", afterEntry.openPosition?.orders.length, 1);
const order1 = afterEntry.openPosition!.orders[0];
check("entry price", order1.entryPrice, 162);
check("take profit = nearTarget edge (219)", order1.takeProfit, 219);

// Price runs straight to TP (219) without touching SL first.
const tpCandle = mk(M5_MS, 9, 162, 225, 160, 220);
const closeResult = orchestrator.onCandle(dailyCandles, m15Candles, [...trade1M5, tpCandle]);
check("price runs to TP -> order closed", closeResult.action, "ORDER_CLOSED");

const afterClose = orchestrator.getState();
check("position cleared after close", afterClose.openPosition, null);
check("one closed trade recorded", afterClose.closedTrades.length, 1);
const expectedPnl1 = order1.quantity * (219 - 162);
check("equity updated by the realized PnL", afterClose.equity, 10_000 + expectedPnl1);

// --- Trade 2, day 1: same recipe, day-shifted M5 timestamps -> a fresh entry with the updated equity. ---
const trade2M5 = confirmationM5(DAY_IN_M5_STEPS);
for (let k = 1; k < 9; k++) {
  orchestrator.onCandle(dailyCandles, m15Candles, trade2M5.slice(0, k));
}
const trade2Result = orchestrator.onCandle(dailyCandles, m15Candles, trade2M5.slice(0, 9));
check("day 1: fresh entry opens", trade2Result.action, "ENTRY_OPENED");

const afterTrade2Entry = orchestrator.getState();
const order2 = afterTrade2Entry.openPosition!.orders[0];
check("day 1 order sized off the updated equity (bigger than trade 1's)", order2.quantity > order1.quantity, true);

// The exact startOfDayEquity trade 2 should have seen: initial balance + trade 1's realized PnL (closed the day before).
const expectedStartOfDayEquity2 = equityAtStartOfDay(10_000, afterClose.closedTrades, trade2M5[8].closeTime);
check("startOfDayEquity for day 1 includes trade 1's PnL", expectedStartOfDayEquity2, 10_000 + expectedPnl1);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
