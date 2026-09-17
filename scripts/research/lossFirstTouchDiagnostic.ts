/**
 * TICKET-27X-C — diagnostic only, no production code touched, no PnL computed.
 * Question: among LOSS trades (SL_HIT), did price touch a favorable R-multiple level
 * before hitting SL, or did it go straight to SL? Answers whether the 60% direction-correct
 * vs 17.8% actual-win gap is a T1 problem (entries/targets wrong) or a T2 problem (no
 * breakeven/trailing to lock in a move that was already going the right way).
 * Run: tsx scripts/research/lossFirstTouchDiagnostic.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../../src/core/types.js";
import { createOrchestrator, type TradeRecord } from "../../src/core/orchestrator.js";

// --- Locked parameters (per ticket: do not change after seeing results) ---
const FAVORABLE_R_LEVELS = [1.0, 1.5, 2.0];
const PRICE_SOURCE = "M5"; // same timeframe as the system's own entry confirmation
const TIE_BREAK = "SL_FIRST"; // reuses exitManager.ts's own convention: SL wins a same-candle tie

const DAILY_PATH = resolve("data/ohlcv-BTCUSDT-1d.json");
const H1_PATH = resolve("data/ohlcv-BTCUSDT-1h.json");
const M15_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const M5_PATH = resolve("data/ohlcv-BTCUSDT-5m.json");

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

type TouchResult = "FAVORABLE_FIRST" | "ADVERSE_FIRST";

/**
 * Scans `candles` (the M5 candles strictly after entry, up to and including the real SL-hit
 * candle) for whether price reached `entryPrice + rMultiple*slDistance` (favorable, in the
 * trade's direction) before it reached `slPrice`. Same wick-check + SL-priority tie-break as
 * exitManager.ts's checkExit: if a single candle touches both, SL wins (TIE_BREAK='SL_FIRST').
 */
function classifyFirstTouch(candles: Candle[], entryPrice: number, slPrice: number, direction: "UP" | "DOWN", rMultiple: number): TouchResult {
  const slDistance = Math.abs(entryPrice - slPrice);
  const favorableLevel = direction === "UP" ? entryPrice + rMultiple * slDistance : entryPrice - rMultiple * slDistance;
  for (const c of candles) {
    const slHit = direction === "UP" ? c.low <= slPrice : c.high >= slPrice;
    const favHit = direction === "UP" ? c.high >= favorableLevel : c.low <= favorableLevel;
    if (slHit) return "ADVERSE_FIRST"; // SL_FIRST: wins even if favHit is also true this candle
    if (favHit) return "FAVORABLE_FIRST";
  }
  return "ADVERSE_FIRST"; // defensive only — candles always run through the real SL-hit candle
}

// --- Synthetic verification (must pass before touching real data, per project convention) ---
let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function c(high: number, low: number): Candle {
  return { openTime: 0, closeTime: 0, open: high, high, low, close: low, volume: 1 };
}

function runSyntheticVerification(): void {
  const entryPrice = 100;
  const slPrice = 90; // UP direction, slDistance = 10 -> R levels at 110 / 115 / 120

  // 1. Straight down to SL, no retrace -> ADVERSE_FIRST at every R level.
  {
    const candles = [c(99, 95), c(94, 90)];
    for (const r of FAVORABLE_R_LEVELS) {
      check(`case1 straight-to-SL R=${r} -> ADVERSE_FIRST`, classifyFirstTouch(candles, entryPrice, slPrice, "UP", r), "ADVERSE_FIRST");
    }
  }

  // 2. Touches +1R, reverses to SL without reaching +1.5R -> FAVORABLE_FIRST at 1.0R only.
  {
    const candles = [c(112, 105), c(95, 90)];
    check("case2 touches +1R then SL, R=1.0 -> FAVORABLE_FIRST", classifyFirstTouch(candles, entryPrice, slPrice, "UP", 1.0), "FAVORABLE_FIRST");
    check("case2 touches +1R then SL, R=1.5 -> ADVERSE_FIRST", classifyFirstTouch(candles, entryPrice, slPrice, "UP", 1.5), "ADVERSE_FIRST");
    check("case2 touches +1R then SL, R=2.0 -> ADVERSE_FIRST", classifyFirstTouch(candles, entryPrice, slPrice, "UP", 2.0), "ADVERSE_FIRST");
  }

  // 3. Touches +2R, reverses to SL -> FAVORABLE_FIRST at every R level.
  {
    const candles = [c(122, 105), c(95, 90)];
    for (const r of FAVORABLE_R_LEVELS) {
      check(`case3 touches +2R then SL, R=${r} -> FAVORABLE_FIRST`, classifyFirstTouch(candles, entryPrice, slPrice, "UP", r), "FAVORABLE_FIRST");
    }
  }

  // 4. One candle touches both SL and +1R (two-way wick) -> TIE_BREAK='SL_FIRST' -> ADVERSE_FIRST.
  {
    const candles = [c(112, 90)];
    for (const r of FAVORABLE_R_LEVELS) {
      check(`case4 same-candle SL+favorable tie, R=${r} -> ADVERSE_FIRST (SL_FIRST)`, classifyFirstTouch(candles, entryPrice, slPrice, "UP", r), "ADVERSE_FIRST");
    }
  }
}

