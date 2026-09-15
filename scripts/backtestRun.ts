/**
 * TICKET-17X-A — real backtest driver over 3 years of BTC D1/M15/M5, causal.
 * No parameter tuning here or after seeing results — run and report only.
 * Run: tsx scripts/backtestRun.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle, RegimeState } from "../src/core/types.js";
import { createOrchestrator, type TradeRecord } from "../src/core/orchestrator.js";
import { detectRegime, MIN_CANDLES } from "../src/regime/regimeDetector.js";

const DAILY_PATH = resolve("data/ohlcv-BTCUSDT-1d.json");
const H1_PATH = resolve("data/ohlcv-BTCUSDT-1h.json");
const M15_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const M5_PATH = resolve("data/ohlcv-BTCUSDT-5m.json");
const REPORT_PATH = resolve("data/backtest-report.json");
const INITIAL_EQUITY = 10_000;
const MIN_SAMPLE_SIZE = 50;

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function runBacktest(dailyAll: Candle[]) {
  const h1All = loadJson<Candle[]>(H1_PATH);
  const m15All = loadJson<Candle[]>(M15_PATH);
  const m5All = loadJson<Candle[]>(M5_PATH);

  const orchestrator = createOrchestrator(INITIAL_EQUITY);

  let d1Index = 0;
  let h1Index = 0;
  let m15Index = 0;
  let cachedDaily: Candle[] = [];
  let lastD1Index = -1;

  const startedAt = Date.now();
  for (let i = 0; i < m5All.length; i++) {
    const m5Candle = m5All[i];
    const now = m5Candle.closeTime;

    while (d1Index < dailyAll.length && dailyAll[d1Index].closeTime <= now) d1Index++;
    if (d1Index !== lastD1Index) {
      cachedDaily = dailyAll.slice(0, d1Index); // only re-slice when a new D1 candle has actually closed
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

    if (i % 50_000 === 0) {
      console.log(`progress: ${i}/${m5All.length} M5 candles, ${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed`);
    }
  }

  console.log(`Backtest run complete: ${m5All.length} M5 candles in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return orchestrator.getState();
}

interface GroupSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  stillOpenAtEnd: number;
  winRatePct: number | null;
  profitFactor: number | null;
  grossProfit: number;
  grossLoss: number;
}

function summarize(trades: TradeRecord[]): GroupSummary {
  const closed = trades.filter((t) => t.exitReason !== null);
  const wins = closed.filter((t) => t.exitReason === "TP_HIT");
  const losses = closed.filter((t) => t.exitReason === "SL_HIT");
  const grossProfit = wins.reduce((sum, t) => sum + (t.realizedPnl as number), 0);
  const grossLoss = losses.reduce((sum, t) => sum + (t.realizedPnl as number), 0); // negative
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    stillOpenAtEnd: trades.length - closed.length,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    profitFactor: grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null,
    grossProfit,
    grossLoss,
  };
}

function directionAccuracy(trades: TradeRecord[], horizon: "directionCorrect15" | "directionCorrect30" | "directionCorrect60") {
  const resolved = trades.filter((t) => t[horizon] !== null);
  const correct = resolved.filter((t) => t[horizon] === true);
  return {
    resolvedCount: resolved.length,
    correctCount: correct.length,
    pctDirectionCorrect: resolved.length > 0 ? (correct.length / resolved.length) * 100 : null,
  };
}

// TICKET-18X-A #3 — reuses detectRegime unchanged, causally, over the full D1 series -> % of
// evaluated days spent in each regime state (no trading logic involved, report-only).
function d1RegimeTimeDistribution(dailyAll: Candle[]) {
  const counts: Record<RegimeState, number> = { UPTREND: 0, DOWNTREND: 0, SIDEWAY: 0, DANGER_ZONE: 0 };
  for (let i = MIN_CANDLES - 1; i < dailyAll.length; i++) {
    counts[detectRegime(dailyAll.slice(0, i + 1)).state]++;
  }
  const totalDaysEvaluated = Object.values(counts).reduce((a, b) => a + b, 0);
  const pctOfDaysEvaluated = Object.fromEntries(
    (Object.keys(counts) as RegimeState[]).map((k) => [k, totalDaysEvaluated > 0 ? (counts[k] / totalDaysEvaluated) * 100 : 0]),
  );
  return { totalDaysEvaluated, counts, pctOfDaysEvaluated };
}

// TICKET-18X-A #4 — average SL distance (raw + % of entry, since BTC's price level moved ~6x
// over the 3 years) and average R-multiple actually achieved, per closed trade.
function slAndRR(trades: TradeRecord[]) {
  const closed = trades.filter((t) => t.exitPrice !== null);
  if (closed.length === 0) return { sampleSize: 0, avgSlDistance: null, avgSlDistancePct: null, avgRMultiple: null };
  let sumDist = 0;
  let sumDistPct = 0;
  let sumR = 0;
  for (const t of closed) {
    const dist = Math.abs(t.entryPrice - t.stopLoss);
    sumDist += dist;
    sumDistPct += (dist / t.entryPrice) * 100;
    const sign = t.direction === "UP" ? 1 : -1;
    sumR += dist > 0 ? (sign * ((t.exitPrice as number) - t.entryPrice)) / dist : 0;
  }
  return {
    sampleSize: closed.length,
    avgSlDistance: sumDist / closed.length,
    avgSlDistancePct: sumDistPct / closed.length,
    avgRMultiple: sumR / closed.length,
  };
}

function buildReport(trades: TradeRecord[], equity: number, dailyAll: Candle[]) {
  const overall = summarize(trades);
  const score2 = trades.filter((t) => t.confluenceScoreAtEntry === 2);
  const scoreOther = trades.filter((t) => t.confluenceScoreAtEntry !== 2);
  const split = trades.filter((t) => t.splitMode === "SPLIT");
  const single = trades.filter((t) => t.splitMode === "SINGLE");
  const up = trades.filter((t) => t.direction === "UP");
  const down = trades.filter((t) => t.direction === "DOWN");

  return {
    generatedAt: new Date().toISOString(),
    finalEquity: equity,
    initialEquity: INITIAL_EQUITY,
    sampleSizeWarning:
      overall.totalTrades < MIN_SAMPLE_SIZE
        ? `Only ${overall.totalTrades} trades — below the ${MIN_SAMPLE_SIZE}-trade minimum sample size; not enough to draw conclusions.`
        : null,
    overall,
    directionCorrectVsActualWin: {
      // "went the right direction" per horizon (independent of SL/TP/zone) vs "actually won" (checkExit's TP_HIT verdict).
      at15Candles: directionAccuracy(trades, "directionCorrect15"),
      at30Candles: directionAccuracy(trades, "directionCorrect30"),
      at60Candles: directionAccuracy(trades, "directionCorrect60"),
      actualWinRatePct: overall.winRatePct,
    },
    byConfluenceScore: {
      score2: summarize(score2),
      scoreOther: summarize(scoreOther),
    },
    bySplitMode: {
      split: summarize(split),
      single: summarize(single),
    },
    byDirection: {
      up: summarize(up),
      down: summarize(down),
    },
    // TICKET-18X-A #1 — 4-cell cross-tab: is confluenceScore=2 equally strong for DOWN as for UP?
    crossTabDirectionByScore: {
      upScore2: summarize(up.filter((t) => t.confluenceScoreAtEntry === 2)),
      upScoreOther: summarize(up.filter((t) => t.confluenceScoreAtEntry !== 2)),
      downScore2: summarize(down.filter((t) => t.confluenceScoreAtEntry === 2)),
      downScoreOther: summarize(down.filter((t) => t.confluenceScoreAtEntry !== 2)),
    },
    // TICKET-18X-A #2 — same 15/30/60 direction-correct metric as before, split by trade direction.
    directionCorrectByDirection: {
      up: { at15Candles: directionAccuracy(up, "directionCorrect15"), at30Candles: directionAccuracy(up, "directionCorrect30"), at60Candles: directionAccuracy(up, "directionCorrect60") },
      down: { at15Candles: directionAccuracy(down, "directionCorrect15"), at30Candles: directionAccuracy(down, "directionCorrect30"), at60Candles: directionAccuracy(down, "directionCorrect60") },
    },
    d1RegimeTimeDistribution: d1RegimeTimeDistribution(dailyAll),
    slAndRRByDirection: {
      up: slAndRR(up),
      down: slAndRR(down),
    },
  };
}

function main() {
  const dailyAll = loadJson<Candle[]>(DAILY_PATH);
  const state = runBacktest(dailyAll);
  const report = buildReport(state.tradeLog, state.equity, dailyAll);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Saved report to ${REPORT_PATH}`);
  console.log(JSON.stringify(report, null, 2));
}

main();
