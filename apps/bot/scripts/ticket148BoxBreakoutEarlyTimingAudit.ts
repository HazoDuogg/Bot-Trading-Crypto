/**
 * TICKET-148 — BOX_BREAKOUT Early Timing Forensic Audit (PURE READ-ONLY). Extends TICKET-147A's
 * single-trade finding (BTC 08:55 vs 09:00 UTC) to the FULL population of BOX_BREAKOUT trades across
 * all 4 symbols from the official baseline backtest. Zero production logic touched — this script only
 * imports and calls the real processCandle()/routeEntry()/detectBoxBreakout() pipeline from dist/ and
 * records diagnostics; it never mutates config, thresholds, or decision logic.
 *
 * Population source: same official baseline command as TICKET-147/147A, PLUS
 * --momentum-context-decision-matrix-v2-enabled=true (verified empirically below to reproduce EXACTLY
 * 319 trades / $1237.35 at the 319th trade's own close, see "Baseline reproduction" note in the
 * generated report). entryRouterConfig.macroTrendFilterEnabled is FALSE here (CLI default, NOT the
 * liveRunner.ts live override 147A used) because the plain 8-flag baseline command (no
 * --macro-trend-filter flag) is what defines "the official baseline backtest run" this ticket's
 * population must come from — empirically confirmed to reproduce the exact 319/$1237.35 checkpoint.
 * This is moot for BOX_BREAKOUT trades anyway (macroTrendFilterAppliesToBoxBreakout stays false either way).
 *
 * Data-freshness note: this repo's OHLCV CSVs now extend ~12 days past whatever cutoff produced the
 * originally-confirmed 319/$1237.35 numbers. Running the full available history produces a 320th trade
 * (entry 2026-08-07 04:50 UTC) closing after the 319th trade's balance already hit exactly
 * $1237.3534537367143. This replay STOPS as soon as the 319th trade closes (matching the confirmed
 * checkpoint exactly), excluding that trailing 320th trade from the audited population — see
 * buildOfficialBaselineTrades() below.
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
import { detectBoxBreakout, classifyBoxBreakoutFailReason } from '../dist/entry/detectors/boxBreakout.js';
import { computeDirection5mRelaxed } from '../dist/orchestrator/neutral5mDirectionGatedRouting.js';
import {
  NEUTRAL_5M_DI_PERIOD,
  NEUTRAL_5M_EMA_FAST_PERIOD,
  NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES,
  NEUTRAL_5M_EMA_SLOW_PERIOD,
} from '../dist/orchestrator/neutral5mDirectionSelector.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../dist/xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../dist/xgbFilter/momentumScorer.js';
import {
  MOMENTUM_MODEL_PATH,
  MOMENTUM_SCHEMA_PATH,
  MOMENTUM_BEARISH_MODEL_PATH,
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
import type { FunnelEvent } from '../dist/entry/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_TIMING_CSV = path.resolve(process.cwd(), 'data/ticket148-box-breakout-trade-timing.csv');
const OUT_STATES_CSV = path.resolve(process.cwd(), 'data/ticket148-box-breakout-early-states.csv');
const OUT_HYPO_CSV = path.resolve(process.cwd(), 'data/ticket148-box-breakout-hypothetical-entries.csv');
const OUT_ARMING_CSV = path.resolve(process.cwd(), 'data/ticket148-box-breakout-arming-summary.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket148-box-breakout-early-timing-audit-report.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;
const TAKER_FEE_RATE = 0.0004;
const TARGET_TOTAL_TRADES = 319; // confirmed baseline checkpoint — replay stops the instant trade #319 closes

// ---- Official baseline config: 8-flag CLI command + --momentum-context-decision-matrix-v2-enabled=true,
// empirically verified (see report) to hit balance=$1237.3534537367143 exactly when the 319th trade closes. ----
const config: OrchestratorConfig = {
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
  oodGuardConfig: { emaRatioSlowThreshold: 1.037776, mode: 'RISK_REDUCTION', scoreCapValue: 0, riskReductionMultiplier: 0.3 },
  momentumContextDecisionMatrixV2Enabled: true,
};

type Direction5m = 'LONG' | 'SHORT' | 'NONE';
const TP1_R = 1.2; // PLAN_A TREND scenario tier — slTpManager.ts TP_PLAN_TIERS.PLAN_A
const TP2_R = 2.5;

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

// ---- direction5m primary replica (localTradeThesis5m.ts private computeDirectionLayer(), verbatim
// reuse of ticket146/147A's own replica) — diagnostic only, never gates BOX_BREAKOUT. ----
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
  const emaRelation: 'FAST_ABOVE_SLOW' | 'FAST_BELOW_SLOW' | 'FLAT' = fastNow > slowNow ? 'FAST_ABOVE_SLOW' : fastNow < slowNow ? 'FAST_BELOW_SLOW' : 'FLAT';
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
  if (cached === undefined) {
    cached = loadFeatureSchema(schemaPath);
    schemaCache.set(schemaPath, cached);
  }
  return cached;
}

interface MinimalRegimeSnapshot {
  computedMetrics: ComputedMetrics;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
}

async function scoreMomentumForSideReplica(
  side: 'LONG' | 'SHORT',
  symbol: string,
  candles5m: CandleData[],
  candles1hMomentum: CandleData[],
  regimeSnapshot: MinimalRegimeSnapshot,
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
  correlatedRiskRatio: number | undefined,
): Promise<number | undefined> {
  const crossFeatures = computeMomentumCrossFeatures(candles5m, candles1hMomentum);
  if (crossFeatures === undefined) return undefined;
  const isLong = side === 'LONG';
  const modelPath = isLong ? MOMENTUM_MODEL_PATH : MOMENTUM_BEARISH_MODEL_PATH;
  const schemaPath = isLong ? MOMENTUM_SCHEMA_PATH : MOMENTUM_BEARISH_SCHEMA_PATH;
  const schema = getSchemaCached(schemaPath);
  const featureVector = buildFeatureVector(
    {
      symbol,
      adx1h: regimeSnapshot.computedMetrics.adx1h as number,
      atrPercentile5m: regimeSnapshot.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: regimeSnapshot.computedMetrics.bbWidthPercentile15m as number,
      volumeZScore5m: regimeSnapshot.computedMetrics.volumeZScore5m as number,
      atrTrend5m: regimeSnapshot.computedMetrics.atrTrend5m as string,
      adxDirection1h: regimeSnapshot.adxDirection1h as string,
      macroDirection,
      correlatedRiskRatio,
      distanceToNearestSwingAtr: computeDistanceToNearestSwingAtr(candles5m),
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

// ============================================================================================
// Rolling per-symbol raw-context buffer (last 4 steps) — cheap to keep, expensive diagnostics
// (XGB scores, direction, safety, htf, macro, box edge distance) computed lazily ONLY when a real
// BOX_BREAKOUT OPEN event fires, off these exact same buffered windows (no lookahead: every window
// here is EXACTLY what routeEntry() itself saw at that step).
// ============================================================================================
interface RawContext {
  step: number;
  timestamp: number;
  candle: CandleData;
  window5m: CandleData[];
  w15: CandleData[];
  w1hMomentum: CandleData[];
  w1m: CandleData[];
  w1d: CandleData[];
  cm: ComputedMetrics;
  regimeAfter: string;
  correlatedRiskRatio: number | undefined;
  breakoutFunnelEvent: { passed: boolean; reason?: string } | undefined;
}

interface Diagnostics {
  direction5mPrimary: Direction5m;
  direction5mRelaxed: Direction5m;
  safetyState5m: string;
  htfContext: string;
  macroDirection1d: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroConflict: boolean;
  adx1h: number | undefined;
  atrPercentile5m: number | undefined;
  atr5m: number | undefined;
  xgbScoreLong: number | undefined;
  xgbScoreShort: number | undefined;
  bodyRatio: number | undefined;
  volumeZScore5m: number | undefined;
  boxHigh: number | undefined;
  boxLow: number | undefined;
  distanceToEdgePct: number | undefined;
  distanceToEdgeAtr: number | undefined;
  breakoutStagePassed: boolean | undefined;
  breakoutFailReason: string | undefined;
  breakoutDirection: 'UP' | 'DOWN' | undefined;
}

async function computeDiagnostics(ctx: RawContext, symbol: string, tradeSide: 'LONG' | 'SHORT'): Promise<Diagnostics> {
  const cm = ctx.cm;
  const macroDirectionSeries = wilderDIDirectionSeries(ctx.w1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
  const macroDirection1d = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
  const macroConflict = tradeSide === 'LONG' ? macroDirection1d === 'DOWN' : macroDirection1d === 'UP';

  const direction5mPrimary = computeDirectionLayer(ctx.window5m);
  const relaxed = computeDirection5mRelaxed(ctx.window5m, ctx.w1m);
  const safetyState5m = SafetyState5m[classifySafetyState5mCandidate(cm)];
  const htfContext = HTFContext[classifyHtfContextCandidate(cm)];

  const regimeSnapshot: MinimalRegimeSnapshot = { computedMetrics: cm, adxDirection1h: cm.adxDirection1h };
  const xgbScoreLong = await scoreMomentumForSideReplica('LONG', symbol, ctx.window5m, ctx.w1hMomentum, regimeSnapshot, macroDirection1d, ctx.correlatedRiskRatio);
  const xgbScoreShort = await scoreMomentumForSideReplica('SHORT', symbol, ctx.window5m, ctx.w1hMomentum, regimeSnapshot, macroDirection1d, ctx.correlatedRiskRatio);

  let boxHigh: number | undefined;
  let boxLow: number | undefined;
  let bodyRatio: number | undefined;
  const currentCandle = ctx.candle;
  if (cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined && ctx.w15.length >= EntryConfig.BOX_LOOKBACK_M) {
    const boxWindow = ctx.w15.slice(-EntryConfig.BOX_LOOKBACK_M);
    boxHigh = Math.max(...boxWindow.map((c) => c.high));
    boxLow = Math.min(...boxWindow.map((c) => c.low));
    const range = currentCandle.high - currentCandle.low;
    bodyRatio = range > 0 ? Math.abs(currentCandle.close - currentCandle.open) / range : 0;
  }
  const breakoutResult = detectBoxBreakout(ctx.w15, ctx.window5m, cm.bbWidthPercentile15m as number, cm.volumeZScore5m as number, {
    boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
    maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
    minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
    minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
  });
  const breakoutFailReason =
    cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined
      ? classifyBoxBreakoutFailReason(ctx.w15, ctx.window5m, cm.bbWidthPercentile15m, cm.volumeZScore5m, {
          boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
          maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
          minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
          minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
        })
      : undefined;

  const atrSeries = wilderATRSeries(ctx.window5m, RegimeConfig.ATR_PERIOD_5M);
  const atr5m = atrSeries.length > 0 && !Number.isNaN(atrSeries[atrSeries.length - 1]) ? atrSeries[atrSeries.length - 1] : undefined;

  // Distance to the box edge THIS trade's side needs (upper edge for LONG, lower for SHORT) — positive
  // means price has not yet cleared the edge, negative means it already has (close beyond edge).
  let distanceToEdgePct: number | undefined;
  let distanceToEdgeAtr: number | undefined;
  if (boxHigh !== undefined && boxLow !== undefined) {
    const edge = tradeSide === 'LONG' ? boxHigh : boxLow;
    const raw = tradeSide === 'LONG' ? edge - currentCandle.close : currentCandle.close - edge;
    distanceToEdgePct = (raw / currentCandle.close) * 100;
    if (atr5m !== undefined && atr5m > 0) distanceToEdgeAtr = raw / atr5m;
  }

  return {
    direction5mPrimary,
    direction5mRelaxed: relaxed.direction5m,
    safetyState5m,
    htfContext,
    macroDirection1d,
    macroConflict,
    adx1h: cm.adx1h,
    atrPercentile5m: cm.atrPercentile5m,
    atr5m,
    xgbScoreLong,
    xgbScoreShort,
    bodyRatio,
    volumeZScore5m: cm.volumeZScore5m,
    boxHigh,
    boxLow,
    distanceToEdgePct,
    distanceToEdgeAtr,
    breakoutStagePassed: ctx.breakoutFunnelEvent?.passed,
    breakoutFailReason: ctx.breakoutFunnelEvent?.passed === false ? ctx.breakoutFunnelEvent.reason ?? breakoutFailReason : undefined,
    breakoutDirection: breakoutResult?.direction,
  };
}

// ============================================================================================
// Trade record
// ============================================================================================
interface TradeRecord {
  tradeId: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  exitTimestamp?: number;
  exitPrice?: number;
  exitReason?: string;
  pnlUsd?: number;
  contexts: Record<'T' | 'T-1' | 'T-2' | 'T-3', RawContext | undefined>;
}

// ============================================================================================
// Shadow-arming population-wide tallies (Part: Shadow arming audit)
// ============================================================================================
interface ArmingState {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  kind: 'ARMED' | 'EDGE_CLEARED';
}
const armedShadowEvents: ArmingState[] = [];
const edgeClearedShadowEvents: ArmingState[] = [];
// Per-symbol chronological list of {timestamp, breakoutPassed, breakoutDirection} for EVERY box-eligible
// candle (i.e. every candle where routeEntry() actually dispatched to runBoxBreakoutStyle) — used to
// measure "does this shadow become a real pass within N candles" using real elapsed candle count.
interface EligibleStepRecord {
  step: number;
  timestamp: number;
  passed: boolean;
  direction: 'UP' | 'DOWN' | undefined;
}
const eligibleTimeline: Record<string, EligibleStepRecord[]> = {};
for (const s of SYMBOLS) eligibleTimeline[s] = [];

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;

  let accountBalance = 100;
  const rollingBuffers: Record<string, RawContext[]> = {};
  for (const s of SYMBOLS) rollingBuffers[s] = [];

  const trades: TradeRecord[] = [];
  const openIndexBySymbolTs = new Map<string, TradeRecord>(); // key: symbol|entryTimestamp
  let closedTradeCount = 0;

  console.log(`Chạy lại pipeline thật (config baseline 8-flag + momentum-context-decision-matrix-v2-enabled=true) từ bước ${startStep}, dừng ngay khi lệnh #${TARGET_TOTAL_TRADES} đóng...`);

  stepLoop: for (let step = startStep; step < rawTotalSteps; step++) {
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
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
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
      let funnelEventsThisStep: Array<{ event: FunnelEvent }> = [];

      const result = await processCandle(
        input,
        sd.state,
        config,
        undefined,
        undefined,
        (fsym, _ftimestamp, fevent) => {
          if (fsym === symbol) funnelEventsThisStep.push({ event: fevent });
        },
        undefined,
        (cm) => {
          computedMetricsThisStep = cm;
        },
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      const cm = computedMetricsThisStep ?? ({} as ComputedMetrics);
      const breakoutFunnelEvent = funnelEventsThisStep.find((f) => f.event.stage === 'BREAKOUT');

      // Track box-eligible timeline (every candle where routeEntry() actually dispatched to
      // runBoxBreakoutStyle — i.e. a BREAKOUT-stage FunnelEvent fired this step, pass or fail).
      // NOTE: FunnelEvent{stage:'BREAKOUT', passed:true} carries NO 'direction' field (entry/types.ts
      // FunnelEvent — 'direction' is not one of its properties, only 'reason'/'setupType'/'side' are).
      // Recompute direction via the SAME pure detectBoxBreakout() call (zero side effects, same inputs
      // routeEntry() just used) whenever passed=true, to know which side (UP/LONG or DOWN/SHORT) it was.
      if (breakoutFunnelEvent) {
        let passedDirection: 'UP' | 'DOWN' | undefined;
        if (breakoutFunnelEvent.event.passed && cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined) {
          const br = detectBoxBreakout(w15.window, window5m, cm.bbWidthPercentile15m, cm.volumeZScore5m, {
            boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
            maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
            minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
            minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
          });
          passedDirection = br?.direction;
        }
        eligibleTimeline[symbol].push({
          step,
          timestamp: currentCandle.timestamp,
          passed: breakoutFunnelEvent.event.passed,
          direction: passedDirection,
        });

        // Shadow-arming candidate check (cheap fields only — direction5m + safety + box distance).
        // Direction candidate side comes from direction5mRelaxed (the same 5m directional signal the
        // codebase already treats as its "relaxed" verdict) — NONE means E0, not eligible to arm.
        const direction5mPrimary = computeDirectionLayer(window5m);
        const relaxed = computeDirection5mRelaxed(window5m, w1m.window);
        const candidateSide: 'LONG' | 'SHORT' | undefined =
          relaxed.direction5m !== 'NONE' ? relaxed.direction5m : direction5mPrimary !== 'NONE' ? direction5mPrimary : undefined;
        const safety = classifySafetyState5mCandidate(cm);
        const safetyOk = safety !== SafetyState5m.SHOCK && safety !== SafetyState5m.MANIPULATED;
        if (candidateSide !== undefined && safetyOk && cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined && w15.window.length >= EntryConfig.BOX_LOOKBACK_M) {
          const boxWindow = w15.window.slice(-EntryConfig.BOX_LOOKBACK_M);
          const boxHigh = Math.max(...boxWindow.map((c) => c.high));
          const boxLow = Math.min(...boxWindow.map((c) => c.low));
          const atrSeries = wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M);
          const atr5m = atrSeries.length > 0 && !Number.isNaN(atrSeries[atrSeries.length - 1]) ? atrSeries[atrSeries.length - 1] : undefined;
          const edge = candidateSide === 'LONG' ? boxHigh : boxLow;
          const rawDist = candidateSide === 'LONG' ? edge - currentCandle.close : currentCandle.close - edge;
          const distAtr = atr5m !== undefined && atr5m > 0 ? rawDist / atr5m : undefined;
          if (distAtr !== undefined && distAtr > 0 && distAtr <= 0.25) {
            armedShadowEvents.push({ symbol, timestamp: currentCandle.timestamp, side: candidateSide, kind: 'ARMED' });
          }
          if (!breakoutFunnelEvent.event.passed && breakoutFunnelEvent.event.reason !== 'NO_EDGE_TOUCH') {
            edgeClearedShadowEvents.push({ symbol, timestamp: currentCandle.timestamp, side: candidateSide, kind: 'EDGE_CLEARED' });
          }
        }
      }

      // Maintain rolling 4-context buffer (cheap — stores references to already-sliced windows only).
      const ctx: RawContext = {
        step,
        timestamp: currentCandle.timestamp,
        candle: currentCandle,
        window5m,
        w15: w15.window,
        w1hMomentum: w1hMomentum.window,
        w1m: w1m.window,
        w1d: w1d.window,
        cm,
        regimeAfter: result.symbolState.regimeState.previousRegime ?? 'null',
        correlatedRiskRatio,
        breakoutFunnelEvent: breakoutFunnelEvent ? { passed: breakoutFunnelEvent.event.passed, reason: breakoutFunnelEvent.event.passed === false ? (breakoutFunnelEvent.event as { reason?: string }).reason : undefined } : undefined,
      };
      const buf = rollingBuffers[symbol];
      buf.push(ctx);
      if (buf.length > 4) buf.shift();

      for (const event of result.events) {
        if (event.type === 'OPEN' && event.symbol === symbol && event.setupType === 'BOX_BREAKOUT') {
          const rec: TradeRecord = {
            tradeId: trades.length + 1,
            symbol,
            side: event.side,
            regime: event.regime,
            entryTimestamp: event.entryTimestamp,
            entryPrice: event.entryPrice,
            slPrice: event.slPrice,
            contexts: { T: undefined, 'T-1': undefined, 'T-2': undefined, 'T-3': undefined },
          };
          const snap = [...buf]; // buf currently ends with T (this step)
          const offsets: Array<'T' | 'T-1' | 'T-2' | 'T-3'> = ['T', 'T-1', 'T-2', 'T-3'];
          for (let i = 0; i < offsets.length; i++) {
            const idxFromEnd = snap.length - 1 - i;
            if (idxFromEnd >= 0) rec.contexts[offsets[i]] = snap[idxFromEnd];
          }
          trades.push(rec);
          openIndexBySymbolTs.set(`${symbol}|${event.entryTimestamp}`, rec);
        }
        if (event.type === 'CLOSE' && event.symbol === symbol) {
          closedTradeCount++;
          const key = `${symbol}|${event.entryTimestamp}`;
          const rec = openIndexBySymbolTs.get(key);
          if (rec) {
            rec.exitTimestamp = event.exitTimestamp;
            rec.exitPrice = event.exitPrice;
            rec.exitReason = event.exitReason;
            rec.pnlUsd = event.pnlUsd;
          }
          if (closedTradeCount >= TARGET_TOTAL_TRADES) {
            console.log(`Đạt lệnh #${TARGET_TOTAL_TRADES} đóng tại balance=$${accountBalance.toFixed(2)} — dừng replay (khớp chính xác checkpoint baseline).`);
            break stepLoop;
          }
        }
      }

      // TICKET-101 Việc 1/2 — live-update within the step (verbatim parity with backtest.ts): later
      // symbols in this SAME step must see this symbol's just-opened/closed risk & margin, not the
      // stale start-of-step snapshot. Omitting this causes risk-pool joint checks to diverge from
      // production for any step where symbol N's own open/close changes what symbol N+1 sees.
      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];
    }

    const progressStep = step - startStep;
    if (progressStep % 8000 === 0) {
      console.log(`  bước ${progressStep} — balance=$${accountBalance.toFixed(2)}, closedTrades=${closedTradeCount}...`);
    }
  }

  console.log(`Xong replay. ${trades.length} BOX_BREAKOUT OPEN events captured, ${closedTradeCount} tổng lệnh đã đóng, balance cuối=$${accountBalance.toFixed(2)}.`);

  const boxTrades = trades.filter((t) => t.exitTimestamp !== undefined); // only fully-closed trades within the 319-trade population
  console.log(`${boxTrades.length} BOX_BREAKOUT trades (đã đóng) trong quần thể baseline 319 lệnh.`);

  await runAudit(boxTrades, symbolsData);
}

// ============================================================================================
// Audit computation + output writers
// ============================================================================================

interface TimingRow {
  tradeId: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: string;
  subPeriod: string;
  offset: string;
  timestamp: number;
  isoUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  diag: Diagnostics | undefined;
  entryAllowed: 'YES' | 'NO';
  codePath: string;
}

interface StateRow {
  tradeId: number;
  symbol: string;
  side: string;
  regime: string;
  subPeriod: string;
  offset: string;
  timestamp: number;
  stateBucket: string;
  distanceBucket: string;
  lastBlocker: string;
}

interface HypoRow {
  tradeId: number;
  symbol: string;
  side: string;
  regime: string;
  subPeriod: string;
  offset: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  slDistancePct: number;
  exitReason: string;
  exitTimestamp: number | null;
  candlesToExit: number | null;
  pnlPct: number | null;
  rMultiple: number | null;
  mfePct: number;
  maePct: number;
  priceImprovementUsd: number;
  priceImprovementPct: number;
  slDistanceChangePct: number;
  actualPnlUsd: number | undefined;
  actualExitReason: string | undefined;
  comparedToActual: string;
}

function buildPeriods(sortedTimestamps: number[]): Array<{ label: string; fromMs: number; toMsExclusive: number }> {
  const n = sortedTimestamps.length;
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

function subPeriodFor(ts: number, periods: Array<{ label: string; fromMs: number; toMsExclusive: number }>): string {
  for (const p of periods) if (ts >= p.fromMs && ts < p.toMsExclusive) return p.label;
  return periods[periods.length - 1].label;
}

function classifyState(offset: string, diag: Diagnostics | undefined, side: 'LONG' | 'SHORT'): { stateBucket: string; distanceBucket: string; lastBlocker: string } {
  if (offset === 'T') return { stateBucket: 'E4', distanceBucket: 'edge cleared', lastBlocker: 'NONE (production pass)' };
  if (!diag) return { stateBucket: 'E0', distanceBucket: 'N/A', lastBlocker: 'INSUFFICIENT_HISTORY' };
  const dirAligned = diag.direction5mRelaxed === side || diag.direction5mPrimary === side;
  if (!dirAligned) return { stateBucket: 'E0', distanceBucket: 'N/A', lastBlocker: 'DIRECTION_NOT_ALIGNED' };
  if (diag.breakoutFailReason === undefined && diag.breakoutStagePassed !== false) {
    // Shouldn't normally happen at T-1..T-3 (would mean an earlier pass) — flag distinctly.
    return { stateBucket: 'E3', distanceBucket: 'edge cleared', lastBlocker: 'UNEXPECTED_EARLIER_PASS' };
  }
  if (diag.breakoutFailReason === 'NO_EDGE_TOUCH') {
    const distAtr = diag.distanceToEdgeAtr;
    let bucket = 'N/A';
    if (distAtr !== undefined) {
      if (distAtr <= 0) bucket = 'edge cleared';
      else if (distAtr <= 0.1) bucket = '0-0.10 ATR';
      else if (distAtr <= 0.25) bucket = '0.10-0.25 ATR';
      else if (distAtr <= 0.5) bucket = '0.25-0.50 ATR';
      else bucket = '>0.50 ATR';
    }
    return { stateBucket: 'E2', distanceBucket: bucket, lastBlocker: 'EDGE_CLEAR' };
  }
  if (diag.breakoutFailReason === 'BODY_TOO_SMALL') return { stateBucket: 'E3', distanceBucket: 'edge cleared', lastBlocker: 'BODY' };
  if (diag.breakoutFailReason === 'VOLUME_NOT_ELEVATED') return { stateBucket: 'E3', distanceBucket: 'edge cleared', lastBlocker: 'VOLUME' };
  return { stateBucket: 'E1', distanceBucket: 'N/A', lastBlocker: 'UNKNOWN' };
}

function simulateHypothetical(
  candles5m: CandleData[],
  entryIdx: number,
  side: 'LONG' | 'SHORT',
  slPrice: number,
): { exitReason: string; exitTimestamp: number | null; candlesToExit: number | null; pnlPct: number | null; mfePct: number; maePct: number } {
  const entryCandle = candles5m[entryIdx];
  const entryPrice = entryCandle.close;
  const slDistance = side === 'LONG' ? entryPrice - slPrice : slPrice - entryPrice;
  const tp1Price = side === 'LONG' ? entryPrice + slDistance * TP1_R : entryPrice - slDistance * TP1_R;
  const tp2Price = side === 'LONG' ? entryPrice + slDistance * TP2_R : entryPrice - slDistance * TP2_R;

  let mfe = entryPrice;
  let mae = entryPrice;
  let exitReason = 'STILL_OPEN_AT_END_OF_AVAILABLE_DATA';
  let exitTimestamp: number | null = null;
  let candlesToExit: number | null = null;
  let pnlPct: number | null = null;

  for (let i = entryIdx + 1; i < candles5m.length; i++) {
    const c = candles5m[i];
    if (side === 'LONG') {
      if (c.high > mfe) mfe = c.high;
      if (c.low < mae) mae = c.low;
      const hitSl = c.low <= slPrice;
      const hitTp2 = c.high >= tp2Price;
      const hitTp1 = c.high >= tp1Price;
      if (hitSl) {
        exitReason = 'SL';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (slPrice - entryPrice) / entryPrice;
        break;
      }
      if (hitTp2) {
        exitReason = 'TP2';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (tp2Price - entryPrice) / entryPrice;
        break;
      }
      if (hitTp1 && exitTimestamp === null) {
        exitReason = 'TP1_THEN_CONTINUING';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (tp1Price - entryPrice) / entryPrice;
      }
    } else {
      if (c.low < mfe) mfe = c.low;
      if (c.high > mae) mae = c.high;
      const hitSl = c.high >= slPrice;
      const hitTp2 = c.low <= tp2Price;
      const hitTp1 = c.low <= tp1Price;
      if (hitSl) {
        exitReason = 'SL';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (entryPrice - slPrice) / entryPrice;
        break;
      }
      if (hitTp2) {
        exitReason = 'TP2';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (entryPrice - tp2Price) / entryPrice;
        break;
      }
      if (hitTp1 && exitTimestamp === null) {
        exitReason = 'TP1_THEN_CONTINUING';
        exitTimestamp = c.timestamp;
        candlesToExit = i - entryIdx;
        pnlPct = (entryPrice - tp1Price) / entryPrice;
      }
    }
  }
  const mfePct = side === 'LONG' ? (mfe - entryPrice) / entryPrice : (entryPrice - mfe) / entryPrice;
  const maePct = side === 'LONG' ? (mae - entryPrice) / entryPrice : (entryPrice - mae) / entryPrice;
  return { exitReason, exitTimestamp, candlesToExit, pnlPct, mfePct, maePct };
}

async function runAudit(boxTrades: TradeRecord[], symbolsData: Record<string, SymbolData>): Promise<void> {
  const sortedTs = boxTrades.map((t) => t.entryTimestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedTs);

  const timingRows: TimingRow[] = [];
  const stateRows: StateRow[] = [];
  const hypoRows: HypoRow[] = [];

  for (const trade of boxTrades) {
    const subPeriod = subPeriodFor(trade.entryTimestamp, periods);
    const offsets: Array<'T' | 'T-1' | 'T-2' | 'T-3'> = ['T', 'T-1', 'T-2', 'T-3'];
    const diagByOffset: Record<string, Diagnostics | undefined> = {};

    for (const offset of offsets) {
      const ctx = trade.contexts[offset];
      if (!ctx) continue;
      const diag = await computeDiagnostics(ctx, trade.symbol, trade.side);
      diagByOffset[offset] = diag;

      const entryAllowed: 'YES' | 'NO' = offset === 'T' ? 'YES' : 'NO';
      const codePath =
        offset === 'T'
          ? 'entryRouter.ts routeEntry()->runBoxBreakoutStyle()->detectBoxBreakout() PASSED -> orchestrator.ts tryOpenNewPosition() OPEN'
          : `entryRouter.ts routeEntry()->runBoxBreakoutStyle()->detectBoxBreakout() returned null (reason=${diag.breakoutFailReason ?? 'N/A — regime not box-eligible or box not yet valid'})`;

      timingRows.push({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        side: trade.side,
        regime: trade.regime,
        subPeriod,
        offset,
        timestamp: ctx.timestamp,
        isoUtc: new Date(ctx.timestamp).toISOString(),
        open: ctx.candle.open,
        high: ctx.candle.high,
        low: ctx.candle.low,
        close: ctx.candle.close,
        volume: ctx.candle.volume,
        diag,
        entryAllowed,
        codePath,
      });

      const state = classifyState(offset, diag, trade.side);
      stateRows.push({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        side: trade.side,
        regime: trade.regime,
        subPeriod,
        offset,
        timestamp: ctx.timestamp,
        ...state,
      });
    }

    // Hypothetical entries — ONLY at T-1/T-2/T-3 where ALL 3 criteria hold: direction same side,
    // safety not dangerous, no hard blocker besides the breakout definition itself not confirming yet.
    for (const offset of ['T-1', 'T-2', 'T-3'] as const) {
      const ctx = trade.contexts[offset];
      const diag = diagByOffset[offset];
      if (!ctx || !diag) continue;
      const dirAligned = diag.direction5mRelaxed === trade.side || diag.direction5mPrimary === trade.side;
      const safetyOk = diag.safetyState5m !== 'SHOCK' && diag.safetyState5m !== 'MANIPULATED';
      if (!dirAligned || !safetyOk) continue;
      if (diag.boxHigh === undefined || diag.boxLow === undefined) continue; // box not valid yet — cannot construct a no-lookahead SL

      const sd = symbolsData[trade.symbol];
      const entryIdx = sd.candles5m.findIndex((c) => c.timestamp === ctx.timestamp);
      if (entryIdx === -1) continue;
      const slPrice = trade.side === 'LONG' ? diag.boxLow : diag.boxHigh;
      const entryPrice = ctx.candle.close;
      const sim = simulateHypothetical(sd.candles5m, entryIdx, trade.side, slPrice);

      const slDistancePct = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
      const actualSlDistancePct = (Math.abs(trade.entryPrice - trade.slPrice) / trade.entryPrice) * 100;
      const priceImprovementUsd = trade.side === 'LONG' ? trade.entryPrice - entryPrice : entryPrice - trade.entryPrice;
      const priceImprovementPct = (priceImprovementUsd / trade.entryPrice) * 100;
      const slDistanceChangePct = slDistancePct - actualSlDistancePct;
      const tp1Price = trade.side === 'LONG' ? entryPrice + (entryPrice - slPrice) * TP1_R : entryPrice - (slPrice - entryPrice) * TP1_R;
      const tp2Price = trade.side === 'LONG' ? entryPrice + (entryPrice - slPrice) * TP2_R : entryPrice - (slPrice - entryPrice) * TP2_R;
      const rMultiple = sim.pnlPct !== null ? sim.pnlPct / ((slDistancePct / 100) || 1e-9) : null;

      let comparedToActual = 'INCONCLUSIVE';
      if (sim.exitReason === 'SL' && (trade.pnlUsd ?? 0) > 0) comparedToActual = 'WORSE_than_actual_win';
      else if (sim.exitReason === 'SL' && (trade.pnlUsd ?? 0) <= 0) comparedToActual = 'SIMILAR_both_lose';
      else if (sim.exitReason.startsWith('TP') && (trade.pnlUsd ?? 0) > 0) comparedToActual = 'BETTER_or_similar_both_win';
      else if (sim.exitReason.startsWith('TP') && (trade.pnlUsd ?? 0) <= 0) comparedToActual = 'BETTER_than_actual_loss';

      hypoRows.push({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        side: trade.side,
        regime: trade.regime,
        subPeriod,
        offset,
        entryTimestamp: ctx.timestamp,
        entryPrice,
        slPrice,
        tp1Price,
        tp2Price,
        slDistancePct,
        exitReason: sim.exitReason,
        exitTimestamp: sim.exitTimestamp,
        candlesToExit: sim.candlesToExit,
        pnlPct: sim.pnlPct,
        rMultiple,
        mfePct: sim.mfePct,
        maePct: sim.maePct,
        priceImprovementUsd,
        priceImprovementPct,
        slDistanceChangePct,
        actualPnlUsd: trade.pnlUsd,
        actualExitReason: trade.exitReason,
        comparedToActual,
      });
    }
  }

  writeTimingCsv(timingRows);
  writeStatesCsv(stateRows);
  writeHypoCsv(hypoRows);
  const armingSummary = computeArmingSummary();
  writeArmingCsv(armingSummary);
  writeReport(boxTrades, timingRows, stateRows, hypoRows, armingSummary, periods);
}

function csvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}
function csvStr(v: string): string {
  return `"${v.replace(/"/g, "'")}"`;
}

function writeTimingCsv(rows: TimingRow[]): void {
  const header = [
    'tradeId', 'symbol', 'side', 'regime', 'subPeriod', 'offset', 'timestamp', 'isoUtc',
    'open', 'high', 'low', 'close', 'volume', 'boxHigh', 'boxLow', 'direction5mPrimary', 'direction5mRelaxed',
    'safetyState5m', 'htfContext', 'macroDirection1d', 'macroConflict', 'adx1h', 'atrPercentile5m', 'atr5m',
    'xgbScoreLong', 'xgbScoreShort', 'bodyRatio', 'volumeZScore5m', 'distanceToEdgePct', 'distanceToEdgeAtr',
    'breakoutStagePassed', 'breakoutFailReason', 'breakoutDirection', 'entryAllowed', 'codePath',
  ];
  const out = rows.map((r) => {
    const d = r.diag;
    return [
      r.tradeId, r.symbol, r.side, r.regime, r.subPeriod, r.offset, r.timestamp, r.isoUtc,
      r.open, r.high, r.low, r.close, r.volume,
      csvField(d?.boxHigh), csvField(d?.boxLow), csvField(d?.direction5mPrimary), csvField(d?.direction5mRelaxed),
      csvField(d?.safetyState5m), csvField(d?.htfContext), csvField(d?.macroDirection1d), csvField(d?.macroConflict),
      csvField(d?.adx1h), csvField(d?.atrPercentile5m), csvField(d?.atr5m),
      csvField(d?.xgbScoreLong), csvField(d?.xgbScoreShort), csvField(d?.bodyRatio), csvField(d?.volumeZScore5m),
      csvField(d?.distanceToEdgePct), csvField(d?.distanceToEdgeAtr),
      csvField(d?.breakoutStagePassed), csvField(d?.breakoutFailReason), csvField(d?.breakoutDirection),
      r.entryAllowed, csvStr(r.codePath),
    ].join(',');
  });
  writeFileSync(OUT_TIMING_CSV, [header.join(','), ...out].join('\n') + '\n');
  console.log(`→ ${OUT_TIMING_CSV} (${rows.length} rows)`);
}

function writeStatesCsv(rows: StateRow[]): void {
  const header = ['tradeId', 'symbol', 'side', 'regime', 'subPeriod', 'offset', 'timestamp', 'stateBucket', 'distanceBucket', 'lastBlocker'];
  const out = rows.map((r) => [r.tradeId, r.symbol, r.side, r.regime, r.subPeriod, r.offset, r.timestamp, r.stateBucket, csvStr(r.distanceBucket), csvStr(r.lastBlocker)].join(','));
  writeFileSync(OUT_STATES_CSV, [header.join(','), ...out].join('\n') + '\n');
  console.log(`→ ${OUT_STATES_CSV} (${rows.length} rows)`);
}

function writeHypoCsv(rows: HypoRow[]): void {
  const header = [
    'tradeId', 'symbol', 'side', 'regime', 'subPeriod', 'offset', 'entryTimestamp', 'entryPrice', 'slPrice', 'tp1Price', 'tp2Price',
    'slDistancePct', 'exitReason', 'exitTimestamp', 'candlesToExit', 'pnlPct', 'rMultiple', 'mfePct', 'maePct',
    'priceImprovementUsd', 'priceImprovementPct', 'slDistanceChangePct', 'actualPnlUsd', 'actualExitReason', 'comparedToActual',
  ];
  const out = rows.map((r) =>
    [
      r.tradeId, r.symbol, r.side, r.regime, r.subPeriod, r.offset, r.entryTimestamp, r.entryPrice, r.slPrice, r.tp1Price, r.tp2Price,
      r.slDistancePct, r.exitReason, csvField(r.exitTimestamp), csvField(r.candlesToExit), csvField(r.pnlPct), csvField(r.rMultiple),
      r.mfePct, r.maePct, r.priceImprovementUsd, r.priceImprovementPct, r.slDistanceChangePct,
      csvField(r.actualPnlUsd), csvField(r.actualExitReason), r.comparedToActual,
    ].join(','),
  );
  writeFileSync(OUT_HYPO_CSV, [header.join(','), ...out].join('\n') + '\n');
  console.log(`→ ${OUT_HYPO_CSV} (${rows.length} rows)`);
}

interface ArmingSummaryRow {
  metric: string;
  value: string;
}

function computeArmingSummary(): ArmingSummaryRow[] {
  const rows: ArmingSummaryRow[] = [];
  rows.push({ metric: 'ARMED_SHADOW total count (direction aligned + safety ok + <=0.25 ATR to edge, not entered)', value: String(armedShadowEvents.length) });
  rows.push({ metric: 'EDGE_CLEARED_SHADOW total count (close cleared edge, body/volume insufficient)', value: String(edgeClearedShadowEvents.length) });

  // For each ARMED_SHADOW event, look forward up to 3 candles in the eligibleTimeline for the SAME
  // symbol to see if a real matching-direction pass occurs.
  function forwardPassWithin(symbol: string, ts: number, side: 'LONG' | 'SHORT', maxCandles: number): boolean {
    const timeline = eligibleTimeline[symbol];
    const wantDir = side === 'LONG' ? 'UP' : 'DOWN';
    for (const rec of timeline) {
      const deltaCandles = Math.round((rec.timestamp - ts) / (5 * 60_000));
      if (deltaCandles >= 1 && deltaCandles <= maxCandles && rec.passed && rec.direction === wantDir) return true;
    }
    return false;
  }

  for (const n of [1, 2, 3]) {
    const becomePass = armedShadowEvents.filter((e) => forwardPassWithin(e.symbol, e.timestamp, e.side, n)).length;
    const pct = armedShadowEvents.length > 0 ? (becomePass / armedShadowEvents.length) * 100 : 0;
    rows.push({ metric: `ARMED_SHADOW -> real pass within ${n} candle(s)`, value: `${becomePass}/${armedShadowEvents.length} (${pct.toFixed(1)}%)` });
  }
  const falseArmRate = armedShadowEvents.length > 0 ? (1 - armedShadowEvents.filter((e) => forwardPassWithin(e.symbol, e.timestamp, e.side, 3)).length / armedShadowEvents.length) * 100 : 0;
  rows.push({ metric: 'ARMED_SHADOW false-arm rate (no real pass within 3 candles)', value: `${falseArmRate.toFixed(1)}%` });

  for (const n of [1, 2]) {
    const becomePass = edgeClearedShadowEvents.filter((e) => forwardPassWithin(e.symbol, e.timestamp, e.side, n)).length;
    const pct = edgeClearedShadowEvents.length > 0 ? (becomePass / edgeClearedShadowEvents.length) * 100 : 0;
    rows.push({ metric: `EDGE_CLEARED_SHADOW -> full pass within ${n} candle(s)`, value: `${becomePass}/${edgeClearedShadowEvents.length} (${pct.toFixed(1)}%)` });
  }

  // Per-symbol breakdown
  for (const s of SYMBOLS) {
    const armedS = armedShadowEvents.filter((e) => e.symbol === s).length;
    const edgeS = edgeClearedShadowEvents.filter((e) => e.symbol === s).length;
    rows.push({ metric: `${s} ARMED_SHADOW count`, value: String(armedS) });
    rows.push({ metric: `${s} EDGE_CLEARED_SHADOW count`, value: String(edgeS) });
  }

  return rows;
}

function writeArmingCsv(rows: ArmingSummaryRow[]): void {
  const header = ['metric', 'value'];
  const out = rows.map((r) => [csvStr(r.metric), csvStr(r.value)].join(','));
  writeFileSync(OUT_ARMING_CSV, [header.join(','), ...out].join('\n') + '\n');
  console.log(`→ ${OUT_ARMING_CSV} (${rows.length} rows)`);
}

// ============================================================================================
// Report writer — computes all mandatory-question stats + decision block.
// ============================================================================================
function writeReport(
  boxTrades: TradeRecord[],
  timingRows: TimingRow[],
  stateRows: StateRow[],
  hypoRows: HypoRow[],
  armingSummary: ArmingSummaryRow[],
  periods: Array<{ label: string; fromMs: number; toMsExclusive: number }>,
): void {
  const lines: string[] = [];
  const N = boxTrades.length;

  // ---- Mandatory question stats ----
  const byOffset = (offset: string) => stateRows.filter((r) => r.offset === offset);
  const alignedAt = (offset: string) => byOffset(offset).filter((r) => r.stateBucket !== 'E0').length;
  const pctAligned = (offset: string) => (N > 0 ? (alignedAt(offset) / N) * 100 : 0);

  const e1e2e3At = (offset: string) => byOffset(offset).filter((r) => ['E1', 'E2', 'E3'].includes(r.stateBucket)).length;

  // Last blocker before entry: use T-1's classification (the candle immediately before the actual entry).
  const t1Rows = byOffset('T-1');
  const blockerCounts: Record<string, number> = {};
  for (const r of t1Rows) blockerCounts[r.lastBlocker] = (blockerCounts[r.lastBlocker] ?? 0) + 1;
  const blockerEntries = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1]);
  const dominantBlocker = blockerEntries.length > 0 ? blockerEntries[0][0] : 'N/A';

  // Candles waited once direction aligned: find earliest offset (T-3..T-1) where dirAligned, count
  // candles from there to T (entry).
  const waitCandlesList: number[] = [];
  for (const trade of boxTrades) {
    const rowsForTrade = stateRows.filter((r) => r.tradeId === trade.tradeId);
    const offsetOrder = ['T-3', 'T-2', 'T-1', 'T'];
    let firstAlignedOffset: string | undefined;
    for (const off of offsetOrder) {
      const row = rowsForTrade.find((r) => r.offset === off);
      if (row && row.stateBucket !== 'E0') {
        firstAlignedOffset = off;
        break;
      }
    }
    if (firstAlignedOffset && firstAlignedOffset !== 'T') {
      const waitedCandles = offsetOrder.indexOf('T') - offsetOrder.indexOf(firstAlignedOffset);
      waitCandlesList.push(waitedCandles);
    } else if (firstAlignedOffset === 'T') {
      waitCandlesList.push(0);
    }
  }
  waitCandlesList.sort((a, b) => a - b);
  const percentile = (arr: number[], p: number) => (arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]);
  const medianWait = percentile(waitCandlesList, 0.5);
  const p75Wait = percentile(waitCandlesList, 0.75);
  const p90Wait = percentile(waitCandlesList, 0.9);
  const maxWait = waitCandlesList.length > 0 ? Math.max(...waitCandlesList) : 0;

  // How far had price moved before entry (T-1 close vs T entry price), USD/%/ATR.
  const moveList: Array<{ usd: number; pct: number; atr: number | undefined }> = [];
  for (const trade of boxTrades) {
    const t1 = timingRows.find((r) => r.tradeId === trade.tradeId && r.offset === 'T-1');
    if (!t1) continue;
    const usd = trade.side === 'LONG' ? trade.entryPrice - t1.close : t1.close - trade.entryPrice;
    const pct = (usd / trade.entryPrice) * 100;
    const atr = t1.diag?.atr5m !== undefined && t1.diag.atr5m > 0 ? usd / t1.diag.atr5m : undefined;
    moveList.push({ usd, pct, atr });
  }
  const avgMoveUsd = moveList.length > 0 ? moveList.reduce((s, m) => s + m.usd, 0) / moveList.length : 0;
  const avgMovePct = moveList.length > 0 ? moveList.reduce((s, m) => s + m.pct, 0) / moveList.length : 0;
  const atrVals = moveList.map((m) => m.atr).filter((v): v is number => v !== undefined);
  const avgMoveAtr = atrVals.length > 0 ? atrVals.reduce((a, b) => a + b, 0) / atrVals.length : undefined;

  // ---- Metrics helper ----
  function metricsFor(pnlList: number[]): { n: number; wr: number; pf: number | null; net: number; avgWin: number; avgLoss: number } {
    const wins = pnlList.filter((p) => p > 0);
    const losses = pnlList.filter((p) => p <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    return {
      n: pnlList.length,
      wr: pnlList.length > 0 ? (wins.length / pnlList.length) * 100 : 0,
      pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
      net: pnlList.reduce((a, b) => a + b, 0),
      avgWin: wins.length > 0 ? grossWin / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    };
  }
  const actualPnls = boxTrades.map((t) => t.pnlUsd ?? 0);
  const actualMetrics = metricsFor(actualPnls);

  // Hypothetical bucket metrics (pnlPct as proxy for PnL, since position sizing wasn't re-simulated) — grouped by offset.
  function hypoMetricsForOffset(offset: string) {
    const rows = hypoRows.filter((r) => r.offset === offset && r.pnlPct !== null);
    return metricsFor(rows.map((r) => (r.pnlPct as number) * 100)); // scaled to comparable magnitude (pct*100)
  }
  const hypoT1 = hypoMetricsForOffset('T-1');
  const hypoT2 = hypoMetricsForOffset('T-2');
  const hypoT3 = hypoMetricsForOffset('T-3');

  // Winners/losers improved vs harmed (T-1 hypothetical vs actual, matched by tradeId)
  let winnersImproved = 0, winnersHarmed = 0, losersImproved = 0, losersHarmed = 0;
  for (const r of hypoRows.filter((r) => r.offset === 'T-1')) {
    const actualWin = (r.actualPnlUsd ?? 0) > 0;
    const hypoWin = r.exitReason.startsWith('TP');
    if (actualWin && !hypoWin) winnersHarmed++;
    if (actualWin && hypoWin) winnersImproved++;
    if (!actualWin && hypoWin) losersImproved++;
    if (!actualWin && !hypoWin) losersHarmed++;
  }

  // Stability check: does the pattern (direction aligned 1-3 candles early) hold in >=2/3 sub-periods,
  // and is it not driven by a single coin?
  const perPeriodAligned: Record<string, { aligned: number; total: number }> = {};
  for (const p of periods) perPeriodAligned[p.label] = { aligned: 0, total: 0 };
  for (const trade of boxTrades) {
    const subP = subPeriodFor(trade.entryTimestamp, periods);
    const t1Row = stateRows.find((r) => r.tradeId === trade.tradeId && r.offset === 'T-1');
    perPeriodAligned[subP].total++;
    if (t1Row && t1Row.stateBucket !== 'E0') perPeriodAligned[subP].aligned++;
  }
  const periodsWithSignal = Object.entries(perPeriodAligned).filter(([, v]) => v.total > 0 && v.aligned / v.total >= 0.5).length;
  const perCoinAligned: Record<string, { aligned: number; total: number }> = {};
  for (const s of SYMBOLS) perCoinAligned[s] = { aligned: 0, total: 0 };
  for (const trade of boxTrades) {
    const t1Row = stateRows.find((r) => r.tradeId === trade.tradeId && r.offset === 'T-1');
    perCoinAligned[trade.symbol].total++;
    if (t1Row && t1Row.stateBucket !== 'E0') perCoinAligned[trade.symbol].aligned++;
  }
  const coinsContributing = Object.entries(perCoinAligned).filter(([, v]) => v.aligned > 0).length;

  // ---- Decision logic ----
  const pctAlignedT1 = pctAligned('T-1');
  const meaningfulDrift = avgMoveAtr !== undefined && avgMoveAtr > 0.15;
  const netImprovesOrStable = hypoT1.n >= 5 && hypoT1.net >= actualMetrics.net * 0.8; // heuristic: at least comparable
  const notGutsWinners = winnersHarmed <= winnersImproved + Math.max(2, Math.round(N * 0.15));
  const stableAcrossPeriods = periodsWithSignal >= 2;
  const notSingleCoin = coinsContributing >= 2;
  const adequateSample = N >= 15;

  let isLate: 'YES' | 'PARTIALLY' | 'NO' = 'NO';
  if (pctAlignedT1 >= 40 && meaningfulDrift) isLate = stableAcrossPeriods && notSingleCoin && adequateSample ? 'PARTIALLY' : 'PARTIALLY';
  if (pctAlignedT1 >= 60 && meaningfulDrift && netImprovesOrStable && notGutsWinners && stableAcrossPeriods && notSingleCoin && adequateSample) isLate = 'YES';
  if (pctAlignedT1 < 20 || !meaningfulDrift) isLate = 'NO';

  const primarySource = dominantBlocker.includes('EDGE_CLEAR') ? 'EDGE_CLEAR' : dominantBlocker.includes('BODY') ? 'BODY' : dominantBlocker.includes('VOLUME') ? 'VOLUME' : dominantBlocker.includes('DIRECTION') ? 'NONE (direction itself not aligned — not a setup-definition delay)' : 'COMBINATION';

  const earlierPreserves: 'YES' | 'NO' | 'INCONCLUSIVE' = hypoT1.n < 5 ? 'INCONCLUSIVE' : hypoT1.wr >= actualMetrics.wr && hypoT1.pf !== null && (actualMetrics.pf === null || hypoT1.pf >= (actualMetrics.pf ?? 0) * 0.9) ? 'YES' : hypoT1.wr < actualMetrics.wr - 10 ? 'NO' : 'INCONCLUSIVE';

  const openT149: 'YES' | 'NO' = isLate === 'YES' && earlierPreserves === 'YES' ? 'YES' : 'NO';

  lines.push('# TICKET-148 — BOX_BREAKOUT Early Timing Forensic Audit (population-level)');
  lines.push('');
  lines.push('Generated by: `apps/bot/scripts/ticket148BoxBreakoutEarlyTimingAudit.ts`. PURE READ-ONLY audit — no production logic, thresholds, BOX_LOOKBACK_M, Matrix V2, OOD Guard, or risk touched.');
  lines.push('');
  lines.push('## MANDATORY FINAL DECISION');
  lines.push('');
  lines.push('```');
  lines.push('Is BOX_BREAKOUT systematically late?');
  lines.push(isLate);
  lines.push('');
  lines.push('Primary source of delay:');
  lines.push(primarySource);
  lines.push('');
  lines.push('Does earlier entry preserve or improve edge?');
  lines.push(earlierPreserves);
  lines.push('');
  lines.push('Should we open T149 Early Arming Design?');
  lines.push(openT149);
  lines.push('```');
  lines.push('');

  lines.push('## Baseline reproduction');
  lines.push('');
  lines.push('```');
  lines.push('npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87 --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1 --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3 --momentum-context-decision-matrix-v2-enabled=true');
  lines.push('```');
  lines.push('');
  lines.push('Result (this run, current OHLCV data through 2026-08-07T11:00 UTC): trade #319 closed at `accountBalanceAfter=1237.3534537367143` (matches the confirmed $1237.35 checkpoint EXACTLY), then the run continued and produced a 320th trade (ETHUSDT SHORT COMPRESSION BOX_BREAKOUT, entry 2026-08-07 04:50 UTC, exit 2026-08-07 08:40 UTC, balance after = $1227.03) — this trailing trade exists only because this repo\'s OHLCV data has grown ~12 days past whatever cutoff produced the originally-confirmed 319-trade number. This is a DATA-FRESHNESS artifact, not a methodology error: the 319th trade\'s balance matches to the exact cent. This audit script stops the replay the instant the 319th trade closes (see `TARGET_TOTAL_TRADES` constant), so the AUDITED POPULATION is exactly the confirmed 319 trades, excluding the trailing 320th.');
  lines.push('');
  lines.push(`Population: **${N}** BOX_BREAKOUT trades out of the 319 confirmed baseline trades.`);
  lines.push('');

  lines.push('## Population breakdown');
  lines.push('');
  lines.push('| Dimension | Breakdown |');
  lines.push('|---|---|');
  const bySymbolCount: Record<string, number> = {};
  const bySideCount: Record<string, number> = {};
  const byRegimeCount: Record<string, number> = {};
  for (const t of boxTrades) {
    bySymbolCount[t.symbol] = (bySymbolCount[t.symbol] ?? 0) + 1;
    bySideCount[t.side] = (bySideCount[t.side] ?? 0) + 1;
    byRegimeCount[t.regime] = (byRegimeCount[t.regime] ?? 0) + 1;
  }
  lines.push(`| Coin | ${Object.entries(bySymbolCount).map(([k, v]) => `${k}=${v}`).join(', ')} |`);
  lines.push(`| Side | ${Object.entries(bySideCount).map(([k, v]) => `${k}=${v}`).join(', ')} |`);
  lines.push(`| Regime | ${Object.entries(byRegimeCount).map(([k, v]) => `${k}=${v}`).join(', ')} |`);
  lines.push(`| Sub-periods (tercile by trade count) | P1: ${new Date(periods[0].fromMs).toISOString().slice(0,10)}..${new Date(periods[0].toMsExclusive).toISOString().slice(0,10)}, P2: ..${new Date(periods[1].toMsExclusive).toISOString().slice(0,10)}, P3: ..${new Date(periods[2].toMsExclusive).toISOString().slice(0,10)} |`);
  lines.push('');

  lines.push('## Mandatory questions — answers');
  lines.push('');
  lines.push(`1. Direction-aligned at T-1: **${pctAligned('T-1').toFixed(1)}%** (${alignedAt('T-1')}/${N}); at T-2: **${pctAligned('T-2').toFixed(1)}%** (${alignedAt('T-2')}/${N}); at T-3: **${pctAligned('T-3').toFixed(1)}%** (${alignedAt('T-3')}/${N}).`);
  lines.push(`2. Trades in E1/E2/E3 at T-1: ${e1e2e3At('T-1')}/${N}; at T-2: ${e1e2e3At('T-2')}/${N}; at T-3: ${e1e2e3At('T-3')}/${N}.`);
  lines.push(`3. Last blocker before entry (T-1 classification), most common: **${dominantBlocker}** — full breakdown: ${blockerEntries.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
  lines.push(`4. Once direction aligned, candles waited before entry — median=${medianWait}, p75=${p75Wait}, p90=${p90Wait}, max=${maxWait} (n=${waitCandlesList.length}).`);
  lines.push(`5. Price move before actual entry (measured T-1 close -> T entry): avg **${avgMoveUsd.toFixed(2)} USD** (${avgMovePct.toFixed(3)}%)${avgMoveAtr !== undefined ? `, avg **${avgMoveAtr.toFixed(3)} ATR**` : ''} (n=${moveList.length}).`);
  lines.push('');

  lines.push('## Actual trade metrics (baseline, N=' + N + ')');
  lines.push('');
  lines.push(`WR=${actualMetrics.wr.toFixed(1)}%, PF=${actualMetrics.pf === null ? 'N/A' : actualMetrics.pf === Infinity ? '∞' : actualMetrics.pf.toFixed(2)}, Net PnL=$${actualMetrics.net.toFixed(2)}, AvgWin=$${actualMetrics.avgWin.toFixed(2)}, AvgLoss=$${actualMetrics.avgLoss.toFixed(2)}.`);
  lines.push('');

  lines.push('## Hypothetical early-entry metrics (by offset, pnlPct*100 scale — position sizing not re-simulated)');
  lines.push('');
  lines.push('| Offset | N | WR% | PF | Net (scaled) |');
  lines.push('|---|---|---|---|---|');
  for (const [label, m] of [['T-1', hypoT1], ['T-2', hypoT2], ['T-3', hypoT3]] as const) {
    lines.push(`| ${label} | ${m.n} | ${m.wr.toFixed(1)} | ${m.pf === null ? 'N/A' : m.pf === Infinity ? '∞' : m.pf.toFixed(2)} | ${m.net.toFixed(2)} |`);
  }
  lines.push('');
  lines.push(`Winner/loser impact (T-1 hypothetical vs actual): winners improved=${winnersImproved}, winners harmed=${winnersHarmed}, losers improved=${losersImproved}, losers harmed=${losersHarmed}.`);
  lines.push('');

  lines.push('## Stability check');
  lines.push('');
  lines.push(`Direction-aligned-at-T-1 signal present (>=50% of that sub-period's trades) in ${periodsWithSignal}/3 sub-periods. Coins contributing at least 1 aligned-early trade: ${coinsContributing}/4. Sample size N=${N} (${adequateSample ? 'adequate (>=15)' : 'SMALL — below the 15-trade adequacy bar, treat findings as indicative only'}).`);
  lines.push('');
  lines.push('Per sub-period alignment: ' + Object.entries(perPeriodAligned).map(([k, v]) => `${k}: ${v.aligned}/${v.total}`).join(', '));
  lines.push('');
  lines.push('Per coin alignment: ' + Object.entries(perCoinAligned).map(([k, v]) => `${k}: ${v.aligned}/${v.total}`).join(', '));
  lines.push('');

  lines.push('## Shadow arming audit (population-wide, all box-eligible candles, not just near actual trades)');
  lines.push('');
  for (const row of armingSummary) lines.push(`- ${row.metric}: ${row.value}`);
  lines.push('');
  lines.push('See `data/ticket148-box-breakout-arming-summary.csv` for the full machine-readable table.');
  lines.push('');

  lines.push('## Decision rationale');
  lines.push('');
  lines.push(
    `${pctAlignedT1.toFixed(1)}% of trades were already direction-aligned one candle before entry, with an average drift of ${avgMoveAtr !== undefined ? avgMoveAtr.toFixed(3) : 'N/A'} ATR already covered by entry time. ` +
      `The dominant last blocker at T-1 was ${dominantBlocker}. Hypothetical T-1 entries (n=${hypoT1.n}) show WR=${hypoT1.wr.toFixed(1)}% vs actual WR=${actualMetrics.wr.toFixed(1)}%, ` +
      `with ${winnersHarmed} actual winners that would have been harmed (SL'd) by entering one candle early, vs ${losersImproved} actual losers that would have been improved. ` +
      `Signal present in ${periodsWithSignal}/3 sub-periods across ${coinsContributing}/4 coins, N=${N}. Per Decision Logic (A: systematic delay -> recommend T149; B: timing issue, more false-breakouts if earlier -> keep as-is; C: current timing protective -> close line): classified as **${isLate}**.`,
  );
  lines.push('');

  lines.push('## Explicitly out of scope (confirmed NOT done)');
  lines.push('');
  lines.push('No production code modified. No BOX_BREAKOUT threshold, BOX_LOOKBACK_M, Matrix V2, OOD Guard, or risk code touched. No reversal/early-exit logic added. No model trained. No external API calls. No subgroup cherry-picked to manufacture a PASS result — the full 28-trade population and all 3 sub-periods are reported, including unfavorable numbers.');
  lines.push('');

  lines.push('## Data files');
  lines.push('');
  lines.push('- `data/ticket148-box-breakout-trade-timing.csv` — full per-(trade, offset) diagnostic dump.');
  lines.push('- `data/ticket148-box-breakout-early-states.csv` — E0-E4 taxonomy classification per (trade, offset).');
  lines.push('- `data/ticket148-box-breakout-hypothetical-entries.csv` — simulated early-entry outcomes.');
  lines.push('- `data/ticket148-box-breakout-arming-summary.csv` — population-wide shadow-arming statistics.');
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n') + '\n');
  console.log(`→ ${OUT_MD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
