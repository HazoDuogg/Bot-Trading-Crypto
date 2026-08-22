/**
 * TICKET-SCALP-001/002/003/004 — dedicated backtest driver for scalp/sweepReversalEntry.ts. Independent
 * of scripts/backtest.ts (which drives the OLD MarketRegime/routeEntry/OB-FVG-Sweep/momentum
 * pipeline) — this only wires together the modules the ticket names as "giữ nguyên": regime/
 * (detectRegime() for raw computedMetrics only — NOT its MarketRegime decision — htfContext.ts,
 * safetyState5m.ts, safetyState5mTrackerV2.ts), scalp/sweepReversalEntry.ts, risk/slTpManager.ts
 * (COUNTER_TREND path), risk/riskPool.ts, backtest/executionCostEngine.ts.
 *
 * TICKET-SCALP-003 Phần A: back to fixed margin (ScalpConfig.MARGIN_USD * LEVERAGE) — the
 * TICKET-SCALP-002 risk$-inverted sizing let positionSize blow up on tiny real SL%.
 * TICKET-SCALP-003 Phần B / TICKET-SCALP-004 Việc 1: sweeps ScalpConfig.MIN_SL_DISTANCE_PERCENT
 * across several candidate levels in one run (LEVELS_TO_SWEEP below), plus TICKET-SCALP-004 Việc 2's
 * per-symbol breakdown at PER_SYMBOL_BREAKDOWN_LABEL — reports each separately, never picks one.
 * No look-ahead: every timeframe window is sliced via two-pointer (closedWindow, same technique
 * scripts/backtest.ts already uses) to only candles already CLOSED as of each decision time.
 *
 * Run from repo root (needs `npm run build` first so dist/ reflects the latest src/):
 *   npm run scalp-backtest -- --data-dir=data/ohlcv-scalp-6m --start-balance=1000
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { classifyHtfContextCandidate } from '../dist/regime/htfContext.js';
import { classifySafetyState5mCandidate } from '../dist/regime/safetyState5m.js';
import { applySafetyState5mFinalStabilization, INITIAL_SAFETY_STATE_5M_TRACKER, type SafetyState5mTrackerState } from '../dist/regime/safetyState5mTrackerV2.js';
import { HTFContext, SafetyState5m } from '../dist/regime/htfSafetyTypes.js';
import { ScalpConfig } from '../dist/scalp/config.js';
import { detectSweepReversalEntry, type SweepReversalSetup } from '../dist/scalp/sweepReversalEntry.js';
import { openPosition, onSlHit, onCounterTrendTpHit, isTpHit, isSlHitAtPrice, type ManagedPositionState } from '../dist/risk/slTpManager.js';
import { wouldExceedRiskPool, DEFAULT_RISK_POOL_CONFIG, type OpenPositionRisk } from '../dist/risk/riskPool.js';
import { attributeTradeExecution, type ExecutionCostConfig } from '../dist/backtest/executionCostEngine.js';

// ---- CLI args ----
function argValue(flag: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=')[1] : fallback;
}
const DATA_DIR = path.resolve(process.cwd(), argValue('data-dir', 'data/ohlcv-scalp-6m'));
const START_BALANCE = Number(argValue('start-balance', '1000'));
const OUT_DIR = path.resolve(process.cwd(), 'data');

/** TICKET-SCALP-003 Phần B: baseline (no filter) plus the ticket's own candidate levels. */
const LEVELS_TO_SWEEP: Array<{ label: string; minSlDistancePercent: number }> = [
  { label: 'baseline (no filter)', minSlDistancePercent: 0 },
  { label: '0.15%', minSlDistancePercent: 0.0015 },
  { label: '0.2%', minSlDistancePercent: 0.002 },
  { label: '0.3%', minSlDistancePercent: 0.003 },
  { label: '0.4%', minSlDistancePercent: 0.004 },
  { label: '0.5%', minSlDistancePercent: 0.005 },
  // TICKET-SCALP-004 Việc 1: extends the sweep to see whether the winrate/PF trend keeps improving.
  { label: '0.6%', minSlDistancePercent: 0.006 },
  { label: '0.7%', minSlDistancePercent: 0.007 },
  { label: '0.8%', minSlDistancePercent: 0.008 },
  { label: '1.0%', minSlDistancePercent: 0.01 },
];

