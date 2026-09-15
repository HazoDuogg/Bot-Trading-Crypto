/**
 * TICKET-14X-A verify — one synthetic lifecycle: no setup -> setup -> entry ->
 * price runs to TP -> close -> equity updates -> a later entry sees the right startOfDayEquity.
 * Run: tsx scripts/research/orchestratorVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { createOrchestrator, equityAtStartOfDay, TAKER_FEE_PCT, MAKER_FEE_PCT, type OnCandleResult } from "../../src/core/orchestrator.js";
import { RISK_PCT_PER_TRADE } from "../../src/risk/positionSizer.js";

const D1_MS = 24 * 60 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const DAY_IN_M5_STEPS = 288; // 24h / 5min

function mk(barMs: number, i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * barMs, closeTime: i * barMs + barMs - 1, open, high, low, close, volume: 1 };
}

// TICKET-21X-A: H1 series with exactly 2 clean swing points at `low`/`high` (same technique as entryRouterVerify.ts).
function flatH1(i: number, r: number): Candle {
  return mk(H1_MS, i, r, r + 1, r - 1, r);
}
function buildH1Range(low: number, high: number): Candle[] {
  const r = (low + high) / 2;
  const lowBlock = [flatH1(0, r), flatH1(1, r), mk(H1_MS, 2, low, r, low, low), flatH1(3, r), flatH1(4, r)];
  const gap = [flatH1(5, r), flatH1(6, r), flatH1(7, r), flatH1(8, r)];
  const highBlock = [flatH1(9, r), flatH1(10, r), mk(H1_MS, 11, high, high, r, high), flatH1(12, r), flatH1(13, r)];
  return [...lowBlock, ...gap, ...highBlock];
}
// Covers every zone used across trade 1 ([99,101]/[219,221]) and trade 2 ([999,1001]/[1249,1251]).
const wideH1Range = buildH1Range(50, 1300);

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

// M5 retest+confirmation recipe, anchored at `base` (default 100, matching trade 1's [99,101] zone
// exactly). Touches [base-1,base+1], swing high at base+60, entry confirms at base+62 (local index 8).
function confirmationM5(dayOffsetSteps: number, base = 100): Candle[] {
  return [
    mk(M5_MS, dayOffsetSteps + 0, base + 50, base + 52, base + 49, base + 51),
    mk(M5_MS, dayOffsetSteps + 1, base + 51, base + 56, base + 50, base + 55),
    mk(M5_MS, dayOffsetSteps + 2, base + 55, base + 60, base + 54, base + 58), // swing high
    mk(M5_MS, dayOffsetSteps + 3, base + 56, base + 57, base + 52, base + 53),
    mk(M5_MS, dayOffsetSteps + 4, base + 53, base + 54, base + 40, base + 42),
    mk(M5_MS, dayOffsetSteps + 5, base + 42, base + 43, base + 20, base + 22),
    mk(M5_MS, dayOffsetSteps + 6, base + 22, base + 23, base, base + 1), // touches the zone
    mk(M5_MS, dayOffsetSteps + 7, base + 1, base + 40, base, base + 35), // rallying but close still < swing high
    mk(M5_MS, dayOffsetSteps + 8, base + 35, base + 65, base + 34, base + 62), // closes above swing high -> entry
  ];
}

// A second, price-isolated demand+supply pair for trade 2 — reusing trade 1's own leftover M5
// candles (still sitting in the shared rolling window) would otherwise satisfy trade 1's own
// retest again and confuse the picture, so trade 2 gets its own zone far from trade 1's prices.
function demandSupplySnippet(startIdx: number, base: number): Candle[] {
  const candles: Candle[] = [];
  let idx = startIdx;
  for (let i = 0; i < 20; i++) candles.push(mk(M15_MS, idx++, base, base + 1, base - 1, base));
  candles.push(mk(M15_MS, idx++, base, base + 1, base - 1, base)); // base candle
  candles.push(mk(M15_MS, idx++, base, base + 80, base, base + 75)); // displacement -> demand zone [base-1,base+1]
  const p2 = base + 250;
  candles.push(mk(M15_MS, idx++, p2, p2 + 1, p2 - 1, p2)); // base candle
  candles.push(mk(M15_MS, idx++, p2, p2 + 1, p2 - 90, p2 - 85)); // displacement down -> supply zone [p2-1,p2+1]
  return candles;
}

const orchestrator = createOrchestrator(10_000);

// --- Trade 1, day 0 ---
// TICKET-15X-A/16X-B: onCandle's 2nd/3rd args are now only the NEWLY-closed M15/M5 candle(s) —
// ingest the M15 snapshot once, on the first call, then feed exactly one new M5 candle per call.
const trade1M5 = confirmationM5(0);
for (let k = 1; k < 9; k++) {
  const result = orchestrator.onCandle(dailyCandles, k === 1 ? wideH1Range : [], k === 1 ? m15Candles : [], [trade1M5[k - 1]]);
  check(`no setup yet at M5 step ${k}`, result.action, "NONE");
}
{
  const result = orchestrator.onCandle(dailyCandles, [], [], [trade1M5[8]]);
  check("setup confirmed -> entry opened", result.action, "ENTRY_OPENED");
}

const afterEntry = orchestrator.getState();
check("one order open, SINGLE mode", afterEntry.openPosition?.orders.length, 1);
const order1 = afterEntry.openPosition!.orders[0];
check("entry price", order1.entryPrice, 162);
check("take profit = nearTarget edge (219)", order1.takeProfit, 219);

// Price runs straight to TP (219) without touching SL first.
const tpCandle = mk(M5_MS, 9, 162, 225, 160, 220);
const closeResult = orchestrator.onCandle(dailyCandles, [], [], [tpCandle]);
check("price runs to TP -> order closed", closeResult.action, "ORDER_CLOSED");

const afterClose = orchestrator.getState();
check("position cleared after close", afterClose.openPosition, null);
check("one closed trade recorded", afterClose.closedTrades.length, 1);
// TICKET-24X-A: TP_HIT -> entry fee is taker, exit fee is maker.
const trade1GrossPnl = order1.quantity * (219 - 162);
const trade1EntryFee = order1.quantity * order1.entryPrice * TAKER_FEE_PCT;
const trade1ExitFee = order1.quantity * 219 * MAKER_FEE_PCT;
const expectedPnl1 = trade1GrossPnl - trade1EntryFee - trade1ExitFee;
check("equity updated by the realized PnL (net of fees)", afterClose.equity, 10_000 + expectedPnl1);

// --- Trade 2, day 1: a fresh, isolated zone (base 1000) plus day-shifted M5 -> a fresh entry with the updated equity. ---
const trade2M15 = demandSupplySnippet(24, 1000); // demand [999,1001], supply [1249,1251]
const trade2M5 = confirmationM5(DAY_IN_M5_STEPS, 1000);
for (let k = 1; k < 9; k++) {
  orchestrator.onCandle(dailyCandles, [], k === 1 ? trade2M15 : [], [trade2M5[k - 1]]);
}
const trade2Result = orchestrator.onCandle(dailyCandles, [], [], [trade2M5[8]]);
check("day 1: fresh entry opens", trade2Result.action, "ENTRY_OPENED");

const afterTrade2Entry = orchestrator.getState();
const order2 = afterTrade2Entry.openPosition!.orders[0];
// Trade 2 uses a different zone (different SL distance), so compare against the sizing formula directly
// rather than trade 1's quantity: quantity = updated equity x RISK_PCT_PER_TRADE / |entry - SL|.
const expectedQuantity2 = (afterClose.equity * RISK_PCT_PER_TRADE) / (order2.entryPrice - order2.stopLoss);
check("day 1 order sized off the updated equity", order2.quantity, expectedQuantity2);

// The exact startOfDayEquity trade 2 should have seen: initial balance + trade 1's realized PnL (closed the day before).
const expectedStartOfDayEquity2 = equityAtStartOfDay(10_000, afterClose.closedTrades, trade2M5[8].closeTime);
check("startOfDayEquity for day 1 includes trade 1's PnL", expectedStartOfDayEquity2, 10_000 + expectedPnl1);

// --- TICKET-24X-A: fee-inclusive realizedPnl, TP (maker exit) vs SL (taker exit), and net < gross always. ---
{
  function openFreshOrder() {
    const orch = createOrchestrator(10_000);
    const m5 = confirmationM5(0);
    for (let k = 1; k < 9; k++) orch.onCandle(dailyCandles, k === 1 ? wideH1Range : [], k === 1 ? m15Candles : [], [m5[k - 1]]);
    orch.onCandle(dailyCandles, [], [], [m5[8]]);
    const order = orch.getState().openPosition!.orders[0];
    return { orch, order };
  }

  // 1. TP exit: net PnL = gross - (entry fee, taker) - (exit fee, maker).
  {
    const { orch, order } = openFreshOrder();
    orch.onCandle(dailyCandles, [], [], [tpCandle]);
    const netPnl = orch.getState().closedTrades[0].realizedPnl;
    const gross = order.quantity * (219 - 162);
    const expectedNet = gross - order.quantity * order.entryPrice * TAKER_FEE_PCT - order.quantity * 219 * MAKER_FEE_PCT;
    check("TP exit: net PnL matches gross - taker entry fee - maker exit fee", netPnl, expectedNet);
    check("TP exit: net PnL < gross PnL (fees always reduce profit)", netPnl < gross, true);
  }

  // 2. SL exit: net PnL = gross - (entry fee, taker) - (exit fee, taker).
  {
    const { orch, order } = openFreshOrder();
    const slCandle = mk(M5_MS, 9, order.entryPrice, order.entryPrice, order.stopLoss - 1, order.stopLoss - 1);
    orch.onCandle(dailyCandles, [], [], [slCandle]);
    const netPnl = orch.getState().closedTrades[0].realizedPnl;
    const gross = order.quantity * (order.stopLoss - order.entryPrice); // negative, UP direction
    const expectedNet = gross - order.quantity * order.entryPrice * TAKER_FEE_PCT - order.quantity * order.stopLoss * TAKER_FEE_PCT;
    check("SL exit: net PnL matches gross - taker entry fee - taker exit fee", netPnl, expectedNet);
    check("SL exit: net PnL < gross PnL (fees always reduce profit, even on a loss)", netPnl < gross, true);
  }
}

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
      perfOrchestrator.onCandle(dailyCandles, [], [perfM15[i]], trivialM5);
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

// --- TICKET-16X-B perf check: mirror of the M15 perf test, but stressing the M5 rolling window —
// tens of thousands of M5 candles fed one at a time, confirming per-candle cost stays roughly flat. ---
{
  const PERF_M5_CANDLES = 30_000;
  const BATCH = 5000;

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
  const rand = mulberry32(0x424242);
  const perfM5: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < PERF_M5_CANDLES; i++) {
    const move = (rand() - 0.5) * 2;
    const close = price + move;
    perfM5.push(mk(M5_MS, i, price, Math.max(price, close) + 0.5, Math.min(price, close) - 0.5, close));
    price = close;
  }

  const perfOrchestrator = createOrchestrator(10_000);
  const batchTimes: number[] = [];
  for (let start = 0; start < PERF_M5_CANDLES; start += BATCH) {
    const t0 = performance.now();
    for (let i = start; i < start + BATCH; i++) {
      perfOrchestrator.onCandle(dailyCandles, [], [], [perfM5[i]]);
    }
    batchTimes.push(performance.now() - t0);
  }

  console.log(`\nperf (M5): ${PERF_M5_CANDLES} M5 candles, ${BATCH}-candle batch times (ms): ${batchTimes.map((t) => t.toFixed(1)).join(", ")}`);
  const ratio = batchTimes[batchTimes.length - 1] / Math.max(batchTimes[0], 1);
  console.log(`m5 window size at end: ${perfOrchestrator.getState().m5WindowCount} (capped at M5_WINDOW_SIZE), last/first batch ratio: ${ratio.toFixed(2)}x`);
  check("M5 last batch isn't drastically slower than the first (roughly linear, not quadratic)", ratio < 5, true);
}

// --- TICKET-16X-B window trade-off: a zone formed long ago is still retestable within the M5
// rolling window, but a retest whose TOUCH candle has rolled off the front of the window is missed. ---
{
  // Same proven demand[99,101]+supply[219,221] recipe as trade 1 above, in an isolated instance.
  const windowM15: Candle[] = [];
  {
    let price = 100;
    for (let i = 0; i < 20; i++) windowM15.push(mk(M15_MS, i, price, price + 1, price - 1, price));
    windowM15.push(mk(M15_MS, 20, 100, 101, 99, 100));
    windowM15.push(mk(M15_MS, 21, 100, 135, 100, 130));
    windowM15.push(mk(M15_MS, 22, 220, 221, 219, 220));
    windowM15.push(mk(M15_MS, 23, 220, 221, 180, 185));
  }
  const fillerFarFromZoneAndStructure = (i: number) => mk(M5_MS, i, 500, 501, 499, 500); // doesn't touch [99,101] or break the 160 swing

  // Case A: the zone formed long ago, but a modest amount of filler precedes the retest, all within the window -> still detected.
  {
    const orch = createOrchestrator(10_000);
    orch.onCandle(dailyCandles, wideH1Range, windowM15, [fillerFarFromZoneAndStructure(0)]);
    for (let i = 1; i < 50; i++) orch.onCandle(dailyCandles, [], [], [fillerFarFromZoneAndStructure(i)]);
    const retest = confirmationM5(50);
    let last: OnCandleResult = { action: "NONE" };
    for (const c of retest) last = orch.onCandle(dailyCandles, [], [], [c]);
    check("retest within the M5 window -> still detected", last.action, "ENTRY_OPENED");
  }

  // Case B: the retest's touch candle rolls off the front of the window before the break candle arrives -> missed.
  // Documented trade-off, not a bug: TICKET-16X-B accepts this in exchange for bounded memory.
  {
    const orch = createOrchestrator(10_000);
    orch.onCandle(dailyCandles, wideH1Range, windowM15, [fillerFarFromZoneAndStructure(0)]);
    const retest = confirmationM5(1);
    for (let i = 0; i < 7; i++) orch.onCandle(dailyCandles, [], [], [retest[i]]); // through the touch candle (index 6)
    for (let i = 0; i < 4000; i++) orch.onCandle(dailyCandles, [], [], [fillerFarFromZoneAndStructure(1000 + i)]); // pushes the touch out of the window
    let last: OnCandleResult = { action: "NONE" };
    for (let i = 7; i < retest.length; i++) last = orch.onCandle(dailyCandles, [], [], [retest[i]]); // the break candles, now touch-less
    check("retest whose touch fell outside the M5 window -> missed (accepted trade-off)", last.action, "NONE");
  }
}

// --- TICKET-25X-A: equity <=0 permanently blocks new entries; PnL sign invariants (grossProfit>=0,
// grossLoss<=0) hold even after bankruptcy. Two real, consecutive losing trades (not injected equity)
// drive the account to <=0: a mild ~29% loss, then a tight-SL/high-price trade whose fees alone finish it off. ---
{
  const PRICE = 50_000;
  let idx = 0;
  const m15: Candle[] = [];
  let price = PRICE;
  for (let i = 0; i < 20; i++) m15.push(mk(M15_MS, idx++, price, price + 0.06, price - 0.06, price));
  const zone1Start = price;
  m15.push(mk(M15_MS, idx++, price, price + 0.06, price - 0.06, price)); // zone1 base
  m15.push(mk(M15_MS, idx++, price, price + 2, price, price + 1.6)); // zone1 displacement -> demand [~-0.06,+0.06]
  price = price + 1.6 + 2.4; // gradual step, no gap
  m15.push(mk(M15_MS, idx++, price, price + 0.06, price - 0.06, price)); // supply1 base (zone1's nearTarget)
  m15.push(mk(M15_MS, idx++, price, price + 0.06, price - 2, price - 1.7)); // supply1 displacement
  price = price - 1.7;
  for (let i = 0; i < 5; i++) m15.push(mk(M15_MS, idx++, price, price + 0.06, price - 0.06, price)); // gradual transition
  const zone2Start = price;
  m15.push(mk(M15_MS, idx++, price, price + 0.01, price - 0.01, price)); // zone2 base (razor-tight)
  m15.push(mk(M15_MS, idx++, price, price + 0.5, price, price + 0.4)); // zone2 displacement -> tiny demand zone
  price = price + 0.4 + 0.6;
  m15.push(mk(M15_MS, idx++, price, price + 0.01, price - 0.01, price)); // supply2 base (zone2's nearTarget)
  m15.push(mk(M15_MS, idx++, price, price + 0.01, price - 0.3, price - 0.2)); // supply2 displacement
  const m15Part1 = m15.slice(0, 24); // through supply1 — ingested causally, not the whole array at once
  const m15Part2 = m15.slice(24);

  function m5RetestAt(dayOffset: number, base: number, k: number): Candle[] {
    return [
      mk(M5_MS, dayOffset + 0, base + 0.2 * k, base + 0.22 * k, base + 0.19 * k, base + 0.21 * k),
      mk(M5_MS, dayOffset + 1, base + 0.21 * k, base + 0.24 * k, base + 0.2 * k, base + 0.23 * k),
      mk(M5_MS, dayOffset + 2, base + 0.23 * k, base + 0.26 * k, base + 0.22 * k, base + 0.25 * k), // swing high
      mk(M5_MS, dayOffset + 3, base + 0.24 * k, base + 0.25 * k, base + 0.21 * k, base + 0.22 * k),
      mk(M5_MS, dayOffset + 4, base + 0.22 * k, base + 0.23 * k, base + 0.15 * k, base + 0.16 * k),
      mk(M5_MS, dayOffset + 5, base + 0.16 * k, base + 0.17 * k, base + 0.08 * k, base + 0.09 * k),
      mk(M5_MS, dayOffset + 6, base + 0.09 * k, base + 0.1 * k, base - 0.01 * k, base + 0.005 * k), // touches the zone
      mk(M5_MS, dayOffset + 7, base + 0.005 * k, base + 0.15 * k, base, base + 0.12 * k),
      mk(M5_MS, dayOffset + 8, base + 0.12 * k, base + 0.3 * k, base + 0.11 * k, base + 0.27 * k), // closes above swing high -> entry
    ];
  }

  const orch = createOrchestrator(1_000);
  const h1Range = buildH1Range(PRICE - 100, PRICE + 100);

  // Trade A: a mild, ordinary SL loss (~29% of equity).
  const m5A = m5RetestAt(0, zone1Start, 6);
  for (let k = 1; k < 9; k++) orch.onCandle(dailyCandles, k === 1 ? h1Range : [], k === 1 ? m15Part1 : [], [m5A[k - 1]]);
  orch.onCandle(dailyCandles, [], [], [m5A[8]]);
  const orderA = orch.getState().openPosition!.orders[0];
  orch.onCandle(dailyCandles, [], [], [mk(M5_MS, DAY_IN_M5_STEPS - 1, orderA.entryPrice, orderA.entryPrice, orderA.stopLoss - 0.01, orderA.stopLoss - 0.01)]);
  check("trade A: mild SL loss, equity still positive", orch.getState().equity > 0, true);

  // Trade B: a real (not injected) tight-SL/high-price loss whose fees alone finish the account off.
  const m5B = m5RetestAt(DAY_IN_M5_STEPS, zone2Start, 1);
  orch.onCandle(dailyCandles, [], m15Part2, [m5B[0]]);
  for (let k = 1; k < 9; k++) orch.onCandle(dailyCandles, [], [], [m5B[k]]);
  const orderB = orch.getState().openPosition!.orders[0];
  orch.onCandle(
    dailyCandles,
    [],
    [],
    [mk(M5_MS, 2 * DAY_IN_M5_STEPS - 1, orderB.entryPrice, orderB.entryPrice, orderB.stopLoss - 0.001, orderB.stopLoss - 0.001)],
  );
  check("trade B: second consecutive loss crosses equity to <=0", orch.getState().equity <= 0, true);

  // Attempt a fresh, otherwise-valid entry (zone1, still VALID, day-shifted M5) after bankruptcy -> never opens.
  const m5C = m5RetestAt(3 * DAY_IN_M5_STEPS, zone1Start, 6);
  for (let k = 1; k <= 9; k++) {
    const result = orch.onCandle(dailyCandles, [], [], [m5C[k - 1]]);
    check(`no entry after bankruptcy, M5 step ${k}`, result.action, "NONE");
  }
  check("still no open position after bankruptcy", orch.getState().openPosition, null);

  // Sign invariant: summed TP_HIT pnl is never negative, summed SL_HIT pnl is never positive.
  const trades = orch.getState().tradeLog;
  const grossProfit = trades.filter((t) => t.exitReason === "TP_HIT").reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const grossLoss = trades.filter((t) => t.exitReason === "SL_HIT").reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  check("grossProfit >= 0", grossProfit >= 0, true);
  check("grossLoss <= 0", grossLoss <= 0, true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
