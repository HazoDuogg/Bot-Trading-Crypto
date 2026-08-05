/**
 * TICKET-136 (2nd instance, same number) — Neutral MOMENTUM_DIRECT Side & Missed 5m Setup Audit.
 * PURE AUDIT, no production decision logic touched.
 *
 * Phần A — for every REAL MOMENTUM_DIRECT trade with regime=NEUTRAL_TRANSITION from the official
 * baseline backtest trades CSV, recompute direction5m/adxDirection1h/macroDirection1d/aiScore at its
 * entry candle and classify ALIGNED_5M / CONFLICT_5M / 5M_NONE against the trade's own recorded side.
 *
 * Phần B — reuses/adapts ticket136Neutral5mOpportunityFunnelAudit.ts's direction-blind OB/FVG/SWEEP/
 * BOX_BREAKOUT candidate detection + hypothetical outcome simulation machinery (same walker
 * convention as ticket113FullyEnrichCandidates.ts/ticket132NeutralCandidateAudit.ts: two-pointer,
 * no-look-ahead, closed candles only) for a NEW rejection-reason taxonomy that adds
 * NEUTRAL_ROUTING_DISABLED and AI_GATE_BLOCK (replacing NEUTRAL_AI_GATE_BLOCK) and ACCEPTED
 * (replacing ACCEPTED_PRODUCTION).
 *
 * NEUTRAL_ROUTING_DISABLED precedence — CODE-VERIFIED judgment call (not guessed): read
 * orchestrator.ts's tryOpenNewPosition() lines ~714-771. For ANY effectiveDraftSetup with
 * regime===NEUTRAL_TRANSITION and setupType!=='MOMENTUM_DIRECT' (i.e. OB/FVG/SWEEP/BOX_BREAKOUT —
 * the only setup types routeEntry() can ever build for this regime), the FIRST check is
 * `if (!config.neutralTransitionGateConfig.neutralTransitionTradingEnabled)`. Under the official
 * baseline this flag is false (never set by the 8-flag command) AND
 * `config.neutral5mDirectionGatedRoutingEnabled` is also not true (not part of the 8 flags either) —
 * so `routingAccepted` stays false and the function returns `{ event: null, newEntry: null }`
 * UNCONDITIONALLY, BEFORE gateScore/AI-gate/HTF-direction/macro is ever computed, and BEFORE any
 * onMomentumGateEvaluation event fires. This applies identically to BOX_BREAKOUT and to OB/FVG/SWEEP
 * — there is no special case for BOX_BREAKOUT in this code path (routeEntry() itself DOES run
 * detectBoxBreakout()/runBoxBreakoutStyle() and finds real candidates, but the resulting DraftSetup is
 * always rejected by this same gate before its own AI check). This directly confirms (independently,
 * from primary source, not just trusted prose) the prior ticket's own "Phát hiện quan trọng bổ sung"
 * footnote finding (0 real onMomentumGateEvaluation NEUTRAL_TRANSITION events ever fired for
 * BOX_BREAKOUT under baseline) — and CORRECTS this new ticket's own prompt text, which assumed
 * BOX_BREAKOUT is structurally different and reaches a real AI gate; it does not, under the exact
 * baseline config. Decision: NEUTRAL_ROUTING_DISABLED is assigned to EVERY OB/FVG/SWEEP/BOX_BREAKOUT
 * candidate as its PRIMARY, real rejectionReason (this is the actual, unconditional blocker under
 * current config) — HTF_DIRECTION_BLOCK/MACRO_DIRECTION_BLOCK/AI_GATE_BLOCK/SETUP_INVALID are computed
 * as a SEPARATE hypothetical "if the cascade did run" classification, reported in a distinct
 * `hypotheticalReasonIfRoutingEnabled` field, never overriding rejectionReason. This is the ticket's
 * own suggested framing, now backed by code, not assumed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData, type RegimeOutput } from '../dist/regime/types.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { EntryConfig } from '../dist/entry/config.js';
import { detectOrderBlock } from '../dist/entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../dist/entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../dist/entry/detectors/liquiditySweep.js';
import { detectMarketStructureShift } from '../dist/entry/detectors/marketStructureShift.js';
import { detectBoxBreakout } from '../dist/entry/detectors/boxBreakout.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { computeDirection5mRelaxed } from '../dist/orchestrator/neutral5mDirectionGatedRouting.js';
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
import { selectTpPlan } from '../dist/orchestrator/orchestrator.js';
import type { OrchestratorConfig } from '../dist/orchestrator/types.js';
import { openPosition, computeRealizedPnl, type ManagedPositionState, type TpPlan as OrchTpPlan } from '../dist/risk/slTpManager.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const TRADES_CSV = path.resolve(
  process.cwd(),
  'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated-oodriskreduction-1.037776.csv',
);
const OUT_CSV = path.resolve(process.cwd(), 'data/ticket136-neutral-momentum-side-missed-5m-candidates.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket136-neutral-momentum-side-missed-5m-audit.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;

const POSITION_SIZE_USD = 1000; // JUDGMENT CALL — same fixed-notional convention as ticket132/prior ticket136.
const TAKER_FEE_RATE = 0.0004;

// ---- Official baseline config (exact 8-flag command). ----
const BASELINE_CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG },
  tpPlan: 'PLAN_A' as OrchTpPlan,
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
};

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
  regimeAge: number;
  lastConfirmedRegime: MarketRegime | null;
  regimeState: { previousRegime: MarketRegime | null; previousCandidateRegime: MarketRegime | null; streakCount: number; previousDangerZoneTimestamp: number | null };
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
    regimeAge: 0,
    lastConfirmedRegime: null,
    regimeState: { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null },
  };
}

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// ---- Verbatim replica of orchestrator.ts's private computeDistanceToNearestSwingAtr(). ----
function computeDistanceToNearestSwingAtr(candles5m: CandleData[]): number | undefined {
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
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

// ---- Verbatim replica of orchestrator.ts's private scoreMomentumForSide() — same formula used for
// BOTH real MOMENTUM_DIRECT scoring (Phần A) and hypothetical OB/FVG/SWEEP/BOX_BREAKOUT scoring
// (Phần B) — production uses the exact same function for both call sites. ----
async function scoreMomentumForSideReplica(
  side: 'LONG' | 'SHORT',
  symbol: string,
  candles5m: CandleData[],
  candles1hMomentum: CandleData[],
  regimeOutput: RegimeOutput,
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
      adx1h: regimeOutput.computedMetrics.adx1h as number,
      atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
      atrTrend5m: regimeOutput.computedMetrics.atrTrend5m as string,
      adxDirection1h: regimeOutput.adxDirection1h as string,
      macroDirection,
      correlatedRiskRatio,
      distanceToNearestSwingAtr: computeDistanceToNearestSwingAtr(candles5m),
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

// ---- Verbatim replica of orchestrator.ts's private computeMomentumDirectSlPrice() — needed because
// the real trades CSV does not record the SL price used at entry (only entry/exit/pnl). Same formula,
// same config, not a new threshold. ----
function computeMomentumDirectSlPriceReplica(side: 'LONG' | 'SHORT', entryPrice: number, currentCandle: CandleData, atr: number, config: OrchestratorConfig): number {
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < config.momentumDirectMinSlPercent) {
    const flooredDistance = (config.momentumDirectMinSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  return slPrice;
}

// ============================================================================================
// PHẦN A — real MOMENTUM_DIRECT trades in NEUTRAL_TRANSITION
// ============================================================================================

interface RealTradeRow {
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: string;
  setupType: string;
  tpPlan: string;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: string;
  pnlUsd: number;
  pnlPct: number;
  riskMultiplierApplied: number;
  accountBalanceAfter: number;
}

function readTradesCsv(filePath: string): RealTradeRow[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [symbol, side, regime, setupType, tpPlan, entryTimestamp, entryPrice, exitTimestamp, exitPrice, exitReason, pnlUsd, pnlPct, riskMultiplierApplied, accountBalanceAfter] =
      line.split(',');
    return {
      symbol,
      side: side as 'LONG' | 'SHORT',
      regime,
      setupType,
      tpPlan,
      entryTimestamp: Number(entryTimestamp),
      entryPrice: Number(entryPrice),
      exitTimestamp: Number(exitTimestamp),
      exitPrice: Number(exitPrice),
      exitReason,
      pnlUsd: Number(pnlUsd),
      pnlPct: Number(pnlPct),
      riskMultiplierApplied: Number(riskMultiplierApplied),
      accountBalanceAfter: Number(accountBalanceAfter),
    };
  });
}

type Dir5mGroup = 'ALIGNED_5M' | 'CONFLICT_5M' | '5M_NONE';

interface PhanARow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  aiScore: number | undefined;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroDirection1d: 'UP' | 'DOWN' | 'FLAT' | undefined;
  direction5m: 'LONG' | 'SHORT' | 'NONE';
  direction5mStrength: string;
  alignedWith1h: boolean | 'N/A';
  alignedWith1d: boolean | 'N/A';
  alignedWith5m: boolean | 'N/A';
  entryPrice: number;
  sl: number | null;
  exitReason: string;
  pnl: number;
  rMultiple: number | null;
  group: Dir5mGroup;
}

function computeAlignment(side: 'LONG' | 'SHORT', dir: 'UP' | 'DOWN' | 'FLAT' | undefined): boolean | 'N/A' {
  if (dir === undefined || dir === 'FLAT') return 'N/A';
  return (side === 'LONG' && dir === 'UP') || (side === 'SHORT' && dir === 'DOWN');
}
function computeAlignment5m(side: 'LONG' | 'SHORT', direction5m: 'LONG' | 'SHORT' | 'NONE'): boolean | 'N/A' {
  if (direction5m === 'NONE') return 'N/A';
  return side === direction5m;
}
function classify5mGroup(side: 'LONG' | 'SHORT', direction5m: 'LONG' | 'SHORT' | 'NONE'): Dir5mGroup {
  if (direction5m === 'NONE') return '5M_NONE';
  return side === direction5m ? 'ALIGNED_5M' : 'CONFLICT_5M';
}

async function runPhanA(symbolsData: Record<string, SymbolData>): Promise<PhanARow[]> {
  console.log('Phần A: đọc real trades CSV...');
  const allTrades = readTradesCsv(TRADES_CSV);
  const target = allTrades.filter((t) => t.setupType === 'MOMENTUM_DIRECT' && t.regime === 'NEUTRAL_TRANSITION');
  console.log(`Phần A: ${allTrades.length} tổng trades, ${allTrades.filter((t) => t.setupType === 'MOMENTUM_DIRECT').length} MOMENTUM_DIRECT, ${target.length} MOMENTUM_DIRECT+NEUTRAL_TRANSITION.`);

  const rows: PhanARow[] = [];
  for (const trade of target) {
    const sd = symbolsData[trade.symbol];
    const step = sd.candles5m.findIndex((c) => c.timestamp === trade.entryTimestamp);
    if (step === -1) {
      // No matching candle found — should not happen for a real trade from this exact OHLCV dataset.
      rows.push({
        symbol: trade.symbol,
        timestamp: trade.entryTimestamp,
        side: trade.side,
        aiScore: undefined,
        adxDirection1h: undefined,
        macroDirection1d: undefined,
        direction5m: 'NONE',
        direction5mStrength: 'N/A',
        alignedWith1h: 'N/A',
        alignedWith1d: 'N/A',
        alignedWith5m: 'N/A',
        entryPrice: trade.entryPrice,
        sl: null,
        exitReason: trade.exitReason,
        pnl: trade.pnlUsd,
        rMultiple: null,
        group: '5M_NONE',
      });
      continue;
    }
    const decisionTime = trade.entryTimestamp + 5 * 60_000;
    const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
    const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
    const w15 = closedWindow(sd.candles15m, -1, 15 * 60_000, decisionTime, WINDOW_15M);
    const w1h = closedWindow(sd.candles1h, -1, 60 * 60_000, decisionTime, WINDOW_1H);
    const w1hMomentum = closedWindow(sd.candles1h, -1, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
    const w1m = closedWindow(sd.candles1m, -1, 60_000, decisionTime, WINDOW_1M);
    const w1d = closedWindow(sd.candles1d, -1, 24 * 60 * 60_000, decisionTime, WINDOW_1D);

    // correlatedRiskRatio needs all 4 symbols' 1h windows at this SAME decisionTime.
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const s of SYMBOLS) {
      w1hBySymbol[s] = closedWindow(symbolsData[s].candles1h, -1, 60 * 60_000, decisionTime, WINDOW_1H).window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    // regimeOutput here is only used for its computedMetrics/adxDirection1h (pure function of the
    // window, independent of hysteresis) — regime confirmation itself is already given by the real
    // trades CSV's own `regime` column (produced by the actual production replay), not recomputed.
    const regimeOutput = detectRegime({
      candles5m: window5m,
      candles15m: w15.window,
      candles1h: w1h.window,
      previousRegime: null,
      previousCandidateRegime: null,
      streakCount: 0,
      previousDangerZoneTimestamp: null,
      candles5mSessionVolume: windowSessionVolume5m,
      correlatedRiskRatio,
    });

    const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection1d = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

    const direction5mFull = computeDirection5mRelaxed(window5m, w1m.window);
    const direction5m = direction5mFull.direction5m;

    const aiScore = await scoreMomentumForSideReplica(trade.side, trade.symbol, window5m, w1hMomentum.window, regimeOutput, macroDirection1d, correlatedRiskRatio);

    const atr = lastDefined(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M));
    const sl = atr !== undefined ? computeMomentumDirectSlPriceReplica(trade.side, trade.entryPrice, sd.candles5m[step], atr, BASELINE_CONFIG) : null;

    // JUDGMENT CALL: rMultiple computed as PRICE-DISTANCE R-multiple (exit-entry distance / entry-SL
    // distance, signed by side), NOT a dollar-risk-based R — the real trade's actual dollar risk
    // depends on risk-pool/margin-cap dynamics at the moment it opened, not reconstructable from the
    // trades CSV alone (which only records pnlUsd/pnlPct/riskMultiplierApplied, not actualRiskDollar).
    // This is the standard scenario-independent R-multiple definition and does not require guessing
    // position sizing.
    const rMultiple =
      sl !== null && Math.abs(trade.entryPrice - sl) > 0
        ? ((trade.side === 'LONG' ? trade.exitPrice - trade.entryPrice : trade.entryPrice - trade.exitPrice) / Math.abs(trade.entryPrice - sl))
        : null;

    rows.push({
      symbol: trade.symbol,
      timestamp: trade.entryTimestamp,
      side: trade.side,
      aiScore,
      adxDirection1h: regimeOutput.adxDirection1h,
      macroDirection1d,
      direction5m,
      direction5mStrength: 'N/A',
      alignedWith1h: computeAlignment(trade.side, regimeOutput.adxDirection1h),
      alignedWith1d: computeAlignment(trade.side, macroDirection1d),
      alignedWith5m: computeAlignment5m(trade.side, direction5m),
      entryPrice: trade.entryPrice,
      sl,
      exitReason: trade.exitReason,
      pnl: trade.pnlUsd,
      rMultiple,
      group: classify5mGroup(trade.side, direction5m),
    });
  }
  return rows;
}

// ============================================================================================
// PHẦN B — direction-blind missed 5m setup audit, NEW rejection-reason taxonomy
// ============================================================================================

type RejectionReasonB =
  | 'HTF_DIRECTION_BLOCK'
  | 'MACRO_DIRECTION_BLOCK'
  | 'NEUTRAL_ROUTING_DISABLED'
  | 'AI_GATE_BLOCK'
  | 'MOMENTUM_GATE_BLOCK'
  | 'SETUP_INVALID'
  | 'RISK_BLOCK'
  | 'ACCEPTED'
  | 'OTHER';

interface CandidateB {
  symbol: string;
  timestamp: number;
  setupType: 'OB' | 'FVG' | 'SWEEP' | 'BOX_BREAKOUT';
  candidateSide: 'LONG' | 'SHORT';
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroDirection1d: 'UP' | 'DOWN' | 'FLAT' | undefined;
  direction5m: 'LONG' | 'SHORT' | 'NONE';
  direction5mStrength: string;
  rejectionStage: string;
  rejectionReason: RejectionReasonB;
  hypotheticalReasonIfRoutingEnabled: string;
  aiScore: number | undefined;
  hypotheticalOutcome: 'RESOLVED_WIN' | 'RESOLVED_LOSS' | 'UNRESOLVED' | 'NOT_SIMULATED';
  pnl: number | null;
  rMultiple: number | null;
  // internal (not in required CSV columns but needed for simulation)
  entryTimestamp: number | null;
  entryPrice: number | null;
  slPrice: number | null;
}

function classifyDirGroupSimple(side: 'LONG' | 'SHORT', htf: 'UP' | 'DOWN' | 'FLAT' | undefined): 'ALIGNED' | 'CONFLICT' | 'FLAT_OR_NA' {
  if (htf === undefined || htf === 'FLAT') return 'FLAT_OR_NA';
  return (side === 'LONG' && htf === 'UP') || (side === 'SHORT' && htf === 'DOWN') ? 'ALIGNED' : 'CONFLICT';
}

async function runPhanB(symbolsData: Record<string, SymbolData>): Promise<{ candidates: CandidateB[]; decisionCandleCount: number }> {
  const candidates: CandidateB[] = [];
  const seenKeys = new Set<string>();
  let decisionCandleCount = 0;
  const decisionCandleKeys = new Set<string>();

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Phần B: walk direction-blind qua ${totalSteps - startStep} bước x ${SYMBOLS.length} coin...`);

  for (let step = startStep; step < totalSteps; step++) {
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

      const regimeOutput = detectRegime({
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        previousRegime: sd.regimeState.previousRegime,
        previousCandidateRegime: sd.regimeState.previousCandidateRegime,
        streakCount: sd.regimeState.streakCount,
        previousDangerZoneTimestamp: sd.regimeState.previousDangerZoneTimestamp,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
      });
      sd.regimeState = {
        previousRegime: regimeOutput.regime,
        previousCandidateRegime: regimeOutput.candidateRegime,
        streakCount: regimeOutput.streakCount,
        previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
      };

      if (regimeOutput.regime !== MarketRegime.NEUTRAL_TRANSITION) continue;

      decisionCandleCount++;
      decisionCandleKeys.add(`${symbol}|${currentCandle.timestamp}`);

      const direction5mFull = computeDirection5mRelaxed(window5m, w1m.window);
      const direction5m = direction5mFull.direction5m;
      const adxDirection1h = regimeOutput.adxDirection1h;
      const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
      const macroDirection1d = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

      // ---- OB/FVG/SWEEP direction-blind, both sides ----
      for (const [direction, candidateSide] of [
        ['BULLISH', 'LONG'],
        ['BEARISH', 'SHORT'],
      ] as const) {
        const obDisabled = BASELINE_CONFIG.entryRouterConfig.obDisabledSymbols.includes(symbol);
        const ob = obDisabled ? null : detectOrderBlock(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K });
        const fvg = detectFairValueGap(window5m, direction);
        const sweep = detectLiquiditySweep(window5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD });

        const zones: Array<{ setupType: 'OB' | 'FVG' | 'SWEEP'; rawSlPrice: number; zoneCandleIndex: number; bufferMultiplier: number }> = [];
        if (ob) zones.push({ setupType: 'OB', rawSlPrice: direction === 'BULLISH' ? ob.low : ob.high, zoneCandleIndex: ob.candleIndex, bufferMultiplier: BASELINE_CONFIG.entryRouterConfig.obSlBufferAtrMultiplier });
        if (fvg) zones.push({ setupType: 'FVG', rawSlPrice: direction === 'BULLISH' ? fvg.bottom : fvg.top, zoneCandleIndex: fvg.candleIndex, bufferMultiplier: EntryConfig.SL_BUFFER_ATR_MULTIPLIER });
        if (sweep) {
          const sweepCandle = window5m[sweep.candleIndex];
          zones.push({ setupType: 'SWEEP', rawSlPrice: direction === 'BULLISH' ? sweepCandle.low : sweepCandle.high, zoneCandleIndex: sweep.candleIndex, bufferMultiplier: EntryConfig.SL_BUFFER_ATR_MULTIPLIER });
        }

        for (const zone of zones) {
          const key = `${symbol}|${currentCandle.timestamp}|${zone.setupType}|${candidateSide}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const zoneTimestamp = window5m[zone.zoneCandleIndex].timestamp;
          const mssWindow = w1m.window.filter((c) => c.timestamp >= zoneTimestamp);
          const mssConfirmedIndex = detectMarketStructureShift(mssWindow, direction, { fractalN: EntryConfig.FRACTAL_N });

          let entryPrice: number | null = null;
          let slPrice: number | null = null;
          let entryTimestamp: number | null = null;
          let setupInvalid = false;
          let setupInvalidDetail = '';

          if (mssConfirmedIndex === null) {
            setupInvalid = true;
            setupInvalidDetail = 'zone found, MSS chưa xác nhận trong window hiện có';
          } else {
            const candlesFromEnd = mssWindow.length - 1 - mssConfirmedIndex;
            if (candlesFromEnd >= EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES) {
              setupInvalid = true;
              setupInvalidDetail = `MSS_TIMEOUT — confirmation cũ ${candlesFromEnd} nến`;
            } else {
              entryPrice = mssWindow[mssConfirmedIndex].close;
              entryTimestamp = mssWindow[mssConfirmedIndex].timestamp;
              const atr = lastDefined(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M));
              if (atr === undefined) {
                setupInvalid = true;
                setupInvalidDetail = 'không đủ lịch sử 5m để tính ATR buffer';
                entryPrice = null;
                entryTimestamp = null;
              } else {
                const buffer = zone.bufferMultiplier * atr;
                slPrice = direction === 'BULLISH' ? zone.rawSlPrice - buffer : zone.rawSlPrice + buffer;
              }
            }
          }

          // PRIMARY rejectionReason: under baseline, EVERY OB/FVG/SWEEP candidate is unconditionally
          // rejected by the neutralTransitionTradingEnabled=false gate before AI/HTF/macro is ever
          // reached (see file header for the code citation) — UNLESS the setup itself never completed
          // (SETUP_INVALID takes priority: a candidate with no valid entry/SL was never even a real
          // routing decision).
          let rejectionReason: RejectionReasonB;
          let rejectionStage: string;
          let hypotheticalReasonIfRoutingEnabled = 'N/A';
          let aiScore: number | undefined;

          if (setupInvalid) {
            rejectionReason = 'SETUP_INVALID';
            rejectionStage = 'MSS/ATR';
            hypotheticalReasonIfRoutingEnabled = setupInvalidDetail;
          } else {
            rejectionReason = 'NEUTRAL_ROUTING_DISABLED';
            rejectionStage = 'ROUTING (neutralTransitionTradingEnabled=false, neutral5mDirectionGatedRoutingEnabled=false dưới baseline — code-verified, orchestrator.ts tryOpenNewPosition())';

            // Hypothetical secondary classification — "if the cascade did run", in priority order
            // matching runTrendStyle()'s hypothetical gate order (same as prior ticket's script).
            const htfBlocked = adxDirection1h !== undefined && adxDirection1h !== 'FLAT' && (candidateSide === 'LONG' ? 'UP' : 'DOWN') !== adxDirection1h;
            const macroBlocked =
              BASELINE_CONFIG.entryRouterConfig.macroTrendFilterEnabled &&
              ((candidateSide === 'LONG' && macroDirection1d === 'DOWN') || (candidateSide === 'SHORT' && macroDirection1d === 'UP'));
            if (htfBlocked) {
              hypotheticalReasonIfRoutingEnabled = 'HTF_DIRECTION_BLOCK';
            } else if (macroBlocked) {
              hypotheticalReasonIfRoutingEnabled = 'MACRO_DIRECTION_BLOCK';
            } else {
              aiScore = await scoreMomentumForSideReplica(candidateSide, symbol, window5m, w1hMomentum.window, regimeOutput, macroDirection1d, correlatedRiskRatio);
              const threshold = BASELINE_CONFIG.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold;
              if (aiScore === undefined) {
                hypotheticalReasonIfRoutingEnabled = 'DATA_INSUFFICIENT (không đủ lịch sử EMA/ATR để tính momentum score)';
              } else if (aiScore < threshold) {
                hypotheticalReasonIfRoutingEnabled = 'AI_GATE_BLOCK (hypothetical)';
              } else {
                hypotheticalReasonIfRoutingEnabled = 'WOULD_PASS_AI_GATE (hypothetical)';
              }
            }
          }

          candidates.push({
            symbol,
            timestamp: currentCandle.timestamp,
            setupType: zone.setupType,
            candidateSide,
            adxDirection1h,
            macroDirection1d,
            direction5m,
            direction5mStrength: 'N/A',
            rejectionStage,
            rejectionReason,
            hypotheticalReasonIfRoutingEnabled,
            aiScore,
            hypotheticalOutcome: 'NOT_SIMULATED',
            pnl: null,
            rMultiple: null,
            entryTimestamp,
            entryPrice,
            slPrice,
          });
        }
      }

      // ---- BOX_BREAKOUT — direction-blind by construction. Same NEUTRAL_ROUTING_DISABLED verdict
      // applies (code-verified: no special case for BOX_BREAKOUT in the gate at orchestrator.ts
      // lines ~714-771 — routeEntry() DOES run runBoxBreakoutStyle() and CAN find a real candidate,
      // but the resulting DraftSetup is rejected by the exact same unconditional gate). ----
      const bbWidthPercentile15m = regimeOutput.computedMetrics.bbWidthPercentile15m as number | undefined;
      const volumeZScore5m = regimeOutput.computedMetrics.volumeZScore5m as number | undefined;
      if (bbWidthPercentile15m !== undefined && volumeZScore5m !== undefined) {
        const breakout = detectBoxBreakout(w15.window, window5m, bbWidthPercentile15m, volumeZScore5m, {
          boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
          maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
          minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
          minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
        });
        if (breakout) {
          const candidateSide: 'LONG' | 'SHORT' = breakout.direction === 'UP' ? 'LONG' : 'SHORT';
          const key = `${symbol}|${currentCandle.timestamp}|BOX_BREAKOUT|${candidateSide}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const entryPrice = window5m[breakout.breakoutCandleIndex].close;
            const slPrice = breakout.direction === 'UP' ? breakout.boxLow : breakout.boxHigh;
            const entryTs = window5m[breakout.breakoutCandleIndex].timestamp;

            const macroBlocked =
              BASELINE_CONFIG.entryRouterConfig.macroTrendFilterEnabled &&
              BASELINE_CONFIG.entryRouterConfig.macroTrendFilterAppliesToBoxBreakout &&
              ((candidateSide === 'LONG' && macroDirection1d === 'DOWN') || (candidateSide === 'SHORT' && macroDirection1d === 'UP'));

            let hypotheticalReasonIfRoutingEnabled: string;
            let aiScore: number | undefined;
            if (macroBlocked) {
              hypotheticalReasonIfRoutingEnabled = 'MACRO_DIRECTION_BLOCK';
            } else {
              aiScore = await scoreMomentumForSideReplica(candidateSide, symbol, window5m, w1hMomentum.window, regimeOutput, macroDirection1d, correlatedRiskRatio);
              const threshold = BASELINE_CONFIG.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold;
              hypotheticalReasonIfRoutingEnabled =
                aiScore === undefined
                  ? 'DATA_INSUFFICIENT (không đủ lịch sử EMA/ATR để tính momentum score)'
                  : aiScore < threshold
                    ? 'AI_GATE_BLOCK (hypothetical)'
                    : 'WOULD_PASS_AI_GATE (hypothetical)';
            }

            candidates.push({
              symbol,
              timestamp: currentCandle.timestamp,
              setupType: 'BOX_BREAKOUT',
              candidateSide,
              adxDirection1h,
              macroDirection1d,
              direction5m,
              direction5mStrength: 'N/A',
              rejectionStage: 'ROUTING (neutralTransitionTradingEnabled=false dưới baseline — code-verified; BOX_BREAKOUT KHÔNG khác OB/FVG/SWEEP ở gate này, dù runBoxBreakoutStyle() có thực sự chạy detect)',
              rejectionReason: 'NEUTRAL_ROUTING_DISABLED',
              hypotheticalReasonIfRoutingEnabled,
              aiScore,
              hypotheticalOutcome: 'NOT_SIMULATED',
              pnl: null,
              rMultiple: null,
              entryTimestamp: entryTs,
              entryPrice,
              slPrice,
            });
          }
        }
      }
    }
  }

  console.log(`Phần B: decision candles = ${decisionCandleKeys.size}, candidates = ${candidates.length}`);

  // ---- Hypothetical outcome simulation — every candidate with a valid entry/SL (SETUP_INVALID rows
  // excluded, since they never had a real entry/SL to simulate). Not gated on rejectionReason
  // (unlike the prior ticket's script) because per this ticket's own §Kiểm tra, "Candidate đủ setup
  // nhưng bị routing/gate chặn phải được hypothetical simulation" — ALL NEUTRAL_ROUTING_DISABLED
  // candidates qualify since that IS the real block. ----
  const simTargets = candidates.filter((c) => c.entryPrice !== null && c.slPrice !== null && c.rejectionReason === 'NEUTRAL_ROUTING_DISABLED');
  console.log(`Phần B: chạy hypothetical simulation cho ${simTargets.length} candidate (NEUTRAL_ROUTING_DISABLED)...`);

  for (const cand of simTargets) {
    const sd = symbolsData[cand.symbol];
    const entryStep = sd.candles5m.findIndex((c) => c.timestamp === cand.entryTimestamp);
    if (entryStep === -1) {
      cand.hypotheticalOutcome = 'UNRESOLVED';
      continue;
    }
    const tpPlan = selectTpPlan(BASELINE_CONFIG.tpPlan, cand.aiScore, BASELINE_CONFIG.planAutoSelectionConfig);
    let pos: ManagedPositionState;
    try {
      pos = openPosition({
        scenario: 'TREND',
        entryPrice: cand.entryPrice as number,
        slPrice: cand.slPrice as number,
        side: cand.candidateSide,
        tpPlan,
        positionSize: POSITION_SIZE_USD,
        takerFeeRate: TAKER_FEE_RATE,
      });
    } catch {
      cand.hypotheticalOutcome = 'UNRESOLVED';
      continue;
    }
    let resolved = false;
    let exitPrice: number | null = null;
    const { advancePosition } = await import('../dist/orchestrator/orchestrator.js');
    for (let step = entryStep + 1; step < sd.candles5m.length; step++) {
      const candle = sd.candles5m[step];
      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const { position, exitPrice: ep } = advancePosition(pos, candle, window5m, BASELINE_CONFIG.isLowConfidenceOrLowLiquidity);
      pos = position;
      if (pos.closed) {
        resolved = true;
        exitPrice = ep;
        break;
      }
    }
    if (!resolved) {
      cand.hypotheticalOutcome = 'UNRESOLVED';
      continue;
    }
    const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
    const riskDollar = Math.abs((cand.entryPrice as number) - (cand.slPrice as number)) * (POSITION_SIZE_USD / (cand.entryPrice as number));
    cand.pnl = pnlUsd;
    cand.rMultiple = riskDollar > 0 ? pnlUsd / riskDollar : null;
    cand.hypotheticalOutcome = pnlUsd > 0 ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
  }

  return { candidates, decisionCandleCount: decisionCandleKeys.size };
}

// ============================================================================================
// CSV / report writers
// ============================================================================================

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(phanA: PhanARow[], phanB: CandidateB[]): string {
  const lines: string[] = [];
  lines.push('# PHẦN A — MOMENTUM_DIRECT real trades (NEUTRAL_TRANSITION)');
  lines.push(
    ['section', 'symbol', 'timestamp', 'side', 'aiScore', 'adxDirection1h', 'macroDirection1d', 'direction5m', 'direction5mStrength', 'alignedWith1h', 'alignedWith1d', 'alignedWith5m', 'entryPrice', 'sl', 'exitReason', 'pnl', 'rMultiple', 'group'].join(','),
  );
  for (const r of phanA) {
    lines.push(
      ['A', r.symbol, r.timestamp, r.side, r.aiScore, r.adxDirection1h, r.macroDirection1d, r.direction5m, r.direction5mStrength, r.alignedWith1h, r.alignedWith1d, r.alignedWith5m, r.entryPrice, r.sl, r.exitReason, r.pnl, r.rMultiple, r.group]
        .map(esc)
        .join(','),
    );
  }
  lines.push('# PHẦN B — direction-blind missed 5m setup candidates');
  lines.push(
    ['section', 'symbol', 'timestamp', 'setupType', 'candidateSide', 'adxDirection1h', 'macroDirection1d', 'direction5m', 'direction5mStrength', 'rejectionStage', 'rejectionReason', 'hypotheticalReasonIfRoutingEnabled', 'aiScore', 'hypotheticalOutcome', 'pnl', 'rMultiple'].join(','),
  );
  for (const c of phanB) {
    lines.push(
      ['B', c.symbol, c.timestamp, c.setupType, c.candidateSide, c.adxDirection1h, c.macroDirection1d, c.direction5m, c.direction5mStrength, c.rejectionStage, c.rejectionReason, c.hypotheticalReasonIfRoutingEnabled, c.aiScore, c.hypotheticalOutcome, c.pnl, c.rMultiple]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

interface GroupStats {
  n: number;
  resolved: number;
  wins: number;
  winRate: number | null;
  pf: number | null;
  netPnl: number;
  avgR: number | null;
  maxDdUsd: number | null;
}
function statsFromResolved(resolvedRows: { pnl: number | null; rMultiple: number | null }[]): GroupStats {
  const wins = resolvedRows.filter((r) => (r.pnl as number) > 0);
  const losses = resolvedRows.filter((r) => (r.pnl as number) <= 0);
  const grossWin = wins.reduce((s, r) => s + (r.pnl as number), 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + (r.pnl as number), 0));
  const netPnl = resolvedRows.reduce((s, r) => s + (r.pnl as number), 0);
  const rVals = resolvedRows.filter((r) => r.rMultiple !== null).map((r) => r.rMultiple as number);
  let cum = 0, peak = 0, maxDd = 0;
  for (const r of resolvedRows) {
    cum += r.pnl as number;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  return {
    n: resolvedRows.length,
    resolved: resolvedRows.length,
    wins: wins.length,
    winRate: resolvedRows.length > 0 ? (wins.length / resolvedRows.length) * 100 : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    netPnl,
    avgR: rVals.length > 0 ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null,
    maxDdUsd: resolvedRows.length > 0 ? maxDd : null,
  };
}
function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return 'N/A';
  if (n === Infinity) return '∞';
  return n.toFixed(d);
}
function statsRow(label: string, s: GroupStats): string {
  return `| ${label} | ${s.n} | ${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'} | ${fmt(s.pf, 4)} | ${s.netPnl >= 0 ? '+' : ''}${fmt(s.netPnl)} | ${fmt(s.avgR, 3)} | ${s.maxDdUsd !== null ? fmt(s.maxDdUsd) : 'N/A'} |`;
}

function subPeriodsGeneric<T extends { timestamp: number }>(rows: T[]): { label: string; rows: T[] }[] {
  if (rows.length === 0) return [{ label: 'P1', rows: [] }, { label: 'P2', rows: [] }, { label: 'P3', rows: [] }];
  const timestamps = rows.map((r) => r.timestamp);
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const span = max - min;
  const bounds = [min, min + span / 3, min + (2 * span) / 3, max + 1];
  const labels = ['P1', 'P2', 'P3'];
  return labels.map((label, i) => ({ label, rows: rows.filter((r) => r.timestamp >= bounds[i] && r.timestamp < bounds[i + 1]) }));
}

function buildReport(phanA: PhanARow[], phanB: CandidateB[], decisionCandleCount: number, commitHash: string, runCmdOutput: string): string {
  const lines: string[] = [];
  lines.push('# TICKET-136 — Neutral MOMENTUM_DIRECT Side & Missed 5m Setup Audit');
  lines.push('');
  lines.push('Nhánh `cai-tien`. Audit thuần túy — KHÔNG sửa production decision code. Chỉ đo/phân tích.');
  lines.push('');

  lines.push('## Phương pháp');
  lines.push('');
  lines.push('- Phần A dùng REAL trades từ file trades CSV của lần chạy baseline chính thức (không phải candidate giả định) — lọc `setupType=MOMENTUM_DIRECT` và `regime=NEUTRAL_TRANSITION`. Tại mỗi entry timestamp, tính lại `adxDirection1h`/`macroDirection1d`/`direction5m`/`aiScore` bằng đúng công thức production (`detectRegime()`, `wilderDIDirectionSeries()`, `computeDirection5mRelaxed()`, `scoreMomentumForSide()` replica).');
  lines.push('- `sl` (stop loss) không được ghi trong trades CSV gốc (chỉ có entry/exit/pnl) — tính lại bằng bản sao verbatim `computeMomentumDirectSlPriceReplica()` của hàm private `computeMomentumDirectSlPrice()` trong `orchestrator.ts` (cùng công thức, cùng config, không đổi threshold).');
  lines.push('- **JUDGMENT CALL — rMultiple (Phần A)**: tính theo PRICE-DISTANCE R-multiple (khoảng cách exit-entry / khoảng cách entry-SL, có dấu theo side), KHÔNG phải dollar-risk-based R — dollar risk thật của lệnh phụ thuộc risk-pool/margin-cap tại thời điểm mở, không tái tạo được chỉ từ trades CSV (vốn chỉ có pnlUsd/pnlPct/riskMultiplierApplied, không có actualRiskDollar). Đây là định nghĩa R-multiple chuẩn, độc lập với position sizing thật.');
  lines.push('- Phần B: reuse/adapt trực tiếp `ticket136Neutral5mOpportunityFunnelAudit.ts` (walker two-pointer no-look-ahead, direction-blind OB/FVG/SWEEP/BOX_BREAKOUT detection, cùng convention `ticket113FullyEnrichCandidates.ts`/`ticket132NeutralCandidateAudit.ts`) cho taxonomy MỚI.');
  lines.push('');
  lines.push('### Judgment call bắt buộc — thứ tự ưu tiên `NEUTRAL_ROUTING_DISABLED`');
  lines.push('');
  lines.push('**CODE-VERIFIED, không đoán**: đọc trực tiếp `apps/bot/src/orchestrator/orchestrator.ts`\'s `tryOpenNewPosition()` (dòng ~714-771). Với MỌI `effectiveDraftSetup` có `regime===NEUTRAL_TRANSITION` và `setupType!=="MOMENTUM_DIRECT"` (tức là OB/FVG/SWEEP/BOX_BREAKOUT — các setupType duy nhất `routeEntry()` có thể trả về cho regime này), check ĐẦU TIÊN là `if (!config.neutralTransitionGateConfig.neutralTransitionTradingEnabled)`. Dưới baseline chính thức, flag này là `false` (không nằm trong 8 flag) VÀ `config.neutral5mDirectionGatedRoutingEnabled` cũng không `true` (cũng không nằm trong 8 flag) — nên `routingAccepted` luôn `false` và hàm trả `{ event: null, newEntry: null }` NGAY LẬP TỨC, TRƯỚC KHI gateScore/AI-gate/HTF-direction/macro từng được tính, và TRƯỚC KHI bất kỳ `onMomentumGateEvaluation` event nào bắn ra.');
  lines.push('');
  lines.push('**Áp dụng CHO CẢ BOX_BREAKOUT** — không có nhánh riêng cho BOX_BREAKOUT ở gate này (`routeEntry()` THẬT SỰ chạy `runBoxBreakoutStyle()`/`detectBoxBreakout()` và có thể tìm ra candidate thật, nhưng `DraftSetup` kết quả vẫn bị chặn bởi ĐÚNG gate này trước AI check riêng của nó). Điều này XÁC NHẬN ĐỘC LẬP (từ code, không chỉ tin lời văn) phát hiện "Phát hiện quan trọng bổ sung" của báo cáo ticket trước (0 event `onMomentumGateEvaluation` thật từng bắn cho BOX_BREAKOUT dưới baseline) — và ĐÍNH CHÍNH giả định trong chính prompt ticket này (rằng BOX_BREAKOUT "khác biệt" và có gate thật) — nó KHÔNG khác biệt dưới đúng config baseline hiện tại.');
  lines.push('');
  lines.push('**Quyết định**: `NEUTRAL_ROUTING_DISABLED` được gán là `rejectionReason` CHÍNH (real blocker) cho MỌI candidate OB/FVG/SWEEP/BOX_BREAKOUT có setup hợp lệ (entry/SL xác định được) — đây là block THẬT, không điều kiện, dưới config hiện tại. `HTF_DIRECTION_BLOCK`/`MACRO_DIRECTION_BLOCK`/`AI_GATE_BLOCK` được tính RIÊNG như một phân loại hypothetical "nếu cascade có chạy", lưu ở field `hypotheticalReasonIfRoutingEnabled`, KHÔNG BAO GIỜ ghi đè `rejectionReason`. `SETUP_INVALID` có ưu tiên cao hơn `NEUTRAL_ROUTING_DISABLED` (một candidate chưa có entry/SL hợp lệ thì chưa từng là một quyết định routing thật để mà "bị disable").');
  lines.push('');

  const phanAResolved = phanA; // all real trades are, by definition, resolved
  const aligned5m = phanA.filter((r) => r.group === 'ALIGNED_5M');
  const conflict5m = phanA.filter((r) => r.group === 'CONFLICT_5M');
  none5m: {
    // no-op label just for readability
  }
  const none5mRows = phanA.filter((r) => r.group === '5M_NONE');

  lines.push('## Phần A — Bảng tổng theo nhóm (ALIGNED_5M / CONFLICT_5M / 5M_NONE)');
  lines.push('');
  lines.push('| Nhóm | Trades | WR | PF | Net PnL | Avg R | Max DD |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(statsRow('ALIGNED_5M', statsFromResolved(aligned5m)));
  lines.push(statsRow('CONFLICT_5M', statsFromResolved(conflict5m)));
  lines.push(statsRow('5M_NONE', statsFromResolved(none5mRows)));
  lines.push(statsRow('TỔNG', statsFromResolved(phanAResolved)));
  lines.push('');

  lines.push('## Phần A — Theo LONG/SHORT');
  lines.push('');
  lines.push('| Side | Trades | WR | PF | Net PnL | Avg R | Max DD |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(statsRow('LONG', statsFromResolved(phanA.filter((r) => r.side === 'LONG'))));
  lines.push(statsRow('SHORT', statsFromResolved(phanA.filter((r) => r.side === 'SHORT'))));
  lines.push('');

  lines.push('## Phần A — Theo Coin × Nhóm');
  lines.push('');
  lines.push('| Coin | Nhóm | Trades | WR | PF | Net PnL |');
  lines.push('|---|---|---|---|---|---|');
  for (const symbol of SYMBOLS) {
    for (const group of ['ALIGNED_5M', 'CONFLICT_5M', '5M_NONE'] as Dir5mGroup[]) {
      const rows = phanA.filter((r) => r.symbol === symbol && r.group === group);
      const s = statsFromResolved(rows);
      lines.push(`| ${symbol} | ${group} | ${s.n} | ${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'} | ${fmt(s.pf, 4)} | ${fmt(s.netPnl)} |`);
    }
  }
  lines.push('');

  lines.push('## Phần A — 3 giai đoạn thời gian không chồng lấn (chia đều theo timestamp min/max)');
  lines.push('');
  if (phanA.length > 0) {
    const allTs = phanA.map((r) => r.timestamp);
    lines.push(`Span: ${new Date(Math.min(...allTs)).toISOString().slice(0, 10)} → ${new Date(Math.max(...allTs)).toISOString().slice(0, 10)}`);
  }
  lines.push('');
  const periodsA = subPeriodsGeneric(phanA);
  lines.push('| Period | ALIGNED_5M (Trades/WR/PF/NetPnL) | CONFLICT_5M | 5M_NONE |');
  lines.push('|---|---|---|---|');
  for (const p of periodsA) {
    const fmtGroup = (group: Dir5mGroup) => {
      const s = statsFromResolved(p.rows.filter((r) => r.group === group));
      return `${s.n}/${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'}/${fmt(s.pf, 3)}/${fmt(s.netPnl)}`;
    };
    lines.push(`| ${p.label} | ${fmtGroup('ALIGNED_5M')} | ${fmtGroup('CONFLICT_5M')} | ${fmtGroup('5M_NONE')} |`);
  }
  lines.push('');

  // ---- Phần B funnel ----
  const longCands = phanB.filter((c) => c.candidateSide === 'LONG');
  const shortCands = phanB.filter((c) => c.candidateSide === 'SHORT');
  const alignedDir5m = phanB.filter((c) => c.direction5m !== 'NONE' && c.direction5m === c.candidateSide);
  const conflictDir5m = phanB.filter((c) => c.direction5m !== 'NONE' && c.direction5m !== c.candidateSide);
  const htfMacroBlocked = phanB.filter((c) => c.hypotheticalReasonIfRoutingEnabled === 'HTF_DIRECTION_BLOCK' || c.hypotheticalReasonIfRoutingEnabled === 'MACRO_DIRECTION_BLOCK');
  const routingBlocked = phanB.filter((c) => c.rejectionReason === 'NEUTRAL_ROUTING_DISABLED');
  const aiMomentumBlocked = phanB.filter((c) => c.hypotheticalReasonIfRoutingEnabled.startsWith('AI_GATE_BLOCK'));
  const accepted = phanB.filter((c) => c.rejectionReason === 'ACCEPTED');
  const resolvedHypo = phanB.filter((c) => c.hypotheticalOutcome === 'RESOLVED_WIN' || c.hypotheticalOutcome === 'RESOLVED_LOSS');

  lines.push('## Phần B — Funnel setup bị bỏ qua');
  lines.push('');
  lines.push('| Stage | Count |');
  lines.push('|---|---|');
  lines.push(`| Neutral candles | ${decisionCandleCount} |`);
  lines.push(`| Có setup 5m | ${phanB.length} |`);
  lines.push(`| LONG candidates | ${longCands.length} |`);
  lines.push(`| SHORT candidates | ${shortCands.length} |`);
  lines.push(`| Khớp direction5m | ${alignedDir5m.length} |`);
  lines.push(`| Ngược direction5m | ${conflictDir5m.length} |`);
  lines.push(`| Bị HTF/macro block (hypothetical) | ${htfMacroBlocked.length} |`);
  lines.push(`| Bị Neutral routing block (thật, rejectionReason=NEUTRAL_ROUTING_DISABLED) | ${routingBlocked.length} |`);
  lines.push(`| Bị AI/Momentum block (hypothetical) | ${aiMomentumBlocked.length} |`);
  lines.push(`| Accepted (thật) | ${accepted.length} |`);
  lines.push(`| Resolved hypothetical | ${resolvedHypo.length} |`);
  lines.push('');

  lines.push('## Phần B — Outcome theo Setup × Side × Quan hệ với 5m');
  lines.push('');
  lines.push('| Setup | Side | Quan hệ 5m | Candidates | Resolved | WR | PF | Net PnL |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const setupSideGroupMap = new Map<string, CandidateB[]>();
  for (const c of phanB) {
    const rel = c.direction5m === 'NONE' ? '5M_NONE' : c.direction5m === c.candidateSide ? 'ALIGNED_5M' : 'CONFLICT_5M';
    const k = `${c.setupType}|${c.candidateSide}|${rel}`;
    if (!setupSideGroupMap.has(k)) setupSideGroupMap.set(k, []);
    (setupSideGroupMap.get(k) as CandidateB[]).push(c);
  }
  for (const [k, rows] of [...setupSideGroupMap.entries()].sort()) {
    const [setupType, side, rel] = k.split('|');
    const resolved = rows.filter((r) => r.hypotheticalOutcome === 'RESOLVED_WIN' || r.hypotheticalOutcome === 'RESOLVED_LOSS');
    const s = statsFromResolved(resolved);
    lines.push(`| ${setupType} | ${side} | ${rel} | ${rows.length} | ${resolved.length} | ${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'} | ${fmt(s.pf, 4)} | ${fmt(s.netPnl)} |`);
  }
  lines.push('');

  lines.push('## Phần B — Outcome theo rejection reason');
  lines.push('');
  lines.push('| Rejection reason | Candidates | Resolved | WR | PF | Net PnL |');
  lines.push('|---|---|---|---|---|---|');
  const reasonMap = new Map<string, CandidateB[]>();
  for (const c of phanB) {
    if (!reasonMap.has(c.rejectionReason)) reasonMap.set(c.rejectionReason, []);
    (reasonMap.get(c.rejectionReason) as CandidateB[]).push(c);
  }
  for (const [reason, rows] of [...reasonMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const resolved = rows.filter((r) => r.hypotheticalOutcome === 'RESOLVED_WIN' || r.hypotheticalOutcome === 'RESOLVED_LOSS');
    const s = statsFromResolved(resolved);
    lines.push(`| ${reason} | ${rows.length} | ${resolved.length} | ${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'} | ${fmt(s.pf, 4)} | ${fmt(s.netPnl)} |`);
  }
  lines.push('');

  lines.push('## Kiểm tra tính đúng đắn');
  lines.push('');
  lines.push('- No-look-ahead: xác nhận (two-pointer `closedWindow()`, cùng hàm/convention `ticket132NeutralCandidateAudit.ts`/`ticket136Neutral5mOpportunityFunnelAudit.ts` đã dùng).');
  lines.push('- No duplicate: `seenKeys` Set theo `symbol|timestamp|setupType|side` chặn ghi trùng (Phần B).');
  lines.push('- Outcome không được dùng để quyết định candidate: candidate/trade được phân loại TRƯỚC khi simulation chạy (2 pha tách biệt trong code).');
  lines.push('- Không đổi threshold, không train model, không sửa SL/TP/sizing, không xử lý reversal.');
  lines.push('- Feature flag mới: KHÔNG có — script này không thêm flag nào vào `backtest.ts`/production code (pure offline analysis, chỉ đọc `dist/` build có sẵn). Baseline trước/sau ticket giữ nguyên khi flag OFF là TRIVIALLY TRUE vì không có flag nào được thêm.');
  lines.push('');

  lines.push('## Baseline equality');
  lines.push('');
  lines.push('```');
  lines.push(runCmdOutput);
  lines.push('```');
  lines.push('');
  lines.push(`Commit: \`${commitHash}\``);
  lines.push('');

  // ---- Mandatory A-E conclusion ----
  const alignedStats = statsFromResolved(aligned5m);
  const conflictStats = statsFromResolved(conflict5m);
  const routingStats = statsFromResolved(routingBlocked.filter((c) => c.hypotheticalOutcome === 'RESOLVED_WIN' || c.hypotheticalOutcome === 'RESOLVED_LOSS'));

  let conclusion: string;
  const conflictSignificantlyWorse =
    conflictStats.resolved >= 20 && alignedStats.resolved >= 20 && conflictStats.pf !== null && alignedStats.pf !== null && conflictStats.pf < alignedStats.pf - 0.15 && conflictStats.netPnl < 0;
  const routingHasEdge = routingStats.resolved >= 20 && routingStats.pf !== null && routingStats.pf > 1.1 && routingStats.netPnl > 0;

  if (conflictSignificantlyWorse && routingHasEdge) {
    conclusion = `C — Cả hai vấn đề đều tồn tại: CONFLICT_5M (PF=${fmt(conflictStats.pf, 4)}, Net PnL=${fmt(conflictStats.netPnl)}) kém rõ rệt so với ALIGNED_5M (PF=${fmt(alignedStats.pf, 4)}), VÀ nhóm NEUTRAL_ROUTING_DISABLED có edge (PF=${fmt(routingStats.pf, 4)}, Net PnL=${fmt(routingStats.netPnl)}, resolved=${routingStats.resolved}).`;
  } else if (conflictSignificantlyWorse) {
    conclusion = `A — MOMENTUM_DIRECT chọn side ngược direction5m và có outcome rõ rệt xấu hơn: CONFLICT_5M PF=${fmt(conflictStats.pf, 4)}/Net PnL=${fmt(conflictStats.netPnl)} so với ALIGNED_5M PF=${fmt(alignedStats.pf, 4)}/Net PnL=${fmt(alignedStats.netPnl)} (${conflictStats.resolved} vs ${alignedStats.resolved} resolved).`;
  } else if (routingHasEdge) {
    conclusion = `B — MOMENTUM_DIRECT ổn (CONFLICT_5M không kém rõ rệt so với ALIGNED_5M: PF=${fmt(conflictStats.pf, 4)} vs ${fmt(alignedStats.pf, 4)}), nhưng các setup 5m khác đang bị NEUTRAL_ROUTING_DISABLED chặn có edge (PF=${fmt(routingStats.pf, 4)}, Net PnL=${fmt(routingStats.netPnl)}, resolved=${routingStats.resolved}).`;
  } else if (phanAResolved.length >= 20 && resolvedHypo.length >= 20) {
    conclusion = `D — Không có edge rõ ở các cơ hội bị bỏ qua: ALIGNED_5M PF=${fmt(alignedStats.pf, 4)}, CONFLICT_5M PF=${fmt(conflictStats.pf, 4)} (không khác biệt đủ lớn/có ý nghĩa), NEUTRAL_ROUTING_DISABLED hypothetical PF=${fmt(routingStats.pf, 4)} (không đủ mạnh/dương đủ ổn định).`;
  } else {
    conclusion = `E — Dữ liệu/pipeline chưa đủ tin cậy: Phần A chỉ ${phanAResolved.length} trades, Phần B chỉ ${resolvedHypo.length} candidate resolved qua hypothetical simulation — mẫu quá nhỏ (<20) để kết luận A/B/C/D đáng tin cậy.`;
  }
  lines.push('## KẾT LUẬN BẮT BUỘC');
  lines.push('');
  lines.push(`**${conclusion}**`);
  lines.push('');

  lines.push('## Ghi chú kỹ thuật / judgment calls / N/A fields');
  lines.push('');
  lines.push('- `direction5mStrength`: N/A ở mọi row — không tồn tại strength score nào cho direction5m trong hệ thống hiện tại (chỉ có verdict LONG/SHORT/NONE), không tự suy diễn công thức thay thế.');
  lines.push('- `hypotheticalReasonIfRoutingEnabled`: field bổ sung của script này (không nằm trong CSV bắt buộc theo §5 gốc, nhưng cần thiết để tách rõ real-block khỏi hypothetical-if-enabled theo đúng judgment call nêu trên) — luôn `N/A` cho row `SETUP_INVALID` (chưa từng tới bước routing).');
  lines.push('- `RISK_BLOCK`/`OTHER`/`MOMENTUM_GATE_BLOCK`: 0 candidate ở Phần B — dưới baseline, không có mechanism sizing/risk-pool/concurrency nào từng được thử cho OB/FVG/SWEEP/BOX_BREAKOUT NEUTRAL_TRANSITION (routing đã chặn trước khi tới bước đó), và `MOMENTUM_GATE_BLOCK` (khác `AI_GATE_BLOCK` — dành cho gate `neutralTransitionMomentumGateThreshold` cụ thể) không có candidate nào matching theo cấu trúc hệ thống hiện tại (giữ nguyên trong enum vì ticket §7 liệt kê).');
  lines.push(`- positionSize=$${POSITION_SIZE_USD} cố định cho Phần B hypothetical simulation — JUDGMENT CALL cùng convention ticket132/prior ticket136, không ảnh hưởng WR/PF/R-multiple.`);
  lines.push('- Không production code nào bị sửa. Không hạ threshold, không grid search, không tune bucket, không xử lý reversal.');
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const phanA = await runPhanA(symbolsData);

  // Reset per-symbol pointers/regime state before Phần B's own independent full walk.
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);
  const { candidates: phanB, decisionCandleCount } = await runPhanB(symbolsData);

  writeFileSync(OUT_CSV, toCsv(phanA, phanB));
  console.log(`Đã ghi ${OUT_CSV}`);

  const report = buildReport(phanA, phanB, decisionCandleCount, process.env.GIT_COMMIT_HASH ?? 'N/A', process.env.BASELINE_RUN_SUMMARY ?? 'N/A — xem báo cáo kèm ticket');
  writeFileSync(OUT_MD, report);
  console.log(`Đã ghi ${OUT_MD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
