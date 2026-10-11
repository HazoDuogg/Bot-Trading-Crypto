/**
 * TICKET-07X-B verify — synthetic D1/M15/M5 series with a known outcome each.
 * Run: tsx scripts/research/entryRouterVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { detectEntry } from "../../src/entry/entryRouter.js";
import type { ClosedTrade } from "../../src/risk/dailyThrottle.js";
import { computeAdxDi } from "../../src/regime/adxDiCompare.js";
import { advanceRegistry, buildInitialRegistry } from "../../src/entry/zoneRegistry.js";

// TICKET-15X-A/21X-A: detectEntry now takes a pre-built registry plus raw h1Candles instead of
// atr15/currentPrice. This reproduces exactly what it used to do internally, once, per test.
function detectEntryFromM15(
  dailyCandles: Candle[],
  m15Candles: Candle[],
  h1Candles: Candle[],
  m5Candles: Candle[],
  closedTrades: ClosedTrade[],
  startOfDayEquity: number,
) {
  const { atr: atr15 } = computeAdxDi(m15Candles);
  const registry = buildInitialRegistry(m15Candles, atr15);
  return detectEntry(dailyCandles, registry, h1Candles, m5Candles, closedTrades, startOfDayEquity);
}

function mk(barMs: number, i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * barMs, closeTime: i * barMs + barMs - 1, open, high, low, close, volume: 1 };
}
const D1_MS = 24 * 60 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;

// TICKET-21X-A: builds an H1 series with exactly 2 clean swing points at `low`/`high` — flat filler
// candles are byte-identical so they never register as a swing themselves (strict > required).
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
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5UpTo(8), [], 10_000);
  check("bias + zone + M5 confirmed -> entry", result && { direction: result.direction, confirmedAtIndex: result.confirmedAtIndex }, {
    direction: "UP",
    confirmedAtIndex: 8,
  });
}

// 2. Clear UP bias + valid demand zone, but M5 hasn't broken structure yet -> no entry.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5UpTo(7), [], 10_000);
  check("bias + zone, M5 not confirmed -> no entry", result, null);
}

// 3. Bias NONE -> no entry even with the same otherwise-good zone and confirmed M5.
{
  const result = detectEntryFromM15(flatSidewayD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5UpTo(8), [], 10_000);
  check("bias NONE -> no entry", result, null);
}

// TICKET-12X-A: dailyThrottle wired into detectEntry.
const m5Confirmed = m5UpTo(8);
const now = m5Confirmed[8].closeTime;
const equity = 10_000;
const throttlingTrades: ClosedTrade[] = [{ closeTime: now, realizedPnl: 0.05 * equity }]; // exactly at the 5% boundary -> throttled

// 4. Good setup, under the 5%/day threshold -> entry unaffected.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5Confirmed, [], equity);
  check("under 5%/day -> entry unaffected", result !== null, true);
}

// 5. Good setup but low-score zone (<2), throttled -> blocked.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5Confirmed, throttlingTrades, equity);
  check("throttled + low score -> blocked", result, null);
}

// 6. Same throttle, but max-score zone (=2, once its nearby liquidity is swept) -> still allowed through.
// TICKET-27X-F: buildInitialRegistry (unchanged) gets the zone with its imbalance intact, then one
// extra advanceRegistry step applies a sweep candle — mirrors a new candle arriving causally after
// the zone already exists, without touching buildInitialRegistry's own (unbounded) base search.
{
  const baseCandles = m15WithScore2DemandZone();
  const sweepCandle = mk(M15_MS, baseCandles.length, 100, 100.5, 97.1, 97.3); // closes inside [zone.low=97, liquidityLevel=97.5)
  const allCandles = [...baseCandles, sweepCandle];
  const { atr: atr15 } = computeAdxDi(allCandles);
  let registry = buildInitialRegistry(baseCandles, atr15.slice(0, baseCandles.length));
  registry = advanceRegistry(registry, allCandles, atr15, baseCandles.length);
  const result = detectEntry(strongUptrendD1(40), registry, buildH1Range(90, 110), m5Confirmed, throttlingTrades, equity);
  check("throttled + score=2 -> still allowed", result !== null, true);
}

// TICKET-21X-A: H1 trading range replaces the old 10x ATR distance cap.

// 7. Zone exists but doesn't overlap the H1 trading range (even though it was within the old 10x ATR) -> excluded.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithOnlyFarZone(), buildH1Range(500, 600), m5UpToNearZone(13), [], equity);
  check("zone outside H1 range -> excluded, no entry", result, null);
}

// 8. Two zones exist; only the H1 range's own zone qualifies -> that one gets chosen.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithFarAndNearZone(), buildH1Range(290, 310), m5UpToNearZone(13), [], equity);
  check("zone overlapping H1 range chosen over the one outside it", result?.zone.low, 299);
}

// 11. Fewer than 2 H1 swings -> no trading range yet -> no entry, even with an otherwise-good zone/M5.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), [], m5UpTo(8), [], equity);
  check("fewer than 2 H1 swings -> no entry", result, null);
}

// TICKET-19X-B: reverted TICKET-19X-A's DOWN-only confluence filter -> UP and DOWN are fully symmetric again.

// 9. DOWN + score-0 supply zone -> picked normally, same as UP (no DOWN-only filtering).
{
  const result = detectEntryFromM15(strongDowntrendD1(40), m15WithSupplyZone(), buildH1Range(190, 210), m5DownTo(8), [], equity);
  check("DOWN + score-0 zone -> picked, entry unaffected (symmetric with UP)", result !== null, true);
}

// 10. UP + score-0 demand zone -> picked normally, unchanged.
{
  const result = detectEntryFromM15(strongUptrendD1(40), m15WithDemandZone(), buildH1Range(90, 110), m5UpTo(8), [], equity);
  check("UP + score-0 zone -> still picked, entry unaffected", result !== null, true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
