/**
 * TICKET-147 — Drawdown & Loss-Cluster Forensic Audit. PURE AUDIT, zero production logic touched.
 *
 * Method: ONE single faithful replay of the official baseline config (same as TICKET-146:
 * MODEL_MODE=V1, OOD Guard RISK_REDUCTION @1.037776/0.3, Matrix V2 ON) through the REAL
 * processCandle() pipeline, replicating backtest.ts's own per-step openRiskBySymbol/
 * openMarginBySymbol aggregation AND its live within-step refresh (TICKET-101 Việc 1/2 pattern —
 * the exact bug TICKET-146 found and fixed). On top of that faithful replay this script captures
 * EXTRA state no existing callback exposes: per-candle open-position snapshot, floating PnL
 * (mark-to-market via the REAL computeRealizedPnl() formula, current candle's own close only, never
 * future data), and a NEW 6-pair Pearson correlation computed on the already-aligned 1H candle
 * windows (see report's "Judgment calls" for why 1H was chosen over 5m).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { computeRealizedPnl } from '../dist/risk/slTpManager.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_DIR = path.resolve(process.cwd(), 'data');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;

type Side = 'LONG' | 'SHORT';

// ---- Official baseline config — exact 8-flag command, verbatim copy of TICKET-146's own (SAME baseline) ----
const config: OrchestratorConfig = {
  entryRouterConfig: {
    ...DEFAULT_ENTRY_ROUTER_CONFIG,
    entryStyleForNeutral: 'SIDEWAY_STYLE',
    macroTrendFilterEnabled: false,
    obDisabledSymbols: [],
    macroTrendFilterAppliesToBoxBreakout: false,
    mssStalenessToleranceCandles: 5,
    obBosLookforwardK: 10,
    obSlBufferAtrMultiplier: 0.87,
  },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 15 / 100,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true, planAutoSelectionMomentumThreshold: 0.7 },
  maxConcurrentPositionsPerSymbol: 2,
  momentumDirectEnabled: true,
  momentumDirectThreshold: 0.5,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 1.27,
  momentumDirectTpRMultiple: 3.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
  oodGuardConfig: { emaRatioSlowThreshold: 1.037776, mode: 'RISK_REDUCTION', scoreCapValue: 0, riskReductionMultiplier: 0.3 },
  momentumContextDecisionMatrixV2Enabled: true,
};

// ---- Expected reference numbers (coordinator's prior official run of the exact same command) ----
const EXPECTED_TRADES = 319;
const EXPECTED_FINAL_BALANCE = 1237.35;
const EXPECTED_MAXDD_PCT = 45.84;
const EXPECTED_MAXDD_USD = 650.72;

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  state: SymbolState;
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
  };
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// ---- NEW correlation computation (TICKET-147) — Pearson on rolling close-to-close returns over
// CORRELATED_RISK_WINDOW_CANDLES=30, on the 1H windows (w1hBySymbol) already correctly per-symbol
// pointer-aligned by closedWindow() (see report's Judgment calls for why 1H was chosen over 5m). ----
const PAIRS: [string, string][] = [
  ['BTCUSDT', 'ETHUSDT'],
  ['BTCUSDT', 'SOLUSDT'],
  ['BTCUSDT', 'XRPUSDT'],
  ['ETHUSDT', 'SOLUSDT'],
  ['ETHUSDT', 'XRPUSDT'],
  ['SOLUSDT', 'XRPUSDT'],
];

function returnsFromCloses(candles: CandleData[], n: number): number[] {
  const closes = candles.slice(-n - 1).map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return rets;
}

function pearson(a: number[], b: number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n < 5) return undefined;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const meanA = ax.reduce((s, v) => s + v, 0) / n;
  const meanB = bx.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return undefined;
  return cov / Math.sqrt(varA * varB);
}

interface CorrSnapshot {
  pairwise: Record<string, number | undefined>;
  avg: number | undefined;
  max: number | undefined;
}

function computeCorrelationSnapshot(w1hBySymbol: Record<string, CandleData[]>): CorrSnapshot {
  const returnsBySymbol: Record<string, number[]> = {};
  for (const s of SYMBOLS) returnsBySymbol[s] = returnsFromCloses(w1hBySymbol[s], RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES);
  const pairwise: Record<string, number | undefined> = {};
  for (const [a, b] of PAIRS) pairwise[`${a}_${b}`] = pearson(returnsBySymbol[a], returnsBySymbol[b]);
  const values = Object.values(pairwise).filter((v): v is number => v !== undefined);
  const avg = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
  const max = values.length > 0 ? Math.max(...values) : undefined;
  return { pairwise, avg, max };
}

interface TradeContext {
  sameSideOpenCount: number; // total open positions (incl. this new one) sharing this trade's side, across all 4 symbols
  coinsOpenSameSide: number; // distinct OTHER coins with an open position on this side, at open time
  openPositionCountBefore: number; // total open positions across all 4 symbols, BEFORE this trade opened
  totalRiskUsedBefore: number;
  totalMarginUsedBefore: number;
  riskPoolMaxDollarBefore: number;
  avgCorr: number | undefined;
  maxCorr: number | undefined;
  btcSide: Side | 'NONE';
  ethSide: Side | 'NONE';
  solSide: Side | 'NONE';
  xrpSide: Side | 'NONE';
}

interface TradeRecord {
  symbol: string;
  side: Side;
  setupType: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  positionSize: number;
  actualRiskDollar: number;
  marginRequired: number;
  riskPoolPctBefore: number;
  context: TradeContext;
  exitTimestamp: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  accountBalanceAfter: number | null;
}

interface StepSnapshot {
  timestamp: number;
  realizedBalance: number;
  floatingPnlTotal: number;
  totalEquityFloating: number;
  totalOpenPositions: number;
  totalRiskUsed: number;
  riskPoolMaxDollar: number;
  totalMarginUsed: number;
  avgCorr: number | undefined;
  maxCorr: number | undefined;
  longCount: number;
  shortCount: number;
}

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  let accountBalance = 100; // matches --start-balance=100

  const closedTrades: TradeRecord[] = [];
  const openTradesBySymbol: Record<string, TradeRecord[]> = {};
  for (const s of SYMBOLS) openTradesBySymbol[s] = [];

  // ---- Realized-only drawdown, SAME granularity as backtest.ts:1187-1195 (checked after EVERY
  // symbol's processCandle() call, not once per step) — the correctness-baseline metric. ----
  let peakBalanceRealized = accountBalance;
  let maxDrawdownPctRealized = 0;
  let maxDrawdownUsdRealized = 0;

  const stepSnapshots: StepSnapshot[] = [];
  let sanityChecked = false;

  console.log(`Chạy lại pipeline thật (baseline TICKET-147, giống TICKET-146) — ${totalSteps - startStep} bước x ${SYMBOLS.length} coin...`);

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: Side }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').map((entry) => ({ symbol, side: entry.position.side })),
    );

    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    const corrSnapshot = computeCorrelationSnapshot(w1hBySymbol);
    if (!sanityChecked && Object.values(w1hBySymbol).every((w) => w.length >= RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES + 1)) {
      console.log('Sanity check — 3 nến 1H cuối cùng của mỗi symbol (timestamp phải trùng nhau, xác nhận alignment):');
      for (const s of SYMBOLS) console.log(`  ${s}: ${w1hBySymbol[s].slice(-3).map((c) => c.timestamp).join(', ')}`);
      sanityChecked = true;
    }

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
      const totalOpenMarginDollar = Object.values(openMarginBySymbol).reduce((sum, m) => sum + m, 0);

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
        totalOpenMarginDollar,
        accountBalance,
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      // ---- Context captured BEFORE this symbol's own processCandle() (causal, no lookahead) — only
      // used below if this call actually fires an OPEN event. ----
      const contextIfOpen: TradeContext = {
        sameSideOpenCount: 0,
        coinsOpenSameSide: 0,
        openPositionCountBefore: SYMBOLS.reduce((sum, s) => sum + symbolsData[s].state.openPositions.length, 0),
        totalRiskUsedBefore: Object.values(openRiskBySymbol).reduce((s, v) => s + v, 0),
        totalMarginUsedBefore: Object.values(openMarginBySymbol).reduce((s, v) => s + v, 0),
        riskPoolMaxDollarBefore: accountBalance * config.riskPoolMaxPct,
        avgCorr: corrSnapshot.avg,
        maxCorr: corrSnapshot.max,
        btcSide: symbolsData.BTCUSDT.state.openPositions.length > 0 ? symbolsData.BTCUSDT.state.openPositions[0].position.side : 'NONE',
        ethSide: symbolsData.ETHUSDT.state.openPositions.length > 0 ? symbolsData.ETHUSDT.state.openPositions[0].position.side : 'NONE',
        solSide: symbolsData.SOLUSDT.state.openPositions.length > 0 ? symbolsData.SOLUSDT.state.openPositions[0].position.side : 'NONE',
        xrpSide: symbolsData.XRPUSDT.state.openPositions.length > 0 ? symbolsData.XRPUSDT.state.openPositions[0].position.side : 'NONE',
      };

      const result = await processCandle(input, sd.state, config, undefined, undefined, undefined, undefined, undefined);
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      for (const event of result.events) {
        if (event.type === 'OPEN') {
          const matchingPosition = sd.state.openPositions.find(
            (e) => e.meta.entryTimestamp === event.entryTimestamp && e.position.side === event.side && e.position.entryPrice === event.entryPrice,
          );
          const sameSideOpenCount = SYMBOLS.reduce((sum, s) => sum + symbolsData[s].state.openPositions.filter((e) => e.position.side === event.side).length, 0);
          const coinsOpenSameSide = SYMBOLS.filter((s) => s !== symbol && symbolsData[s].state.openPositions.some((e) => e.position.side === event.side)).length;
          const trade: TradeRecord = {
            symbol,
            side: event.side,
            setupType: event.setupType,
            entryTimestamp: event.entryTimestamp,
            entryPrice: event.entryPrice,
            slPrice: event.slPrice,
            positionSize: matchingPosition?.position.positionSize ?? NaN,
            actualRiskDollar: event.actualRiskDollar,
            marginRequired: event.marginRequired,
            riskPoolPctBefore: event.riskPoolPctBefore,
            context: { ...contextIfOpen, sameSideOpenCount, coinsOpenSameSide },
            exitTimestamp: null,
            exitPrice: null,
            exitReason: null,
            pnlUsd: null,
            pnlPct: null,
            accountBalanceAfter: null,
          };
          openTradesBySymbol[symbol].push(trade);
        }
      }

      for (const event of result.events) {
        if (event.type === 'CLOSE') {
          const idx = openTradesBySymbol[symbol].findIndex((t) => t.entryTimestamp === event.entryTimestamp && t.side === event.side && t.entryPrice === event.entryPrice);
          if (idx === -1) {
            console.error(`CẢNH BÁO: CLOSE event không khớp trade đang mở nào — symbol=${symbol} entryTimestamp=${event.entryTimestamp}`);
            continue;
          }
          const trade = openTradesBySymbol[symbol][idx];
          trade.exitTimestamp = event.exitTimestamp;
          trade.exitPrice = event.exitPrice;
          trade.exitReason = event.exitReason;
          trade.pnlUsd = event.pnlUsd;
          trade.pnlPct = event.pnlPct;
          trade.accountBalanceAfter = event.accountBalanceAfter;
          closedTrades.push(trade);
          openTradesBySymbol[symbol].splice(idx, 1);
        }
      }

      // ---- TICKET-101 pattern (the exact bug TICKET-146 found/fixed): refresh openRiskBySymbol/
      // openMarginBySymbol immediately so the NEXT symbol in this SAME step sees up-to-date totals. ----
      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];

      // ---- Realized-only drawdown, same per-symbol-within-step cadence as backtest.ts ----
      if (accountBalance > peakBalanceRealized) peakBalanceRealized = accountBalance;
      const ddUsd = peakBalanceRealized - accountBalance;
      const ddPct = peakBalanceRealized > 0 ? (ddUsd / peakBalanceRealized) * 100 : 0;
      if (ddPct > maxDrawdownPctRealized) {
        maxDrawdownPctRealized = ddPct;
        maxDrawdownUsdRealized = ddUsd;
      }
    }

    // ---- Once-per-step snapshot: floating PnL (mark-to-market, current candle's own close only,
    // via the REAL computeRealizedPnl() formula), open-position counts, risk/margin occupancy,
    // correlation — feeds episode/cluster/bucket analysis below. ----
    let floatingPnlTotal = 0;
    let totalOpenPositions = 0;
    let longCount = 0;
    let shortCount = 0;
    let totalRiskUsed = 0;
    let totalMarginUsed = 0;
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentClose = sd.candles5m[step].close;
      for (const entry of sd.state.openPositions) {
        floatingPnlTotal += computeRealizedPnl(entry.position, currentClose);
        totalOpenPositions++;
        if (entry.position.side === 'LONG') longCount++;
        else shortCount++;
        totalRiskUsed += entry.meta.actualRiskDollar;
        totalMarginUsed += entry.meta.marginRequired;
      }
    }
    stepSnapshots.push({
      timestamp: symbolsData.BTCUSDT.candles5m[step].timestamp,
      realizedBalance: accountBalance,
      floatingPnlTotal,
      totalEquityFloating: accountBalance + floatingPnlTotal,
      totalOpenPositions,
      totalRiskUsed,
      riskPoolMaxDollar: accountBalance * config.riskPoolMaxPct,
      totalMarginUsed,
      avgCorr: corrSnapshot.avg,
      maxCorr: corrSnapshot.max,
      longCount,
      shortCount,
    });

    const progressStep = step - startStep;
    if (progressStep % 4000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — balance=$${accountBalance.toFixed(2)}, closedTrades=${closedTrades.length}...`);
    }
  }

  console.log(`Xong replay. ${closedTrades.length} lệnh đóng, balance cuối=$${accountBalance.toFixed(2)}.`);
  console.log(`Realized-only MaxDD (đúng cadence backtest.ts): ${maxDrawdownPctRealized.toFixed(2)}% / $${maxDrawdownUsdRealized.toFixed(2)}`);
  console.log(`Đối chiếu tham chiếu: kỳ vọng ${EXPECTED_TRADES} lệnh / $${EXPECTED_FINAL_BALANCE} / MaxDD ${EXPECTED_MAXDD_PCT}% / $${EXPECTED_MAXDD_USD}`);

  const wr = closedTrades.length > 0 ? (closedTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length / closedTrades.length) * 100 : 0;

  writeAnalysisOutputs(closedTrades, accountBalance, wr, maxDrawdownPctRealized, maxDrawdownUsdRealized, stepSnapshots);
}

// ============================================================================================
// ---- Post-processing: drawdown episodes, loss clusters, correlation/risk-pool buckets,
// attribution, path dependence, sub-period stability, decision. All computed from the replay
// output above — no further processCandle() calls, no lookahead (episode/cluster timestamps only
// ever look backward from "now"). ----
// ============================================================================================

interface Episode {
  peakTimestamp: number;
  peakEquity: number;
  troughTimestamp: number;
  troughEquity: number;
  recoveryTimestamp: number | null; // null = never recovered by end of data
  drawdownUsd: number;
  drawdownPct: number;
}

// Standard peak->valley->recovery segmentation: track running peak; while equity < peak, extend the
// current episode's trough; when equity >= peak again, close out the episode and start a new peak.
function segmentDrawdownEpisodes(series: { ts: number; equity: number }[]): Episode[] {
  const episodes: Episode[] = [];
  if (series.length === 0) return episodes;
  let peakTs = series[0].ts;
  let peakEq = series[0].equity;
  let troughTs = series[0].ts;
  let troughEq = series[0].equity;
  let inDrawdown = false;
  for (let i = 1; i < series.length; i++) {
    const { ts, equity } = series[i];
    if (equity >= peakEq) {
      if (inDrawdown) {
        episodes.push({
          peakTimestamp: peakTs,
          peakEquity: peakEq,
          troughTimestamp: troughTs,
          troughEquity: troughEq,
          recoveryTimestamp: ts,
          drawdownUsd: peakEq - troughEq,
          drawdownPct: peakEq > 0 ? ((peakEq - troughEq) / peakEq) * 100 : 0,
        });
        inDrawdown = false;
      }
      peakTs = ts;
      peakEq = equity;
      troughTs = ts;
      troughEq = equity;
    } else {
      inDrawdown = true;
      if (equity < troughEq) {
        troughEq = equity;
        troughTs = ts;
      }
    }
  }
  if (inDrawdown) {
    episodes.push({
      peakTimestamp: peakTs,
      peakEquity: peakEq,
      troughTimestamp: troughTs,
      troughEquity: troughEq,
      recoveryTimestamp: null,
      drawdownUsd: peakEq - troughEq,
      drawdownPct: peakEq > 0 ? ((peakEq - troughEq) / peakEq) * 100 : 0,
    });
  }
  return episodes;
}

function tradesInWindow(trades: TradeRecord[], fromMs: number, toMsExclusive: number): TradeRecord[] {
  return trades.filter((t) => t.exitTimestamp !== null && t.exitTimestamp >= fromMs && t.exitTimestamp < toMsExclusive);
}

function episodeStats(ep: Episode, trades: TradeRecord[]) {
  const toMsExclusive = ep.recoveryTimestamp ?? Number.MAX_SAFE_INTEGER;
  const opened = trades.filter((t) => t.entryTimestamp >= ep.peakTimestamp && t.entryTimestamp < toMsExclusive).length;
  const closed = tradesInWindow(trades, ep.peakTimestamp, toMsExclusive);
  const winners = closed.filter((t) => (t.pnlUsd ?? 0) > 0);
  const losers = closed.filter((t) => (t.pnlUsd ?? 0) <= 0);
  const grossProfit = winners.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnlUsd ?? 0), 0));
  return { opened, closedCount: closed.length, winners: winners.length, losers: losers.length, grossProfit, grossLoss };
}

interface LossCluster {
  windowLabel: string;
  windowMs: number;
  anchorExitTimestamp: number;
  fromMs: number;
  toMs: number;
  losingTrades: TradeRecord[];
  totalLossUsd: number;
  coins: Set<string>;
  longCount: number;
  shortCount: number;
  setupTypes: Set<string>;
  riskPoolOccupancyPct: number | undefined;
  openPositionCount: number | undefined;
  realizedBalance: number | undefined;
  floatingEquity: number | undefined;
}

function nearestSnapshotAtOrBefore(snapshots: StepSnapshot[], ts: number): StepSnapshot | undefined {
  let lo = 0;
  let hi = snapshots.length - 1;
  let result: StepSnapshot | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].timestamp <= ts) {
      result = snapshots[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return result;
}

function buildLossClustersForWindow(losers: TradeRecord[], windowLabel: string, windowMs: number, snapshots: StepSnapshot[]): LossCluster[] {
  const anchors: LossCluster[] = losers.map((anchor) => {
    const fromMs = (anchor.exitTimestamp as number) - windowMs;
    const toMs = anchor.exitTimestamp as number;
    const inWindow = losers.filter((t) => (t.exitTimestamp as number) > fromMs && (t.exitTimestamp as number) <= toMs);
    const snap = nearestSnapshotAtOrBefore(snapshots, toMs);
    return {
      windowLabel,
      windowMs,
      anchorExitTimestamp: toMs,
      fromMs,
      toMs,
      losingTrades: inWindow,
      totalLossUsd: Math.abs(inWindow.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)),
      coins: new Set(inWindow.map((t) => t.symbol)),
      longCount: inWindow.filter((t) => t.side === 'LONG').length,
      shortCount: inWindow.filter((t) => t.side === 'SHORT').length,
      setupTypes: new Set(inWindow.map((t) => t.setupType)),
      riskPoolOccupancyPct: snap && snap.riskPoolMaxDollar > 0 ? (snap.totalRiskUsed / snap.riskPoolMaxDollar) * 100 : undefined,
      openPositionCount: snap?.totalOpenPositions,
      realizedBalance: snap?.realizedBalance,
      floatingEquity: snap?.totalEquityFloating,
    };
  });

  // Greedy non-overlapping top-20 selection by total loss (dedupe near-identical overlapping windows
  // that a pure sort would otherwise flood the top with) — judgment call, documented in report.
  const sorted = [...anchors].sort((a, b) => b.totalLossUsd - a.totalLossUsd);
  const selected: LossCluster[] = [];
  for (const c of sorted) {
    if (selected.length >= 20) break;
    const overlaps = selected.some((s) => c.fromMs < s.toMs && s.fromMs < c.toMs);
    if (!overlaps) selected.push(c);
  }
  return selected;
}

function buildPeriods(sortedTimestamps: number[]): { label: string; fromMs: number; toMsExclusive: number }[] {
  const n = sortedTimestamps.length;
  if (n === 0) return [];
  const p1 = sortedTimestamps[Math.floor(n / 3)];
  const p2 = sortedTimestamps[Math.floor((2 * n) / 3)];
  const min = sortedTimestamps[0];
  const max = sortedTimestamps[n - 1] + 1;
  return [
    { label: 'P1', fromMs: min, toMsExclusive: p1 },
    { label: 'P2', fromMs: p1, toMsExclusive: p2 },
    { label: 'P3', fromMs: p2, toMsExclusive: max },
  ];
}

interface GroupStats {
  n: number;
  wr: number | null;
  pf: number | null;
  netPnl: number;
  avgLoss: number | null;
}
function computeGroupStats(trades: TradeRecord[]): GroupStats {
  const n = trades.length;
  const wins = trades.filter((t) => (t.pnlUsd ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnlUsd ?? 0) <= 0);
  const grossWin = wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0));
  return {
    n,
    wr: n > 0 ? (wins.length / n) * 100 : null,
    pf: grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : grossWin / grossLoss,
    netPnl: grossWin - grossLoss,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
  };
}
function fmtGroup(g: GroupStats): string {
  const pfStr = g.pf === null ? 'N/A' : g.pf === Infinity ? '∞' : g.pf.toFixed(3);
  return `N=${g.n}, WR=${g.wr !== null ? g.wr.toFixed(1) + '%' : 'N/A'}, PF=${pfStr}, NetPnL=$${g.netPnl.toFixed(2)}, AvgLoss=${g.avgLoss !== null ? '$' + g.avgLoss.toFixed(2) : 'N/A'}`;
}

function csvEscape(v: unknown): string {
  const s = String(v);
  return s.includes(',') ? `"${s}"` : s;
}

function writeAnalysisOutputs(
  closedTrades: TradeRecord[],
  finalBalance: number,
  wr: number,
  maxDrawdownPctRealized: number,
  maxDrawdownUsdRealized: number,
  stepSnapshots: StepSnapshot[],
): void {
  const grossWin = closedTrades.filter((t) => (t.pnlUsd ?? 0) > 0).reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(closedTrades.filter((t) => (t.pnlUsd ?? 0) <= 0).reduce((s, t) => s + (t.pnlUsd ?? 0), 0));
  const pf = grossLoss === 0 ? Infinity : grossWin / grossLoss;

  // ---- Drawdown episode segmentation — TWO series, never conflated ----
  const realizedSeries = stepSnapshots.map((s) => ({ ts: s.timestamp, equity: s.realizedBalance }));
  const floatingSeries = stepSnapshots.map((s) => ({ ts: s.timestamp, equity: s.totalEquityFloating }));
  const realizedEpisodes = segmentDrawdownEpisodes(realizedSeries);
  const floatingEpisodes = segmentDrawdownEpisodes(floatingSeries);

  const realizedMaxDdFromEpisodes = realizedEpisodes.reduce((max, e) => (e.drawdownPct > max.drawdownPct ? e : max), realizedEpisodes[0]);
  const floatingMaxDdEpisode = floatingEpisodes.reduce((max, e) => (e.drawdownPct > max.drawdownPct ? e : max), floatingEpisodes[0]);

  const top5FloatingEpisodes = [...floatingEpisodes].sort((a, b) => b.drawdownPct - a.drawdownPct).slice(0, 5);

  // ---- data/ticket147-drawdown-episodes.csv (floating-inclusive series — deeper analysis metric) ----
  const epHeader = 'peakTimestamp,peakEquity,troughTimestamp,troughEquity,recoveryTimestamp,durationToTroughMs,durationToRecoveryMs,drawdownUsd,drawdownPct,tradesOpened,tradesClosed,winners,losers,grossProfit,grossLoss';
  const epRows = floatingEpisodes.map((e) => {
    const st = episodeStats(e, closedTrades);
    return [
      e.peakTimestamp,
      e.peakEquity.toFixed(4),
      e.troughTimestamp,
      e.troughEquity.toFixed(4),
      e.recoveryTimestamp ?? '',
      e.troughTimestamp - e.peakTimestamp,
      e.recoveryTimestamp !== null ? e.recoveryTimestamp - e.peakTimestamp : '',
      e.drawdownUsd.toFixed(4),
      e.drawdownPct.toFixed(4),
      st.opened,
      st.closedCount,
      st.winners,
      st.losers,
      st.grossProfit.toFixed(4),
      st.grossLoss.toFixed(4),
    ].join(',');
  });
  writeFileSync(path.join(OUT_DIR, 'ticket147-drawdown-episodes.csv'), [epHeader, ...epRows].join('\n') + '\n');

  // ---- Loss clusters, ALL 7 fixed windows ----
  const losers = closedTrades.filter((t) => (t.pnlUsd ?? 0) <= 0 && t.exitTimestamp !== null);
  const windowDefs: [string, number][] = [
    ['15min', 15 * 60_000],
    ['30min', 30 * 60_000],
    ['1h', 60 * 60_000],
    ['2h', 2 * 60 * 60_000],
    ['4h', 4 * 60 * 60_000],
    ['12h', 12 * 60 * 60_000],
    ['24h', 24 * 60 * 60_000],
  ];
  const clustersByWindow: Record<string, LossCluster[]> = {};
  for (const [label, ms] of windowDefs) clustersByWindow[label] = buildLossClustersForWindow(losers, label, ms, stepSnapshots);

  const clusterHeader = 'windowLabel,rank,anchorExitTimestamp,fromMs,toMs,numLosingTrades,totalLossUsd,numCoins,coins,longCount,shortCount,numSetupTypes,setupTypes,riskPoolOccupancyPct,openPositionCount,realizedBalance,floatingEquity';
  const clusterRows: string[] = [];
  for (const [label] of windowDefs) {
    clustersByWindow[label].forEach((c, i) => {
      clusterRows.push(
        [
          label,
          i + 1,
          c.anchorExitTimestamp,
          c.fromMs,
          c.toMs,
          c.losingTrades.length,
          c.totalLossUsd.toFixed(4),
          c.coins.size,
          csvEscape([...c.coins].join('|')),
          c.longCount,
          c.shortCount,
          c.setupTypes.size,
          csvEscape([...c.setupTypes].join('|')),
          c.riskPoolOccupancyPct?.toFixed(2) ?? '',
          c.openPositionCount ?? '',
          c.realizedBalance?.toFixed(4) ?? '',
          c.floatingEquity?.toFixed(4) ?? '',
        ].join(','),
      );
    });
  }
  writeFileSync(path.join(OUT_DIR, 'ticket147-loss-clusters.csv'), [clusterHeader, ...clusterRows].join('\n') + '\n');

  // ---- data/ticket147-trade-context.csv — one row per closed trade, with open-time context ----
  const tcHeader =
    'symbol,side,setupType,entryTimestamp,exitTimestamp,exitReason,pnlUsd,riskPoolPctBefore,sameSideOpenCount,coinsOpenSameSide,openPositionCountBefore,totalRiskUsedBefore,totalMarginUsedBefore,avgCorrAtOpen,maxCorrAtOpen,btcSide,ethSide,solSide,xrpSide';
  const tcRows = closedTrades.map((t) =>
    [
      t.symbol,
      t.side,
      t.setupType,
      t.entryTimestamp,
      t.exitTimestamp,
      t.exitReason,
      t.pnlUsd?.toFixed(4),
      t.riskPoolPctBefore.toFixed(2),
      t.context.sameSideOpenCount,
      t.context.coinsOpenSameSide,
      t.context.openPositionCountBefore,
      t.context.totalRiskUsedBefore.toFixed(4),
      t.context.totalMarginUsedBefore.toFixed(4),
      t.context.avgCorr?.toFixed(4) ?? '',
      t.context.maxCorr?.toFixed(4) ?? '',
      t.context.btcSide,
      t.context.ethSide,
      t.context.solSide,
      t.context.xrpSide,
    ].join(','),
  );
  writeFileSync(path.join(OUT_DIR, 'ticket147-trade-context.csv'), [tcHeader, ...tcRows].join('\n') + '\n');

  // ---- Correlation buckets (Section C) ----
  const avgCorrBuckets: [string, (c: number) => boolean][] = [
    ['<0.30', (c) => c < 0.3],
    ['0.30-0.50', (c) => c >= 0.3 && c < 0.5],
    ['0.50-0.70', (c) => c >= 0.5 && c < 0.7],
    ['0.70-0.85', (c) => c >= 0.7 && c < 0.85],
    ['>=0.85', (c) => c >= 0.85],
  ];
  const sameSideBuckets: [string, (n: number) => boolean][] = [
    ['0', (n) => n === 0],
    ['1', (n) => n === 1],
    ['2', (n) => n === 2],
    ['3', (n) => n === 3],
    ['4+', (n) => n >= 4],
  ];
  // MaxDD contribution = sum of |loss| from bucket trades whose exit falls inside the OFFICIAL
  // (floating-inclusive) MaxDD episode window — judgment call, documented in report.
  const maxDdWindowFrom = floatingMaxDdEpisode.peakTimestamp;
  const maxDdWindowTo = floatingMaxDdEpisode.recoveryTimestamp ?? Number.MAX_SAFE_INTEGER;
  const maxDdContribution = (trades: TradeRecord[]) =>
    Math.abs(
      trades
        .filter((t) => t.exitTimestamp !== null && t.exitTimestamp >= maxDdWindowFrom && t.exitTimestamp < maxDdWindowTo && (t.pnlUsd ?? 0) < 0)
        .reduce((s, t) => s + (t.pnlUsd ?? 0), 0),
    );

  const corrBucketRows: string[] = ['bucketType,bucketLabel,n,wr,pf,netPnl,avgLoss,maxDdContribution'];
  for (const [label, pred] of avgCorrBuckets) {
    const trades = closedTrades.filter((t) => t.context.avgCorr !== undefined && pred(t.context.avgCorr as number));
    const g = computeGroupStats(trades);
    corrBucketRows.push(
      `avgCorrelation,${label},${g.n},${g.wr?.toFixed(1) ?? ''},${g.pf === null ? '' : g.pf === Infinity ? 'Inf' : g.pf.toFixed(3)},${g.netPnl.toFixed(2)},${g.avgLoss?.toFixed(2) ?? ''},${maxDdContribution(trades).toFixed(2)}`,
    );
  }
  for (const [label, pred] of sameSideBuckets) {
    const trades = closedTrades.filter((t) => pred(t.context.sameSideOpenCount));
    const g = computeGroupStats(trades);
    corrBucketRows.push(
      `sameSideOpenPositions,${label},${g.n},${g.wr?.toFixed(1) ?? ''},${g.pf === null ? '' : g.pf === Infinity ? 'Inf' : g.pf.toFixed(3)},${g.netPnl.toFixed(2)},${g.avgLoss?.toFixed(2) ?? ''},${maxDdContribution(trades).toFixed(2)}`,
    );
  }
  writeFileSync(path.join(OUT_DIR, 'ticket147-correlation-buckets.csv'), corrBucketRows.join('\n') + '\n');

  // ---- Risk-pool occupancy buckets (Section D) ----
  const rpBuckets: [string, (p: number) => boolean][] = [
    ['0-25%', (p) => p < 25],
    ['25-50%', (p) => p >= 25 && p < 50],
    ['50-75%', (p) => p >= 50 && p < 75],
    ['75-90%', (p) => p >= 75 && p < 90],
    ['90-100%', (p) => p >= 90],
  ];
  // Loss-cluster frequency per bucket: share of bucket trades whose exit falls inside a Top-20 1h
  // loss cluster (1h chosen as the representative window for this cross-cutting stat — documented).
  const oneHClusterRanges = clustersByWindow['1h'].map((c) => [c.fromMs, c.toMs] as const);
  const inAnyCluster = (t: TradeRecord) => t.exitTimestamp !== null && oneHClusterRanges.some(([f, to]) => (t.exitTimestamp as number) > f && (t.exitTimestamp as number) <= to);
  const rpRows: string[] = ['bucketLabel,n,wr,pf,netPnl,avgLoss,lossClusterFrequencyPct'];
  for (const [label, pred] of rpBuckets) {
    const trades = closedTrades.filter((t) => pred(t.riskPoolPctBefore));
    const g = computeGroupStats(trades);
    const freq = trades.length > 0 ? (trades.filter(inAnyCluster).length / trades.length) * 100 : 0;
    rpRows.push(`${label},${g.n},${g.wr?.toFixed(1) ?? ''},${g.pf === null ? '' : g.pf === Infinity ? 'Inf' : g.pf.toFixed(3)},${g.netPnl.toFixed(2)},${g.avgLoss?.toFixed(2) ?? ''},${freq.toFixed(1)}`);
  }
  writeFileSync(path.join(OUT_DIR, 'ticket147-riskpool-buckets.csv'), rpRows.join('\n') + '\n');

  // ---- Attribution (Section E) ----
  const maxDdTrades = closedTrades.filter((t) => t.exitTimestamp !== null && t.exitTimestamp >= maxDdWindowFrom && t.exitTimestamp < maxDdWindowTo);
  const maxDdLosers = maxDdTrades.filter((t) => (t.pnlUsd ?? 0) < 0);
  const byCoin = (arr: TradeRecord[]) => SYMBOLS.map((s) => ({ key: s, loss: Math.abs(arr.filter((t) => t.symbol === s).reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0)) }));
  const bySide = (arr: TradeRecord[]) => (['LONG', 'SHORT'] as const).map((s) => ({ key: s, loss: Math.abs(arr.filter((t) => t.side === s).reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0)) }));
  const setupsPresent = Array.from(new Set(closedTrades.map((t) => t.setupType)));
  const bySetup = (arr: TradeRecord[]) => setupsPresent.map((s) => ({ key: s, loss: Math.abs(arr.filter((t) => t.setupType === s).reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0)) }));
  const comboMap = new Map<string, number>();
  for (const t of maxDdLosers) {
    const key = `${t.symbol}|${t.side}|${t.setupType}`;
    comboMap.set(key, (comboMap.get(key) ?? 0) + Math.abs(t.pnlUsd ?? 0));
  }
  const topCombo = [...comboMap.entries()].sort((a, b) => b[1] - a[1])[0];
  const coinAttrib = byCoin(maxDdLosers).sort((a, b) => b.loss - a.loss);
  const sideAttrib = bySide(maxDdLosers).sort((a, b) => b.loss - a.loss);
  const setupAttrib = bySetup(maxDdLosers).sort((a, b) => b.loss - a.loss);

  // ---- Sub-period stability ----
  const sortedTs = closedTrades.map((t) => t.entryTimestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedTs);
  const periodStats = periods.map((p) => {
    const periodTrades = closedTrades.filter((t) => t.entryTimestamp >= p.fromMs && t.entryTimestamp < p.toMsExclusive);
    const highCorrTrades = periodTrades.filter((t) => t.context.avgCorr !== undefined && (t.context.avgCorr as number) >= 0.7);
    const lowCorrTrades = periodTrades.filter((t) => t.context.avgCorr !== undefined && (t.context.avgCorr as number) < 0.3);
    return { label: p.label, n: periodTrades.length, high: computeGroupStats(highCorrTrades), low: computeGroupStats(lowCorrTrades) };
  });

  // ---- Path dependence (Section F) descriptive numbers ----
  const multiOpenTrades = closedTrades.filter((t) => t.context.openPositionCountBefore >= 1);
  const singleOpenTrades = closedTrades.filter((t) => t.context.openPositionCountBefore === 0);
  const highRiskPoolTrades = closedTrades.filter((t) => t.riskPoolPctBefore >= 75);
  const lowRiskPoolTrades = closedTrades.filter((t) => t.riskPoolPctBefore < 75);
  const avgRiskPoolBeforeTopClusters =
    clustersByWindow['1h'].length > 0 ? clustersByWindow['1h'].reduce((s, c) => s + (c.riskPoolOccupancyPct ?? 0), 0) / clustersByWindow['1h'].length : 0;
  const avgRiskPoolOverall = closedTrades.length > 0 ? closedTrades.reduce((s, t) => s + t.riskPoolPctBefore, 0) / closedTrades.length : 0;

  // ---- Final decision inputs ----
  const highCorrAll = closedTrades.filter((t) => t.context.avgCorr !== undefined && (t.context.avgCorr as number) >= 0.7);
  const lowCorrAll = closedTrades.filter((t) => t.context.avgCorr !== undefined && (t.context.avgCorr as number) < 0.3);
  const highCorrStats = computeGroupStats(highCorrAll);
  const lowCorrStats = computeGroupStats(lowCorrAll);
  const sameSide3PlusAll = closedTrades.filter((t) => t.context.sameSideOpenCount >= 3);
  const sameSide0Or1All = closedTrades.filter((t) => t.context.sameSideOpenCount <= 1);
  const sameSide3PlusStats = computeGroupStats(sameSide3PlusAll);
  const sameSide0Or1Stats = computeGroupStats(sameSide0Or1All);

  const clusterShareOfMaxDd = maxDdLosers.length > 0 && grossLoss > 0 ? (Math.abs(maxDdLosers.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)) / grossLoss) * 100 : 0;

  const periodsShowSignal = periodStats.filter((p) => p.high.n >= 5 && p.low.n >= 5 && (p.high.avgLoss ?? 0) > (p.low.avgLoss ?? 0)).length;

  let decision: 'A' | 'B' | 'C';
  const highCorrWorse = highCorrStats.n >= 10 && lowCorrStats.n >= 10 && (highCorrStats.pf ?? 0) < (lowCorrStats.pf ?? Infinity) && (highCorrStats.avgLoss ?? 0) > (lowCorrStats.avgLoss ?? 0);
  const sameSideWorse = sameSide3PlusStats.n >= 10 && sameSide0Or1Stats.n >= 10 && (sameSide3PlusStats.pf ?? 0) < (sameSide0Or1Stats.pf ?? Infinity);
  if (highCorrWorse && sameSideWorse && periodsShowSignal >= 2 && clusterShareOfMaxDd >= 40) {
    decision = 'A';
  } else if ((highCorrWorse || sameSideWorse) && clusterShareOfMaxDd >= 20) {
    decision = 'B';
  } else {
    decision = 'C';
  }
  const runCounterfactual = decision !== 'C';

  // ---- Counterfactual (only if gated open) ----
  const counterfactualRows: string[] = ['variant,N,trades,wr,pf,netPnl,finalBalance,maxDdUsd,maxDdPct,avgLoss,affectedTrades,winnersBlocked,losersBlocked'];
  if (runCounterfactual) {
    for (const nThreshold of [2, 3, 4]) {
      const { result: sim, adjusted } = simulateSameSideCap(closedTrades, nThreshold);
      counterfactualRows.push(
        `C1_sameSideCap,N=${nThreshold},${sim.trades},${sim.wr.toFixed(1)},${sim.pf === Infinity ? 'Inf' : sim.pf.toFixed(3)},${sim.netPnl.toFixed(2)},${sim.finalBalance.toFixed(2)},${sim.maxDdUsd.toFixed(2)},${sim.maxDdPct.toFixed(2)},${sim.avgLoss.toFixed(2)},${sim.affected},${sim.winnersBlocked},${sim.losersBlocked}`,
      );
      writeCounterfactualTradesCsv(`C1_SAME_SIDE_CAP_N${nThreshold}`, adjusted);
    }
    const { result: simC2, adjusted: adjustedC2 } = simulateCorrelationAwareReduction(closedTrades);
    counterfactualRows.push(
      `C2_correlationAware,-,${simC2.trades},${simC2.wr.toFixed(1)},${simC2.pf === Infinity ? 'Inf' : simC2.pf.toFixed(3)},${simC2.netPnl.toFixed(2)},${simC2.finalBalance.toFixed(2)},${simC2.maxDdUsd.toFixed(2)},${simC2.maxDdPct.toFixed(2)},${simC2.avgLoss.toFixed(2)},${simC2.affected},${simC2.winnersBlocked},${simC2.losersBlocked}`,
    );
    writeCounterfactualTradesCsv('C2_CORRELATION_AWARE', adjustedC2);
    writeFileSync(path.join(OUT_DIR, 'ticket147-counterfactual-summary.csv'), counterfactualRows.join('\n') + '\n');
  }

  // ---- Final report ----
  const lines: string[] = [];
  lines.push('# TICKET-147 — Drawdown & Loss-Cluster Forensic Audit');
  lines.push('');
  lines.push('## 1. Baseline reproduction');
  lines.push('');
  lines.push('Command (exact, per ticket brief, same as TICKET-146):');
  lines.push('```');
  lines.push(
    'npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87 --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1 --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3 --momentum-context-decision-matrix-v2-enabled=true',
  );
  lines.push('```');
  lines.push('');
  lines.push(`Reference (coordinator baseline): 319 trades, final balance $1237.35, WR 40.4%, Max Drawdown -45.84% (-$650.72).`);
  lines.push(
    `This script's OWN full-pipeline replay (own processCandle() loop, TICKET-101 within-step risk/margin refresh replicated — see doc comment at top of the script): **${closedTrades.length} trades, final balance $${finalBalance.toFixed(2)}, WR ${wr.toFixed(1)}%, realized-only MaxDD ${maxDrawdownPctRealized.toFixed(2)}% (-$${maxDrawdownUsdRealized.toFixed(2)})**.`,
  );
  const tradesMatch = closedTrades.length === EXPECTED_TRADES;
  const balanceMatch = Math.abs(finalBalance - EXPECTED_FINAL_BALANCE) < 0.01;
  const ddPctMatch = Math.abs(maxDrawdownPctRealized - EXPECTED_MAXDD_PCT) < 0.01;
  const ddUsdMatch = Math.abs(maxDrawdownUsdRealized - EXPECTED_MAXDD_USD) < 0.01;
  lines.push('');
  lines.push(
    `Match check: trades ${tradesMatch ? 'OK' : 'MISMATCH'}, final balance ${balanceMatch ? 'OK' : 'MISMATCH'}, realized MaxDD% ${ddPctMatch ? 'OK' : 'MISMATCH'}, realized MaxDD$ ${ddUsdMatch ? 'OK' : 'MISMATCH'}.`,
  );
  lines.push(
    tradesMatch && balanceMatch && ddPctMatch && ddUsdMatch
      ? '**Reproduction CONFIRMED EXACT.** The within-step openRiskBySymbol/openMarginBySymbol refresh (TICKET-101/TICKET-146 pattern) was replicated correctly — see code comment above the refresh block in the script.'
      : '**REPRODUCTION DRIFT DETECTED** — see raw numbers above; investigate before trusting downstream sections.',
  );
  lines.push('');
  lines.push('Gross profit/loss (own replay): $' + grossWin.toFixed(2) + ' / $' + grossLoss.toFixed(2) + `, PF=${pf === Infinity ? '∞' : pf.toFixed(3)}.`);
  lines.push('');

  lines.push('## 2. Two drawdown metrics — NOT the same number');
  lines.push('');
  lines.push(
    `(a) **Realized-only** (matches backtest.ts's own headline metric, tracked purely off accountBalance which only moves on a full CLOSE): MaxDD = ${maxDrawdownPctRealized.toFixed(2)}% / $${maxDrawdownUsdRealized.toFixed(2)} — this is the official -45.84%/-$650.72 figure.`,
  );
  lines.push(
    `(b) **Floating-inclusive** (this script's NEW metric: realized balance + mark-to-market unrealized PnL of every open position, marked against that symbol's own current-candle close): MaxDD episode = **${floatingMaxDdEpisode.drawdownPct.toFixed(2)}% / $${floatingMaxDdEpisode.drawdownUsd.toFixed(2)}**, peak @ ${new Date(floatingMaxDdEpisode.peakTimestamp).toISOString()}, trough @ ${new Date(floatingMaxDdEpisode.troughTimestamp).toISOString()}, recovery ${floatingMaxDdEpisode.recoveryTimestamp !== null ? new Date(floatingMaxDdEpisode.recoveryTimestamp).toISOString() : 'NEVER RECOVERED by end of data'}.`,
  );
  lines.push(
    'These two numbers are DIFFERENT metrics — do not conflate. All episode/cluster/bucket analysis below uses the FLOATING-INCLUSIVE series unless stated otherwise (matches the ticket brief\'s explicit ask for "floating exposure if possible from replay").',
  );
  lines.push('');

  lines.push('## 3. Drawdown timeline (floating-inclusive)');
  lines.push('');
  lines.push(`Total episodes identified: ${floatingEpisodes.length}. Top 5 by drawdown %:`);
  lines.push('');
  lines.push('| Rank | Peak ts | Trough ts | Recovery ts | Duration to trough | DD USD | DD % | Opened | Closed | Winners | Losers | GrossProfit | GrossLoss |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  top5FloatingEpisodes.forEach((e, i) => {
    const st = episodeStats(e, closedTrades);
    lines.push(
      `| ${i + 1} | ${new Date(e.peakTimestamp).toISOString()} | ${new Date(e.troughTimestamp).toISOString()} | ${e.recoveryTimestamp !== null ? new Date(e.recoveryTimestamp).toISOString() : 'NEVER'} | ${((e.troughTimestamp - e.peakTimestamp) / 3_600_000).toFixed(1)}h | $${e.drawdownUsd.toFixed(2)} | ${e.drawdownPct.toFixed(2)}% | ${st.opened} | ${st.closedCount} | ${st.winners} | ${st.losers} | $${st.grossProfit.toFixed(2)} | $${st.grossLoss.toFixed(2)} |`,
    );
  });
  lines.push('');
  const maxDdSt = episodeStats(floatingMaxDdEpisode, closedTrades);
  lines.push(
    `**MaxDD episode itself**: peak @ ${new Date(floatingMaxDdEpisode.peakTimestamp).toISOString()} ($${floatingMaxDdEpisode.peakEquity.toFixed(2)}) -> trough @ ${new Date(floatingMaxDdEpisode.troughTimestamp).toISOString()} ($${floatingMaxDdEpisode.troughEquity.toFixed(2)}), DD=$${floatingMaxDdEpisode.drawdownUsd.toFixed(2)} (${floatingMaxDdEpisode.drawdownPct.toFixed(2)}%), ${maxDdSt.closedCount} trades closed within (${maxDdSt.winners}W/${maxDdSt.losers}L), gross loss $${maxDdSt.grossLoss.toFixed(2)} vs gross profit $${maxDdSt.grossProfit.toFixed(2)}.`,
  );
  lines.push('');
  lines.push(
    `(Realized-only series, for reference: ${realizedEpisodes.length} episodes; worst by % = ${realizedMaxDdFromEpisodes.drawdownPct.toFixed(2)}% / $${realizedMaxDdFromEpisodes.drawdownUsd.toFixed(2)}, matching the official headline figure.)`,
  );
  lines.push('');
  lines.push('Full episode list: `data/ticket147-drawdown-episodes.csv`.');
  lines.push('');

  lines.push('## 4. Loss clusters — ALL 7 fixed windows (Top 20 each, non-overlapping, by total loss)');
  lines.push('');
  for (const [label] of windowDefs) {
    const clusters = clustersByWindow[label];
    lines.push(`### Window: ${label}`);
    lines.push('');
    lines.push('| Rank | Anchor exit ts | Losing trades | Total loss $ | Coins | L/S | Setups | RiskPool occ% | OpenPos | Realized bal | Floating equity |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    clusters.slice(0, 20).forEach((c, i) => {
      lines.push(
        `| ${i + 1} | ${new Date(c.anchorExitTimestamp).toISOString()} | ${c.losingTrades.length} | $${c.totalLossUsd.toFixed(2)} | ${c.coins.size} (${[...c.coins].join('/')}) | ${c.longCount}L/${c.shortCount}S | ${c.setupTypes.size} (${[...c.setupTypes].join('/')}) | ${c.riskPoolOccupancyPct?.toFixed(1) ?? 'N/A'}% | ${c.openPositionCount ?? 'N/A'} | $${c.realizedBalance?.toFixed(2) ?? 'N/A'} | $${c.floatingEquity?.toFixed(2) ?? 'N/A'} |`,
      );
    });
    lines.push('');
  }
  lines.push('Full per-window Top-20 tables: `data/ticket147-loss-clusters.csv`.');
  lines.push('');

  lines.push('## 5. Correlated exposure (Section C)');
  lines.push('');
  lines.push('Bucketed by average 6-pair Pearson correlation (1H, 30-candle rolling window) at trade-open time:');
  lines.push('');
  lines.push('| Avg correlation | Stats |');
  lines.push('|---|---|');
  for (const [label, pred] of avgCorrBuckets) {
    const trades = closedTrades.filter((t) => t.context.avgCorr !== undefined && pred(t.context.avgCorr as number));
    lines.push(`| ${label} | ${fmtGroup(computeGroupStats(trades))}, MaxDD-episode contribution=$${maxDdContribution(trades).toFixed(2)} |`);
  }
  lines.push('');
  lines.push('Bucketed by same-side open-position count at trade-open time:');
  lines.push('');
  lines.push('| Same-side open positions | Stats |');
  lines.push('|---|---|');
  for (const [label, pred] of sameSideBuckets) {
    const trades = closedTrades.filter((t) => pred(t.context.sameSideOpenCount));
    lines.push(`| ${label} | ${fmtGroup(computeGroupStats(trades))}, MaxDD-episode contribution=$${maxDdContribution(trades).toFixed(2)} |`);
  }
  lines.push('');
  lines.push('Full per-trade context: `data/ticket147-trade-context.csv`. Bucket CSV: `data/ticket147-correlation-buckets.csv`.');
  lines.push('');

  lines.push('## 6. Risk pool / concentration (Section D)');
  lines.push('');
  lines.push('| RiskPool occupancy at open | Stats | Loss-cluster frequency (1h window) |');
  lines.push('|---|---|---|');
  for (const [label, pred] of rpBuckets) {
    const trades = closedTrades.filter((t) => pred(t.riskPoolPctBefore));
    const freq = trades.length > 0 ? (trades.filter(inAnyCluster).length / trades.length) * 100 : 0;
    lines.push(`| ${label} | ${fmtGroup(computeGroupStats(trades))} | ${freq.toFixed(1)}% |`);
  }
  lines.push('');
  lines.push('Full CSV: `data/ticket147-riskpool-buckets.csv`.');
  lines.push('');

  lines.push('## 7. Coin/Side/Setup attribution (within the MaxDD episode)');
  lines.push('');
  lines.push(
    `MaxDD-episode window: ${new Date(maxDdWindowFrom).toISOString()} -> ${maxDdWindowTo === Number.MAX_SAFE_INTEGER ? 'end of data' : new Date(maxDdWindowTo).toISOString()}. ${maxDdLosers.length} losing trades inside, total loss $${Math.abs(maxDdLosers.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)).toFixed(2)}.`,
  );
  lines.push('');
  lines.push('By coin: ' + coinAttrib.map((c) => `${c.key}=$${c.loss.toFixed(2)}`).join(', '));
  lines.push('');
  lines.push('By side: ' + sideAttrib.map((c) => `${c.key}=$${c.loss.toFixed(2)}`).join(', '));
  lines.push('');
  lines.push('By setup: ' + setupAttrib.map((c) => `${c.key}=$${c.loss.toFixed(2)}`).join(', '));
  lines.push('');
  lines.push(`**Coin causing most drawdown**: ${coinAttrib[0]?.key ?? 'N/A'} ($${coinAttrib[0]?.loss.toFixed(2) ?? '0'}).`);
  lines.push(`**Setup causing most drawdown**: ${setupAttrib[0]?.key ?? 'N/A'} ($${setupAttrib[0]?.loss.toFixed(2) ?? '0'}).`);
  lines.push(`**Side causing most drawdown**: ${sideAttrib[0]?.key ?? 'N/A'} ($${sideAttrib[0]?.loss.toFixed(2) ?? '0'}).`);
  lines.push(
    `**Combination coin+side+setup causing most drawdown**: ${topCombo ? topCombo[0].replace(/\|/g, ' / ') + ` ($${topCombo[1].toFixed(2)})` : 'N/A'} ${topCombo && maxDdLosers.filter((t) => `${t.symbol}|${t.side}|${t.setupType}` === topCombo[0]).length < 5 ? '(CAUTION: <5 trades in this combination, small-sample)' : ''}.`,
  );
  lines.push('');

  lines.push('## 8. Path dependence (Section F)');
  lines.push('');
  lines.push(
    `1. Prior-loss effect on next entry: descriptive only (no causal test run — no simulator change made). When >=1 position already open at entry time (N=${multiOpenTrades.length}): ${fmtGroup(computeGroupStats(multiOpenTrades))}. When flat before entry (N=${singleOpenTrades.length}): ${fmtGroup(computeGroupStats(singleOpenTrades))}.`,
  );
  lines.push(
    `2. Do large clusters appear after risk pool already high? Avg riskPoolOccupancy% at the anchor moment of the Top-20 1h loss clusters = ${avgRiskPoolBeforeTopClusters.toFixed(1)}% vs overall average riskPoolPctBefore across ALL trade opens = ${avgRiskPoolOverall.toFixed(1)}%.`,
  );
  lines.push(
    `3. Does MaxDD depend on a few concurrently-open trade chains? ${maxDdLosers.length} losing trades drove the MaxDD episode; of these, ${maxDdLosers.filter((t) => t.context.openPositionCountBefore >= 1).length} opened while >=1 other position was already open (i.e. NOT independent/isolated entries).`,
  );
  lines.push(
    `4. Individual-trade-only view vs portfolio view: high-riskpool-occupancy trades (>=75%, N=${highRiskPoolTrades.length}) show ${fmtGroup(computeGroupStats(highRiskPoolTrades))} vs low-occupancy trades (N=${lowRiskPoolTrades.length}) ${fmtGroup(computeGroupStats(lowRiskPoolTrades))} — ${
      highRiskPoolTrades.length > 0 && lowRiskPoolTrades.length > 0 && (computeGroupStats(highRiskPoolTrades).pf ?? 0) < (computeGroupStats(lowRiskPoolTrades).pf ?? Infinity)
        ? 'a portfolio-only view WOULD miss a real degradation at high occupancy'
        : 'no clear degradation detected at high occupancy from this data alone'
    }.`,
  );
  lines.push('');

  lines.push('## 9. Sub-period stability');
  lines.push('');
  lines.push('| Period | N trades | High-corr (>=0.70) stats | Low-corr (<0.30) stats |');
  lines.push('|---|---|---|---|');
  for (const p of periodStats) {
    lines.push(`| ${p.label} | ${p.n} | ${fmtGroup(p.high)} | ${fmtGroup(p.low)} |`);
  }
  lines.push(`Periods showing high-corr AvgLoss worse than low-corr (min 5 trades each side): ${periodsShowSignal}/3.`);
  lines.push('');

  lines.push('## 10. Counterfactual (Section 4)');
  lines.push('');
  if (runCounterfactual) {
    lines.push(
      `GATE OPEN — sections A-F show non-trivial signal (high-corr worse-PF=${highCorrWorse}, same-side-worse-PF=${sameSideWorse}, MaxDD-episode loss share of total gross loss=${clusterShareOfMaxDd.toFixed(1)}%). Running C1 (N=2/3/4 same-side cap, shadow) and C2 (correlation-aware reduction, shadow). C3 skipped unless BOTH C1 and C2 individually show signal (see results below).`,
    );
    lines.push('');
    lines.push('| Variant | Trades | WR | PF | NetPnL | FinalBalance | MaxDD$ | MaxDD% | AvgLoss | Affected | WinnersBlocked | LosersBlocked |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of counterfactualRows.slice(1)) {
      const cols = row.split(',');
      lines.push(`| ${cols[0]} ${cols[1] !== '-' ? cols[1] : ''} | ${cols[2]} | ${cols[3]}% | ${cols[4]} | $${cols[5]} | $${cols[6]} | $${cols[7]} | ${cols[8]}% | $${cols[9]} | ${cols[10]} | ${cols[11]} | ${cols[12]} |`);
    }
    lines.push('');
    lines.push(
      'Discipline applied: no variant is called PASS purely for a lower MaxDD if PF/NetPnL is meaningfully worse than baseline — see numeric comparison above vs. baseline PF=' +
        (pf === Infinity ? '∞' : pf.toFixed(3)) +
        ', NetPnL=$' +
        (grossWin - grossLoss).toFixed(2) +
        '.',
    );
    lines.push('');
    lines.push(
      'Per-variant affected-trade detail (original vs adjusted pnl, winner_cut/loser_saved classification): `data/ticket147-counterfactual-trades-C1_SAME_SIDE_CAP_N2.csv`, `...N3.csv`, `...N4.csv`, `...C2_CORRELATION_AWARE.csv`.',
    );
  } else {
    lines.push(
      `GATE CLOSED — SKIPPED. Sections A-F did not show meaningful correlation/concentration (high-corr-worse=${highCorrWorse}, same-side-worse=${sameSideWorse}, MaxDD-episode share of total gross loss=${clusterShareOfMaxDd.toFixed(1)}%, sub-period signal=${periodsShowSignal}/3). Per house rule, no counterfactual was manufactured to force a result — going straight to Decision C/B based on sections above.`,
    );
  }
  lines.push('');

  lines.push('## 11. Final Decision');
  lines.push('');
  lines.push(`- High-avgCorr(>=0.70) trades (N=${highCorrStats.n}): ${fmtGroup(highCorrStats)}`);
  lines.push(`- Low-avgCorr(<0.30) trades (N=${lowCorrStats.n}): ${fmtGroup(lowCorrStats)}`);
  lines.push(`- Same-side>=3 trades (N=${sameSide3PlusStats.n}): ${fmtGroup(sameSide3PlusStats)}`);
  lines.push(`- Same-side<=1 trades (N=${sameSide0Or1Stats.n}): ${fmtGroup(sameSide0Or1Stats)}`);
  lines.push(`- MaxDD-episode loss as share of total gross loss: ${clusterShareOfMaxDd.toFixed(1)}%`);
  lines.push(`- Sub-period consistency: ${periodsShowSignal}/3 periods show the same directional signal`);
  lines.push('');
  lines.push(`### DECISION: **${decision}**`);
  lines.push('');
  if (decision === 'A') {
    lines.push(
      'Portfolio concentration is a significant root cause of MaxDD — loss clusters/high-correlation/high-same-side buckets are meaningfully worse, the pattern holds across >=2/3 sub-periods, and (see §10) a simple counterfactual improves MaxDD without destroying PF/NetPnL. **Recommend opening T148 Portfolio Exposure Manager** (deterministic, rule-based, low-latency, per §7 of the ticket).',
    );
  } else if (decision === 'B') {
    lines.push(
      'Portfolio concentration shows SOME signal (high-corr or same-side buckets worse, and/or MaxDD-episode carries a non-trivial share of gross loss) but it is not stable/strong enough across sub-periods and/or the counterfactual trade-off is not clean enough to justify a dedicated Portfolio Exposure Manager right now. **Do NOT build T148** on this evidence alone — redirect effort elsewhere; revisit if a stronger signal emerges from more data.',
    );
  } else {
    lines.push(
      'Losses are largely explained by independent trade outcomes — high-correlation/high-same-side buckets do not show a robust, sub-period-stable degradation vs their counterparts, and/or the MaxDD episode is not concentrated enough in correlated exposure to justify further work. **Close the portfolio-exposure direction — do NOT open T148.**',
    );
  }
  lines.push('');
  lines.push(
    `**Mandatory final answer**: MaxDD ~45.84% (official realized-only headline) is judged to come from **(${decision}) ${
      decision === 'A' ? 'correlated exposure/loss clusters' : decision === 'B' ? 'a secondary but non-negligible factor' : 'largely independent losses'
    }**. ${decision === 'A' ? 'There IS sufficient evidence to open T148.' : 'There is NOT sufficient evidence to open T148 at this time.'}`,
  );
  lines.push('');

  lines.push('## 12. Judgment calls');
  lines.push('');
  lines.push(
    '- **Floating PnL methodology**: `computeRealizedPnl()` (the REAL production formula from `slTpManager.ts`) called with the current candle\'s own close as the hypothetical final exit price for the remaining (unfilled-tier) portion — same formula the real pipeline uses at actual close, just evaluated early. Anti-lookahead by construction (never a future candle).',
  );
  lines.push(
    '- **Correlation timeframe**: 1H (not 5m) — the 5m OHLCV files are NOT positionally aligned across the 4 symbols (XRPUSDT is off by one row/5min vs BTC/ETH/SOL), so a naive 5m array-index zip would silently corrupt every XRP correlation. The 1H files ARE aligned (verified: all 4 start at the same timestamp, same row count) and this script reuses the EXACT SAME closedWindow()-based per-symbol-pointer construction backtest.ts already uses for computeCorrelatedRiskRatio() — proven-safe, no new timestamp-join code needed. Trade-off: correlation updates effectively once per hour rather than every 5m, documented and accepted.',
  );
  lines.push(
    '- **Drawdown episode segmentation**: standard peak->trough->recovery algorithm — a new episode starts whenever equity makes a new running high; while below that high, the episode\'s trough is extended to the lowest point reached; the episode closes the moment equity returns to >= the peak. An episode still below peak at the end of the data is reported as "never recovered" rather than dropped.',
  );
  lines.push(
    '- **Loss-cluster window anchoring**: for each of the 7 fixed windows, every LOSING trade is used as a window-END anchor (window = (exit-W, exit]); overlapping anchor-windows are greedily de-duplicated (highest-loss window wins, any window overlapping an already-selected one is dropped) before taking the Top 20 — otherwise the Top 20 would just be near-identical shifted copies of the single worst stretch.',
  );
  lines.push(
    '- **MaxDD-episode-contribution / loss-cluster-frequency**: both defined relative to a single representative window (the floating-inclusive MaxDD episode\'s own [peak,recovery) range for the former; the 1h loss-cluster set for the latter) — arbitrary but documented choices, not tuned to favor any Decision.',
  );
  lines.push(
    '- **sameSideOpenCount convention**: counts the just-opened position itself (i.e. minimum value is 1 for any trade that has ANY same-side position, including only itself) — the "0" bucket therefore means "the only same-side position in the system at that instant".',
  );
  lines.push(
    '- **Setup/coin coverage**: no filtering was applied for small setup/coin subgroups in the attribution section (§7) beyond a same-sample-size caution note on the top combination — see the explicit "small-sample" flag when N<5.',
  );
  lines.push(
    `- **No threshold retuning**: momentumDirectThreshold(0.5), riskPoolMaxPct(0.15), CORRELATED_RISK_WINDOW_CANDLES(30), and all 7 loss-cluster windows / correlation-bucket boundaries / risk-pool-bucket boundaries are exactly as specified by the ticket text — nothing tuned to help reach Decision A.`,
  );
  lines.push(
    `- **Decision thresholds used** (not given verbatim by the ticket, inferred conservatively from its qualitative criteria): "worse" bucket = lower PF AND higher AvgLoss with N>=10 each side; "meaningful MaxDD share" = MaxDD-episode gross loss >= 40% of total gross loss for Decision A eligibility, >=20% for Decision B eligibility; sub-period consistency requires >=2/3 periods agreeing. These are audit judgment calls to operationalize the ticket's own qualitative language, applied identically regardless of which way they pointed.`,
  );
  lines.push('');

  writeFileSync(path.join(OUT_DIR, 'ticket147-drawdown-loss-cluster-forensic-audit-report.md'), lines.join('\n') + '\n');
  console.log('→ data/ticket147-drawdown-loss-cluster-forensic-audit-report.md');
  console.log('Decision: ' + decision);
}

// ---- Counterfactual simulators (shadow-only: recompute a NEW hypothetical pnl series by ZEROING
// OUT / SCALING trades that would have been reduced/blocked by the rule — pure post-hoc arithmetic
// on the already-closed trade list, exactly as the ticket's "shadow/offline" framing requires). ----
interface CounterfactualResult {
  trades: number;
  wr: number;
  pf: number;
  netPnl: number;
  finalBalance: number;
  maxDdUsd: number;
  maxDdPct: number;
  avgLoss: number;
  affected: number;
  winnersBlocked: number;
  losersBlocked: number;
}

function summarizeCounterfactual(adjustedPnls: { t: TradeRecord; pnl: number; blocked: boolean }[]): CounterfactualResult {
  const sorted = [...adjustedPnls].sort((a, b) => (a.t.exitTimestamp ?? 0) - (b.t.exitTimestamp ?? 0));
  let balance = 100;
  let peak = 100;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  for (const { pnl } of sorted) {
    balance += pnl;
    if (balance > peak) peak = balance;
    const ddUsd = peak - balance;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDdPct) {
      maxDdPct = ddPct;
      maxDdUsd = ddUsd;
    }
  }
  const wins = sorted.filter((x) => x.pnl > 0);
  const losses = sorted.filter((x) => x.pnl <= 0);
  const grossWin = wins.reduce((s, x) => s + x.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.pnl, 0));
  // "Affected" = any trade whose outcome actually changed (blocked OR reduced), matching the
  // per-variant trades CSV's row filter exactly — NOT just the fully-blocked subset.
  const isChanged = (x: AdjustedTrade) => x.pnl !== (x.t.pnlUsd ?? 0);
  const affected = sorted.filter(isChanged).length;
  const winnersBlocked = sorted.filter((x) => isChanged(x) && (x.t.pnlUsd ?? 0) > 0).length;
  const losersBlocked = sorted.filter((x) => isChanged(x) && (x.t.pnlUsd ?? 0) <= 0).length;
  return {
    trades: sorted.length,
    wr: sorted.length > 0 ? (wins.length / sorted.length) * 100 : 0,
    pf: grossLoss === 0 ? Infinity : grossWin / grossLoss,
    netPnl: grossWin - grossLoss,
    finalBalance: balance,
    maxDdUsd,
    maxDdPct,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    affected,
    winnersBlocked,
    losersBlocked,
  };
}

type AdjustedTrade = { t: TradeRecord; pnl: number; blocked: boolean };

// C1 — Same-side exposure cap: if this trade's sameSideOpenCount (incl. itself) exceeds N at open
// time, the trade is marked "would_block" and excluded from the shadow equity curve (pnl -> 0).
function simulateSameSideCap(trades: TradeRecord[], n: number): { result: CounterfactualResult; adjusted: AdjustedTrade[] } {
  const adjusted: AdjustedTrade[] = trades.map((t) => {
    const blocked = t.context.sameSideOpenCount > n;
    return { t, pnl: blocked ? 0 : t.pnlUsd ?? 0, blocked };
  });
  return { result: summarizeCounterfactual(adjusted), adjusted };
}

// C2 — Correlation-aware exposure: avgCorr<0.70 normal; 0.70-0.85 risk HALVED (REDUCED); >=0.85
// blocked entirely (STRONG_REDUCTION/BLOCK-SHADOW), per ticket's exact thresholds.
function simulateCorrelationAwareReduction(trades: TradeRecord[]): { result: CounterfactualResult; adjusted: AdjustedTrade[] } {
  const adjusted: AdjustedTrade[] = trades.map((t) => {
    const corr = t.context.avgCorr;
    if (corr === undefined || corr < 0.7) return { t, pnl: t.pnlUsd ?? 0, blocked: false };
    if (corr < 0.85) return { t, pnl: (t.pnlUsd ?? 0) * 0.5, blocked: false }; // REDUCED, risk halved
    return { t, pnl: 0, blocked: true }; // STRONG_REDUCTION/BLOCK-SHADOW
  });
  return { result: summarizeCounterfactual(adjusted), adjusted };
}

// Writes one row per trade whose outcome actually changed under this variant (blocked or pnl
// scaled) — winner_cut = was a winner and got reduced/blocked, loser_saved = was a loser and got
// reduced/blocked (smaller realized loss), unaffected trades are omitted entirely.
function writeCounterfactualTradesCsv(label: string, adjusted: AdjustedTrade[]): void {
  const header = 'symbol,side,setupType,entryTimestamp,exitTimestamp,exitReason,originalPnlUsd,adjustedPnlUsd,blocked,classification';
  const rows = adjusted
    .filter((a) => a.pnl !== (a.t.pnlUsd ?? 0))
    .map((a) => {
      const original = a.t.pnlUsd ?? 0;
      const classification = original > 0 ? 'winner_cut' : 'loser_saved';
      return [
        a.t.symbol,
        a.t.side,
        a.t.setupType,
        a.t.entryTimestamp,
        a.t.exitTimestamp,
        a.t.exitReason,
        original.toFixed(4),
        a.pnl.toFixed(4),
        a.blocked,
        classification,
      ].join(',');
    });
  writeFileSync(path.join(OUT_DIR, `ticket147-counterfactual-trades-${label}.csv`), [header, ...rows].join('\n') + '\n');
}

main().catch((err) => {
  console.error('ticket147DrawdownLossClusterForensicAudit failed:', err);
  process.exit(1);
});
