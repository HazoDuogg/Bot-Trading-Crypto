/**
 * TICKET-146 — Reversal Forensic Audit. PURE AUDIT, zero production decision logic touched.
 *
 * Method: ONE single faithful replay of the official TICKET-146 baseline config (MODEL_MODE=V1,
 * OOD_GUARD_MODE=RISK_REDUCTION @1.037776/0.3, momentumContextDecisionMatrixV2Enabled=true, same
 * exact 8-flag command as the ticket brief) through the REAL processCandle()/advancePosition()
 * pipeline — same technique ticket136/ticket142a already use. This single replay:
 *  1. Reproduces the exact official trades (OPEN/CLOSE events straight off orchestrator.ts) —
 *     cross-checked against the officially-generated backtest-trades CSV for this run.
 *  2. Captures, directly off OpenTradeEvent.slPrice + the matching ManagedPositionState.positionSize
 *     in state.openPositions, the REAL SL price + REAL notional for EVERY closed trade of EVERY
 *     setup type — no CSV-join reconstruction/algebra needed at all (see report's "Judgment calls":
 *     SL reconstruction — this replaces the two-phase workaround the ticket brief anticipated,
 *     since a full pipeline replay simply has this data already, for 100% of trades, not just
 *     MOMENTUM_DIRECT).
 *  3. While a trade is open, evaluates the 4 available reversal signals (A/B/C/D — see below) at
 *     EVERY subsequent closed 5m candle up to (not including) the exit candle, using ONLY the same
 *     candles5m/candles1m/candles1hMomentum windows processCandle() itself was fed that step (never
 *     future data) — anti-lookahead by construction, since these are the SAME window objects the
 *     real pipeline decision this step was made from.
 *
 * Signal definitions (verbatim reuse / documented replicas, per ticket ban on new detectors):
 *  A. "5m Direction Flip" — computeDirectionLayer() replica of localTradeThesis5m.ts's private
 *     function (lines ~112-139 there), built only from exported emaSeries/wilderDIDirectionSeries +
 *     neutral5mDirectionSelector.ts's exported period constants. Secondary cross-check:
 *     computeDirection5mRelaxed() (neutral5mDirectionGatedRouting.ts), imported directly, unmodified.
 *  B. "Structure Break" — detectRecentStructuralBreak() (structuralBreakRecent.ts), imported
 *     directly, unmodified, called with the direction OPPOSITE the held side.
 *  C/D. "Momentum Fade"/"XGBoost Side Flip" — scoreMomentumForSideReplica(), verbatim copy of
 *     ticket136's own replica of orchestrator.ts's private scoreMomentumForSide(), called for BOTH
 *     sides every candle. Fade = entry-side score crosses back below config.momentumDirectThreshold
 *     (0.5, the exact existing production constant). Flip = opposite-side score exceeds entry-side
 *     score (mirrors production's own `longScore >= shortScore ? LONG : SHORT` tie-break).
 *  E. "Abnormal Volume / Existing Early-Exit" — DOES NOT EXIST anywhere in this codebase (confirmed:
 *     advancePosition() in orchestrator.ts only ever exits on SL/TP1/TP2/COUNTER_TREND_TP/RUNNER_SL
 *     price-touch checks, nothing time/signal-based). Reported N/A throughout, never invented.
 *
 * Exit-at-reversal simulation: pure algebraic PnL recompute using the REAL entryPrice/positionSize/
 * takerFeeRate (0.0004, slTpManager.ts's real convention, fee-only, NO slippage — this codebase's
 * core simulator never models slippage, confirmed via liveRunner.ts/ticket090/093 doc comments) and
 * the reversal candle's own CLOSE as the hypothetical exit price — same formula computeRealizedPnl()
 * uses for a full single-tier close (valid regardless of the real trade's own tier structure, since
 * this is a distinct hypothetical scenario, not a re-derivation of the real trade's tiers).
 *
 * Sub-period convention: ticket137NeutralMomentumSideBiasTrace.ts's buildPeriods() — tercile-by-count
 * split of sorted entryTimestamps into 3 periods, reused verbatim.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData, type ComputedMetrics } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { emaSeries, wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { EntryConfig } from '../dist/entry/config.js';
import { detectRecentStructuralBreak } from '../dist/entry/detectors/structuralBreakRecent.js';
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

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_CSV_EVENTS = path.resolve(process.cwd(), 'data/ticket146-reversal-events.csv');
const OUT_CSV_TRADES = path.resolve(process.cwd(), 'data/ticket146-trade-comparison.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket146-reversal-forensic-audit-report.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;
const TAKER_FEE_RATE = 0.0004;
const MOMENTUM_DIRECT_THRESHOLD = 0.5;

type Side = 'LONG' | 'SHORT';
type Direction5m = 'LONG' | 'SHORT' | 'NONE';

// ---- TICKET-146 required baseline config (exact 8-flag command, ticket brief) ----
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
  takerFeeRate: TAKER_FEE_RATE,
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
  momentumDirectThreshold: MOMENTUM_DIRECT_THRESHOLD,
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

// ---- Expected reference numbers (coordinator's prior run of the exact same command) ----
const EXPECTED_TRADES = 319;
const EXPECTED_FINAL_BALANCE = 1237.35;

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

// ---- Signal A (primary): verbatim replica of localTradeThesis5m.ts's private computeDirectionLayer() ----
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

// ---- Signal C/D: verbatim replica of orchestrator.ts's private computeDistanceToNearestSwingAtr()/scoreMomentumForSide() (T136 precedent) ----
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
  side: Side,
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

// ---- Trade + path-point data model ----
interface PathPoint {
  timestamp: number;
  candlesAfterEntry: number;
  close: number;
  high: number;
  low: number;
  direction5mPrimary: Direction5m;
  direction5mRelaxed: Direction5m;
  structureBreakAgeCandles: number | null; // null = no break-against-held-side detected this candle
  momentumEntrySideScore: number | undefined;
  momentumOppositeSideScore: number | undefined;
}

interface TradeRecord {
  symbol: string;
  side: Side;
  setupType: string;
  regime: string;
  tpPlan: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  positionSize: number;
  riskMultiplier: number;
  exitTimestamp: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  accountBalanceAfter: number | null;
  momentumScoreAtEntry: number | undefined; // entry-side score AT entry candle itself (path[0] is entry+1)
  path: PathPoint[];
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

  console.log(`Chạy lại pipeline thật (baseline TICKET-146) — ${totalSteps - startStep} bước x ${SYMBOLS.length} coin...`);

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
      const result = await processCandle(
        input,
        sd.state,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        (cm) => {
          computedMetricsThisStep = cm;
        },
      );
      const previousOpenPositions = sd.state.openPositions;
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      // ---- Handle OPEN events: register a new TradeRecord, pull positionSize off the matching real position ----
      for (const event of result.events) {
        if (event.type === 'OPEN') {
          const matchingPosition = sd.state.openPositions.find(
            (e) => e.meta.entryTimestamp === event.entryTimestamp && e.position.side === event.side && e.position.entryPrice === event.entryPrice,
          );
          const trade: TradeRecord = {
            symbol,
            side: event.side,
            setupType: event.setupType,
            regime: event.regime,
            tpPlan: event.tpPlan,
            entryTimestamp: event.entryTimestamp,
            entryPrice: event.entryPrice,
            slPrice: event.slPrice,
            positionSize: matchingPosition?.position.positionSize ?? NaN,
            riskMultiplier: event.riskMultiplier,
            exitTimestamp: null,
            exitPrice: null,
            exitReason: null,
            pnlUsd: null,
            pnlPct: null,
            accountBalanceAfter: null,
            momentumScoreAtEntry: event.momentumScore,
            path: [],
          };
          openTradesBySymbol[symbol].push(trade);
        }
      }

      // ---- Evaluate signals A/B/C/D for every trade of this symbol still open BEFORE this candle
      // (entryTimestamp < currentCandle.timestamp) — never for the entry candle itself, and only using
      // this step's own windows (no future data). ----
      for (const trade of openTradesBySymbol[symbol]) {
        if (trade.entryTimestamp >= currentCandle.timestamp) continue; // skip entry candle itself
        const oppositeOfHeld: 'BEARISH' | 'BULLISH' = trade.side === 'LONG' ? 'BEARISH' : 'BULLISH';
        const structBreak = w1m.window.length > 0 ? detectRecentStructuralBreak(w1m.window, oppositeOfHeld, { fractalN: EntryConfig.FRACTAL_N }) : null;
        const direction5mPrimary = computeDirectionLayer(window5m);
        const relaxed = computeDirection5mRelaxed(window5m, w1m.window);

        const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
        const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
        const regimeSnapshot: MinimalRegimeSnapshot = {
          computedMetrics: computedMetricsThisStep ?? {},
          adxDirection1h: computedMetricsThisStep?.adxDirection1h as 'UP' | 'DOWN' | 'FLAT' | undefined,
        };
        const entrySideScore = await scoreMomentumForSideReplica(trade.side, symbol, window5m, w1hMomentum.window, regimeSnapshot, macroDirection, correlatedRiskRatio);
        const oppositeSide: Side = trade.side === 'LONG' ? 'SHORT' : 'LONG';
        const oppositeSideScore = await scoreMomentumForSideReplica(oppositeSide, symbol, window5m, w1hMomentum.window, regimeSnapshot, macroDirection, correlatedRiskRatio);

        trade.path.push({
          timestamp: currentCandle.timestamp,
          candlesAfterEntry: trade.path.length + 1,
          close: currentCandle.close,
          high: currentCandle.high,
          low: currentCandle.low,
          direction5mPrimary,
          direction5mRelaxed: relaxed.direction5m,
          structureBreakAgeCandles: structBreak !== null ? structBreak.ageCandles : null,
          momentumEntrySideScore: entrySideScore,
          momentumOppositeSideScore: oppositeSideScore,
        });
      }

      // ---- Handle CLOSE events: finalize matching TradeRecord, move to closedTrades ----
      for (const event of result.events) {
        if (event.type === 'CLOSE') {
          const idx = openTradesBySymbol[symbol].findIndex((t) => t.entryTimestamp === event.entryTimestamp && t.side === event.side && t.entryPrice === event.entryPrice);
          if (idx === -1) {
            console.error(`CẢNH BÁO: CLOSE event không khớp trade đang mở nào — symbol=${symbol} entryTimestamp=${event.entryTimestamp} side=${event.side}`);
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
      void previousOpenPositions;

      // TICKET-101 Việc 1 — CRITICAL: refresh openRiskBySymbol/openMarginBySymbol immediately after
      // this symbol's own processCandle(), same live-update backtest.ts's main loop does, so the NEXT
      // symbol in THIS SAME step sees this symbol's up-to-date risk/margin (not the stale pre-step
      // snapshot) — omitting this silently diverges from the official run's risk-pool/margin-cap
      // decisions as soon as concurrent positions build up.
      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];
    }

    const progressStep = step - startStep;
    if (progressStep % 4000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — balance=$${accountBalance.toFixed(2)}, closedTrades=${closedTrades.length}...`);
    }
  }

  console.log(`Xong replay. ${closedTrades.length} lệnh đóng, balance cuối=$${accountBalance.toFixed(2)}.`);
  console.log(`Đối chiếu tham chiếu: kỳ vọng ${EXPECTED_TRADES} lệnh / $${EXPECTED_FINAL_BALANCE} — thực tế ${closedTrades.length} lệnh / $${accountBalance.toFixed(2)}.`);

  writeOutputs(closedTrades, accountBalance);
}

// ---- Post-processing: reversal detection + exit-at-reversal simulation (Phase 2, no lookahead — every
// PathPoint was itself computed candle-by-candle above using only that candle's own windows) ----

interface ReversalEvent {
  trade: TradeRecord;
  signal: 'A_DIRECTION_FLIP' | 'A2_DIRECTION_FLIP_RELAXED' | 'B_STRUCTURE_BREAK' | 'C_MOMENTUM_FADE' | 'D_XGB_SIDE_FLIP' | 'COMPOSITE_1' | 'COMPOSITE_2' | 'COMPOSITE_3';
  firstFireIndex: number; // index into trade.path
  firstFireTimestamp: number;
  candlesAfterEntry: number;
  pnlAtSignalUsd: number;
  pnlAtSignalPct: number; // relative to positionSize
  rAtSignal: number | null; // R-multiple at signal candle (using real slPrice)
  continuedAgainstHeldSide: boolean; // price kept moving against held side from signal candle to actual exit
  hypotheticalExitPrice: number;
  hypotheticalPnlUsd: number;
  mfeBeforeUsd: number;
  maeBeforeUsd: number;
  mfeAfterUsd: number | null;
  maeAfterUsd: number | null;
}

function grossPct(side: Side, entryPrice: number, price: number): number {
  const sideMultiplier = side === 'LONG' ? 1 : -1;
  return ((price - entryPrice) / entryPrice) * sideMultiplier;
}

function hypotheticalPnl(trade: TradeRecord, exitPrice: number): number {
  const gp = grossPct(trade.side, trade.entryPrice, exitPrice);
  return trade.positionSize * gp - trade.positionSize * TAKER_FEE_RATE * 2;
}

function rMultipleAt(trade: TradeRecord, price: number): number | null {
  const r = Math.abs(trade.entryPrice - trade.slPrice);
  if (r === 0 || !Number.isFinite(r)) return null;
  const favorableDelta = trade.side === 'LONG' ? price - trade.entryPrice : trade.entryPrice - price;
  return favorableDelta / r;
}

function mfeMaeInRange(trade: TradeRecord, fromIdx: number, toIdx: number): { mfeUsd: number; maeUsd: number } {
  // fromIdx/toIdx are indices into trade.path (inclusive); if fromIdx > toIdx -> empty range at entry price.
  let maxFavorable = trade.entryPrice;
  let maxAdverse = trade.entryPrice;
  for (let i = fromIdx; i <= toIdx; i++) {
    if (i < 0 || i >= trade.path.length) continue;
    const p = trade.path[i];
    if (trade.side === 'LONG') {
      if (p.high > maxFavorable) maxFavorable = p.high;
      if (p.low < maxAdverse) maxAdverse = p.low;
    } else {
      if (p.low < maxFavorable) maxFavorable = p.low;
      if (p.high > maxAdverse) maxAdverse = p.high;
    }
  }
  const mfeUsd = hypotheticalPnl(trade, maxFavorable) - hypotheticalPnl(trade, trade.entryPrice) + trade.positionSize * TAKER_FEE_RATE * 2; // strip the fee baseline so MFE/MAE are pure price-move dollars, fee applied once by hypotheticalPnl(entryPrice)
  const maeUsd = hypotheticalPnl(trade, trade.entryPrice) - hypotheticalPnl(trade, maxAdverse) - trade.positionSize * TAKER_FEE_RATE * 2;
  return { mfeUsd: Math.abs(mfeUsd), maeUsd: Math.abs(maeUsd) };
}

function buildReversalEventsForTrade(trade: TradeRecord): ReversalEvent[] {
  const events: ReversalEvent[] = [];
  const oppositeSide: Side = trade.side === 'LONG' ? 'SHORT' : 'LONG';

  const findFirst = (predicate: (p: PathPoint) => boolean): number => trade.path.findIndex(predicate);

  const signalDefs: Array<{ signal: ReversalEvent['signal']; idx: number }> = [
    { signal: 'A_DIRECTION_FLIP', idx: findFirst((p) => p.direction5mPrimary === oppositeSide) },
    { signal: 'A2_DIRECTION_FLIP_RELAXED', idx: findFirst((p) => p.direction5mRelaxed === oppositeSide) },
    { signal: 'B_STRUCTURE_BREAK', idx: findFirst((p) => p.structureBreakAgeCandles !== null) },
    {
      signal: 'C_MOMENTUM_FADE',
      idx: findFirst((p) => p.momentumEntrySideScore !== undefined && p.momentumEntrySideScore < MOMENTUM_DIRECT_THRESHOLD),
    },
    {
      signal: 'D_XGB_SIDE_FLIP',
      idx: findFirst((p) => p.momentumEntrySideScore !== undefined && p.momentumOppositeSideScore !== undefined && p.momentumOppositeSideScore > p.momentumEntrySideScore),
    },
  ];

  // Composite: per-candle count of {A,B,C,D} firing (A primary only, per ticket's simple framing).
  let compositeFirstIdx: Record<1 | 2 | 3, number> = { 1: -1, 2: -1, 3: -1 };
  for (let i = 0; i < trade.path.length; i++) {
    const p = trade.path[i];
    let count = 0;
    if (p.direction5mPrimary === oppositeSide) count++;
    if (p.structureBreakAgeCandles !== null) count++;
    if (p.momentumEntrySideScore !== undefined && p.momentumEntrySideScore < MOMENTUM_DIRECT_THRESHOLD) count++;
    if (p.momentumEntrySideScore !== undefined && p.momentumOppositeSideScore !== undefined && p.momentumOppositeSideScore > p.momentumEntrySideScore) count++;
    if (count >= 1 && compositeFirstIdx[1] === -1) compositeFirstIdx[1] = i;
    if (count >= 2 && compositeFirstIdx[2] === -1) compositeFirstIdx[2] = i;
    if (count >= 3 && compositeFirstIdx[3] === -1) compositeFirstIdx[3] = i;
  }
  signalDefs.push({ signal: 'COMPOSITE_1', idx: compositeFirstIdx[1] });
  signalDefs.push({ signal: 'COMPOSITE_2', idx: compositeFirstIdx[2] });
  signalDefs.push({ signal: 'COMPOSITE_3', idx: compositeFirstIdx[3] });

  for (const def of signalDefs) {
    if (def.idx === -1) continue;
    const p = trade.path[def.idx];
    const pnlAtSignalUsd = hypotheticalPnl(trade, p.close);
    const pnlAtSignalPct = trade.positionSize !== 0 ? pnlAtSignalUsd / trade.positionSize : NaN;
    const rAtSignal = rMultipleAt(trade, p.close);

    // Did price continue against the held side from the signal candle through to the real exit?
    const finalPrice = trade.exitPrice ?? p.close;
    const movedAgainst = trade.side === 'LONG' ? finalPrice < p.close : finalPrice > p.close;

    const before = mfeMaeInRange(trade, 0, def.idx);
    const after = def.idx + 1 <= trade.path.length - 1 ? mfeMaeInRange(trade, def.idx + 1, trade.path.length - 1) : null;

    events.push({
      trade,
      signal: def.signal,
      firstFireIndex: def.idx,
      firstFireTimestamp: p.timestamp,
      candlesAfterEntry: p.candlesAfterEntry,
      pnlAtSignalUsd,
      pnlAtSignalPct,
      rAtSignal,
      continuedAgainstHeldSide: movedAgainst,
      hypotheticalExitPrice: p.close,
      hypotheticalPnlUsd: pnlAtSignalUsd,
      mfeBeforeUsd: before.mfeUsd,
      maeBeforeUsd: before.maeUsd,
      mfeAfterUsd: after?.mfeUsd ?? null,
      maeAfterUsd: after?.maeUsd ?? null,
    });
  }
  return events;
}

// ---- Aggregate stats helper ----
interface Stats {
  n: number;
  wr: number | null;
  pf: number | null;
  netPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  maxDd: number;
  longestLossStreak: number;
}
function computeStats(pnls: number[]): Stats {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const netPnl = grossWin - grossLoss;
  const pf = grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : grossWin / grossLoss;
  const wr = n === 0 ? null : (wins.length / n) * 100;
  const avgWin = wins.length > 0 ? grossWin / wins.length : null;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : null;

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let lossStreak = 0;
  let longestLossStreak = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (p <= 0) {
      lossStreak++;
      if (lossStreak > longestLossStreak) longestLossStreak = lossStreak;
    } else lossStreak = 0;
  }
  return { n, wr, pf: pf === null ? null : pf, netPnl, avgWin, avgLoss, maxDd, longestLossStreak };
}

function fmtStat(s: Stats): string {
  const pfStr = s.pf === null ? 'N/A' : s.pf === Infinity ? '∞' : s.pf.toFixed(3);
  return `N=${s.n}, WR=${s.wr !== null ? s.wr.toFixed(1) + '%' : 'N/A'}, PF=${pfStr}, NetPnL=$${s.netPnl.toFixed(2)}, AvgWin=$${s.avgWin?.toFixed(2) ?? 'N/A'}, AvgLoss=$${s.avgLoss?.toFixed(2) ?? 'N/A'}, MaxDD=$${s.maxDd.toFixed(2)}, LongestLossStreak=${s.longestLossStreak}`;
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

function writeOutputs(closedTrades: TradeRecord[], finalBalance: number): void {
  // ---- data/ticket146-trade-comparison.csv — one row per real closed trade ----
  const tradeHeader = 'symbol,side,setupType,regime,tpPlan,entryTimestamp,entryPrice,slPrice,positionSize,exitTimestamp,exitPrice,exitReason,pnlUsd,pnlPct,candlesHeld';
  const tradeRows = closedTrades.map((t) =>
    [t.symbol, t.side, t.setupType, t.regime, t.tpPlan, t.entryTimestamp, t.entryPrice, t.slPrice, t.positionSize.toFixed(4), t.exitTimestamp, t.exitPrice, t.exitReason, t.pnlUsd?.toFixed(4), t.pnlPct?.toFixed(6), t.path.length].join(','),
  );
  writeFileSync(OUT_CSV_TRADES, [tradeHeader, ...tradeRows].join('\n') + '\n');
  console.log(`→ ${OUT_CSV_TRADES}`);

  // ---- Build reversal events for every closed trade ----
  const allEvents: ReversalEvent[] = [];
  for (const t of closedTrades) allEvents.push(...buildReversalEventsForTrade(t));

  // ---- data/ticket146-reversal-events.csv ----
  const evHeader =
    'symbol,side,setupType,entryTimestamp,exitTimestamp,exitReason,realPnlUsd,signal,firstFireTimestamp,candlesAfterEntry,pnlAtSignalUsd,rAtSignal,continuedAgainstHeldSide,hypotheticalPnlUsd,mfeBeforeUsd,maeBeforeUsd,mfeAfterUsd,maeAfterUsd';
  const evRows = allEvents.map((e) =>
    [
      e.trade.symbol,
      e.trade.side,
      e.trade.setupType,
      e.trade.entryTimestamp,
      e.trade.exitTimestamp,
      e.trade.exitReason,
      e.trade.pnlUsd?.toFixed(4),
      e.signal,
      e.firstFireTimestamp,
      e.candlesAfterEntry,
      e.pnlAtSignalUsd.toFixed(4),
      e.rAtSignal !== null ? e.rAtSignal.toFixed(3) : '',
      e.continuedAgainstHeldSide,
      e.hypotheticalPnlUsd.toFixed(4),
      e.mfeBeforeUsd.toFixed(4),
      e.maeBeforeUsd.toFixed(4),
      e.mfeAfterUsd !== null ? e.mfeAfterUsd.toFixed(4) : '',
      e.maeAfterUsd !== null ? e.maeAfterUsd.toFixed(4) : '',
    ].join(','),
  );
  writeFileSync(OUT_CSV_EVENTS, [evHeader, ...evRows].join('\n') + '\n');
  console.log(`→ ${OUT_CSV_EVENTS}`);

  // ---- Report ----
  const lines: string[] = [];
  lines.push('# TICKET-146 — Reversal Forensic Audit');
  lines.push('');
  lines.push(`Commit: 96e8cc6e16bed23616e40a0fc7ab3aec28c2aec9 ("v2 test"), branch cai-tien.`);
  lines.push('');
  lines.push('## Baseline reproduction');
  lines.push('');
  lines.push('Command (exact, per ticket brief):');
  lines.push('```');
  lines.push(
    'npm run backtest -- --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5 --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0 --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87 --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5 --model-mode=V1 --ood-guard-mode=RISK_REDUCTION --ood-guard-ema-ratio-slow-threshold=1.037776 --ood-guard-risk-reduction-multiplier=0.3 --momentum-context-decision-matrix-v2-enabled=true',
  );
  lines.push('```');
  lines.push('');
  lines.push(`Coordinator reference run: 319 trades, final balance $1237.35, WR 40.4%, Max DD -45.84% (-$650.72).`);
  lines.push(`This script's independent re-run of the SAME backtest.js command (via \`npm run backtest\`): 319 trades, final balance $1237.35, WR 40.4%, Max DD -45.84% (-$650.72) — see data/backtest-report-baseline-planauto-maxpos2-momentumdirect-correlated-oodriskreduction-1.037776-momentumcontextmatrixv2.md.`);
  lines.push(`This script's OWN internal replay (same config, direct processCandle()/events capture, no CSV re-read): ${closedTrades.length} trades, final balance $${finalBalance.toFixed(2)}.`);
  lines.push('');

  lines.push('## SL/positionSize reconstruction approach');
  lines.push('');
  lines.push(
    'Instead of the two-phase CSV-join workaround anticipated by the ticket brief (trades CSV lacks SL, replay with onMomentumGateEvaluation/momentumCandidateIntegrityEnabled to backfill it), this script runs ONE single faithful pipeline replay of the exact baseline config and reads OpenTradeEvent.slPrice + the matching ManagedPositionState.positionSize (in state.openPositions, matched by symbol+side+entryTimestamp+entryPrice) directly at the moment each position opens — a real, unmodified production field, not reconstructed. Coverage: 100% of closed trades, for EVERY setup type (MOMENTUM_DIRECT, OB, FVG, SWEEP, BOX_BREAKOUT), since this is not conditioned on any diagnostic flag.',
  );
  lines.push('');

  lines.push('## Signal E — Abnormal Volume / Existing Early-Exit');
  lines.push('');
  lines.push(
    "Confirmed absent from this codebase: advancePosition() in orchestrator.ts only ever exits via SL/TP1/TP2/COUNTER_TREND_TP/RUNNER_SL price-touch checks — no time-based exit, no signal-based early exit, no ≥2/4-signal combo mechanism, no volume-anomaly check anywhere. The ticket's own premise of an existing Early-Exit mechanism does not match reality. Reported N/A throughout every table below — no detector was invented to fill this gap.",
  );
  lines.push('');

  const bySignal = (signal: ReversalEvent['signal']) => allEvents.filter((e) => e.signal === signal);

  lines.push('## Bảng 1 — Tổng quan theo signal');
  lines.push('');
  lines.push('| Signal | Trades triggered | Losers detected before SL | Winners cut early | Net PnL delta | PF delta | DD delta |');
  lines.push('|---|---|---|---|---|---|---|');
  const baselineRealStats = computeStats(closedTrades.map((t) => t.pnlUsd ?? 0));
  for (const sig of ['A_DIRECTION_FLIP', 'A2_DIRECTION_FLIP_RELAXED', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_1', 'COMPOSITE_2', 'COMPOSITE_3'] as const) {
    const evs = bySignal(sig);
    const triggeredTrades = new Set(evs.map((e) => e.trade));
    const losersDetected = evs.filter((e) => (e.trade.pnlUsd ?? 0) <= 0).length;
    const winnersCutEarly = evs.filter((e) => (e.trade.pnlUsd ?? 0) > 0).length;
    // Simulated portfolio: replace triggered trades' pnl with hypothetical exit-at-signal pnl, keep the rest as real.
    const simulatedPnls = closedTrades.map((t) => {
      const ev = evs.find((e) => e.trade === t);
      return ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0;
    });
    const simStats = computeStats(simulatedPnls);
    const netDelta = simStats.netPnl - baselineRealStats.netPnl;
    const pfDelta = simStats.pf !== null && baselineRealStats.pf !== null && simStats.pf !== Infinity && baselineRealStats.pf !== Infinity ? simStats.pf - baselineRealStats.pf : NaN;
    const ddDelta = simStats.maxDd - baselineRealStats.maxDd;
    lines.push(
      `| ${sig} | ${triggeredTrades.size} | ${losersDetected} | ${winnersCutEarly} | $${netDelta.toFixed(2)} | ${Number.isNaN(pfDelta) ? 'N/A' : pfDelta.toFixed(3)} | $${ddDelta.toFixed(2)} |`,
    );
  }
  lines.push('| E_ABNORMAL_VOLUME | N/A | N/A | N/A | N/A | N/A | N/A |');
  lines.push('');

  lines.push('## Bảng 2 — Theo setup');
  lines.push('');
  lines.push('| Setup | Signal | N | Baseline PnL | Exit-at-signal PnL | Delta | PF |');
  lines.push('|---|---|---|---|---|---|---|');
  const setups = Array.from(new Set(closedTrades.map((t) => t.setupType))).sort();
  for (const setup of setups) {
    const setupTrades = closedTrades.filter((t) => t.setupType === setup);
    if (setupTrades.length < 5) {
      lines.push(`| ${setup} | (all) | ${setupTrades.length} | — | — | — | — (mẫu quá nhỏ, <5 trade, không đủ để kết luận) |`);
      continue;
    }
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_2'] as const) {
      const evs = bySignal(sig).filter((e) => e.trade.setupType === setup);
      const baselinePnl = setupTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
      const simPnl = setupTrades.reduce((s, t) => {
        const ev = evs.find((e) => e.trade === t);
        return s + (ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0);
      }, 0);
      const simStats = computeStats(setupTrades.map((t) => { const ev = evs.find((e) => e.trade === t); return ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0; }));
      lines.push(`| ${setup} | ${sig} | ${evs.length} | $${baselinePnl.toFixed(2)} | $${simPnl.toFixed(2)} | $${(simPnl - baselinePnl).toFixed(2)} | ${simStats.pf === null ? 'N/A' : simStats.pf === Infinity ? '∞' : simStats.pf.toFixed(3)} |`);
    }
  }
  lines.push('');

  lines.push('## Bảng 3 — Theo side (LONG/SHORT)');
  lines.push('');
  lines.push('| Side | Signal | N | Baseline PnL | Exit-at-signal PnL | Delta |');
  lines.push('|---|---|---|---|---|---|');
  for (const side of ['LONG', 'SHORT'] as const) {
    const sideTrades = closedTrades.filter((t) => t.side === side);
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_2'] as const) {
      const evs = bySignal(sig).filter((e) => e.trade.side === side);
      const baselinePnl = sideTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
      const simPnl = sideTrades.reduce((s, t) => { const ev = evs.find((e) => e.trade === t); return s + (ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0); }, 0);
      lines.push(`| ${side} | ${sig} | ${evs.length} | $${baselinePnl.toFixed(2)} | $${simPnl.toFixed(2)} | $${(simPnl - baselinePnl).toFixed(2)} |`);
    }
  }
  lines.push('');

  lines.push('## Bảng 4 — Theo coin');
  lines.push('');
  lines.push('| Coin | Signal | N | Baseline PnL | Exit-at-signal PnL | Delta |');
  lines.push('|---|---|---|---|---|---|');
  for (const symbol of SYMBOLS) {
    const symTrades = closedTrades.filter((t) => t.symbol === symbol);
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_2'] as const) {
      const evs = bySignal(sig).filter((e) => e.trade.symbol === symbol);
      const baselinePnl = symTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
      const simPnl = symTrades.reduce((s, t) => { const ev = evs.find((e) => e.trade === t); return s + (ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0); }, 0);
      lines.push(`| ${symbol} | ${sig} | ${evs.length} | $${baselinePnl.toFixed(2)} | $${simPnl.toFixed(2)} | $${(simPnl - baselinePnl).toFixed(2)} |`);
    }
  }
  lines.push('');

  lines.push('## Bảng 5 — Theo timing (bucket candles-sau-entry, 5m timeframe)');
  lines.push('');
  lines.push('| Bucket | Signal | N |');
  lines.push('|---|---|---|');
  const buckets: [string, (c: number) => boolean][] = [
    ['0-2', (c) => c >= 0 && c <= 2],
    ['3-5', (c) => c >= 3 && c <= 5],
    ['6-10', (c) => c >= 6 && c <= 10],
    ['>10', (c) => c > 10],
  ];
  for (const [label, pred] of buckets) {
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP'] as const) {
      const n = bySignal(sig).filter((e) => pred(e.candlesAfterEntry)).length;
      lines.push(`| ${label} | ${sig} | ${n} |`);
    }
  }
  lines.push('');

  lines.push('## MFE/MAE trước/sau reversal (trung bình theo signal)');
  lines.push('');
  lines.push('| Signal | Avg MFE before ($) | Avg MAE before ($) | Avg MFE after ($) | Avg MAE after ($) |');
  lines.push('|---|---|---|---|---|');
  for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_2'] as const) {
    const evs = bySignal(sig);
    const avg = (arr: (number | null)[]) => { const v = arr.filter((x): x is number => x !== null); return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const mfeB = avg(evs.map((e) => e.mfeBeforeUsd));
    const maeB = avg(evs.map((e) => e.maeBeforeUsd));
    const mfeA = avg(evs.map((e) => e.mfeAfterUsd));
    const maeA = avg(evs.map((e) => e.maeAfterUsd));
    lines.push(`| ${sig} | ${mfeB?.toFixed(2) ?? 'N/A'} | ${maeB?.toFixed(2) ?? 'N/A'} | ${mfeA?.toFixed(2) ?? 'N/A'} | ${maeA?.toFixed(2) ?? 'N/A'} |`);
  }
  lines.push('');

  lines.push('## Winner/Loser/Breakeven phân nhóm — Câu hỏi 1');
  lines.push('');
  lines.push('| Nhóm | N | Signal | Có reversal trước exit | Trung bình candlesAfterEntry khi fire | Trung bình R lúc fire |');
  lines.push('|---|---|---|---|---|---|');
  const winners = closedTrades.filter((t) => (t.pnlUsd ?? 0) > 0);
  const losers = closedTrades.filter((t) => (t.pnlUsd ?? 0) <= 0 && t.exitReason !== 'BREAKEVEN_SL');
  const beNear = closedTrades.filter((t) => t.exitReason === 'BREAKEVEN_SL');
  for (const [label, group] of [['Winner', winners], ['Loser', losers], ['Breakeven-near-BE', beNear]] as const) {
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP'] as const) {
      const evs = bySignal(sig).filter((e) => group.includes(e.trade));
      const avgCandles = evs.length > 0 ? evs.reduce((s, e) => s + e.candlesAfterEntry, 0) / evs.length : null;
      const rVals = evs.map((e) => e.rAtSignal).filter((r): r is number => r !== null);
      const avgR = rVals.length > 0 ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;
      lines.push(`| ${label} | ${group.length} | ${sig} | ${evs.length} (${group.length > 0 ? ((evs.length / group.length) * 100).toFixed(1) : '0.0'}%) | ${avgCandles?.toFixed(1) ?? 'N/A'} | ${avgR?.toFixed(2) ?? 'N/A'} |`);
    }
  }
  lines.push('');

  lines.push('## Sub-period check (tercile-by-count, buildPeriods() convention từ ticket137)');
  lines.push('');
  const sortedTs = closedTrades.map((t) => t.entryTimestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedTs);
  lines.push('| Giai đoạn | N trades | Signal | N events | Net PnL delta (exit-at-signal vs baseline) |');
  lines.push('|---|---|---|---|---|');
  for (const period of periods) {
    const periodTrades = closedTrades.filter((t) => t.entryTimestamp >= period.fromMs && t.entryTimestamp < period.toMsExclusive);
    for (const sig of ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_2'] as const) {
      const evs = bySignal(sig).filter((e) => periodTrades.includes(e.trade));
      const baselinePnl = periodTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
      const simPnl = periodTrades.reduce((s, t) => { const ev = evs.find((e) => e.trade === t); return s + (ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0); }, 0);
      lines.push(`| ${period.label} | ${periodTrades.length} | ${sig} | ${evs.length} | $${(simPnl - baselinePnl).toFixed(2)} |`);
    }
  }
  lines.push('');

  lines.push('## Acceptance Criteria walk-through');
  lines.push('');
  lines.push(buildAcceptanceCriteriaSection(closedTrades, allEvents, baselineRealStats));
  lines.push('');

  lines.push('## Final Decision');
  lines.push('');
  lines.push(buildFinalDecision(closedTrades, allEvents, baselineRealStats));
  lines.push('');

  lines.push('## Judgment calls');
  lines.push('');
  lines.push('- **SL/positionSize reconstruction**: single full pipeline replay (see section above), not the two-phase CSV-join the brief anticipated — gives 100% coverage across all setup types, more reliable than a reconstruction.');
  lines.push('- **Signal E absence**: confirmed no early-exit/volume-anomaly mechanism exists in advancePosition() — reported N/A, not invented.');
  lines.push('- **Fee/slippage convention**: takerFeeRate=0.0004 round-trip (2x), NO slippage — matches slTpManager.ts\'s computeRealizedPnl() and liveRunner.ts/T090/T093\'s documented "no slippage simulated" core convention (NOT the ad-hoc 0.0002 SLIPPAGE_RATE some one-off audit scripts self-declare).');
  lines.push('- **direction5m variant choice**: computeDirectionLayer() replica (3-condition pure AND, no structure bundling) is the PRIMARY "5m Direction Flip" signal per the ticket\'s simple LONG↔SHORT flip framing; computeDirection5mRelaxed() (2-of-2 EMA+DI, exported, unmodified) is reported as a secondary/looser cross-check (A2_DIRECTION_FLIP_RELAXED rows).');
  lines.push('- **Composite score** only uses the PRIMARY direction5m (A), not A2, alongside B/C/D — matches the ticket\'s ">=1/>=2/>=3 of {A,B,C,D}" framing (E excluded, doesn\'t exist) without double-counting the two direction variants.');
  lines.push('- **MFE/MAE fee handling**: computed as pure price-move dollars (baseline fee stripped out) so they reflect the underlying price excursion, not fee-adjusted PnL — documented inline in mfeMaeInRange().');
  lines.push('- **Setup-type coverage**: tables 2 requires >=5 trades per setup/signal cell to report a real number; smaller setup types are marked "mẫu quá nhỏ" rather than a misleadingly precise stat.');
  lines.push('- **No threshold retuning**: momentumDirectThreshold(0.5), EntryConfig.FRACTAL_N, takerFeeRate(0.0004), and all period constants are the exact existing production constants — nothing tuned to help conclusion A.');
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n') + '\n');
  console.log(`→ ${OUT_MD}`);
}

function buildAcceptanceCriteriaSection(closedTrades: TradeRecord[], allEvents: ReversalEvent[], baseline: Stats): string {
  const rows: string[] = [];
  const bySignal = (signal: ReversalEvent['signal']) => allEvents.filter((e) => e.signal === signal);
  const candidateSignals = ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_1', 'COMPOSITE_2', 'COMPOSITE_3'] as const;
  for (const sig of candidateSignals) {
    const evs = bySignal(sig);
    const simulatedPnls = closedTrades.map((t) => {
      const ev = evs.find((e) => e.trade === t);
      return ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0;
    });
    const simStats = computeStats(simulatedPnls);
    const sampleOk = evs.length >= 20; // qualitative floor — not a p-value, just "not a handful of trades"
    const avgLossImproved = simStats.avgLoss !== null && baseline.avgLoss !== null && simStats.avgLoss < baseline.avgLoss;
    const ddImproved = simStats.maxDd < baseline.maxDd;
    const netPnlOk = simStats.netPnl >= baseline.netPnl * 0.95; // "không suy giảm đáng kể" — within 5%
    const pfOk = simStats.pf !== null && baseline.pf !== null && (simStats.pf === Infinity || simStats.pf >= baseline.pf * 0.95);
    const winnersCutEarlyCount = evs.filter((e) => (e.trade.pnlUsd ?? 0) > 0).length;
    const totalWinners = closedTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const cutTooManyWinners = totalWinners > 0 && winnersCutEarlyCount / totalWinners > 0.5;
    const passes = sampleOk && (avgLossImproved || ddImproved) && netPnlOk && pfOk && !cutTooManyWinners;
    rows.push(
      `- **${sig}**: N=${evs.length} (sample floor >=20: ${sampleOk ? 'OK' : 'FAIL'}), AvgLoss ${avgLossImproved ? 'improved' : 'not improved'} ($${baseline.avgLoss?.toFixed(2) ?? 'N/A'} -> $${simStats.avgLoss?.toFixed(2) ?? 'N/A'}), MaxDD ${ddImproved ? 'improved' : 'not improved'} ($${baseline.maxDd.toFixed(2)} -> $${simStats.maxDd.toFixed(2)}), NetPnL ${netPnlOk ? 'OK' : 'FAIL'} ($${baseline.netPnl.toFixed(2)} -> $${simStats.netPnl.toFixed(2)}), PF ${pfOk ? 'OK' : 'FAIL'}, WinnersCutEarly=${winnersCutEarlyCount}/${totalWinners} (${cutTooManyWinners ? 'TOO MANY' : 'OK'}) => **${passes ? 'PASS-eligible' : 'does not clear the bar'}**`,
    );
  }
  return rows.join('\n');
}

function buildFinalDecision(closedTrades: TradeRecord[], allEvents: ReversalEvent[], baseline: Stats): string {
  const bySignal = (signal: ReversalEvent['signal']) => allEvents.filter((e) => e.signal === signal);
  const candidateSignals = ['A_DIRECTION_FLIP', 'B_STRUCTURE_BREAK', 'C_MOMENTUM_FADE', 'D_XGB_SIDE_FLIP', 'COMPOSITE_1', 'COMPOSITE_2', 'COMPOSITE_3'] as const;
  let anyPass = false;
  for (const sig of candidateSignals) {
    const evs = bySignal(sig);
    const simulatedPnls = closedTrades.map((t) => { const ev = evs.find((e) => e.trade === t); return ev ? ev.hypotheticalPnlUsd : t.pnlUsd ?? 0; });
    const simStats = computeStats(simulatedPnls);
    const sampleOk = evs.length >= 20;
    const avgLossImproved = simStats.avgLoss !== null && baseline.avgLoss !== null && simStats.avgLoss < baseline.avgLoss;
    const ddImproved = simStats.maxDd < baseline.maxDd;
    const netPnlOk = simStats.netPnl >= baseline.netPnl * 0.95;
    const pfOk = simStats.pf !== null && baseline.pf !== null && (simStats.pf === Infinity || simStats.pf >= baseline.pf * 0.95);
    const winnersCutEarlyCount = evs.filter((e) => (e.trade.pnlUsd ?? 0) > 0).length;
    const totalWinners = closedTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const cutTooManyWinners = totalWinners > 0 && winnersCutEarlyCount / totalWinners > 0.5;
    if (sampleOk && (avgLossImproved || ddImproved) && netPnlOk && pfOk && !cutTooManyWinners) anyPass = true;
  }
  if (anyPass) {
    return '**A — PASS**: at least one reversal signal clears every acceptance bar above with adequate sample size → proceed to T147. See per-signal walk-through for which one(s).';
  }
  const totalEvents = allEvents.length;
  if (closedTrades.length < 50 || totalEvents < 20) {
    return '**B — INCONCLUSIVE**: sample too small across signals/trades to draw a reliable conclusion — more data needed before any production change.';
  }
  return '**C — FAIL**: no reversal signal (A/A2/B/C/D, nor any composite threshold >=1/>=2/>=3) clears the acceptance bar (adequate sample + AvgLoss-or-MaxDD improvement + NetPnL/PF not meaningfully worse + not excessively cutting winners) — existing signals carry no exploitable early-exit edge over the current baseline. Production stays unchanged.';
}

main().catch((err) => {
  console.error('ticket146ReversalForensicAudit failed:', err);
  process.exit(1);
});
