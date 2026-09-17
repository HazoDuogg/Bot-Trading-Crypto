/**
 * TICKET-27X-G — diagnostic only, no production code touched, no PnL computed.
 * Measures how far the ATR-buffer SL (`zone.low/high ± 0.25xATR15`, positionSizer.ts's
 * computeStopLoss) sits from the nearest real swing low/high at entry time, in R units.
 * Compares the LOSS group that ran straight to SL without touching +1R first (the
 * ADVERSE_FIRST@1.0R group from TICKET-27X-C, 69.1% of losses) against everyone else,
 * to see whether that group's SL sits systematically looser (further from real structure).
 * Run: tsx scripts/research/slVsSwingGapAudit.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../../src/core/types.js";
import { createOrchestrator, type TradeRecord } from "../../src/core/orchestrator.js";
import { detectSwingPoints } from "../../src/entry/liquidity.js";

const DAILY_PATH = resolve("data/ohlcv-BTCUSDT-1d.json");
const H1_PATH = resolve("data/ohlcv-BTCUSDT-1h.json");
const M15_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const M5_PATH = resolve("data/ohlcv-BTCUSDT-5m.json");

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

// Same causal replay as backtestRun.ts / lossFirstTouchDiagnostic.ts — the only way to recover
// entryTick/closeTime-indexed trades, since backtest-report.json only persists summary stats.
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

// TICKET-27X-C's classification, reused unchanged (same TIE_BREAK='SL_FIRST' convention as
// exitManager.ts) to split LOSS trades into ADVERSE_FIRST@1.0R vs the rest.
function classifyFirstTouch(candles: Candle[], entryPrice: number, slPrice: number, direction: "UP" | "DOWN", rMultiple: number): "FAVORABLE_FIRST" | "ADVERSE_FIRST" {
  const slDistance = Math.abs(entryPrice - slPrice);
  const favorableLevel = direction === "UP" ? entryPrice + rMultiple * slDistance : entryPrice - rMultiple * slDistance;
  for (const c of candles) {
    const slHit = direction === "UP" ? c.low <= slPrice : c.high >= slPrice;
    const favHit = direction === "UP" ? c.high >= favorableLevel : c.low <= favorableLevel;
    if (slHit) return "ADVERSE_FIRST";
    if (favHit) return "FAVORABLE_FIRST";
  }
  return "ADVERSE_FIRST";
}

interface GapSample {
  gapR: number;
  group: "ADVERSE_FIRST_1R" | "OTHER";
}

function main() {
  console.log("--- Running causal backtest replay (unchanged code, diagnostic only) ---");
  const dailyAll = loadJson<Candle[]>(DAILY_PATH);
  const h1All = loadJson<Candle[]>(H1_PATH);
  const m15All = loadJson<Candle[]>(M15_PATH);
  const m5All = loadJson<Candle[]>(M5_PATH);
  const tradeLog = runBacktest(dailyAll, h1All, m15All, m5All);
  console.log(`Total trades: ${tradeLog.length}\n`);

  const closeTimeToM5Index = new Map<number, number>();
  m5All.forEach((c, i) => closeTimeToM5Index.set(c.closeTime, i));

  const samples: GapSample[] = [];
  let skipped = 0;

  for (const t of tradeLog) {
    const entryM5Index = t.entryTick - 1;
    if (entryM5Index < 0 || entryM5Index >= m5All.length) {
      skipped++;
      continue;
    }
    const entryTime = m5All[entryM5Index].closeTime;

    // M15 candles ingested causally up to (and including) entry time — same "closeTime <= now"
    // gate the live driver uses, so this reproduces exactly what the registry saw at entry.
    let m15CutoffIndex = 0;
    while (m15CutoffIndex < m15All.length && m15All[m15CutoffIndex].closeTime <= entryTime) m15CutoffIndex++;
    const m15SoFar = m15All.slice(0, m15CutoffIndex);

    const wantKind = t.direction === "UP" ? "low" : "high";
    const swings = detectSwingPoints(m15SoFar).filter((s) => s.type === wantKind);
    if (swings.length === 0) {
      skipped++; // no swing of the matching type observed yet at entry time — nothing to compare against
      continue;
    }
    const nearestSwing = swings[swings.length - 1]; // most recent confirmed swing as of entry time

    const slDistance = Math.abs(t.entryPrice - t.stopLoss);
    if (slDistance === 0) {
      skipped++;
      continue;
    }
    const gapR = Math.abs(t.stopLoss - nearestSwing.price) / slDistance;

    let group: GapSample["group"] = "OTHER";
    if (t.exitReason === "SL_HIT") {
      const slHitIndex = closeTimeToM5Index.get(t.closeTime as number);
      if (slHitIndex !== undefined && slHitIndex > entryM5Index) {
        const window = m5All.slice(entryM5Index + 1, slHitIndex + 1);
        const result = classifyFirstTouch(window, t.entryPrice, t.stopLoss, t.direction, 1.0);
        if (result === "ADVERSE_FIRST") group = "ADVERSE_FIRST_1R";
      }
    }

    samples.push({ gapR, group });
  }

  console.log(`Samples measured: ${samples.length} (skipped: ${skipped})\n`);

  function summarizeGroup(label: string, group: GapSample["group"] | "ALL") {
    const subset = group === "ALL" ? samples : samples.filter((s) => s.group === group);
    if (subset.length === 0) {
      console.log(`${label}: n=0`);
      return;
    }
    const avgGapR = subset.reduce((sum, s) => sum + s.gapR, 0) / subset.length;
    const sorted = [...subset].sort((a, b) => a.gapR - b.gapR);
    const median = sorted[Math.floor(sorted.length / 2)].gapR;
    console.log(`${label}: n=${subset.length}, avgGapR=${avgGapR.toFixed(3)}, medianGapR=${median.toFixed(3)}`);
  }

  summarizeGroup("ALL trades", "ALL");
  summarizeGroup("ADVERSE_FIRST@1.0R (ran straight to SL)", "ADVERSE_FIRST_1R");
  summarizeGroup("Everyone else (wins + FAVORABLE_FIRST losses)", "OTHER");
}

main();