// --- Real backtest driver (same causal replay as backtestRun.ts, kept self-contained here
// since this script only needs the full tradeLog, which the saved report.json doesn't retain). ---
function runBacktest(dailyAll: Candle[], h1All: Candle[], m15All: Candle[], m5All: Candle[]): TradeRecord[] {
  const orchestrator = createOrchestrator(10_000);
  let d1Index = 0;
  let h1Index = 0;
  let m15Index = 0;
  let cachedDaily: Candle[] = [];
  let lastD1Index = -1;

  for (let i = 0; i < m5All.length; i++) {
    const m5Candle = m5All[i];
    const now = m5Candle.closeTime;

    while (d1Index < dailyAll.length && dailyAll[d1Index].closeTime <= now) d1Index++;
    if (d1Index !== lastD1Index) {
      cachedDaily = dailyAll.slice(0, d1Index);
      lastD1Index = d1Index;
    }

    const newH1: Candle[] = [];
    while (h1Index < h1All.length && h1All[h1Index].closeTime <= now) {
      newH1.push(h1All[h1Index]);
      h1Index++;
    }

    const newM15: Candle[] = [];
    while (m15Index < m15All.length && m15All[m15Index].closeTime <= now) {
      newM15.push(m15All[m15Index]);
      m15Index++;
    }

    orchestrator.onCandle(cachedDaily, newH1, newM15, [m5Candle]);
  }

  return orchestrator.getState().tradeLog;
}

interface FavStats {
  sampleSize: number;
  favorableFirstCount: Record<number, number>;
  favorableFirstPct: Record<number, number>;
}

function computeFavStats(losses: TradeRecord[], m5All: Candle[], closeTimeToIndex: Map<number, number>): FavStats {
  const favorableFirstCount: Record<number, number> = {};
  for (const r of FAVORABLE_R_LEVELS) favorableFirstCount[r] = 0;

  let sampleSize = 0;
  for (const t of losses) {
    const entryIndex = t.entryTick - 1;
    const slHitIndex = closeTimeToIndex.get(t.closeTime as number);
    if (slHitIndex === undefined || slHitIndex <= entryIndex) continue; // defensive only
    const window = m5All.slice(entryIndex + 1, slHitIndex + 1);
    sampleSize++;
    for (const r of FAVORABLE_R_LEVELS) {
      const result = classifyFirstTouch(window, t.entryPrice, t.stopLoss, t.direction, r);
      if (result === "FAVORABLE_FIRST") favorableFirstCount[r]++;
    }
  }

  const favorableFirstPct: Record<number, number> = {};
  for (const r of FAVORABLE_R_LEVELS) {
    favorableFirstPct[r] = sampleSize > 0 ? (favorableFirstCount[r] / sampleSize) * 100 : 0;
  }
  return { sampleSize, favorableFirstCount, favorableFirstPct };
}

function main() {
  console.log(`Locked params: FAVORABLE_R_LEVELS=${JSON.stringify(FAVORABLE_R_LEVELS)}, PRICE_SOURCE=${PRICE_SOURCE}, TIE_BREAK=${TIE_BREAK}\n`);

  console.log("--- Synthetic verification ---");
  runSyntheticVerification();
  if (failures > 0) {
    console.log(`\n${failures} synthetic check(s) FAILED — not running against real data.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll synthetic checks passed.\n");

  console.log("--- Running real backtest (causal replay, diagnostic only) ---");
  const dailyAll = loadJson<Candle[]>(DAILY_PATH);
  const h1All = loadJson<Candle[]>(H1_PATH);
  const m15All = loadJson<Candle[]>(M15_PATH);
  const m5All = loadJson<Candle[]>(M5_PATH);
  const tradeLog = runBacktest(dailyAll, h1All, m15All, m5All);

  const closeTimeToIndex = new Map<number, number>();
  m5All.forEach((c, i) => closeTimeToIndex.set(c.closeTime, i));

  const losses = tradeLog.filter((t) => t.exitReason === "SL_HIT");
  console.log(`Total LOSS trades (SL_HIT): ${losses.length}\n`);

  const overall = computeFavStats(losses, m5All, closeTimeToIndex);
  const up = computeFavStats(
    losses.filter((t) => t.direction === "UP"),
    m5All,
    closeTimeToIndex,
  );
  const down = computeFavStats(
    losses.filter((t) => t.direction === "DOWN"),
    m5All,
    closeTimeToIndex,
  );
  const split = computeFavStats(
    losses.filter((t) => t.splitMode === "SPLIT"),
    m5All,
    closeTimeToIndex,
  );
  const single = computeFavStats(
    losses.filter((t) => t.splitMode === "SINGLE"),
    m5All,
    closeTimeToIndex,
  );

  function printStats(label: string, s: FavStats) {
    console.log(`${label} (sampleSize=${s.sampleSize}):`);
    for (const r of FAVORABLE_R_LEVELS) {
      console.log(`  +${r}R FAVORABLE_FIRST: ${s.favorableFirstCount[r]}/${s.sampleSize} (${s.favorableFirstPct[r].toFixed(1)}%)`);
    }
  }

  printStats("Overall", overall);
  printStats("Direction UP", up);
  printStats("Direction DOWN", down);
  printStats("Split mode SPLIT", split);
  printStats("Split mode SINGLE", single);
}

main();
