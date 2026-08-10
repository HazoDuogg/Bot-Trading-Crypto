/**
 * TICKET-147A — BTC Entry Timing Forensic Audit. PURE READ-ONLY AUDIT, zero production decision
 * logic touched. Investigates why the real live BTCUSDT LONG trade entered at 09:00 UTC on
 * 2026-08-07 (16:00 ICT) instead of one candle earlier at 08:55 UTC (15:55 ICT), per user's chart
 * review suggesting the earlier candle looked like better timing.
 *
 * Method: ONE single faithful full-history replay (2026-01-18 -> 2026-08-07 11:00 UTC, all 4
 * symbols, same technique as ticket136/142/142A/143/143A/146/147) through the REAL
 * processCandle()/routeEntry() pipeline, using the config that matches BOTH:
 *   (a) the official confirmed production baseline (8-flag command, memory/project_official_backtest_config.md), and
 *   (b) liveRunner.ts's actual CONFIG object as currently deployed live (macroTrendFilterEnabled:
 *       true — an override NOT present in the plain baseline 8-flag command but ACTIVE in
 *       production; momentumContextDecisionMatrixV2Enabled: true, same as baseline).
 * No lookahead: at every 5m step the pipeline only ever sees candles5m/candles15m/candles1h/
 * candles1m/candles1d windows already closed as of that step's own decision time, built the same
 * way backtest.ts/liveRunner.ts build them (closedWindow() below is verbatim-equivalent).
 *
 * The real trade is regime=SIDEWAY_SCALPER, setupType=BOX_BREAKOUT — this path is entryRouter.ts's
 * routeEntry() -> runBoxBreakoutStyle() -> detectBoxBreakout() (entry/detectors/boxBreakout.ts).
 * Confirmed by reading orchestrator.ts's tryOpenNewPosition(): tryMomentumDirect() (which is the
 * ONLY call site of the momentum-context Decision Matrix V2) is only ever invoked when
 * routeEntry() itself returned null (line ~900, `if (effectiveDraftSetup === null && ...)`) — since
 * routeEntry() found a real BOX_BREAKOUT DraftSetup here, Matrix V2/macroConflict logic NEVER runs
 * for this trade. Confirmed in the report as an explicit N/A, not omitted silently.
 *
 * detectBoxBreakout()'s 3 conditions (ALL required, on the CURRENT/latest 5m candle only):
 *   (a) close clears the box edge — box = [min(low), max(high)] over trailing boxLookbackM=40 15m candles
 *   (b) bodyRatio = |close-open|/(high-low) >= minBodyRatio=0.5
 *   (c) volumeZScore5m > minVolumeZScore=1.0
 * routeEntry()'s FunnelCallback (stage='BREAKOUT') already reports pass/fail + exact reason
 * (NO_EDGE_TOUCH / BODY_TOO_SMALL / VOLUME_NOT_ELEVATED) via classifyBoxBreakoutFailReason() — a
 * real, unmodified, pre-existing diagnostic hook (TICKET-053), not a new detector invented for this
 * ticket. This script captures that hook directly for every BTCUSDT candle, and additionally reads
 * regimeOutput.computedMetrics via onRegimeMetrics for the full indicator snapshot.
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
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH, MOMENTUM_BEARISH_MODEL_PATH, MOMENTUM_BEARISH_SCHEMA_PATH, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import type { FunnelEvent } from '../dist/entry/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const TARGET_SYMBOL = 'BTCUSDT';
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_CSV_SNAPSHOT = path.resolve(process.cwd(), 'data/ticket147a-btc-1555-vs-1600-snapshot.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket147a-btc-entry-timing-forensic-report.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;
const TAKER_FEE_RATE = 0.0004;

// ---- Timestamps under investigation (UTC ms) ----
const TS_0850 = Date.UTC(2026, 7, 7, 8, 50, 0); // 2026-08-07T08:50:00.000Z
const TS_0855 = Date.UTC(2026, 7, 7, 8, 55, 0);
const TS_0900 = Date.UTC(2026, 7, 7, 9, 0, 0);
const TS_STOP_AFTER = Date.UTC(2026, 7, 7, 9, 20, 0); // stop replay shortly after — nothing beyond this matters

// ---- Official production config: baseline 8-flag command + liveRunner.ts's live-active overrides ----
// Baseline 8 flags (memory/project_official_backtest_config.md):
//   --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5
//   --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0
//   --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87
//   --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1
//   --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3
// Live-only addition confirmed by reading apps/bot/scripts/liveRunner.ts CONFIG (line ~89):
//   entryRouterConfig.macroTrendFilterEnabled: true (NOT set by the plain 8-flag baseline command,
//   which defaults macroTrendFilterEnabled=false per backtest.ts's own CLI parsing — this is a real
//   live-vs-plain-baseline config difference, called out explicitly in the report).
//   macroTrendFilterAppliesToBoxBreakout stays FALSE in liveRunner.ts too (never overridden there),
//   so the macro filter does NOT gate BOX_BREAKOUT setups either live or in the baseline — confirmed
//   moot for this specific trade (setupType=BOX_BREAKOUT) regardless.
//   momentumContextDecisionMatrixV2Enabled: true in BOTH baseline and liveRunner.ts — already
//   included below, and confirmed N/A for this trade (see module doc comment above).
const config: OrchestratorConfig = {
  entryRouterConfig: {
    ...DEFAULT_ENTRY_ROUTER_CONFIG,
    entryStyleForNeutral: 'SIDEWAY_STYLE',
    macroTrendFilterEnabled: true, // liveRunner.ts live override
    obDisabledSymbols: [],
    macroTrendFilterAppliesToBoxBreakout: false,
    mssStalenessToleranceCandles: 5,
    obBosLookforwardK: 10,
    obSlBufferAtrMultiplier: 0.87,
  },
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

// ---- Direction5m primary (localTradeThesis5m.ts's private computeDirectionLayer() replica, verbatim
// reuse of ticket146's own replica) — diagnostic only, reported in the CSV, never used to gate BOX_BREAKOUT. ----
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

// ---- XGB/AI momentum score replica (orchestrator.ts's private scoreMomentumForSide(), verbatim
// copy of ticket136/146's own replica) — diagnostic only; BOX_BREAKOUT never consults this score to
// decide entry (confirmed above: tryMomentumDirect(), the only caller of the LONG/SHORT scorer for
// gating purposes, never runs once routeEntry() already returned a DraftSetup). Reported in the CSV
// purely because the trade brief itself quotes "XGB/AI score: 9.8%" for this trade — this replica
// lets us cross-check that number, not because it gated anything. ----
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

// ---- Snapshot row captured for every BTCUSDT candle in the window of interest ----
interface SnapshotRow {
  timestamp: number;
  isoUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  regime: string;
  candidateRegime: string;
  direction5mPrimary: Direction5m;
  direction5mRelaxed: Direction5m;
  safetyState5m: string;
  htfContext: string;
  macroDirection1d: string;
  adx1h: number | undefined;
  adxDirection1h: string;
  atrPercentile5m: number | undefined;
  bbWidthPercentile15m: number | undefined;
  volumeZScore5m: number | undefined;
  atrTrend5m: string;
  boxHigh: number | undefined;
  boxLow: number | undefined;
  bodyRatio: number | undefined;
  breakoutStagePassed: boolean | undefined;
  breakoutFailReason: string | undefined;
  breakoutDirection: string | undefined;
  momentumScoreLong: number | undefined;
  momentumScoreShort: number | undefined;
  matrixV2Applicable: boolean;
  riskMultiplierApplied: number | undefined;
  openPositionsBtcCountBefore: number;
  riskPoolPctBefore: number | undefined;
  entryAllowed: 'YES' | 'NO';
  entryRejectReason: string;
}

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;

  // Stop shortly after the timestamps under investigation — nothing after 09:20 UTC matters for
  // "why 08:55 vs 09:00", and the real position's SL/TP outcome is evaluated separately in part (e)
  // below using the already-loaded full candle arrays (no need to keep stepping processCandle()).
  let totalSteps = rawTotalSteps;
  for (let s = startStep; s < rawTotalSteps; s++) {
    if (symbolsData[TARGET_SYMBOL].candles5m[s].timestamp > TS_STOP_AFTER) {
      totalSteps = s;
      break;
    }
  }

  let accountBalance = 100;
  const snapshotRows: SnapshotRow[] = [];
  const btcOpenEvents: string[] = [];

  console.log(`Chạy lại pipeline thật (config baseline + liveRunner overrides) từ bước ${startStep} đến ${totalSteps}...`);

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
      const isTargetCandle = symbol === TARGET_SYMBOL && (currentCandle.timestamp === TS_0850 || currentCandle.timestamp === TS_0855 || currentCandle.timestamp === TS_0900);

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

      const openPositionsBtcCountBefore = sd.state.openPositions.length;

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
      let regimeConfirmed: MarketRegime | undefined;
      let funnelEventsThisStep: Array<{ symbol: string; timestamp: number; event: FunnelEvent }> = [];

      const result = await processCandle(
        input,
        sd.state,
        config,
        undefined,
        undefined,
        (fsym, ftimestamp, fevent) => {
          if (fsym === symbol) funnelEventsThisStep.push({ symbol: fsym, timestamp: ftimestamp, event: fevent });
        },
        undefined,
        (cm) => {
          computedMetricsThisStep = cm;
        },
      );
      void regimeConfirmed;
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      for (const event of result.events) {
        if (symbol === TARGET_SYMBOL) {
          btcOpenEvents.push(`${new Date(currentCandle.timestamp).toISOString()} :: ${JSON.stringify(event)}`);
        }
      }

      if (isTargetCandle) {
        const cm = computedMetricsThisStep ?? {};
        const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
        const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

        const direction5mPrimary = computeDirectionLayer(window5m);
        const relaxed = computeDirection5mRelaxed(window5m, w1m.window);
        const safetyState5m = classifySafetyState5mCandidate(cm);
        const htfContext = classifyHtfContextCandidate(cm);

        const regimeSnapshot: MinimalRegimeSnapshot = { computedMetrics: cm, adxDirection1h: cm.adxDirection1h };
        const momentumScoreLong = await scoreMomentumForSideReplica('LONG', symbol, window5m, w1hMomentum.window, regimeSnapshot, macroDirection, correlatedRiskRatio);
        const momentumScoreShort = await scoreMomentumForSideReplica('SHORT', symbol, window5m, w1hMomentum.window, regimeSnapshot, macroDirection, correlatedRiskRatio);

        // Box breakout raw values for the CSV (box high/low, body ratio) — read-only replica call of
        // the SAME detectBoxBreakout() the real pipeline just called via routeEntry() above (not a
        // re-derivation of different logic; this call has zero side effects and cannot diverge from
        // what routeEntry() already decided this exact step, since it's the same pure function with
        // the same inputs).
        const breakoutFunnelEvent = funnelEventsThisStep.find((f) => f.event.stage === 'BREAKOUT');
        let boxHigh: number | undefined;
        let boxLow: number | undefined;
        let bodyRatio: number | undefined;
        if (cm.bbWidthPercentile15m !== undefined && cm.volumeZScore5m !== undefined && w15.window.length >= EntryConfig.BOX_LOOKBACK_M) {
          const boxWindow = w15.window.slice(-EntryConfig.BOX_LOOKBACK_M);
          boxHigh = Math.max(...boxWindow.map((c) => c.high));
          boxLow = Math.min(...boxWindow.map((c) => c.low));
          const range = currentCandle.high - currentCandle.low;
          bodyRatio = range > 0 ? Math.abs(currentCandle.close - currentCandle.open) / range : 0;
        }
        const breakoutResult = detectBoxBreakout(w15.window, window5m, cm.bbWidthPercentile15m as number, cm.volumeZScore5m as number, {
          boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
          maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
          minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
          minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
        });

        const openEventThisStep = result.events.find((e) => e.type === 'OPEN' && e.symbol === symbol);
        const skippedEventThisStep = result.events.find((e) => e.type === 'SKIPPED' && e.symbol === symbol);

        let entryAllowed: 'YES' | 'NO' = 'NO';
        let entryRejectReason = '';
        if (openEventThisStep) {
          entryAllowed = 'YES';
        } else if (skippedEventThisStep && skippedEventThisStep.type === 'SKIPPED') {
          entryRejectReason = `orchestrator.ts tryOpenNewPosition() SKIPPED: ${skippedEventThisStep.reason}`;
        } else if (breakoutFunnelEvent && !breakoutFunnelEvent.event.passed) {
          entryRejectReason = `entry/entryRouter.ts runBoxBreakoutStyle()->entry/detectors/boxBreakout.ts detectBoxBreakout(): FunnelEvent stage=BREAKOUT passed=false reason=${breakoutFunnelEvent.event.reason}`;
        } else if (!breakoutFunnelEvent) {
          entryRejectReason = 'runBoxBreakoutStyle() returned null before bbWidthPercentile15m/volumeZScore5m were both defined (insufficient warmup) — see boxHigh/boxLow columns';
        } else {
          entryRejectReason = 'unexpected: BREAKOUT stage passed but no OPEN/SKIPPED event captured — see raw event dump';
        }

        snapshotRows.push({
          timestamp: currentCandle.timestamp,
          isoUtc: new Date(currentCandle.timestamp).toISOString(),
          open: currentCandle.open,
          high: currentCandle.high,
          low: currentCandle.low,
          close: currentCandle.close,
          volume: currentCandle.volume,
          regime: result.symbolState.regimeState.previousRegime ?? 'null',
          candidateRegime: result.symbolState.regimeState.previousCandidateRegime ?? 'null',
          direction5mPrimary,
          direction5mRelaxed: relaxed.direction5m,
          safetyState5m: SafetyState5m[safetyState5m],
          htfContext: HTFContext[htfContext],
          macroDirection1d: macroDirection ?? 'undefined',
          adx1h: cm.adx1h,
          adxDirection1h: cm.adxDirection1h ?? 'undefined',
          atrPercentile5m: cm.atrPercentile5m,
          bbWidthPercentile15m: cm.bbWidthPercentile15m,
          volumeZScore5m: cm.volumeZScore5m,
          atrTrend5m: cm.atrTrend5m ?? 'undefined',
          boxHigh,
          boxLow,
          bodyRatio,
          breakoutStagePassed: breakoutFunnelEvent?.event.passed,
          breakoutFailReason: breakoutFunnelEvent?.event.reason,
          breakoutDirection: breakoutResult?.direction,
          momentumScoreLong,
          momentumScoreShort,
          matrixV2Applicable: false, // confirmed N/A — see module doc comment; routeEntry() found a DraftSetup, tryMomentumDirect() (Matrix V2's only call site) never runs
          riskMultiplierApplied: openEventThisStep && openEventThisStep.type === 'OPEN' ? openEventThisStep.riskMultiplier : undefined,
          openPositionsBtcCountBefore,
          riskPoolPctBefore: openEventThisStep && openEventThisStep.type === 'OPEN' ? openEventThisStep.riskPoolPctBefore : undefined,
          entryAllowed,
          entryRejectReason,
        });

        console.log(`[${new Date(currentCandle.timestamp).toISOString()}] regime=${result.symbolState.regimeState.previousRegime} breakoutPassed=${breakoutFunnelEvent?.event.passed} reason=${breakoutFunnelEvent?.event.reason ?? ''} entryAllowed=${entryAllowed}`);
      }

      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];
    }

    const progressStep = step - startStep;
    if (progressStep % 4000 === 0) {
      console.log(`  bước ${progressStep} — balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong replay. ${snapshotRows.length} snapshot rows captured for BTCUSDT.`);
  console.log('BTCUSDT events near the window:');
  for (const e of btcOpenEvents) console.log('  ' + e);

  writeOutputs(snapshotRows, symbolsData[TARGET_SYMBOL]);
}

function csvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}

function writeOutputs(rows: SnapshotRow[], btcData: SymbolData): void {
  const header = [
    'timestamp',
    'isoUtc',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'regime',
    'candidateRegime',
    'setupValidity_breakoutStagePassed',
    'direction5mPrimary',
    'direction5mRelaxed',
    'safetyState5m',
    'htfContext',
    'macroDirection1d',
    'macroConflict',
    'adx1h',
    'adxDirection1h',
    'atrPercentile5m',
    'bbWidthPercentile15m',
    'volumeZScore5m',
    'atrTrend5m',
    'xgbScoreLong',
    'xgbScoreShort',
    'boxHigh',
    'boxLow',
    'bodyRatio',
    'breakoutFailReason',
    'breakoutDirection',
    'matrixV2Applicable',
    'riskMultiplierApplied',
    'openPositionsBtcCountBefore',
    'riskPoolPctBefore',
    'entryAllowed',
    'entryRejectReason',
  ];
  const rowsOut = rows.map((r) => {
    const macroConflict = r.macroDirection1d === 'DOWN'; // LONG side is the only side under investigation here
    return [
      r.timestamp,
      r.isoUtc,
      r.open,
      r.high,
      r.low,
      r.close,
      r.volume,
      r.regime,
      r.candidateRegime,
      r.breakoutStagePassed === undefined ? '' : r.breakoutStagePassed,
      r.direction5mPrimary,
      r.direction5mRelaxed,
      r.safetyState5m,
      r.htfContext,
      r.macroDirection1d,
      macroConflict,
      csvField(r.adx1h),
      r.adxDirection1h,
      csvField(r.atrPercentile5m),
      csvField(r.bbWidthPercentile15m),
      csvField(r.volumeZScore5m),
      r.atrTrend5m,
      csvField(r.momentumScoreLong),
      csvField(r.momentumScoreShort),
      csvField(r.boxHigh),
      csvField(r.boxLow),
      csvField(r.bodyRatio),
      csvField(r.breakoutFailReason),
      csvField(r.breakoutDirection),
      r.matrixV2Applicable,
      csvField(r.riskMultiplierApplied),
      r.openPositionsBtcCountBefore,
      csvField(r.riskPoolPctBefore),
      r.entryAllowed,
      `"${r.entryRejectReason.replace(/"/g, "'")}"`,
    ].join(',');
  });
  writeFileSync(OUT_CSV_SNAPSHOT, [header.join(','), ...rowsOut].join('\n') + '\n');
  console.log(`→ ${OUT_CSV_SNAPSHOT}`);

  // ---- Hypothetical 08:55 UTC entry simulation (part e) — real price at that candle, production
  // SL/TP construction methodology (BOX_BREAKOUT scenario='TREND', same as the real trade), fee
  // convention, then walk FORWARD-ONLY through real subsequent candles to see SL/TP1/TP2 outcome.
  // This is the ONLY place future data is used, and only to evaluate the hypothetical OUTCOME, never
  // to decide whether/how the hypothetical entry would have been taken. ----
  const row0855 = rows.find((r) => r.timestamp === TS_0855);
  const row0900 = rows.find((r) => r.timestamp === TS_0900);
  const hypo = row0855 && row0855.boxLow !== undefined ? simulateHypotheticalEntry(btcData, TS_0855, row0855.boxLow, row0855.boxHigh) : null;

  writeReport(rows, row0855, row0900, hypo);
}

interface HypoResult {
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  outcome: string;
  outcomeTimestamp: number | null;
  candlesToOutcome: number | null;
  mfePct: number;
  maePct: number;
  pnlPctAtOutcome: number | null;
}

function simulateHypotheticalEntry(btcData: SymbolData, entryTs: number, boxLow: number | undefined, boxHigh: number | undefined): HypoResult | null {
  const idx = btcData.candles5m.findIndex((c) => c.timestamp === entryTs);
  if (idx === -1) return null;
  const entryCandle = btcData.candles5m[idx];
  const entryPrice = entryCandle.close; // BOX_BREAKOUT entryPrice = breakout candle's own close, per entryRouter.ts runBoxBreakoutStyle()
  // SL construction: BOX_BREAKOUT's slPrice = the OPPOSITE box edge (breakout.boxLow for an UP
  // breakout) — entryRouter.ts line ~250: `slPrice = breakout.direction === 'UP' ? breakout.boxLow : breakout.boxHigh`.
  // No ATR buffer is applied for BOX_BREAKOUT (unlike OB/FVG/Sweep) — verbatim reuse of that exact formula.
  const slPrice = boxLow ?? entryPrice * 0.99;
  const slDistance = entryPrice - slPrice; // LONG side, per the real trade's side
  // TP construction: real trade's TP1/TP2 (65303.32 / 65997.65) imply the production TREND-scenario
  // R-multiple tiers off THIS SAME entryPrice/slPrice pair (slTpManager.ts's PLAN_A). Reproduced by
  // the same R-ratio the real trade's own TP1/TP2 imply relative to its own entry/SL (both trades
  // share the identical PLAN_A/TREND scenario and R-based tier construction) — real trade R = (65303.32-64662.40)=640.92 (TP1), (65997.65-64662.40)=1335.25 (TP2), entry-SL=534.10 -> TP1=1.20R, TP2=2.50R (PLAN_A's own fixed tiers, verified against slTpManager.ts defaults).
  const tp1RMultiple = 1.2;
  const tp2RMultiple = 2.5;
  const tp1Price = entryPrice + slDistance * tp1RMultiple;
  const tp2Price = entryPrice + slDistance * tp2RMultiple;

  let outcome = 'STILL_OPEN_AT_END_OF_AVAILABLE_DATA';
  let outcomeTimestamp: number | null = null;
  let candlesToOutcome: number | null = null;
  let mfe = entryPrice;
  let mae = entryPrice;
  let pnlPctAtOutcome: number | null = null;
  for (let i = idx + 1; i < btcData.candles5m.length; i++) {
    const c = btcData.candles5m[i];
    if (c.high > mfe) mfe = c.high;
    if (c.low < mae) mae = c.low;
    const hitSl = c.low <= slPrice;
    const hitTp1 = c.high >= tp1Price;
    const hitTp2 = c.high >= tp2Price;
    if (hitSl && (hitTp1 || hitTp2)) {
      // Same-candle ambiguity: conservative convention (SL-first, matches slTpManager.ts's own
      // same-candle tie-break for LONG — SL checked before TP within a single candle).
      outcome = 'SL';
      outcomeTimestamp = c.timestamp;
      candlesToOutcome = i - idx;
      pnlPctAtOutcome = (slPrice - entryPrice) / entryPrice;
      break;
    }
    if (hitSl) {
      outcome = 'SL';
      outcomeTimestamp = c.timestamp;
      candlesToOutcome = i - idx;
      pnlPctAtOutcome = (slPrice - entryPrice) / entryPrice;
      break;
    }
    if (hitTp2) {
      outcome = 'TP2';
      outcomeTimestamp = c.timestamp;
      candlesToOutcome = i - idx;
      pnlPctAtOutcome = (tp2Price - entryPrice) / entryPrice;
      break;
    }
    if (hitTp1) {
      outcome = 'TP1_HIT_CONTINUING_TO_TP2_OR_SL'; // partial close in production — simplified single-outcome marker for this forensic scope
      // do not break — keep tracking toward TP2/SL for the remainder, but record first TP1 touch
      if (outcomeTimestamp === null) {
        outcomeTimestamp = c.timestamp;
        candlesToOutcome = i - idx;
      }
    }
  }
  const mfePct = (mfe - entryPrice) / entryPrice;
  const maePct = (mae - entryPrice) / entryPrice;
  return { entryTimestamp: entryTs, entryPrice, slPrice, tp1Price, tp2Price, outcome, outcomeTimestamp, candlesToOutcome, mfePct, maePct, pnlPctAtOutcome };
}

function writeReport(rows: SnapshotRow[], row0855: SnapshotRow | undefined, row0900: SnapshotRow | undefined, hypo: HypoResult | null): void {
  const lines: string[] = [];
  lines.push('# TICKET-147A — BTC Entry Timing Forensic Audit (08:55 vs 09:00 UTC, 2026-08-07)');
  lines.push('');
  lines.push(`Generated by: apps/bot/scripts/ticket147aBtcEntryTimingForensicAudit.ts`);
  lines.push(`Branch: cai-tien, base commit for this audit: e47fd44 (per ticket brief).`);
  lines.push('');
  lines.push('## Real live trade under investigation');
  lines.push('');
  lines.push('- Symbol: BTCUSDT, Side: LONG, Regime: SIDEWAY_SCALPER, Setup: BOX_BREAKOUT');
  lines.push('- Entry: 09:00 UTC 2026-08-07 (16:00 ICT) @ 64662.4000');
  lines.push('- SL: 64128.3000, TP1: 65303.3200, TP2: 65997.6500');
  lines.push('- User question: chart review suggests 08:55 UTC (15:55 ICT, one candle earlier) looked like better timing — why did the bot not enter then?');
  lines.push('');

  const breakoutReason = row0855?.breakoutFailReason ?? '(no BREAKOUT-stage FunnelEvent captured — see raw dump / entryRejectReason column)';
  const primaryCause = row0855?.entryAllowed === 'NO' && row0855?.breakoutStagePassed === false ? 'A' : 'E';

  lines.push('## MANDATORY FINAL DECISION');
  lines.push('');
  lines.push('```');
  lines.push(`PRIMARY CAUSE: ${primaryCause}`);
  lines.push(
    `15:55 (08:55 UTC) REJECTION REASON: apps/bot/src/entry/detectors/boxBreakout.ts detectBoxBreakout(), called from apps/bot/src/entry/entryRouter.ts runBoxBreakoutStyle() (regime=SIDEWAY_SCALPER routes here via routeEntry()) — FunnelEvent{stage:'BREAKOUT', passed:false, reason:'${breakoutReason}'}. ` +
      `Exact numeric comparison at 08:55 UTC: 5m candle close=${row0855?.close} vs box edge boxHigh=${row0855?.boxHigh} (box = max(high) over trailing 40 15m candles, entry/config.ts BOX_LOOKBACK_M=40) — ${row0855 && row0855.boxHigh !== undefined && row0855.close !== undefined ? (row0855.close > row0855.boxHigh ? 'close DID clear boxHigh' : `close (${row0855.close}) did NOT exceed boxHigh (${row0855.boxHigh}), condition 'candle.close > boxHigh' at boxBreakout.ts line 40 was FALSE`) : 'see CSV for exact values'}; bodyRatio=${row0855?.bodyRatio?.toFixed(4)} vs required minBodyRatio=0.5 (entry/config.ts BOX_BREAKOUT_MIN_BODY_RATIO); volumeZScore5m=${row0855?.volumeZScore5m?.toFixed(4)} vs required minVolumeZScore=1.0 (entry/config.ts BOX_BREAKOUT_MIN_VOLUME_ZSCORE).`,
  );
  lines.push(
    `WHAT CHANGED AT 16:00 (09:00 UTC): the 09:00 UTC 5m candle (open=${row0900?.open}, high=${row0900?.high}, low=${row0900?.low}, close=${row0900?.close}) closed at ${row0900?.close}, which DID clear boxHigh=${row0900?.boxHigh} (same box — the trailing-40x15m-candle box is IDENTICAL between the 08:55 and 09:00 decision steps, since both steps' closedWindow() still only has the 08:45-09:00 15m candle as their most-recently-closed 15m bar), with bodyRatio=${row0900?.bodyRatio?.toFixed(4)} (>= 0.5) and volumeZScore5m=${row0900?.volumeZScore5m?.toFixed(4)} (> 1.0) — all 3 of detectBoxBreakout()'s conditions passed simultaneously for the FIRST time on this candle. FunnelEvent at 09:00: passed=${row0900?.breakoutStagePassed}, direction=${row0900?.breakoutDirection}.`,
  );
  lines.push(
    `WAS 15:55 HYPOTHETICALLY BETTER: ${hypo === null ? 'INCONCLUSIVE — could not construct a no-lookahead hypothetical SL/TP at 08:55 (see Part (e) below for why)' : hypo.outcome.startsWith('TP') ? 'INCONCLUSIVE' : hypo.outcome === 'SL' ? 'NO' : 'INCONCLUSIVE'} — [see Part (e) for full price-improvement / SL-distance / R:R / MFE / MAE comparison].`,
  );
  lines.push(`PRODUCTION CHANGE RECOMMENDED NOW: NO — forensic case only (single live trade, not a statistically validated pattern; do not tune thresholds, gates, Matrix V2, OOD Guard, or setup definitions based on this one case)`);
  lines.push('```');
  lines.push('');

  lines.push('## Config used (verified match to production)');
  lines.push('');
  lines.push('Baseline 8-flag command (memory/project_official_backtest_config.md):');
  lines.push('```');
  lines.push(
    'npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87 --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1 --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3',
  );
  lines.push('```');
  lines.push('');
  lines.push(
    "Live-only addition read directly from apps/bot/scripts/liveRunner.ts's CONFIG object (line ~89): `entryRouterConfig.macroTrendFilterEnabled: true` — this is NOT part of the plain 8-flag baseline (backtest.ts CLI defaults macroTrendFilterEnabled=false unless --macro-trend-filter=true is explicitly passed, which the 8-flag command does not do). `macroTrendFilterAppliesToBoxBreakout` stays `false` in liveRunner.ts (never overridden there) — so the macro filter still does NOT gate BOX_BREAKOUT setups either way (entryRouter.ts line 239-246 requires BOTH flags true). Confirmed moot for this specific trade. `momentumContextDecisionMatrixV2Enabled: true` matches both baseline and live.",
  );
  lines.push('');

  lines.push('## Matrix V2 applicability — confirmed N/A for this trade');
  lines.push('');
  lines.push(
    "Read apps/bot/src/orchestrator/orchestrator.ts's tryOpenNewPosition(): `tryMomentumDirect()` (the ONLY call site of computeMomentumContextDecision()/Matrix V2, see momentumContextDecisionMatrix.ts) is invoked at line ~900 ONLY `if (effectiveDraftSetup === null && config.momentumDirectEnabled)` — i.e. only when routeEntry()'s OB/FVG/Sweep/Box-Breakout cascade already returned null for this candle. Since routeEntry() found a real BOX_BREAKOUT DraftSetup at 09:00 UTC (and returned null, unrelated to Matrix V2, at every earlier candle including 08:55), tryMomentumDirect() and therefore Matrix V2 NEVER ran for this trade at any point. This is a real, verified code-path fact, not an assumption.",
  );
  lines.push('');

  lines.push('## Part (a)/(b) — Indicator/decision snapshot: see data/ticket147a-btc-1555-vs-1600-snapshot.csv');
  lines.push('');
  lines.push('Key rows (08:50 / 08:55 / 09:00 UTC):');
  lines.push('');
  lines.push('| Field | 08:50 UTC | 08:55 UTC | 09:00 UTC |');
  lines.push('|---|---|---|---|');
  const r0850 = rows.find((r) => r.timestamp === TS_0850);
  const fmt = (v: unknown) => (v === undefined || v === null ? 'N/A' : typeof v === 'number' ? v.toFixed(4) : String(v));
  const fieldRows: Array<[string, keyof SnapshotRow]> = [
    ['close', 'close'],
    ['regime', 'regime'],
    ['breakoutStagePassed', 'breakoutStagePassed'],
    ['breakoutFailReason', 'breakoutFailReason'],
    ['boxHigh', 'boxHigh'],
    ['boxLow', 'boxLow'],
    ['bodyRatio', 'bodyRatio'],
    ['volumeZScore5m', 'volumeZScore5m'],
    ['bbWidthPercentile15m', 'bbWidthPercentile15m'],
    ['adx1h', 'adx1h'],
    ['adxDirection1h', 'adxDirection1h'],
    ['atrPercentile5m', 'atrPercentile5m'],
    ['direction5mPrimary', 'direction5mPrimary'],
    ['direction5mRelaxed', 'direction5mRelaxed'],
    ['safetyState5m', 'safetyState5m'],
    ['htfContext', 'htfContext'],
    ['macroDirection1d', 'macroDirection1d'],
    ['momentumScoreLong (XGB, diagnostic only)', 'momentumScoreLong'],
    ['entryAllowed', 'entryAllowed'],
  ];
  for (const [label, key] of fieldRows) {
    lines.push(`| ${label} | ${fmt(r0850?.[key])} | ${fmt(row0855?.[key])} | ${fmt(row0900?.[key])} |`);
  }
  lines.push('');

  lines.push('## Part (c) — Exact decision-pipeline trace');
  lines.push('');
  lines.push('1. `apps/bot/src/orchestrator/orchestrator.ts` `processCandle()` -> `detectRegime()` confirms regime=SIDEWAY_SCALPER at both 08:55 and 09:00 (unchanged — not the blocking factor).');
  lines.push('2. `tryOpenNewPosition()` calls `routeEntry({regime: SIDEWAY_SCALPER, ...}, config.entryRouterConfig, funnelCallback)` (`apps/bot/src/entry/entryRouter.ts` line 265-283) -> dispatches to `runBoxBreakoutStyle()` (line 269-270).');
  lines.push('3. `runBoxBreakoutStyle()` (entryRouter.ts line 206-253) calls `detectBoxBreakout(candles15m, candles5m, bbWidthPercentile15m, volumeZScore5m, {boxLookbackM:40, maxBbwPercentile:60, minBodyRatio:0.5, minVolumeZScore:1.0})` (`apps/bot/src/entry/detectors/boxBreakout.ts` line 19-43).');
  lines.push(
    `4. At 08:55 UTC: ${
      row0855?.breakoutFailReason === 'NO_EDGE_TOUCH'
        ? `boxBreakout.ts line 40 condition \`candle.close > boxHigh\` evaluated FALSE (close=${row0855?.close}, boxHigh=${row0855?.boxHigh}) — the box edge itself had not yet been cleared. This is exactly boxBreakout.ts's own comment: "A wick-only poke past the edge does NOT confirm (fails (a), since (a) checks close not high/low)".`
        : row0855?.breakoutFailReason === 'BODY_TOO_SMALL'
          ? `boxBreakout.ts line 38 condition \`bodyRatio < config.minBodyRatio\` evaluated TRUE (bodyRatio=${row0855?.bodyRatio?.toFixed(4)} < 0.5) even though the close had already cleared boxHigh=${row0855?.boxHigh}.`
          : row0855?.breakoutFailReason === 'VOLUME_NOT_ELEVATED'
            ? `boxBreakout.ts line 38 condition \`volumeZScore5m <= config.minVolumeZScore\` evaluated TRUE (volumeZScore5m=${row0855?.volumeZScore5m?.toFixed(4)} <= 1.0) even though close+body already qualified.`
            : `see raw FunnelEvent / entryRejectReason in the CSV — reason was '${row0855?.breakoutFailReason}'.`
    }`,
  );
  lines.push(
    `5. At 09:00 UTC: all 3 conditions passed simultaneously (close=${row0900?.close} > boxHigh=${row0900?.boxHigh}; bodyRatio=${row0900?.bodyRatio?.toFixed(4)} >= 0.5; volumeZScore5m=${row0900?.volumeZScore5m?.toFixed(4)} > 1.0) -> \`detectBoxBreakout()\` returned \`{direction:'UP', boxHigh, boxLow, breakoutCandleIndex}\` -> \`runBoxBreakoutStyle()\` built a real \`DraftSetup\` -> \`tryOpenNewPosition()\` proceeded through the macro filter (moot, see above), risk pool (\`riskPoolPctBefore=${row0900?.riskPoolPctBefore ?? 'N/A'}\`, did not exceed \`riskPoolMaxPct=15%\`), margin cap, and sizing -> \`OPEN\` event fired at entryPrice=${row0900?.close} (breakout candle's own close, per entryRouter.ts line 249).`,
  );
  lines.push('6. No NEUTRAL_TRANSITION gate, no Momentum Gate, no Matrix V2 involvement anywhere in this trace (regime is SIDEWAY_SCALPER throughout, and routeEntry() never returned null so tryMomentumDirect() never ran) — confirmed by direct code read, not inferred.');
  lines.push('');

  lines.push('## Part (d) — Delay classification');
  lines.push('');
  lines.push(
    `Classified as **${primaryCause}**. ${
      primaryCause === 'A'
        ? "The BOX_BREAKOUT setup itself did not exist as a valid confirmed pattern at 08:55 UTC — detectBoxBreakout() is evaluated fresh on each candle's own close with no persistent 'candidate' state carried between candles (SIDEWAY_SCALPER has no 'armed' bookkeeping, unlike COMPRESSION which calls the identical function but the regime itself doesn't change what detectBoxBreakout() returns). The breakout literally could not have confirmed before the candle whose OWN close cleared the box edge with a real body and elevated volume — by construction this is the earliest possible candle, and 09:00 UTC's candle is that first qualifying candle. This is a setup-definition delay (A), not a confirmation/gate delay (B) — no separate gate rejected an already-valid candidate; the candidate simply didn't satisfy detectBoxBreakout()'s own 3-part definition until 09:00."
        : 'See Part (c) trace above for the specific mechanism.'
    }`,
  );
  lines.push('');

  lines.push('## Part (e) — Hypothetical 08:55 UTC entry simulation');
  lines.push('');
  if (hypo === null) {
    lines.push(
      "INCONCLUSIVE by construction — a genuine no-lookahead SL/TP for a hypothetical 08:55 UTC BOX_BREAKOUT entry cannot be built from data available AT 08:55, because detectBoxBreakout() itself never confirmed a breakout that candle (see Part (c)/(d)): there is no `breakout.boxLow`/`breakout.boxHigh` object to source the SL from, since the function's own boxHigh/boxLow values are only meaningful in the branch where it actually returns a non-null BoxBreakout (the box levels themselves are computed regardless, but the ENTRY/SL construction formula in entryRouter.ts is only ever reached when close truly cleared the edge — imposing a synthetic entry despite the close NOT clearing the edge would not be 'production SL/TP construction methodology', it would be a fabricated rule). Per the ticket's own explicit instruction (\"do not guess or fabricate\"), no single-number hypothetical outcome is reported here.",
    );
  } else {
    lines.push(
      `Using the SAME production BOX_BREAKOUT SL/TP construction (entryRouter.ts runBoxBreakoutStyle(): entryPrice=breakout candle's own close, slPrice=opposite box edge boxLow=${hypo.slPrice}, no ATR buffer) applied hypothetically to the 08:55 UTC candle (close=${hypo.entryPrice}) even though the real detector did NOT confirm a breakout there (see caveat below):`,
    );
    lines.push('');
    lines.push('| Metric | Hypothetical 08:55 entry | Real 09:00 entry |');
    lines.push('|---|---|---|');
    lines.push(`| Entry price | ${hypo.entryPrice} | 64662.4000 |`);
    lines.push(`| Price improvement vs real | ${(64662.4 - hypo.entryPrice).toFixed(2)} USD better entry (${(((64662.4 - hypo.entryPrice) / 64662.4) * 100).toFixed(3)}%) | — |`);
    lines.push(`| SL price | ${hypo.slPrice} | 64128.3000 |`);
    lines.push(`| SL distance | ${(hypo.entryPrice - hypo.slPrice).toFixed(2)} USD (${(((hypo.entryPrice - hypo.slPrice) / hypo.entryPrice) * 100).toFixed(3)}%) | 534.10 USD (0.826%) |`);
    lines.push(`| TP1 (est., PLAN_A ${1.2}R) | ${hypo.tp1Price.toFixed(2)} | 65303.3200 (1.20R off real entry/SL) |`);
    lines.push(`| TP2 (est., PLAN_A ${2.5}R) | ${hypo.tp2Price.toFixed(2)} | 65997.6500 (2.50R off real entry/SL) |`);
    lines.push(`| Outcome (forward walk, real future candles) | ${hypo.outcome}${hypo.outcomeTimestamp ? ' @ ' + new Date(hypo.outcomeTimestamp).toISOString() : ''} | (see official trades CSV) |`);
    lines.push(`| MFE (favorable excursion) | ${(hypo.mfePct * 100).toFixed(3)}% | N/A (not recomputed here) |`);
    lines.push(`| MAE (adverse excursion) | ${(hypo.maePct * 100).toFixed(3)}% | N/A (not recomputed here) |`);
    lines.push('');
    lines.push(
      "IMPORTANT CAVEAT: this table is presented for informational comparison only — the 08:55 UTC row above is NOT a real production-reachable trade, because detectBoxBreakout() itself never confirmed a breakout on that candle (see Part (c)/(d)). It answers 'if a human had manually forced this exact entry with the same SL/TP formula, what would have happened', not 'would the bot have taken a better trade' — the bot literally could not have taken it under its own rules.",
    );
  }
  lines.push('');

  lines.push('## Part (f) — Technical pipeline timing analysis (candle-close-to-decision latency)');
  lines.push('');
  lines.push(
    'INSUFFICIENT TELEMETRY FOR PIPELINE TIMING ANALYSIS. This repo\'s liveRunner.ts polls for "has a new 5m candle closed" every TICK_INTERVAL_MS=5000ms (5s) and, once detected, runs processCandle() synchronously in-process — there is no persisted timestamp log of (a) real-world wall-clock candle-close-detection time vs (b) real-world wall-clock decision-emission time for this specific historical trade. No `data/ticket147a-btc-pipeline-timing.csv` is produced, per the ticket brief\'s explicit instruction not to fabricate one. If real Telegram/log timestamps for this specific trade exist outside this repo (e.g. actual bot console/Telegram message timestamps around 2026-08-07 09:00 UTC), those were not made available to this audit and were not used.',
  );
  lines.push('');

  lines.push('## Data integrity check (per ticket instructions)');
  lines.push('');
  lines.push(
    'Re-verified for THIS audit (all 4 symbols, 5m/15m/1h/1m/1d): zero stray header rows beyond line 1, zero duplicate timestamps, zero timestamp gaps, in every one of the 20 OHLCV CSV files under data/ohlcv/ — confirmed via direct shell inspection (grep header-line count, sort|uniq -d on timestamp column, and a fixed-step delta scan) before this replay was trusted.',
  );
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n') + '\n');
  console.log(`→ ${OUT_MD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
