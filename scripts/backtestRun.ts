/**
 * TICKET-17X-A — real backtest driver over 3 years of BTC D1/M15/M5, causal.
 * No parameter tuning here or after seeing results — run and report only.
 * Run: tsx scripts/backtestRun.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../src/core/types.js";
import { createOrchestrator, type TradeRecord } from "../src/core/orchestrator.js";

const DAILY_PATH = resolve("data/ohlcv-BTCUSDT-1d.json");
const M15_PATH = resolve("data/ohlcv-BTCUSDT-15m.json");
const M5_PATH = resolve("data/ohlcv-BTCUSDT-5m.json");
const REPORT_PATH = resolve("data/backtest-report.json");
const INITIAL_EQUITY = 10_000;
const MIN_SAMPLE_SIZE = 50;

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function runBacktest() {
  const dailyAll = loadJson<Candle[]>(DAILY_PATH);
  const m15All = loadJson<Candle[]>(M15_PATH);
  const m5All = loadJson<Candle[]>(M5_PATH);

  const orchestrator = createOrchestrator(INITIAL_EQUITY);

  let d1Index = 0;
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

    const newM15: Candle[] = [];
    while (m15Index < m15All.length && m15All[m15Index].closeTime <= now) {
      newM15.push(m15All[m15Index]);
      m15Index++;
    }

    orchestrator.onCandle(cachedDaily, newM15, [m5Candle]);

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

function buildReport(trades: TradeRecord[], equity: number) {
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
  };
}

function main() {
  const state = runBacktest();
  const report = buildReport(state.tradeLog, state.equity);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Saved report to ${REPORT_PATH}`);
  console.log(JSON.stringify(report, null, 2));
}

main();
