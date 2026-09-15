/**
 * TICKET-07X-B verify — synthetic D1/M15/M5 series with a known outcome each.
 * Run: tsx scripts/research/entryRouterVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { detectEntry } from "../../src/entry/entryRouter.js";
import type { ClosedTrade } from "../../src/risk/dailyThrottle.js";
import { computeAdxDi } from "../../src/regime/adxDiCompare.js";
import { buildInitialRegistry } from "../../src/entry/zoneRegistry.js";

// TICKET-15X-A: detectEntry now takes a pre-built registry/atr15/currentPrice instead of raw m15Candles.
// This reproduces exactly what it used to do internally, once, at the top of each test.
function detectEntryFromM15(
  dailyCandles: Candle[],
  m15Candles: Candle[],
  m5Candles: Candle[],
  closedTrades: ClosedTrade[],
  startOfDayEquity: number,
) {
  const { atr: atr15 } = computeAdxDi(m15Candles);
  const registry = buildInitialRegistry(m15Candles, atr15);
  const currentPrice = m15Candles[m15Candles.length - 1].close;
  return detectEntry(dailyCandles, registry, atr15, currentPrice, m5Candles, closedTrades, startOfDayEquity);
}

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
// Mirror of strongUptrendD1 -> bias DOWN.
function strongDowntrendD1(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 200;
  for (let i = 0; i < n; i++) {
    const close = price - 2;
    candles.push(mk(D1_MS, i, price, price + 0.5, close - 0.5, close));
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

// M15 base+displacement down: 20 flat candles then a base and a big down displacement -> one supply zone [199,201], score 0.
function m15WithSupplyZone(): Candle[] {
  const candles: Candle[] = [];
  let price = 200;
  for (let i = 0; i < 20; i++) candles.push(mk(M15_MS, i, price, price + 1, price - 1, price));
  candles.push(mk(M15_MS, 20, 200, 201, 199, 200));
  candles.push(mk(M15_MS, 21, 200, 201, 165, 170));
  return candles;
}

// M15 base+displacement+FVG, plus an equal-low pair near the base's low -> a demand zone with confluenceScore 2.
function m15WithScore2DemandZone(): Candle[] {
  const candles: Candle[] = [
    mk(M15_MS, 0, 100, 130, 105, 100),
    mk(M15_MS, 1, 100, 125, 100, 100),
    mk(M15_MS, 2, 100, 120, 97, 100), // dip A center, low=97
    mk(M15_MS, 3, 100, 125, 100, 100),
    mk(M15_MS, 4, 100, 130, 105, 100),
    mk(M15_MS, 5, 100, 130, 110, 100),
    mk(M15_MS, 6, 100, 130, 110, 100),
    mk(M15_MS, 7, 100, 130, 105, 100),
    mk(M15_MS, 8, 100, 125, 100, 100),
    mk(M15_MS, 9, 100, 120, 97.5, 100), // dip B center, low=97.5 -> equal-low with dip A, near the eventual zone.low
    mk(M15_MS, 10, 100, 125, 100, 100),
    mk(M15_MS, 11, 100, 130, 105, 100),
    mk(M15_MS, 12, 100, 103, 97, 100),
    mk(M15_MS, 13, 100, 103, 97, 100),
    mk(M15_MS, 14, 100, 103, 97, 100),
    mk(M15_MS, 15, 100, 103, 97, 100),
    mk(M15_MS, 16, 100, 103, 97, 100),
    mk(M15_MS, 17, 100, 103, 97, 100),
    mk(M15_MS, 18, 100, 103, 97, 100),
    mk(M15_MS, 19, 100, 103, 97, 100),
    mk(M15_MS, 20, 100, 101, 99, 100), // base
    mk(M15_MS, 21, 100, 106, 99, 105), // displacement candle 1, doesn't trigger alone
    mk(M15_MS, 22, 105, 145, 104, 140), // displacement candle 2, triggers here + creates an FVG with the base
  ];
  return candles;
}

// Segment shared by the TICKET-13X-A cases: a score-2 demand zone F at [97,103] (confirmed at index 22),
// then a slow ramp + settle that carries price far away and lets ATR shrink back down.
function farZoneSegment(): Candle[] {
  const candles = m15WithScore2DemandZone();
  let price = candles[candles.length - 1].close; // 140
  for (let i = 0; i < 80; i++) {
    const close = price + 2;
    candles.push(mk(M15_MS, candles.length, price, close + 0.5, price - 0.5, close));
    price = close;
  }
  for (let i = 0; i < 30; i++) {
    candles.push(mk(M15_MS, candles.length, price, price + 1, price - 1, price));
  }
  return candles;
}

// TICKET-13X-A case 1: only the far zone F exists -> too far from current price (>10x ATR15), must be filtered out.
function m15WithOnlyFarZone(): Candle[] {
  return farZoneSegment();
}

// TICKET-13X-A case 2: same far zone F, plus a fresh plain (score 0) zone N right near current price.
function m15WithFarAndNearZone(): Candle[] {
  const candles = farZoneSegment();
  const price = candles[candles.length - 1].close; // 300
  candles.push(mk(M15_MS, candles.length, price, price + 1, price - 1, price)); // base
  candles.push(mk(M15_MS, candles.length, price, price + 35, price, price + 30)); // displacement -> zone N [299,301]
  return candles;
}

// M5 retest of zone N [299,301]: swing high (460) at index 2, price drops to retest at index 11, then rallies back up.
function m5UpToNearZone(lastIndex: number): Candle[] {
  const all = [
    mk(M5_MS, 0, 450, 452, 449, 451),
    mk(M5_MS, 1, 451, 456, 450, 455),
    mk(M5_MS, 2, 455, 460, 454, 458), // swing high, price 460
    mk(M5_MS, 3, 456, 457, 452, 453),
    mk(M5_MS, 4, 453, 454, 440, 442),
    mk(M5_MS, 5, 442, 443, 420, 422),
    mk(M5_MS, 6, 422, 423, 400, 401),
    mk(M5_MS, 7, 401, 402, 380, 381),
    mk(M5_MS, 8, 381, 382, 360, 361),
    mk(M5_MS, 9, 361, 362, 340, 341),
    mk(M5_MS, 10, 341, 342, 320, 321),
    mk(M5_MS, 11, 321, 322, 300, 301), // touches zone [299,301]
    mk(M5_MS, 12, 301, 340, 300, 335), // rallying but close still < 460
    mk(M5_MS, 13, 335, 465, 334, 462), // closes above the 460 structure level
  ];
  return all.slice(0, lastIndex + 1);
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

// Mirror of m5UpTo around x'=300-x (and H/L swapped) -> touches supply zone [199,201] at index 6,
// swing low at index 2 (price 140), closes below it at index 8 -> confirms DOWN.
function m5DownTo(lastIndex: number): Candle[] {
  const all = [
    mk(M5_MS, 0, 150, 151, 148, 149),
    mk(M5_MS, 1, 149, 150, 144, 145),
    mk(M5_MS, 2, 145, 146, 140, 142), // swing low, price 140
    mk(M5_MS, 3, 144, 148, 143, 147),
    mk(M5_MS, 4, 147, 160, 146, 158),
    mk(M5_MS, 5, 158, 180, 157, 178),
    mk(M5_MS, 6, 178, 200, 177, 199), // touches zone [199,201]
    mk(M5_MS, 7, 199, 200, 160, 165), // dropping but close still > 140
    mk(M5_MS, 8, 165, 166, 135, 138), // closes below the 140 structure level
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
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), m5UpTo(8), [], 10_000);
  check("bias + zone + M5 confirmed -> entry", result && { direction: result.direction, confirmedAtIndex: result.confirmedAtIndex }, {
    direction: "UP",
    confirmedAtIndex: 8,
  });
}

// 2. Clear UP bias + valid demand zone, but M5 hasn't broken structure yet -> no entry.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), m5UpTo(7), [], 10_000);
  check("bias + zone, M5 not confirmed -> no entry", result, null);
}

// 3. Bias NONE -> no entry even with the same otherwise-good zone and confirmed M5.
{
  const result = detectEntryFromM15(flatSidewayD1(40), m15WithDemandZone(), m5UpTo(8), [], 10_000);
  check("bias NONE -> no entry", result, null);
}

// TICKET-12X-A: dailyThrottle wired into detectEntry.
const m5Confirmed = m5UpTo(8);
const now = m5Confirmed[8].closeTime;
const equity = 10_000;
const throttlingTrades: ClosedTrade[] = [{ closeTime: now, realizedPnl: 0.05 * equity }]; // exactly at the 5% boundary -> throttled

// 4. Good setup, under the 5%/day threshold -> entry unaffected.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), m5Confirmed, [], equity);
  check("under 5%/day -> entry unaffected", result !== null, true);
}

// 5. Good setup but low-score zone (<2), throttled -> blocked.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), m5Confirmed, throttlingTrades, equity);
  check("throttled + low score -> blocked", result, null);
}

// 6. Same throttle, but max-score zone (=2) -> still allowed through.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithScore2DemandZone(), m5Confirmed, throttlingTrades, equity);
  check("throttled + score=2 -> still allowed", result !== null, true);
}

// TICKET-13X-A: zone-distance cap.

// 7. Only a far zone (>10x ATR15 away) exists, still VALID -> filtered out, no entry.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithOnlyFarZone(), m5UpToNearZone(13), [], equity);
  check("only far zone -> filtered out, no entry", result, null);
}

// 8. Near zone (lower score) beats the far zone (higher score) once the far one is filtered -> near zone chosen.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithFarAndNearZone(), m5UpToNearZone(13), [], equity);
  check("near zone (in range) chosen over far zone (out of range)", result?.zone.low, 299);
}

// TICKET-19X-A: DOWN needs confluenceScore >= MIN_CONFLUENCE_SCORE_DOWN, UP is unfiltered.

// 9. DOWN + score-0 supply zone (would have been picked before this ticket) -> now excluded, no entry.
{
  const result = detectEntryFromM15(strongDowntrendD1(40), m15WithSupplyZone(), m5DownTo(8), [], equity);
  check("DOWN + score-0 zone -> excluded, no entry", result, null);
}

// 10. UP + score-0 demand zone -> still picked as before (UP branch unaffected).
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), m5UpTo(8), [], equity);
  check("UP + score-0 zone -> still picked, entry unaffected", result !== null, true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