/** TICKET-SCALP-004 Việc 2: per-symbol breakdown is reported for this one sweep level's label. */
const PER_SYMBOL_BREAKDOWN_LABEL = '0.5%';

// TICKET-SCALP-001 Risk/Entry mapping: "fee 0.04%/chiều, funding tắt".
const EXECUTION_COST_CONFIG: ExecutionCostConfig = {
  enabled: true,
  takerFeeRate: 0.0004,
  slippage: { enabled: false, model: 'FIXED_BPS', bpsPerSide: 0 },
  spread: { enabled: false, model: 'FIXED_TOTAL_BPS', totalBps: 0 },
  latency: { enabled: false, model: 'DISABLED' },
  funding: { enabled: false, model: 'DISABLED' },
};

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

/** Same two-pointer technique as scripts/backtest.ts's closedWindow() — never looks ahead. */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

/** Read-only candle history per symbol, loaded ONCE and reused across every swept threshold level. */
interface SymbolCandles {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
}

function loadSymbolCandles(symbol: string): SymbolCandles {
  return {
    candles5m: readCsv(path.join(DATA_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(DATA_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(DATA_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(DATA_DIR, `${symbol}_1m.csv`)),
  };
}

/** Mutable per-pass state (pointers/tracker/index) — fresh for every swept threshold level. */
interface SymbolPassState {
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  safetyTracker: SafetyState5mTrackerState | null;
  nextIndex: number; // next unconsumed index into candles5m
}

function freshPassState(): SymbolPassState {
  return { ptr15m: -1, ptr1h: -1, ptr1m: -1, safetyTracker: null, nextIndex: 0 };
}

interface OpenTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: '15m' | '5m';
  entryTimestamp: number;
  managed: ManagedPositionState;
  actualRiskDollar: number;
  marginRequired: number;
  sweptLevel: number;
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
}

interface ClosedTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: '15m' | '5m';
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  sweptLevel: number;
  slDistancePercent: number;
  actualRiskDollar: number;
  marginRequired: number;
  positionSize: number;
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: 'TP' | 'SL' | 'END_OF_DATA';
  holdMinutes: number;
  netPnlUsd: number;
  feeCost: number;
  accountBalanceAfter: number;
}

const FIVE_MIN_MS = 5 * 60_000;
const FIFTEEN_MIN_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const ONE_MIN_MS = 60_000;

/** Enough trailing history for RegimeConfig's 300-candle percentile lookbacks (5m/15m), plus buffer. */
const WINDOW_5M = 320;
const WINDOW_15M = 320;
const WINDOW_1H = 60;
const WINDOW_1M = 60;

function closeTrade(open: OpenTrade, exitPrice: number, exitTimestamp: number, exitReason: 'TP' | 'SL' | 'END_OF_DATA', accountBalance: number): ClosedTrade {
  const attribution = attributeTradeExecution(
    {
      symbol: open.symbol,
      side: open.side,
      entryTimestamp: open.entryTimestamp,
      referenceEntry: open.managed.entryPrice,
      positionSize: open.managed.positionSize,
      exits: [{ referencePrice: exitPrice, fraction: 1, timestamp: exitTimestamp }],
    },
    EXECUTION_COST_CONFIG,
  );
  const tp = open.managed.tpLevels.find((t) => t.label === 'COUNTER_TREND_TP');
  return {
    symbol: open.symbol,
    side: open.side,
    timeframe: open.timeframe,
    entryTimestamp: open.entryTimestamp,
    entryPrice: open.managed.entryPrice,
    slPrice: open.managed.initialSlPrice,
    tpPrice: tp && tp.price !== null ? tp.price : NaN,
    sweptLevel: open.sweptLevel,
    slDistancePercent: Math.abs(open.managed.entryPrice - open.managed.initialSlPrice) / open.managed.entryPrice,
    actualRiskDollar: open.actualRiskDollar,
    marginRequired: open.marginRequired,
    positionSize: open.managed.positionSize,
    htfContext: open.htfContext,
    safetyState5m: open.safetyState5m,
    exitTimestamp,
    exitPrice,
    exitReason,
    holdMinutes: Math.round((exitTimestamp - open.entryTimestamp) / 60_000),
    netPnlUsd: attribution.netPnl,
    feeCost: attribution.feeCost,
    accountBalanceAfter: accountBalance + attribution.netPnl,
  };
}

interface PassResult {
  closedTrades: ClosedTrade[];
  finalBalance: number;
  skippedInvalidSetups: number;
}

/**
 * One full 6-month, 5-symbol replay at a single minSlDistancePercent level. Candle arrays are
 * shared/read-only across passes; all mutable state (pointers, open positions, balance) is fresh.
 */
function runBacktestPass(symbolCandles: Map<string, SymbolCandles>, masterClock: number[], minSlDistancePercent: number): PassResult {
  const passState = new Map<string, SymbolPassState>();
  for (const symbol of ScalpConfig.SYMBOLS) passState.set(symbol, freshPassState());

  const openTrades = new Map<string, OpenTrade>(); // symbol -> open trade (max 1 concurrent per symbol)
  const closedTrades: ClosedTrade[] = [];
  let accountBalance = START_BALANCE;
  let skippedInvalidSetups = 0;

  // TICKET-SCALP-003 Phần A: fixed margin -> fixed positionSize, no longer derived from SL%.
  const positionSize = ScalpConfig.MARGIN_USD * ScalpConfig.LEVERAGE;
  const marginRequired = ScalpConfig.MARGIN_USD;

  for (const timestamp of masterClock) {
    // ---- 1. Manage already-open positions first (exit check before any new entry this candle) ----
    for (const [symbol, open] of Array.from(openTrades.entries())) {
      const candles = symbolCandles.get(symbol)!;
      const state = passState.get(symbol)!;
      const idx = state.nextIndex;
      if (idx >= candles.candles5m.length || candles.candles5m[idx].timestamp !== timestamp) continue;
      const candle = candles.candles5m[idx];

      // Conservative ordering: check SL before TP within the same candle (never overstate wins).
      const slExtreme = open.side === 'LONG' ? candle.low : candle.high;
      const tpExtreme = open.side === 'LONG' ? candle.high : candle.low;
      if (isSlHitAtPrice(open.side, slExtreme, open.managed.currentSlPrice)) {
        onSlHit(open.managed);
        const closed = closeTrade(open, open.managed.currentSlPrice, candle.timestamp, 'SL', accountBalance);
        accountBalance = closed.accountBalanceAfter;
        closedTrades.push(closed);
        openTrades.delete(symbol);
      } else {
        const tp = open.managed.tpLevels.find((t) => t.label === 'COUNTER_TREND_TP');
        if (tp && tp.price !== null && isTpHit(open.side, tpExtreme, tp.price)) {
          onCounterTrendTpHit(open.managed);
          const closed = closeTrade(open, tp.price, candle.timestamp, 'TP', accountBalance);
          accountBalance = closed.accountBalanceAfter;
          closedTrades.push(closed);
          openTrades.delete(symbol);
        }
      }
    }

    // ---- 2. Look for new entries on symbols with no open position ----
    for (const symbol of ScalpConfig.SYMBOLS) {
      const candles = symbolCandles.get(symbol)!;
      const state = passState.get(symbol)!;
      const idx = state.nextIndex;
      if (idx >= candles.candles5m.length || candles.candles5m[idx].timestamp !== timestamp) continue;
      state.nextIndex = idx + 1; // consume this candle for this symbol regardless of outcome below

      if (openTrades.has(symbol)) continue; // one concurrent position per symbol

      const w5m = closedWindow(candles.candles5m, idx, FIVE_MIN_MS, timestamp, WINDOW_5M);
      const w15m = closedWindow(candles.candles15m, state.ptr15m, FIFTEEN_MIN_MS, timestamp, WINDOW_15M);
      const w1h = closedWindow(candles.candles1h, state.ptr1h, ONE_HOUR_MS, timestamp, WINDOW_1H);
      const w1m = closedWindow(candles.candles1m, state.ptr1m, ONE_MIN_MS, timestamp, WINDOW_1M);
      state.ptr15m = w15m.ptr;
      state.ptr1h = w1h.ptr;
      state.ptr1m = w1m.ptr;

      // Must be FULLY warmed up (window filled to its cap), not just "some" candles — detectRegime()
      // needs ATR_PCT_LOOKBACK_5M/BBW_PCT_LOOKBACK_15M (300) each fully populated (plus their own
      // ATR/BB period warmup), and 1h ADX(14) needs n >= period*2 (28); WINDOW_5M/15M/1H are sized
      // to cover that with margin, so requiring the window be full is the correct readiness gate.
      if (w5m.window.length < WINDOW_5M || w15m.window.length < WINDOW_15M || w1h.window.length < WINDOW_1H || w1m.window.length === 0) continue;

      // Raw computedMetrics only — same field production.ts's own orchestrator.ts already reuses
      // this way (classifyHtfContextCandidate/classifySafetyState5mCandidate off regimeOutput.computedMetrics),
      // never reads regimeOutput.regime (the OLD MarketRegime decision this ticket explicitly retires).
      const regimeOutput = detectRegime({ candles5m: w5m.window, candles15m: w15m.window, candles1h: w1h.window, previousRegime: null });
      const htfContext: HTFContext = classifyHtfContextCandidate(regimeOutput.computedMetrics);
      const safetyCandidate: SafetyState5m = classifySafetyState5mCandidate(regimeOutput.computedMetrics);
      const tracker = applySafetyState5mFinalStabilization(safetyCandidate, timestamp, state.safetyTracker ?? INITIAL_SAFETY_STATE_5M_TRACKER);
      state.safetyTracker = tracker;
      const safetyState5m: SafetyState5m = tracker.currentState;

      const setup: SweepReversalSetup | null = detectSweepReversalEntry(
        { symbol, candles15m: w15m.window, candles5m: w5m.window, candlesMss: w1m.window, htfContext, safetyState5m },
        minSlDistancePercent,
      );
      if (setup === null) continue;

      const actualRiskDollar = positionSize * (Math.abs(setup.entryPrice - setup.slPrice) / setup.entryPrice);
      const openRisks: OpenPositionRisk[] = Array.from(openTrades.values()).map((t) => ({ id: t.symbol, actualRiskDollar: t.actualRiskDollar }));
      if (wouldExceedRiskPool(openRisks, actualRiskDollar, accountBalance, DEFAULT_RISK_POOL_CONFIG)) continue;

      // openPosition() throws on invalid entry/SL geometry (e.g. slPrice on the wrong side of
      // entryPrice) — defensively skip a malformed historical setup instead of crashing the whole
      // 6-month replay over one edge case; count for the report so it's visible, not silently lost.
      let managed: ManagedPositionState;
      try {
        managed = openPosition({
          scenario: 'COUNTER_TREND',
          entryPrice: setup.entryPrice,
          slPrice: setup.slPrice,
          side: setup.side,
          tpPlan: 'PLAN_B', // ignored for COUNTER_TREND, required by the type
          positionSize,
          takerFeeRate: EXECUTION_COST_CONFIG.takerFeeRate,
          tpPriceOverride: setup.tpPriceOverride,
        });
      } catch (err) {
        skippedInvalidSetups++;
        continue;
      }

      openTrades.set(symbol, { symbol, side: setup.side, timeframe: setup.timeframe, entryTimestamp: setup.timestamp, managed, actualRiskDollar, marginRequired, sweptLevel: setup.sweptLevel, htfContext, safetyState5m });
    }
  }

  // ---- End of data: force-close anything still open, for reporting only (not a trading rule) ----
  for (const [symbol, open] of openTrades.entries()) {
    const candles = symbolCandles.get(symbol)!;
    const lastCandle = candles.candles5m[candles.candles5m.length - 1];
    const closed = closeTrade(open, lastCandle.close, lastCandle.timestamp, 'END_OF_DATA', accountBalance);
    accountBalance = closed.accountBalanceAfter;
    closedTrades.push(closed);
  }

  return { closedTrades, finalBalance: accountBalance, skippedInvalidSetups };
}

interface LevelSummary {
  label: string;
  minSlDistancePercent: number;
  trades: number;
  wins: number;
  winratePct: number;
  profitFactor: number;
  netPnl: number;
  finalBalance: number;
  skippedInvalidSetups: number;
}

function summarize(label: string, minSlDistancePercent: number, result: PassResult): LevelSummary {
  const wins = result.closedTrades.filter((t) => t.netPnlUsd > 0);
  const losses = result.closedTrades.filter((t) => t.netPnlUsd <= 0);
  const grossWin = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));
  return {
    label,
    minSlDistancePercent,
    trades: result.closedTrades.length,
    wins: wins.length,
    winratePct: result.closedTrades.length > 0 ? (wins.length / result.closedTrades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0,
    netPnl: result.closedTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
    finalBalance: result.finalBalance,
    skippedInvalidSetups: result.skippedInvalidSetups,
  };
}

