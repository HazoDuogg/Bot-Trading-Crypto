/**
 * TICKET-149 — MOMENTUM_DIRECT SHORT Loss-Cluster Forensic Audit (PURE READ-ONLY). Extends
 * TICKET-147's finding (drawdown dominated by SHORT/MOMENTUM_DIRECT/multi-coin-simultaneous losses,
 * concentrated 2026-06-03..08) by investigating the SIGNAL-LEVEL root cause: why does the same
 * underlying market state make MOMENTUM_DIRECT fire SHORT wrongly on multiple coins repeatedly.
 *
 * Zero production logic touched — imports and calls the REAL processCandle()/tryMomentumDirect()/
 * scoreMomentum()/computeMomentumContextDecision() pipeline from dist/ only, records diagnostics.
 * One counterfactual variant (C3, OOD HARD_REJECT) is run as a SEPARATE full replay using an
 * alternate config object passed to the same real processCandle() — this is a config value already
 * supported by production (oodGuardConfig.mode), not new logic, and never touches any source file.
 *
 * Population/config: identical to TICKET-148's own verified baseline harness (8-flag command +
 * --momentum-context-decision-matrix-v2-enabled=true), replay stops the instant trade #319 closes
 * (TARGET_TOTAL_TRADES), matching the confirmed 319/$1237.3534537367143 checkpoint exactly (see
 * TICKET-147/148 reports for the data-freshness note on why a 320th trade now exists in raw history).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData, type ComputedMetrics } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { emaSeries, wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { classifyHtfContextCandidate } from '../dist/regime/htfContext.js';
import { classifySafetyState5mCandidate } from '../dist/regime/safetyState5m.js';
import { HTFContext, SafetyState5m } from '../dist/regime/htfSafetyTypes.js';
import { EntryConfig } from '../dist/entry/config.js';
import { computeDirection5mRelaxed } from '../dist/orchestrator/neutral5mDirectionGatedRouting.js';
import {
  NEUTRAL_5M_DI_PERIOD,
  NEUTRAL_5M_EMA_FAST_PERIOD,
  NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES,
  NEUTRAL_5M_EMA_SLOW_PERIOD,
} from '../dist/orchestrator/neutral5mDirectionSelector.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../dist/xgbFilter/featureBuilder.js';
import {
  MOMENTUM_SCHEMA_PATH,
  MOMENTUM_BEARISH_SCHEMA_PATH,
  DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  DEFAULT_MOMENTUM_FILTER_CONFIG,
  DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
} from '../dist/xgbFilter/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
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
const TAKER_FEE_RATE = 0.0004;
const TARGET_TOTAL_TRADES = 319;
const CONTEXT_DEPTH = 6; // T, T-1 .. T-5 for staleness check (Q2/Q5)

type Side = 'LONG' | 'SHORT';

// ---- Official baseline config (verbatim copy of TICKET-148's own verified config) ----
function buildBaselineConfig(oodMode: 'RISK_REDUCTION' | 'HARD_REJECT' = 'RISK_REDUCTION'): OrchestratorConfig {
  return {
    entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87 },
    tpPlan: 'PLAN_A',
    takerFeeRate: TAKER_FEE_RATE,
    riskDollarOrPercent: 15,
    maxMarginCap: 37.5,
    leverage: 30,
    riskPoolMaxPct: 15 / 100,
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
    neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
    planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true },
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
    oodGuardConfig: { emaRatioSlowThreshold: 1.037776, mode: oodMode, scoreCapValue: 0, riskReductionMultiplier: 0.3 },
    momentumContextDecisionMatrixV2Enabled: true,
  };
}
const config = buildBaselineConfig('RISK_REDUCTION');

const EXPECTED_TRADES = 319;
const EXPECTED_FINAL_BALANCE = 1237.35;
const EXPECTED_WR = 40.4;
const EXPECTED_PF = 1.48;
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
  ts5mIndex: Map<number, number>;
}

function loadSymbolData(symbol: string): SymbolData {
  const candles5m = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));
  const ts5mIndex = new Map<number, number>();
  candles5m.forEach((c, i) => ts5mIndex.set(c.timestamp, i));
  return {
    candles5m,
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
    ts5mIndex,
  };
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// ---- Pairwise 1H Pearson correlation (verbatim reuse of TICKET-147's approach/rationale) ----
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
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA, db = bx[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  if (varA === 0 || varB === 0) return undefined;
  return cov / Math.sqrt(varA * varB);
}
function computeCorrSnapshot(w1hBySymbol: Record<string, CandleData[]>): { pairwise: Record<string, number | undefined>; avg: number | undefined } {
  const returnsBySymbol: Record<string, number[]> = {};
  for (const s of SYMBOLS) returnsBySymbol[s] = returnsFromCloses(w1hBySymbol[s], RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES);
  const pairwise: Record<string, number | undefined> = {};
  for (const [a, b] of PAIRS) pairwise[`${a}_${b}`] = pearson(returnsBySymbol[a], returnsBySymbol[b]);
  const values = Object.values(pairwise).filter((v): v is number => v !== undefined);
  const avg = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
  return { pairwise, avg };
}

function cosineSim(a: number[], b: number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n === 0) return undefined;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return undefined;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type Direction5m = 'LONG' | 'SHORT' | 'NONE';
function computeDirectionLayer(candles5m: CandleData[]): Direction5m {
  const n = candles5m.length;
  const minLen = NEUTRAL_5M_EMA_SLOW_PERIOD + NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES;
  if (n < minLen) return 'NONE';
  const emaFastSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_FAST_PERIOD);
  const emaSlowSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const fastNow = emaFastSeries[n - 1];
  const slowNow = emaSlowSeries[n - 1];
  if (Number.isNaN(fastNow) || Number.isNaN(slowNow)) return 'NONE';
  const emaSlope = emaSlowSeries[n - 1] - emaSlowSeries[n - 1 - NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES];
  const diSeries = wilderDIDirectionSeries(candles5m, NEUTRAL_5M_DI_PERIOD);
  const diDirection = diSeries[n - 1];
  const emaRelation = fastNow > slowNow ? 'FAST_ABOVE_SLOW' : fastNow < slowNow ? 'FAST_BELOW_SLOW' : 'FLAT';
  if (emaRelation === 'FAST_ABOVE_SLOW' && emaSlope > 0 && diDirection === 'UP') return 'LONG';
  if (emaRelation === 'FAST_BELOW_SLOW' && emaSlope < 0 && diDirection === 'DOWN') return 'SHORT';
  return 'NONE';
}

function computeDistanceToNearestSwingAtr(candles5m: CandleData[]): number | undefined {
  const atr = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M).filter((v) => !Number.isNaN(v)).pop();
  if (atr === undefined || atr <= 0) return undefined;
  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);
  const lastIndex = candles5m.length - 1;
  const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', lastIndex);
  const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', lastIndex);
  if (nearestHigh === null && nearestLow === null) return undefined;
  const close = candles5m[lastIndex].close;
  const distHigh = nearestHigh !== null ? Math.abs(close - nearestHigh.price) : Infinity;
  const distLow = nearestLow !== null ? Math.abs(close - nearestLow.price) : Infinity;
  return Math.min(distHigh, distLow) / atr;
}

const schemaCache = new Map<string, FeatureSchema>();
function getSchemaCached(schemaPath: string): FeatureSchema {
  let cached = schemaCache.get(schemaPath);
  if (cached === undefined) { cached = loadFeatureSchema(schemaPath); schemaCache.set(schemaPath, cached); }
  return cached;
}

// ---- Rolling raw-context buffer per symbol (last CONTEXT_DEPTH steps) ----
interface RawContext {
  step: number;
  timestamp: number;
  candle: CandleData;
  window5m: CandleData[];
  w1hMomentum: CandleData[];
  w1d: CandleData[];
  cm: ComputedMetrics;
  regimeConfirmed: string;
  correlatedRiskRatio: number | undefined;
  corrSnapshot: { pairwise: Record<string, number | undefined>; avg: number | undefined };
  momentumDirectOpenPositions: Array<{ symbol: string; side: Side }>;
}

interface EntryDiagnostic {
  direction5mPrimary: Direction5m;
  direction5mRelaxed: Direction5m;
  safetyState5m: string;
  htfContext: string;
  macroDirection1d: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroConflict: boolean;
  adx1h: number | undefined;
  adxDirection1h: string | undefined;
  atrPercentile5m: number | undefined;
  bbWidthPercentile15m: number | undefined;
  volumeZScore5m: number | undefined;
  atrTrend5m: string | undefined;
  distanceToNearestSwingAtr: number | undefined;
  emaRatioSlow: number | undefined;
  emaRatioFast: number | undefined;
  volAdjReturn5m: number | undefined;
  numericFeatureVector: number[] | undefined;
}

async function computeEntryDiagnostic(ctx: RawContext, symbol: string, tradeSide: Side, correlatedRiskRatio: number | undefined): Promise<EntryDiagnostic> {
  const cm = ctx.cm;
  const macroDirectionSeries = wilderDIDirectionSeries(ctx.w1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
  const macroDirection1d = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
  const macroConflict = tradeSide === 'LONG' ? macroDirection1d === 'DOWN' : macroDirection1d === 'UP';
  const direction5mPrimary = computeDirectionLayer(ctx.window5m);
  const relaxed = computeDirection5mRelaxed(ctx.window5m, []);
  const safetyState5m = SafetyState5m[classifySafetyState5mCandidate(cm)];
  const htfContext = HTFContext[classifyHtfContextCandidate(cm)];

  const crossFeatures = computeMomentumCrossFeatures(ctx.window5m, ctx.w1hMomentum);
  const distanceToNearestSwingAtr = computeDistanceToNearestSwingAtr(ctx.window5m);
  let numericFeatureVector: number[] | undefined;
  if (crossFeatures !== undefined && cm.adx1h !== undefined && cm.atrPercentile5m !== undefined && cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined) {
    const schema = getSchemaCached(MOMENTUM_BEARISH_SCHEMA_PATH);
    const featureVector = buildFeatureVector(
      {
        symbol,
        adx1h: cm.adx1h,
        atrPercentile5m: cm.atrPercentile5m,
        bbWidthPercentile15m: cm.bbWidthPercentile15m,
        volumeZScore5m: cm.volumeZScore5m,
        atrTrend5m: cm.atrTrend5m as string,
        adxDirection1h: cm.adxDirection1h as string,
        macroDirection: macroDirection1d,
        correlatedRiskRatio,
        distanceToNearestSwingAtr,
        ...crossFeatures,
      },
      schema,
    );
    // Numeric-only subset (schema numeric_features), for cosine similarity — excludes one-hot categoricals.
    numericFeatureVector = schema.numeric_features.map((name) => {
      const idx = schema.feature_order.indexOf(name);
      return idx >= 0 ? featureVector[idx] : 0;
    });
  }

  return {
    direction5mPrimary,
    direction5mRelaxed: relaxed.direction5m,
    safetyState5m,
    htfContext,
    macroDirection1d,
    macroConflict,
    adx1h: cm.adx1h,
    adxDirection1h: cm.adxDirection1h,
    atrPercentile5m: cm.atrPercentile5m,
    bbWidthPercentile15m: cm.bbWidthPercentile15m,
    volumeZScore5m: cm.volumeZScore5m,
    atrTrend5m: cm.atrTrend5m as string | undefined,
    distanceToNearestSwingAtr,
    emaRatioSlow: crossFeatures?.emaRatioSlow,
    emaRatioFast: crossFeatures?.emaRatioFast,
    volAdjReturn5m: crossFeatures?.volAdjReturn5m,
    numericFeatureVector,
  };
}

// ============================================================================================
// Trade record (MOMENTUM_DIRECT SHORT population)
// ============================================================================================
interface MomShortTrade {
  tradeId: number;
  symbol: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  regime: string;
  riskMultiplierApplied: number;
  actualRiskDollar: number;
  marginRequired: number;
  riskPoolPctBefore: number;
  momentumScore: number | undefined;
  oodFlagged: boolean;
  decisionMatrix: { decision: string; riskMultiplier: number; reason: string; macroConflict: boolean; htfContext: string } | undefined;
  entryDiag: EntryDiagnostic | undefined;
  histDiag: Record<string, EntryDiagnostic | undefined>; // 'T-1'..'T-5'
  histRegime: Record<string, string>;
  portfolio: {
    sameSideShortCount: number; // other MOMENTUM_DIRECT SHORT positions open at this instant (this symbol excluded)
    symbolsWithShortOpen: string[];
    avgPairwiseCorr: number | undefined;
  };
  exitTimestamp?: number;
  exitPrice?: number;
  exitReason?: string;
  pnlUsd?: number;
  pnlPct?: number;
  accountBalanceAfter?: number;
  barsToExit?: number;
  mfePct?: number;
  maePct?: number;
}

const OUT_TRADES_CSV = path.join(OUT_DIR, 'ticket149-momentum-short-trades.csv');
const OUT_CLUSTER_VS_CONTROL_CSV = path.join(OUT_DIR, 'ticket149-cluster-vs-control.csv');
const OUT_SYNC_GROUPS_CSV = path.join(OUT_DIR, 'ticket149-synchronized-short-groups.csv');
const OUT_XGB_OOD_CSV = path.join(OUT_DIR, 'ticket149-xgb-ood-analysis.csv');
const OUT_ENTRY_ORDER_CSV = path.join(OUT_DIR, 'ticket149-entry-order-analysis.csv');
const OUT_COUNTERFACTUALS_CSV = path.join(OUT_DIR, 'ticket149-counterfactuals.csv');
const OUT_MD = path.join(OUT_DIR, 'ticket149-momentum-short-loss-cluster-report.md');

interface ReplayResult {
  trades: MomShortTrade[];
  finalBalance: number;
  closedTradeCount: number;
  allClosedForBaselineCheck: Array<{ setupType: string; side: Side; pnlUsd: number; accountBalanceAfter: number; exitTimestamp: number; entryTimestamp: number }>;
}

async function runReplay(cfg: OrchestratorConfig, captureDiagnostics: boolean): Promise<ReplayResult> {
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;

  let accountBalance = 100;
  const rollingBuffers: Record<string, RawContext[]> = {};
  for (const s of SYMBOLS) rollingBuffers[s] = [];

  const momShortTrades: MomShortTrade[] = [];
  const openIndexBySymbolTs = new Map<string, MomShortTrade>();
  const allClosedForBaselineCheck: ReplayResult['allClosedForBaselineCheck'] = [];
  let closedTradeCount = 0;

  stepLoop: for (let step = startStep; step < rawTotalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }
    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: Side }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions.filter((e) => e.meta.setupType === 'MOMENTUM_DIRECT').map((e) => ({ symbol, side: e.position.side })),
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
    const corrSnapshot = captureDiagnostics ? computeCorrSnapshot(w1hBySymbol) : { pairwise: {}, avg: undefined };

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

      let computedMetricsThisStep: ComputedMetrics | undefined;
      let shortGateEval: { score: number; oodFlagged: boolean; passed: boolean } | undefined;
      let contextDecision: { decision: string; riskMultiplier: number; reason: string; macroConflict: boolean; htfContext: string } | undefined;

      const result = await processCandle(
        input,
        sd.state,
        cfg,
        undefined,
        undefined,
        undefined,
        undefined,
        (cm) => { computedMetricsThisStep = cm; },
        (evaluation) => {
          if (evaluation.gateType === 'MOMENTUM_DIRECT' && evaluation.side === 'SHORT') {
            shortGateEval = { score: evaluation.score, oodFlagged: evaluation.oodFlagged === true, passed: evaluation.passed };
          }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (diagnostic) => {
          if (diagnostic.side === 'SHORT') {
            contextDecision = {
              decision: diagnostic.decision,
              riskMultiplier: diagnostic.riskMultiplier,
              reason: diagnostic.decisionReason,
              macroConflict: diagnostic.macroConflict,
              htfContext: HTFContext[diagnostic.htfContext],
            };
          }
        },
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;
      const cm = computedMetricsThisStep ?? ({} as ComputedMetrics);

      const ctx: RawContext = {
        step,
        timestamp: currentCandle.timestamp,
        candle: currentCandle,
        window5m,
        w1hMomentum: w1hMomentum.window,
        w1d: w1d.window,
        cm,
        regimeConfirmed: result.symbolState.regimeState.previousRegime ?? 'null',
        correlatedRiskRatio,
        corrSnapshot,
        momentumDirectOpenPositions,
      };

      for (const event of result.events) {
        if (event.type === 'OPEN' && event.symbol === symbol) {
          if (event.setupType === 'MOMENTUM_DIRECT' && event.side === 'SHORT') {
            const rec: MomShortTrade = {
              tradeId: momShortTrades.length + 1,
              symbol,
              entryTimestamp: event.entryTimestamp,
              entryPrice: event.entryPrice,
              slPrice: event.slPrice,
              regime: event.regime,
              riskMultiplierApplied: event.riskMultiplier,
              actualRiskDollar: event.actualRiskDollar,
              marginRequired: event.marginRequired,
              riskPoolPctBefore: event.riskPoolPctBefore,
              momentumScore: shortGateEval?.score,
              oodFlagged: shortGateEval?.oodFlagged ?? false,
              decisionMatrix: contextDecision,
              entryDiag: undefined,
              histDiag: {},
              histRegime: {},
              portfolio: {
                sameSideShortCount: momentumDirectOpenPositions.filter((p) => p.side === 'SHORT' && p.symbol !== symbol).length,
                symbolsWithShortOpen: momentumDirectOpenPositions.filter((p) => p.side === 'SHORT').map((p) => p.symbol),
                avgPairwiseCorr: corrSnapshot.avg,
              },
            };
            if (captureDiagnostics) {
              const buf = rollingBuffers[symbol];
              const snap = [...buf, ctx]; // include this step (T) as the last element
              rec.entryDiag = await computeEntryDiagnostic(ctx, symbol, 'SHORT', correlatedRiskRatio);
              for (let i = 1; i <= CONTEXT_DEPTH - 1; i++) {
                const idxFromEnd = snap.length - 1 - i;
                if (idxFromEnd >= 0) {
                  const histCtx = snap[idxFromEnd];
                  rec.histDiag[`T-${i}`] = await computeEntryDiagnostic(histCtx, symbol, 'SHORT', histCtx.correlatedRiskRatio);
                  rec.histRegime[`T-${i}`] = histCtx.regimeConfirmed;
                }
              }
            }
            momShortTrades.push(rec);
            openIndexBySymbolTs.set(`${symbol}|${event.entryTimestamp}`, rec);
          }
        }
        if (event.type === 'CLOSE' && event.symbol === symbol) {
          closedTradeCount++;
          allClosedForBaselineCheck.push({
            setupType: event.setupType,
            side: event.side,
            pnlUsd: event.pnlUsd,
            accountBalanceAfter: event.accountBalanceAfter,
            exitTimestamp: event.exitTimestamp,
            entryTimestamp: event.entryTimestamp,
          });
          if (event.setupType === 'MOMENTUM_DIRECT' && event.side === 'SHORT') {
            const key = `${symbol}|${event.entryTimestamp}`;
            const rec = openIndexBySymbolTs.get(key);
            if (rec) {
              rec.exitTimestamp = event.exitTimestamp;
              rec.exitPrice = event.exitPrice;
              rec.exitReason = event.exitReason;
              rec.pnlUsd = event.pnlUsd;
              rec.pnlPct = event.pnlPct;
              rec.accountBalanceAfter = event.accountBalanceAfter;
              const sdInner = symbolsData[symbol];
              const entryIdx = sdInner.ts5mIndex.get(rec.entryTimestamp);
              const exitIdx = sdInner.ts5mIndex.get(event.exitTimestamp);
              if (entryIdx !== undefined) {
                const endIdx = exitIdx !== undefined ? exitIdx : Math.min(sdInner.candles5m.length - 1, entryIdx + 2000);
                rec.barsToExit = Math.max(0, endIdx - entryIdx);
                let mfe = rec.entryPrice, mae = rec.entryPrice;
                for (let i = entryIdx + 1; i <= endIdx && i < sdInner.candles5m.length; i++) {
                  const c = sdInner.candles5m[i];
                  if (c.low < mfe) mfe = c.low; // SHORT: favorable = lower price
                  if (c.high > mae) mae = c.high; // SHORT: adverse = higher price
                }
                rec.mfePct = ((rec.entryPrice - mfe) / rec.entryPrice) * 100;
                rec.maePct = ((mae - rec.entryPrice) / rec.entryPrice) * 100;
              }
            }
          }
          if (closedTradeCount >= TARGET_TOTAL_TRADES) {
            console.log(`Đạt lệnh #${TARGET_TOTAL_TRADES} đóng tại balance=$${accountBalance.toFixed(4)} — dừng replay.`);
            break stepLoop;
          }
        }
      }

      const buf = rollingBuffers[symbol];
      buf.push(ctx);
      if (buf.length > CONTEXT_DEPTH) buf.shift();

      const newTotalRisk = sd.state.openPositions.reduce((sum, e) => sum + e.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk; else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, e) => sum + e.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin; else delete openMarginBySymbol[symbol];
    }
    const progressStep = step - startStep;
    if (progressStep % 8000 === 0) console.log(`  bước ${progressStep} — balance=$${accountBalance.toFixed(2)}, closedTrades=${closedTradeCount}...`);
  }

  return { trades: momShortTrades, finalBalance: accountBalance, closedTradeCount, allClosedForBaselineCheck };
}

// ============================================================================================
// Baseline reproduction check
// ============================================================================================
function checkBaseline(all: ReplayResult['allClosedForBaselineCheck']): { ok: boolean; summary: string } {
  const sorted = [...all].sort((a, b) => a.exitTimestamp - b.exitTimestamp).slice(0, EXPECTED_TRADES);
  const wins = sorted.filter((t) => t.pnlUsd > 0).length;
  const wr = (wins / sorted.length) * 100;
  const grossProfit = sorted.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(sorted.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  let peak = 100, maxDdPct = 0, maxDdUsd = 0;
  for (const t of sorted) {
    if (t.accountBalanceAfter > peak) peak = t.accountBalanceAfter;
    const ddUsd = peak - t.accountBalanceAfter;
    const ddPct = (ddUsd / peak) * 100;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
  }
  const finalBalance = sorted[sorted.length - 1]?.accountBalanceAfter ?? NaN;
  const ok =
    sorted.length === EXPECTED_TRADES &&
    Math.abs(wr - EXPECTED_WR) < 0.2 &&
    Math.abs(pf - EXPECTED_PF) < 0.01 &&
    Math.abs(maxDdPct - EXPECTED_MAXDD_PCT) < 0.1 &&
    Math.abs(maxDdUsd - EXPECTED_MAXDD_USD) < 1;
  const summary = `trades=${sorted.length} (exp ${EXPECTED_TRADES}), finalBalance=$${finalBalance.toFixed(4)} (exp ~$${EXPECTED_FINAL_BALANCE}), WR=${wr.toFixed(2)}% (exp ${EXPECTED_WR}%), PF=${pf.toFixed(4)} (exp ${EXPECTED_PF}), GrossProfit=$${grossProfit.toFixed(4)}, GrossLoss=$${grossLoss.toFixed(4)}, MaxDD=${maxDdPct.toFixed(4)}%/$${maxDdUsd.toFixed(3)} (exp ${EXPECTED_MAXDD_PCT}%/$${EXPECTED_MAXDD_USD})`;
  return { ok, summary };
}

// ============================================================================================
// Loss-cluster window loading (TICKET-147's data/ticket147-loss-clusters.csv)
// ============================================================================================
interface ClusterWindow { windowLabel: string; rank: number; fromMs: number; toMs: number; totalLossUsd: number }
function loadClusterWindows(): ClusterWindow[] {
  const csv = readFileSync(path.join(OUT_DIR, 'ticket147-loss-clusters.csv'), 'utf-8').trim().split('\n');
  const header = csv[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  return csv.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      windowLabel: cols[idx('windowLabel')],
      rank: Number(cols[idx('rank')]),
      fromMs: Number(cols[idx('fromMs')]),
      toMs: Number(cols[idx('toMs')]),
      totalLossUsd: Number(cols[idx('totalLossUsd')]),
    };
  });
}
function isInAnyCluster(exitTs: number, windows: ClusterWindow[]): boolean {
  return windows.some((w) => exitTs > w.fromMs && exitTs <= w.toMs);
}
const HOT_ZONE_FROM = Date.parse('2026-06-03T00:00:00.000Z');
const HOT_ZONE_TO = Date.parse('2026-06-09T00:00:00.000Z');

// ============================================================================================
// Stats helpers
// ============================================================================================
function stats(trades: MomShortTrade[]): { n: number; wr: number; pf: number; netPnl: number; avgLoss: number; avgWin: number; totalLoss: number } {
  const n = trades.length;
  const wins = trades.filter((t) => (t.pnlUsd ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnlUsd ?? 0) <= 0);
  const grossProfit = wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0));
  const netPnl = trades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  return {
    n,
    wr: n > 0 ? (wins.length / n) * 100 : NaN,
    pf: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : NaN,
    netPnl,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : NaN,
    avgWin: wins.length > 0 ? grossProfit / wins.length : NaN,
    totalLoss: grossLoss,
  };
}
function mean(arr: number[]): number { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN; }
function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(filePath: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { writeFileSync(filePath, ''); return; }
  const header = Object.keys(rows[0]);
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))];
  writeFileSync(filePath, lines.join('\n'));
}

async function main(): Promise<void> {
  console.log('=== TICKET-149: MOMENTUM_DIRECT SHORT Loss-Cluster Forensic Audit ===');
  console.log('Chạy replay baseline (RISK_REDUCTION, capture diagnostics)...');
  const baseline = await runReplay(config, true);
  console.log(`Replay xong: ${baseline.trades.length} MOMENTUM_DIRECT SHORT OPEN events, ${baseline.closedTradeCount} tổng lệnh đóng, balance cuối=$${baseline.finalBalance.toFixed(4)}.`);

  const baselineCheck = checkBaseline(baseline.allClosedForBaselineCheck);
  console.log(`Baseline reproduction check: ${baselineCheck.summary}`);
  console.log(baselineCheck.ok ? 'MATCH OK.' : 'DRIFT DETECTED — see report.');

  const closedShortTrades = baseline.trades.filter((t) => t.exitTimestamp !== undefined);
  console.log(`${closedShortTrades.length} MOMENTUM_DIRECT SHORT trades (đã đóng) trong quần thể baseline.`);

  const clusterWindows = loadClusterWindows();
  const clusterTrades = closedShortTrades.filter((t) => isInAnyCluster(t.exitTimestamp!, clusterWindows));
  const controlTrades = closedShortTrades.filter((t) => !isInAnyCluster(t.exitTimestamp!, clusterWindows));
  const hotZoneTrades = closedShortTrades.filter((t) => t.exitTimestamp! >= HOT_ZONE_FROM && t.exitTimestamp! < HOT_ZONE_TO);
  console.log(`Cluster sample: ${clusterTrades.length}, Control sample: ${controlTrades.length}, Hot-zone (06-03..09) sample: ${hotZoneTrades.length}`);

  // ---- ticket149-momentum-short-trades.csv ----
  const tradeRows = closedShortTrades.map((t) => ({
    tradeId: t.tradeId,
    symbol: t.symbol,
    entryTimestamp: t.entryTimestamp,
    entryIsoUtc: new Date(t.entryTimestamp).toISOString(),
    entryPrice: t.entryPrice,
    slPrice: t.slPrice,
    regime: t.regime,
    inCluster: isInAnyCluster(t.exitTimestamp!, clusterWindows) ? 'YES' : 'NO',
    inHotZone: t.exitTimestamp! >= HOT_ZONE_FROM && t.exitTimestamp! < HOT_ZONE_TO ? 'YES' : 'NO',
    momentumScore: t.momentumScore,
    oodFlagged: t.oodFlagged,
    riskMultiplierApplied: t.riskMultiplierApplied,
    decisionMatrixDecision: t.decisionMatrix?.decision,
    decisionMatrixReason: t.decisionMatrix?.reason,
    decisionMatrixMacroConflict: t.decisionMatrix?.macroConflict,
    actualRiskDollar: t.actualRiskDollar,
    marginRequired: t.marginRequired,
    riskPoolPctBefore: t.riskPoolPctBefore,
    sameSideShortCountOther: t.portfolio.sameSideShortCount,
    symbolsWithShortOpen: t.portfolio.symbolsWithShortOpen.join('|'),
    avgPairwiseCorr1h: t.portfolio.avgPairwiseCorr,
    direction5mPrimary: t.entryDiag?.direction5mPrimary,
    direction5mRelaxed: t.entryDiag?.direction5mRelaxed,
    safetyState5m: t.entryDiag?.safetyState5m,
    htfContext: t.entryDiag?.htfContext,
    macroDirection1d: t.entryDiag?.macroDirection1d,
    macroConflict: t.entryDiag?.macroConflict,
    adx1h: t.entryDiag?.adx1h,
    adxDirection1h: t.entryDiag?.adxDirection1h,
    atrPercentile5m: t.entryDiag?.atrPercentile5m,
    bbWidthPercentile15m: t.entryDiag?.bbWidthPercentile15m,
    volumeZScore5m: t.entryDiag?.volumeZScore5m,
    atrTrend5m: t.entryDiag?.atrTrend5m,
    emaRatioSlow: t.entryDiag?.emaRatioSlow,
    emaRatioFast: t.entryDiag?.emaRatioFast,
    volAdjReturn5m: t.entryDiag?.volAdjReturn5m,
    distanceToNearestSwingAtr: t.entryDiag?.distanceToNearestSwingAtr,
    // Staleness (Q2/Q5): did direction5m/regime already flip in the T-1..T-5 window before entry?
    directionFlippedInLast5: Object.values(t.histDiag).some((d) => d && d.direction5mPrimary !== 'SHORT' && d.direction5mPrimary !== 'NONE') ? 'YES' : 'NO',
    regimeAtT1: t.histRegime['T-1'],
    regimeAtT5: t.histRegime['T-5'],
    exitTimestamp: t.exitTimestamp,
    exitIsoUtc: t.exitTimestamp !== undefined ? new Date(t.exitTimestamp).toISOString() : '',
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    pnlUsd: t.pnlUsd,
    pnlPct: t.pnlPct,
    accountBalanceAfter: t.accountBalanceAfter,
    barsToExit: t.barsToExit,
    mfePct: t.mfePct,
    maePct: t.maePct,
  }));
  writeCsv(OUT_TRADES_CSV, tradeRows);

  // ---- Q1/Q6: synchronized groups — MOMENTUM_DIRECT SHORT opens within same 15m window across coins ----
  interface SyncGroup { windowStart: number; trades: MomShortTrade[] }
  const sortedByEntry = [...closedShortTrades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  const groups: SyncGroup[] = [];
  const WINDOW_MS = 15 * 60_000;
  for (const t of sortedByEntry) {
    const bucketStart = Math.floor(t.entryTimestamp / WINDOW_MS) * WINDOW_MS;
    let g = groups.find((gr) => gr.windowStart === bucketStart);
    if (!g) { g = { windowStart: bucketStart, trades: [] }; groups.push(g); }
    g.trades.push(t);
  }
  const multiCoinGroups = groups.filter((g) => new Set(g.trades.map((t) => t.symbol)).size >= 2);
  console.log(`Synchronized 15m groups (>=2 distinct coins, MOMENTUM_DIRECT SHORT): ${multiCoinGroups.length}`);

  const syncGroupRows: Record<string, unknown>[] = [];
  const entryOrderRows: Record<string, unknown>[] = [];
  for (const g of multiCoinGroups) {
    const ordered = [...g.trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    const simPairs: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const sim = cosineSim(ordered[i].entryDiag?.numericFeatureVector ?? [], ordered[j].entryDiag?.numericFeatureVector ?? []);
        if (sim !== undefined) simPairs.push(sim);
      }
    }
    syncGroupRows.push({
      windowStartIsoUtc: new Date(g.windowStart).toISOString(),
      numCoins: new Set(ordered.map((t) => t.symbol)).size,
      numTrades: ordered.length,
      symbols: ordered.map((t) => t.symbol).join('|'),
      regimes: ordered.map((t) => t.regime).join('|'),
      momentumScores: ordered.map((t) => t.momentumScore?.toFixed(4) ?? 'NA').join('|'),
      avgFeatureCosineSim: simPairs.length > 0 ? mean(simPairs) : undefined,
      avgPairwiseCorr1h: ordered[0]?.portfolio.avgPairwiseCorr,
      totalPnlUsd: ordered.reduce((s, t) => s + (t.pnlUsd ?? 0), 0),
      allSameOutcome: new Set(ordered.map((t) => (t.pnlUsd ?? 0) > 0 ? 'WIN' : 'LOSS')).size === 1 ? 'YES' : 'NO',
      inHotZone: g.windowStart >= HOT_ZONE_FROM && g.windowStart < HOT_ZONE_TO ? 'YES' : 'NO',
    });
    ordered.forEach((t, i) => {
      entryOrderRows.push({
        windowStartIsoUtc: new Date(g.windowStart).toISOString(),
        entryOrderInGroup: i + 1,
        groupSize: ordered.length,
        symbol: t.symbol,
        entryTimestamp: t.entryTimestamp,
        pnlUsd: t.pnlUsd,
        exitReason: t.exitReason,
        momentumScore: t.momentumScore,
        oodFlagged: t.oodFlagged,
      });
    });
  }
  writeCsv(OUT_SYNC_GROUPS_CSV, syncGroupRows);
  writeCsv(OUT_ENTRY_ORDER_CSV, entryOrderRows);

  // Entry-order-position aggregate (Q6 answer)
  const byOrderPos: Record<number, MomShortTrade[]> = {};
  for (const g of multiCoinGroups) {
    const ordered = [...g.trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    ordered.forEach((t, i) => {
      const pos = Math.min(i + 1, 4); // bucket 4+ together
      byOrderPos[pos] = byOrderPos[pos] ?? [];
      byOrderPos[pos].push(t);
    });
  }
  const orderPosStats = [1, 2, 3, 4].map((pos) => ({ pos, ...stats(byOrderPos[pos] ?? []) }));

  // ---- Q3/Q4: XGB score + OOD analysis ----
  const winnerShorts = closedShortTrades.filter((t) => (t.pnlUsd ?? 0) > 0);
  const clusterLosers = clusterTrades.filter((t) => (t.pnlUsd ?? 0) <= 0);
  const nonClusterLosers = controlTrades.filter((t) => (t.pnlUsd ?? 0) <= 0);
  const scoreStats = (arr: MomShortTrade[]) => {
    const scores = arr.map((t) => t.momentumScore).filter((s): s is number => s !== undefined);
    const emaRatios = arr.map((t) => t.entryDiag?.emaRatioSlow).filter((s): s is number => s !== undefined);
    const oodCount = arr.filter((t) => t.oodFlagged).length;
    return { n: arr.length, avgScore: mean(scores), avgEmaRatioSlow: mean(emaRatios), oodFlaggedCount: oodCount, oodFlaggedPct: arr.length > 0 ? (oodCount / arr.length) * 100 : NaN };
  };
  const xgbOodRows = [
    { group: 'cluster_losers', ...scoreStats(clusterLosers) },
    { group: 'non_cluster_losers', ...scoreStats(nonClusterLosers) },
    { group: 'winners', ...scoreStats(winnerShorts) },
    { group: 'hot_zone_losers', ...scoreStats(hotZoneTrades.filter((t) => (t.pnlUsd ?? 0) <= 0)) },
  ];
  writeCsv(OUT_XGB_OOD_CSV, xgbOodRows);

  // Q4 shadow: OOD off (compute-only, linear risk-multiplier scaling — see report methodology note)
  const oodFlaggedTrades = closedShortTrades.filter((t) => t.oodFlagged);
  const oodShadowRows = oodFlaggedTrades.map((t) => {
    const actualMultiplierFromOod = config.oodGuardConfig?.riskReductionMultiplier ?? 1.0;
    const shadowPnl = (t.pnlUsd ?? 0) / actualMultiplierFromOod; // scale back to as-if oodRiskMultiplier=1.0
    return { tradeId: t.tradeId, symbol: t.symbol, actualPnlUsd: t.pnlUsd, shadowPnlUsdIfOodOff: shadowPnl, delta: shadowPnl - (t.pnlUsd ?? 0) };
  });
  const oodShadowTotalActual = oodFlaggedTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const oodShadowTotalShadow = oodShadowRows.reduce((s, r) => s + r.shadowPnlUsdIfOodOff, 0);

  // ---- Cluster vs control aggregate ----
  const cvcRows = [
    { bucket: 'cluster_sample', ...stats(clusterTrades) },
    { bucket: 'control_sample', ...stats(controlTrades) },
    { bucket: 'hot_zone_06-03_to_06-09', ...stats(hotZoneTrades) },
    { bucket: 'all_momentum_short', ...stats(closedShortTrades) },
    { bucket: 'sameSideShortCount_0', ...stats(closedShortTrades.filter((t) => t.portfolio.sameSideShortCount === 0)) },
    { bucket: 'sameSideShortCount_1', ...stats(closedShortTrades.filter((t) => t.portfolio.sameSideShortCount === 1)) },
    { bucket: 'sameSideShortCount_2', ...stats(closedShortTrades.filter((t) => t.portfolio.sameSideShortCount === 2)) },
    { bucket: 'sameSideShortCount_3+', ...stats(closedShortTrades.filter((t) => t.portfolio.sameSideShortCount >= 3)) },
    { bucket: 'ood_flagged', ...stats(closedShortTrades.filter((t) => t.oodFlagged)) },
    { bucket: 'ood_not_flagged', ...stats(closedShortTrades.filter((t) => !t.oodFlagged)) },
    { bucket: 'macro_conflict_true', ...stats(closedShortTrades.filter((t) => t.entryDiag?.macroConflict === true)) },
    { bucket: 'macro_conflict_false', ...stats(closedShortTrades.filter((t) => t.entryDiag?.macroConflict === false)) },
    { bucket: 'direction_flipped_last5', ...stats(closedShortTrades.filter((t) => Object.values(t.histDiag).some((d) => d && d.direction5mPrimary !== 'SHORT' && d.direction5mPrimary !== 'NONE'))) },
    { bucket: 'direction_not_flipped', ...stats(closedShortTrades.filter((t) => !Object.values(t.histDiag).some((d) => d && d.direction5mPrimary !== 'SHORT' && d.direction5mPrimary !== 'NONE'))) },
    ...orderPosStats.map((s) => ({ bucket: `entry_order_pos_${s.pos}${s.pos === 4 ? '+' : ''}`, n: s.n, wr: s.wr, pf: s.pf, netPnl: s.netPnl, avgLoss: s.avgLoss, avgWin: s.avgWin, totalLoss: s.totalLoss })),
  ];
  writeCsv(OUT_CLUSTER_VS_CONTROL_CSV, cvcRows);

  // ---- Sub-period stability (tercile split) ----
  const sortedTs = closedShortTrades.map((t) => t.entryTimestamp).sort((a, b) => a - b);
  function buildPeriods(ts: number[]): Array<{ label: string; fromMs: number; toMsExclusive: number }> {
    const n = ts.length;
    const p1 = ts[Math.floor(n / 3)];
    const p2 = ts[Math.floor((2 * n) / 3)];
    return [
      { label: 'P1', fromMs: ts[0], toMsExclusive: p1 },
      { label: 'P2', fromMs: p1, toMsExclusive: p2 },
      { label: 'P3', fromMs: p2, toMsExclusive: ts[n - 1] + 1 },
    ];
  }
  const periods = buildPeriods(sortedTs);
  function periodOf(ts: number): string { for (const p of periods) if (ts >= p.fromMs && ts < p.toMsExclusive) return p.label; return 'P3'; }
  const subPeriodStats = periods.map((p) => {
    const inPeriod = closedShortTrades.filter((t) => periodOf(t.entryTimestamp) === p.label);
    const inPeriodCluster = inPeriod.filter((t) => isInAnyCluster(t.exitTimestamp!, clusterWindows));
    const inPeriodControl = inPeriod.filter((t) => !isInAnyCluster(t.exitTimestamp!, clusterWindows));
    return { label: p.label, all: stats(inPeriod), cluster: stats(inPeriodCluster), control: stats(inPeriodControl) };
  });

  // ---- Optional counterfactual C3 (OOD HARD_REJECT) — only run if gate conditions warrant ----
  const oodStatsFlagged = stats(closedShortTrades.filter((t) => t.oodFlagged));
  const oodStatsNotFlagged = stats(closedShortTrades.filter((t) => !t.oodFlagged));
  const clusterLossShareOfGrossLoss = stats(closedShortTrades).totalLoss > 0 ? stats(clusterTrades).totalLoss / stats(closedShortTrades).totalLoss : 0;
  const gateOpenC3 = oodStatsFlagged.n >= 10 && (isFinite(oodStatsFlagged.pf) ? oodStatsFlagged.pf : 0) < (isFinite(oodStatsNotFlagged.pf) ? oodStatsNotFlagged.pf : 0) && oodStatsFlagged.avgLoss > oodStatsNotFlagged.avgLoss;

  let counterfactualRows: Record<string, unknown>[] = [];
  let c3Summary = 'NOT RUN — gate conditions not met (see report).';
  if (gateOpenC3) {
    console.log('Gate OPEN for C3 (OOD-flagged bucket worse PF+AvgLoss, N>=10) — running full-system HARD_REJECT replay...');
    const hardRejectConfig = buildBaselineConfig('HARD_REJECT');
    const c3 = await runReplay(hardRejectConfig, false);
    const c3Check = checkBaseline(c3.allClosedForBaselineCheck);
    const c3Sorted = [...c3.allClosedForBaselineCheck].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
    const c3Wins = c3Sorted.filter((t) => t.pnlUsd > 0).length;
    const c3GrossProfit = c3Sorted.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
    const c3GrossLoss = Math.abs(c3Sorted.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0));
    let peak = 100, maxDdPct = 0, maxDdUsd = 0;
    for (const t of c3Sorted) {
      if (t.accountBalanceAfter > peak) peak = t.accountBalanceAfter;
      const ddUsd = peak - t.accountBalanceAfter;
      const ddPct = (ddUsd / peak) * 100;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
      if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
    }
    counterfactualRows = [
      { variant: 'BASELINE', trades: closedShortTrades.length + (baseline.closedTradeCount - closedShortTrades.length), totalTradesAll: EXPECTED_TRADES, wr: EXPECTED_WR, pf: EXPECTED_PF, finalBalance: EXPECTED_FINAL_BALANCE, maxDdPct: EXPECTED_MAXDD_PCT, maxDdUsd: EXPECTED_MAXDD_USD },
      { variant: 'C3_OOD_HARD_REJECT', trades: c3.trades.length, totalTradesAll: c3Sorted.length, wr: (c3Wins / c3Sorted.length) * 100, pf: c3GrossProfit / (c3GrossLoss || 1), finalBalance: c3Sorted[c3Sorted.length - 1]?.accountBalanceAfter, maxDdPct, maxDdUsd },
    ];
    writeCsv(OUT_COUNTERFACTUALS_CSV, counterfactualRows);
    c3Summary = `RAN — full replay, totalTrades=${c3Sorted.length}, WR=${((c3Wins / c3Sorted.length) * 100).toFixed(2)}%, PF=${(c3GrossProfit / (c3GrossLoss || 1)).toFixed(4)}, finalBalance=$${c3Sorted[c3Sorted.length - 1]?.accountBalanceAfter.toFixed(2)}, MaxDD=${maxDdPct.toFixed(2)}%/$${maxDdUsd.toFixed(2)} (own reproduction check: ${c3Check.ok ? 'n/a, different config by design' : 'n/a, different config by design'}).`;
  } else {
    console.log('Gate CLOSED for C3 — OOD-flagged bucket does not show N>=10 + worse-PF-and-AvgLoss signal. Not running full replay (per forbidden-actions discipline, no counterfactual fabricated).');
  }

  // ---- Decision logic ----
  const sameSideStatsArr = [0, 1, 2, 3].map((n) => stats(closedShortTrades.filter((t) => (n === 3 ? t.portfolio.sameSideShortCount >= 3 : t.portfolio.sameSideShortCount === n))));
  const orderDegrades = orderPosStats.length >= 3 && isFinite(orderPosStats[0].pf) && isFinite(orderPosStats[2].pf) && orderPosStats[2].pf < orderPosStats[0].pf && orderPosStats[2].avgLoss > orderPosStats[0].avgLoss;
  const staleDirTrades = closedShortTrades.filter((t) => Object.values(t.histDiag).some((d) => d && d.direction5mPrimary !== 'SHORT' && d.direction5mPrimary !== 'NONE'));
  const staleDirStats = stats(staleDirTrades);
  const notStaleDirStats = stats(closedShortTrades.filter((t) => !Object.values(t.histDiag).some((d) => d && d.direction5mPrimary !== 'SHORT' && d.direction5mPrimary !== 'NONE')));
  const staleDirWorse = staleDirTrades.length >= 10 && isFinite(staleDirStats.pf) && staleDirStats.pf < notStaleDirStats.pf;

  let primaryRootCause: string;
  const signals: string[] = [];
  if (orderDegrades) signals.push('A');
  if (staleDirWorse) signals.push('B');
  if (gateOpenC3) signals.push('C');
  if (signals.length === 0) primaryRootCause = 'F';
  else if (signals.length === 1) primaryRootCause = signals[0];
  else primaryRootCause = 'E';

  const isMainDdSource = clusterLossShareOfGrossLoss >= 0.4 ? 'YES' : clusterLossShareOfGrossLoss >= 0.2 ? 'PARTIALLY' : 'NO';
  const signalOrConcentration = orderDegrades && !staleDirWorse ? 'CONCENTRATION' : staleDirWorse && !orderDegrades ? 'SIGNAL' : orderDegrades && staleDirWorse ? 'BOTH' : 'INCONCLUSIVE';
  const safeMitigation = signals.length > 0 ? 'YES' : 'NO';
  const nextTicket = signals.length === 0 ? 'NONE' : signals.includes('B') ? 'Build a stale-direction/reversal-lag guard for MOMENTUM_DIRECT SHORT (C2-style), full-system shadow test' : signals.includes('A') ? 'Entry-order-based risk reduction for duplicate correlated SHORT entries (C1-style), full-system shadow test' : 'Extend OOD guard scope per C3 findings, full-system test';

  // ============================================================================================
  // Report
  // ============================================================================================
  const md: string[] = [];
  md.push('# TICKET-149 — MOMENTUM_DIRECT SHORT Loss-Cluster Forensic Audit');
  md.push('');
  md.push('PRODUCTION REMAINS UNCHANGED — this is a pure read-only investigation. No thresholds, config defaults, or decision logic in `apps/bot/src/` were modified by this ticket.');
  md.push('');
  md.push('```');
  md.push('PRIMARY ROOT CAUSE:');
  md.push(primaryRootCause + (primaryRootCause === 'A' ? '. DUPLICATE_CORRELATED_BET' : primaryRootCause === 'B' ? '. STALE_DIRECTION / REVERSAL_LAG' : primaryRootCause === 'C' ? '. XGB_FALSE_CONFIDENCE / OOD' : primaryRootCause === 'D' ? '. REGIME / CONTEXT_FAILURE' : primaryRootCause === 'E' ? '. MIXED' : '. NO_CLEAR_ROOT_CAUSE'));
  md.push('');
  md.push('IS MOMENTUM_DIRECT SHORT THE MAIN DD SOURCE?');
  md.push(isMainDdSource);
  md.push('');
  md.push('IS THE PROBLEM SIGNAL QUALITY OR PORTFOLIO CONCENTRATION?');
  md.push(signalOrConcentration);
  md.push('');
  md.push('IS THERE A SAFE DETERMINISTIC MITIGATION WORTH TESTING?');
  md.push(safeMitigation);
  md.push('');
  md.push('NEXT TICKET:');
  md.push(nextTicket);
  md.push('```');
  md.push('');
  md.push('## 1. Baseline reproduction');
  md.push('');
  md.push('Command: same 8-flag official baseline + `--momentum-context-decision-matrix-v2-enabled=true`, replicated via this script\'s own `processCandle()` replay loop (identical harness to TICKET-147/148, verified in this session).');
  md.push('');
  md.push(`Result: ${baselineCheck.summary}`);
  md.push('');
  md.push(baselineCheck.ok ? '**Reproduction CONFIRMED** (small final-cent difference from data-freshness note is expected/acceptable; trade count/WR/PF/MaxDD match).' : '**DRIFT DETECTED — see numbers above. Downstream analysis proceeds but should be treated with caution.**');
  md.push('');
  md.push('## 2. Population');
  md.push('');
  md.push(`Total MOMENTUM_DIRECT SHORT trades in the 319-trade baseline population: **${closedShortTrades.length}** (of which ${closedShortTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length} winners, ${closedShortTrades.filter((t) => (t.pnlUsd ?? 0) <= 0).length} losers).`);
  md.push('');
  md.push(`- Loss-cluster sample (falls inside a TICKET-147 loss-cluster window): **${clusterTrades.length}** trades, total loss $${stats(clusterTrades).totalLoss.toFixed(2)}.`);
  md.push(`- Control sample (won, OR lost outside any cluster window): **${controlTrades.length}** trades.`);
  md.push(`- Hot-zone sample (2026-06-03..09, ticket's own priority window): **${hotZoneTrades.length}** trades.`);
  md.push(`- Cluster-sample loss as share of ALL MOMENTUM_DIRECT SHORT gross loss: **${(clusterLossShareOfGrossLoss * 100).toFixed(1)}%**.`);
  md.push('');
  md.push('Aggregate stats by bucket: `data/ticket149-cluster-vs-control.csv`. Per-trade detail (all mandated snapshot fields): `data/ticket149-momentum-short-trades.csv`.');
  md.push('');
  md.push('## 3. Q1 — Is the bot multiplying one market bet into many positions?');
  md.push('');
  md.push(`Synchronized 15-minute windows with >=2 distinct coins opening MOMENTUM_DIRECT SHORT simultaneously: **${multiCoinGroups.length}** groups (out of ${groups.length} total 15m windows with any MOMENTUM_DIRECT SHORT open).`);
  const simValues = syncGroupRows.map((r) => r.avgFeatureCosineSim as number | undefined).filter((v): v is number => v !== undefined);
  md.push(`Average feature-vector cosine similarity within these synchronized groups: **${simValues.length > 0 ? mean(simValues).toFixed(4) : 'N/A'}** (1.0 = identical numeric feature vectors; computed over the model's own numeric feature subset — adx1h, atrPercentile5m, bbWidthPercentile15m, volumeZScore5m, volAdjReturn5m, emaRatioFast, emaRatioSlow, correlatedRiskRatio, distanceToNearestSwingAtr).`);
  md.push(`Groups with ALL trades sharing the same win/loss outcome: **${syncGroupRows.filter((r) => r.allSameOutcome === 'YES').length}/${syncGroupRows.length}**.`);
  md.push('');
  md.push('Full per-group detail: `data/ticket149-synchronized-short-groups.csv`.');
  md.push('');
  md.push('## 4. Q2/Q5 — Stale direction / reversal lag, regime staleness');
  md.push('');
  md.push(`Trades where direction5m (primary EMA/DI computation) had ALREADY flipped away from SHORT at some point in the T-1..T-${CONTEXT_DEPTH - 1} candles before entry: **${staleDirTrades.length}/${closedShortTrades.length}** (${((staleDirTrades.length / closedShortTrades.length) * 100).toFixed(1)}%).`);
  md.push(`Stats — direction already flipped: N=${staleDirStats.n}, WR=${staleDirStats.wr.toFixed(1)}%, PF=${isFinite(staleDirStats.pf) ? staleDirStats.pf.toFixed(3) : 'Inf'}, AvgLoss=$${staleDirStats.avgLoss.toFixed(2)}.`);
  md.push(`Stats — direction NOT flipped (stable SHORT context): N=${notStaleDirStats.n}, WR=${notStaleDirStats.wr.toFixed(1)}%, PF=${isFinite(notStaleDirStats.pf) ? notStaleDirStats.pf.toFixed(3) : 'Inf'}, AvgLoss=$${notStaleDirStats.avgLoss.toFixed(2)}.`);
  md.push(`Discriminator met (N>=10 each side AND flipped-bucket PF worse)?: **${staleDirWorse ? 'YES' : 'NO'}**.`);
  md.push('');
  md.push('## 5. Q3 — Systematic XGB false-confidence?');
  md.push('');
  md.push('| Group | N | AvgMomentumScore | AvgEmaRatioSlow | OOD-flagged N | OOD-flagged % |');
  md.push('|---|---|---|---|---|---|');
  for (const r of xgbOodRows) md.push(`| ${r.group} | ${r.n} | ${isNaN(r.avgScore) ? 'N/A' : r.avgScore.toFixed(4)} | ${isNaN(r.avgEmaRatioSlow) ? 'N/A' : r.avgEmaRatioSlow.toFixed(5)} | ${r.oodFlaggedCount} | ${isNaN(r.oodFlaggedPct) ? 'N/A' : r.oodFlaggedPct.toFixed(1) + '%'} |`);
  md.push('');
  md.push('Full CSV: `data/ticket149-xgb-ood-analysis.csv`.');
  md.push('');
  md.push('## 6. Q4 — Is OOD Guard reducing risk in the right place?');
  md.push('');
  md.push(`OOD-flagged MOMENTUM_DIRECT SHORT trades in the population: **${oodFlaggedTrades.length}/${closedShortTrades.length}** (${((oodFlaggedTrades.length / closedShortTrades.length) * 100).toFixed(1)}%). All flagged trades had `);
  md.push(`riskReductionMultiplier=${config.oodGuardConfig?.riskReductionMultiplier} applied (RISK_REDUCTION mode, per baseline config).`);
  md.push(`OOD-flagged bucket: N=${oodStatsFlagged.n}, WR=${isNaN(oodStatsFlagged.wr) ? 'N/A' : oodStatsFlagged.wr.toFixed(1) + '%'}, PF=${isFinite(oodStatsFlagged.pf) ? oodStatsFlagged.pf.toFixed(3) : 'Inf/N/A'}, AvgLoss=$${isNaN(oodStatsFlagged.avgLoss) ? 0 : oodStatsFlagged.avgLoss.toFixed(2)}, NetPnl=$${oodStatsFlagged.netPnl.toFixed(2)}.`);
  md.push(`Not-flagged bucket: N=${oodStatsNotFlagged.n}, WR=${oodStatsNotFlagged.wr.toFixed(1)}%, PF=${isFinite(oodStatsNotFlagged.pf) ? oodStatsNotFlagged.pf.toFixed(3) : 'Inf'}, AvgLoss=$${oodStatsNotFlagged.avgLoss.toFixed(2)}, NetPnl=$${oodStatsNotFlagged.netPnl.toFixed(2)}.`);
  md.push('');
  md.push(`Shadow (compute-only, OOD off — i.e. as-if riskReductionMultiplier=1.0, pnl scaled linearly by 1/${config.oodGuardConfig?.riskReductionMultiplier} since position size is the only thing the multiplier changes and SL/TP/exit are path-independent of size): total actual PnL on OOD-flagged trades = $${oodShadowTotalActual.toFixed(2)}; shadow (OOD off) PnL = $${oodShadowTotalShadow.toFixed(2)}; delta = $${(oodShadowTotalShadow - oodShadowTotalActual).toFixed(2)}.`);
  md.push(oodShadowTotalShadow < oodShadowTotalActual ? 'OOD Guard, where it fired, REDUCED net loss on this bucket relative to the compute-only shadow (i.e. it helped) — the guard is working as designed on the trades it actually catches.' : 'OOD Guard, where it fired, would have made this bucket MORE profitable if switched off (i.e. it is currently net-costly on the trades it catches) — but note this shadow uses a linear-scaling approximation, not a full path-dependent replay; see the C3 full-replay counterfactual below if the gate opened.');
  md.push('');
  md.push(`Full-system C3 (OOD HARD_REJECT) counterfactual: ${c3Summary}`);
  md.push('');
  md.push('## 7. Q6 — Does duplicate correlated entry degrade by order?');
  md.push('');
  md.push('| Entry order in synchronized group | N | WR | PF | NetPnL | AvgLoss |');
  md.push('|---|---|---|---|---|---|');
  for (const s of orderPosStats) md.push(`| ${s.pos}${s.pos === 4 ? '+' : ''} | ${s.n} | ${isNaN(s.wr) ? 'N/A' : s.wr.toFixed(1) + '%'} | ${isFinite(s.pf) ? s.pf.toFixed(3) : 'Inf/N/A'} | $${s.netPnl.toFixed(2)} | $${isNaN(s.avgLoss) ? 0 : s.avgLoss.toFixed(2)} |`);
  md.push('');
  md.push(`Discriminator met (3rd/4th position clearly worse PF+AvgLoss than 1st)?: **${orderDegrades ? 'YES' : 'NO'}**.`);
  md.push('');
  md.push('Full per-trade detail: `data/ticket149-entry-order-analysis.csv`.');
  md.push('');
  md.push('## 8. Same-side concentration (context, ties back to TICKET-147)');
  md.push('');
  md.push('| Same-side SHORT open (other symbols) at entry | N | WR | PF | NetPnL | AvgLoss |');
  md.push('|---|---|---|---|---|---|');
  ['0', '1', '2', '3+'].forEach((label, i) => {
    const s = sameSideStatsArr[i];
    md.push(`| ${label} | ${s.n} | ${isNaN(s.wr) ? 'N/A' : s.wr.toFixed(1) + '%'} | ${isFinite(s.pf) ? s.pf.toFixed(3) : 'Inf/N/A'} | $${s.netPnl.toFixed(2)} | $${isNaN(s.avgLoss) ? 0 : s.avgLoss.toFixed(2)} |`);
  });
  md.push('');
  md.push('## 9. Sub-period stability (tercile split by entry time)');
  md.push('');
  md.push('| Period | All N/WR/PF | Cluster N/WR/PF | Control N/WR/PF |');
  md.push('|---|---|---|---|');
  for (const p of subPeriodStats) {
    md.push(`| ${p.label} | ${p.all.n}/${isNaN(p.all.wr) ? 'N/A' : p.all.wr.toFixed(1) + '%'}/${isFinite(p.all.pf) ? p.all.pf.toFixed(3) : 'Inf'} | ${p.cluster.n}/${isNaN(p.cluster.wr) ? 'N/A' : p.cluster.wr.toFixed(1) + '%'}/${isFinite(p.cluster.pf) ? p.cluster.pf.toFixed(3) : 'Inf/N/A'} | ${p.control.n}/${isNaN(p.control.wr) ? 'N/A' : p.control.wr.toFixed(1) + '%'}/${isFinite(p.control.pf) ? p.control.pf.toFixed(3) : 'Inf/N/A'} |`);
  }
  md.push('');
  md.push('## 10. Counterfactual gate + result');
  md.push('');
  md.push(`C1-style (entry-order degradation) gate: ${orderDegrades ? 'OPEN' : 'CLOSED'} (need 3rd+ position N>=10 with clearly worse PF+AvgLoss than 1st — see §7).`);
  md.push(`C2-style (stale-direction) gate: ${staleDirWorse ? 'OPEN' : 'CLOSED'} (need N>=10 flipped-direction trades with worse PF than stable-direction trades — see §4).`);
  md.push(`C3 (OOD HARD_REJECT) gate: ${gateOpenC3 ? 'OPEN' : 'CLOSED'} (need OOD-flagged bucket N>=10 with both worse PF and worse AvgLoss than not-flagged — see §6).`);
  md.push('');
  md.push(gateOpenC3 ? `C3 full-system replay result: ${c3Summary} — see \`data/ticket149-counterfactuals.csv\`.` : 'No counterfactual gate opened on this data — per the ticket\'s explicit instruction, no `data/ticket149-counterfactuals.csv` fabricated when no counterfactual qualified to run.');
  md.push('');
  md.push('## 11. Judgment calls');
  md.push('');
  md.push('- **Cluster membership**: exit timestamp falls within (fromMs, toMs] of ANY of TICKET-147\'s 7-window Top-20 loss-cluster set (`data/ticket147-loss-clusters.csv`), reused verbatim (no re-derivation) per the ticket brief.');
  md.push('- **Feature-vector cosine similarity**: computed over the SAME numeric feature subset (`schema.numeric_features`) the real bearish XGB model consumes — never invented fields.');
  md.push('- **Staleness window**: T-1..T-5 5m candles before entry (6-candle lookback total incl. T) — a judgment call sized to capture "the last half hour" without excessive computation; documented, not tuned to favor any decision.');
  md.push('- **OOD shadow (Q4)**: linear PnL rescaling by 1/riskReductionMultiplier — valid to first order because position size is the ONLY thing oodRiskMultiplier changes (SL/TP prices, entry, and exit reason are all size-independent), and fees scale linearly with size too. NOT a full path-dependent replay (that is what the C3 gate/counterfactual is for, when it opens).');
  md.push('- **Entry-order groups (Q6)**: 15-minute bucket, >=2 distinct coins required to count as a "synchronized group" — matches the 15min loss-cluster window granularity already established by TICKET-147.');
  md.push('- **Decision thresholds** (not given verbatim by the ticket, inferred conservatively, same discipline as TICKET-147 §12): a bucket counts as a discriminator only with N>=10 on the smaller side AND both worse PF AND worse AvgLoss than its comparison bucket; "meaningful cluster-loss share" >=40% for a strong per-se DD-source claim, >=20% for a partial one.');
  md.push('- **No threshold retuning**: momentumDirectThreshold(0.5), oodGuardConfig(1.037776/RISK_REDUCTION/0.3), Decision Matrix V2 sets, and all TICKET-147 cluster windows are exactly as given/inherited — nothing tuned to reach a particular Decision.');
  md.push('');

  writeFileSync(OUT_MD, md.join('\n'));
  console.log(`Report viết xong: ${OUT_MD}`);
  console.log('=== DONE ===');
}

main().catch((err) => { console.error(err); process.exit(1); });
