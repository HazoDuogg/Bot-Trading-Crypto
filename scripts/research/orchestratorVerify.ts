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
// TICKET-15X-A: onCandle's 2nd arg is now only the NEWLY-closed M15 candles — ingest the whole
// snapshot once, on the first call, then pass [] since m15Candles doesn't change for the rest of this test.
const trade1M5 = confirmationM5(0);
for (let k = 1; k < 9; k++) {
  const result = orchestrator.onCandle(dailyCandles, k === 1 ? m15Candles : [], trade1M5.slice(0, k));
  check(`no setup yet at M5 step ${k}`, result.action, "NONE");
}
{
  const result = orchestrator.onCandle(dailyCandles, [], trade1M5.slice(0, 9));
  check("setup confirmed -> entry opened", result.action, "ENTRY_OPENED");
}

const afterEntry = orchestrator.getState();
check("one order open, SINGLE mode", afterEntry.openPosition?.orders.length, 1);
const order1 = afterEntry.openPosition!.orders[0];
check("entry price", order1.entryPrice, 162);
check("take profit = nearTarget edge (219)", order1.takeProfit, 219);

// Price runs straight to TP (219) without touching SL first.
const tpCandle = mk(M5_MS, 9, 162, 225, 160, 220);
const closeResult = orchestrator.onCandle(dailyCandles, [], [...trade1M5, tpCandle]);
check("price runs to TP -> order closed", closeResult.action, "ORDER_CLOSED");

const afterClose = orchestrator.getState();
check("position cleared after close", afterClose.openPosition, null);
check("one closed trade recorded", afterClose.closedTrades.length, 1);
const expectedPnl1 = order1.quantity * (219 - 162);
check("equity updated by the realized PnL", afterClose.equity, 10_000 + expectedPnl1);

// --- Trade 2, day 1: same recipe, day-shifted M5 timestamps -> a fresh entry with the updated equity. ---
const trade2M5 = confirmationM5(DAY_IN_M5_STEPS);
for (let k = 1; k < 9; k++) {
  orchestrator.onCandle(dailyCandles, [], trade2M5.slice(0, k));
}
const trade2Result = orchestrator.onCandle(dailyCandles, [], trade2M5.slice(0, 9));
check("day 1: fresh entry opens", trade2Result.action, "ENTRY_OPENED");

const afterTrade2Entry = orchestrator.getState();
const order2 = afterTrade2Entry.openPosition!.orders[0];
check("day 1 order sized off the updated equity (bigger than trade 1's)", order2.quantity > order1.quantity, true);

// The exact startOfDayEquity trade 2 should have seen: initial balance + trade 1's realized PnL (closed the day before).
const expectedStartOfDayEquity2 = equityAtStartOfDay(10_000, afterClose.closedTrades, trade2M5[8].closeTime);
check("startOfDayEquity for day 1 includes trade 1's PnL", expectedStartOfDayEquity2, 10_000 + expectedPnl1);

// --- TICKET-15X-A perf check: a few thousand M15 candles fed one at a time (as a backtest would),
// confirming per-candle cost stays roughly flat instead of growing with total history length. ---
{
  const PERF_CANDLES = 4000;
  const BATCH = 1000;

  // Deterministic pseudo-random walk with occasional bigger moves — realistic zone density, not adversarial.
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0x515151);
  const perfM15: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < PERF_CANDLES; i++) {
    const spike = rand() < 0.03; // occasional bigger candle, so some zones actually form
    const move = (rand() - 0.5) * (spike ? 40 : 4);
    const close = price + move;
    const high = Math.max(price, close) + rand() * (spike ? 10 : 1);
    const low = Math.min(price, close) - rand() * (spike ? 10 : 1);
    perfM15.push(mk(M15_MS, i, price, high, low, close));
    price = close;
  }
  const trivialM5 = [mk(M5_MS, 0, price, price + 0.1, price - 0.1, price)];

  const perfOrchestrator = createOrchestrator(10_000);
  const batchTimes: number[] = [];
  for (let start = 0; start < PERF_CANDLES; start += BATCH) {
    const t0 = performance.now();
    for (let i = start; i < start + BATCH; i++) {
      perfOrchestrator.onCandle(dailyCandles, [perfM15[i]], trivialM5);
    }
    batchTimes.push(performance.now() - t0);
  }

  console.log(`\nperf: ${PERF_CANDLES} M15 candles, ${BATCH}-candle batch times (ms): ${batchTimes.map((t) => t.toFixed(1)).join(", ")}`);
  const firstBatch = batchTimes[0];
  const lastBatch = batchTimes[batchTimes.length - 1];
  const ratio = lastBatch / Math.max(firstBatch, 1); // avoid divide-by-near-zero on a very fast first batch
  console.log(`registry size at end: ${perfOrchestrator.getState().m15CandleCount} candles processed, last/first batch ratio: ${ratio.toFixed(2)}x`);
  check("last batch isn't drastically slower than the first (roughly linear, not quadratic)", ratio < 5, true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