interface SymbolSummary {
  symbol: string;
  trades: number;
  wins: number;
  winratePct: number;
  profitFactor: number;
  netPnl: number;
}

/** TICKET-SCALP-004 Việc 2 — same PF/winrate formula as summarize(), grouped by symbol instead of by level. */
function summarizeBySymbol(trades: ClosedTrade[]): SymbolSummary[] {
  return ScalpConfig.SYMBOLS.map((symbol) => {
    const symbolTrades = trades.filter((t) => t.symbol === symbol);
    const wins = symbolTrades.filter((t) => t.netPnlUsd > 0);
    const losses = symbolTrades.filter((t) => t.netPnlUsd <= 0);
    const grossWin = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));
    return {
      symbol,
      trades: symbolTrades.length,
      wins: wins.length,
      winratePct: symbolTrades.length > 0 ? (wins.length / symbolTrades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0,
      netPnl: symbolTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
    };
  });
}

function tradesCsv(trades: ClosedTrade[]): string {
  const header = [
    'symbol', 'side', 'timeframe', 'htfContextAtEntry', 'safetyState5mAtEntry',
    'entryTimestamp', 'entryPrice', 'slPrice', 'tpPrice', 'sweptLevel', 'slDistancePercent',
    'marginRequiredUsd', 'positionSizeUsd', 'actualRiskDollar',
    'exitTimestamp', 'exitPrice', 'exitReason', 'holdMinutes',
    'netPnlUsd', 'feeCost', 'accountBalanceAfter',
  ].join(',');
  const rows = trades.map((t) =>
    [
      t.symbol, t.side, t.timeframe, t.htfContext, t.safetyState5m,
      new Date(t.entryTimestamp).toISOString(), t.entryPrice, t.slPrice.toFixed(6), t.tpPrice.toFixed(6), t.sweptLevel, (t.slDistancePercent * 100).toFixed(3) + '%',
      t.marginRequired.toFixed(2), t.positionSize.toFixed(2), t.actualRiskDollar.toFixed(4),
      new Date(t.exitTimestamp).toISOString(), t.exitPrice, t.exitReason, t.holdMinutes,
      t.netPnlUsd.toFixed(4), t.feeCost.toFixed(4), t.accountBalanceAfter.toFixed(4),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  console.log(`TICKET-SCALP-004 backtest — data-dir=${DATA_DIR}, start-balance=${START_BALANCE}`);
  const symbolCandles = new Map<string, SymbolCandles>();
  for (const symbol of ScalpConfig.SYMBOLS) {
    if (!existsSync(path.join(DATA_DIR, `${symbol}_5m.csv`))) {
      throw new Error(`scalpBacktest: missing ${symbol}_5m.csv in ${DATA_DIR} — run fetch-ohlcv first.`);
    }
    symbolCandles.set(symbol, loadSymbolCandles(symbol));
    console.log(`  loaded ${symbol}: ${symbolCandles.get(symbol)!.candles5m.length} 5m candles`);
  }

  // Master clock: union of every symbol's 5m timestamps, ascending — shared across every sweep pass.
  const allTimestamps = new Set<number>();
  for (const data of symbolCandles.values()) for (const c of data.candles5m) allTimestamps.add(c.timestamp);
  const masterClock = Array.from(allTimestamps).sort((a, b) => a - b);

  mkdirSync(OUT_DIR, { recursive: true });
  const summaries: LevelSummary[] = [];
  let perSymbolBreakdown: SymbolSummary[] | null = null; // TICKET-SCALP-004 Việc 2
  for (const level of LEVELS_TO_SWEEP) {
    console.log(`\n=== sweep level: ${level.label} (minSlDistancePercent=${level.minSlDistancePercent}) ===`);
    const result = runBacktestPass(symbolCandles, masterClock, level.minSlDistancePercent);
    const summary = summarize(level.label, level.minSlDistancePercent, result);
    summaries.push(summary);
    console.log(`  trades=${summary.trades} winrate=${summary.winratePct.toFixed(1)}% PF=${summary.profitFactor.toFixed(2)} netPnl=${summary.netPnl.toFixed(2)} skipped=${summary.skippedInvalidSetups}`);

    const slug = level.label.replace(/[^a-z0-9.]+/gi, '-');
    writeFileSync(path.join(OUT_DIR, `scalp-backtest-trades-${slug}.csv`), tradesCsv(result.closedTrades));
    if (level.label === PER_SYMBOL_BREAKDOWN_LABEL) perSymbolBreakdown = summarizeBySymbol(result.closedTrades);
  }

  const lines = [
    '# TICKET-SCALP-004 — MIN_SL_DISTANCE_PERCENT sweep report (mở rộng từ TICKET-SCALP-003)',
    '',
    `Sinh tự động ${new Date().toISOString()} — data-dir=${DATA_DIR}, start-balance=${START_BALANCE}.`,
    'Margin cố định $' + ScalpConfig.MARGIN_USD + ' × leverage ' + ScalpConfig.LEVERAGE + 'x = positionSize $' + ScalpConfig.MARGIN_USD * ScalpConfig.LEVERAGE + ' mọi lệnh. TP = SL% thật × R_MULTIPLE(' + ScalpConfig.R_MULTIPLE + ').',
    '',
    '| Ngưỡng | Số lệnh | Winrate | Profit Factor | Net PNL ($) | Balance cuối ($) | Setup bị skip (hình học) |',
    '|---|---|---|---|---|---|---|',
    ...summaries.map(
      (s) =>
        `| ${s.label} | ${s.trades} | ${s.winratePct.toFixed(1)}% | ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} | ${s.netPnl >= 0 ? '+' : ''}${s.netPnl.toFixed(2)} | ${s.finalBalance.toFixed(2)} | ${s.skippedInvalidSetups} |`,
    ),
    '',
    `Breakeven winrate lý thuyết ở R_MULTIPLE=${ScalpConfig.R_MULTIPLE} là ${(100 / (ScalpConfig.R_MULTIPLE + 1)).toFixed(1)}% (bỏ qua phí) — mọi mức trên đây dùng chung R:R này, chỉ khác nhau ở việc có lọc SL% quá sát hay không.`,
    '',
    `## Breakdown theo symbol tại ngưỡng ${PER_SYMBOL_BREAKDOWN_LABEL}`,
    '',
    '| Symbol | Số lệnh | Winrate | Profit Factor | Net PNL ($) |',
    '|---|---|---|---|---|',
    ...(perSymbolBreakdown ?? []).map(
      (s) => `| ${s.symbol} | ${s.trades} | ${s.winratePct.toFixed(1)}% | ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} | ${s.netPnl >= 0 ? '+' : ''}${s.netPnl.toFixed(2)} |`,
    ),
    '',
    '## Giới hạn dữ liệu quan sát được (không phải kết luận, chỉ là ghi nhận)',
    '',
    '- HYPEUSDT: ticket TICKET-SCALP-001 đánh dấu "backtest engine realism audit riêng" cho coin này là NGOÀI phạm vi — số liệu HYPEUSDT CHƯA được audit độ thực tế (execution/liquidity model), không dùng để quyết định go-live.',
    '- executionCostEngine.ts chỉ mô hình hóa fee (0.04%/chiều) — slippage/spread/funding đều tắt theo đúng chỉ định ticket, không phải vì đã đo thực tế bằng 0.',
    '- Thoát lệnh dùng giá TP/SL chính xác (không mô phỏng trượt giá khi chạm), giả định lệnh limit/market khớp đúng mức — lạc quan hơn thực tế live.',
    '- File chi tiết từng lệnh theo TỪNG mức nằm ở data/scalp-backtest-trades-{ngưỡng}.csv.',
  ];
  writeFileSync(path.join(OUT_DIR, 'scalp-backtest-report.md'), lines.join('\n') + '\n');

  console.log('\n' + lines.join('\n'));
}

main().catch((err) => {
  console.error('scalpBacktest failed:', err);
  process.exit(1);
});
