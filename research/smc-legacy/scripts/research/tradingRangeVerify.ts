/**
 * TICKET-21X-A verify — computeH1TradingRange over hand-built H1 candle sequences.
 * Run: tsx scripts/research/tradingRangeVerify.ts
 */
import type { Candle } from "../../src/core/types.js";
import { computeH1TradingRange } from "../../src/entry/tradingRange.js";

const H1_MS = 60 * 60 * 1000;
function mk(i: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: i * H1_MS, closeTime: i * H1_MS + H1_MS - 1, open, high, low, close, volume: 1 };
}
function flat(i: number, r: number): Candle {
  return mk(i, r, r + 1, r - 1, r);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Builds an H1 series with exactly 2 clean swing points at `low`/`high` (flat filler is byte-identical, never a swing itself).
function buildTwoSwings(low: number, high: number): Candle[] {
  const r = (low + high) / 2;
  const lowBlock = [flat(0, r), flat(1, r), mk(2, low, r, low, low), flat(3, r), flat(4, r)];
  const gap = [flat(5, r), flat(6, r), flat(7, r), flat(8, r)];
  const highBlock = [flat(9, r), flat(10, r), mk(11, high, high, r, high), flat(12, r), flat(13, r)];
  return [...lowBlock, ...gap, ...highBlock];
}

// 1. Exactly 2 swings -> range is [min, max] of the two, regardless of which came first.
check("low then high -> correct range", computeH1TradingRange(buildTwoSwings(90, 110)), { low: 90, high: 110 });

// 2. High swing first, then low swing -> still [min, max] (order-independent).
{
  const r = 100;
  const highBlock = [flat(0, r), flat(1, r), mk(2, 120, 120, r, 120), flat(3, r), flat(4, r)];
  const gap = [flat(5, r), flat(6, r), flat(7, r), flat(8, r)];
  const lowBlock = [flat(9, r), flat(10, r), mk(11, 80, r, 80, 80), flat(12, r), flat(13, r)];
  check("high then low -> correct range", computeH1TradingRange([...highBlock, ...gap, ...lowBlock]), { low: 80, high: 120 });
}

// 3. Fewer than 2 swings -> null.
check("0 candles -> null", computeH1TradingRange([]), null);
check("only 1 swing -> null", computeH1TradingRange([flat(0, 100), flat(1, 100), mk(2, 90, 100, 90, 90), flat(3, 100), flat(4, 100)]), null);

// 4. More than 2 swings -> only the LAST 2 (most recent) are used.
{
  const r = 100;
  const oldSwing = [flat(0, r), flat(1, r), mk(2, 200, 200, r, 200), flat(3, r), flat(4, r)]; // old swing high at 200, should be ignored
  const gap1 = [flat(5, r), flat(6, r), flat(7, r), flat(8, r)];
  const twoRecent = buildTwoSwings(90, 110).map((c, i) => mk(9 + i, c.open, c.high, c.low, c.close));
  check("more than 2 swings -> only the last 2 used", computeH1TradingRange([...oldSwing, ...gap1, ...twoRecent]), { low: 90, high: 110 });
}

// 5. TICKET-23X-A: two peaks in a row, then a bottom -> pair the bottom with the NEARER peak, skip the older same-type one.
{
  const r = 100;
  const olderPeak = [flat(0, r), flat(1, r), mk(2, 150, 150, r, 150), flat(3, r), flat(4, r)]; // peak 1 (older), should be ignored
  const gap1 = [flat(5, r), flat(6, r), flat(7, r), flat(8, r)];
  const nearerPeak = [flat(9, r), flat(10, r), mk(11, 130, 130, r, 130), flat(12, r), flat(13, r)]; // peak 2 (nearer)
  const gap2 = [flat(14, r), flat(15, r), flat(16, r), flat(17, r)];
  const bottom = [flat(18, r), flat(19, r), mk(20, 90, r, 90, 90), flat(21, r), flat(22, r)];
  check("two same-type peaks then a bottom -> pairs with the nearer peak", computeH1TradingRange([...olderPeak, ...gap1, ...nearerPeak, ...gap2, ...bottom]), {
    low: 90,
    high: 130,
  });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed");
}
