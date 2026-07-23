/**
 * TICKET-010 Phần B — wires Regime -> Entry -> Position Sizing -> RiskPool -> SL/TP Manager for
 * one symbol's newly-closed 5m candle. Pure function: caller persists the returned SymbolState
 * and accountBalance, feeding them back on the next call (same pattern as regime/'s hysteresis).
 * Does NOT invent TP/SL/fee/sizing formulas — only calls the existing functions in risk/.
 */
import { detectRegime } from '../regime/regimeDetector.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { MarketRegime, type CandleData, type RegimeOutput } from '../regime/types.js';
import { routeEntry } from '../entry/entryRouter.js';
import { EntryConfig } from '../entry/config.js';
import { detectMomentumDirect } from '../entry/momentumDirect.js';
import type { DraftSetup, FunnelCallback } from '../entry/types.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../xgbFilter/momentumScorer.js';
import { computeMomentumMultiplier } from '../xgbFilter/momentumMultiplier.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH, MOMENTUM_BEARISH_MODEL_PATH, MOMENTUM_BEARISH_SCHEMA_PATH, type PlanAutoSelectionConfig } from '../xgbFilter/config.js';
import { DynamicRMarginSizer } from '../risk/dynamicRMarginSizer.js';
import { wouldExceedRiskPool, type OpenPositionRisk } from '../risk/riskPool.js';
import {
  applyAtrTrailing,
  computeRealizedPnl,
  isSlHitAtPrice,
  isTpHit,
  onCounterTrendTpHit,
  onSlHit,
  onTp1Hit,
  onTp2Hit,
  openPosition,
  priceAtR,
  updateGivebackProtection,
  type ManagedPositionState,
  type SlTpManagerInput,
  type TpPlan,
} from '../risk/slTpManager.js';
import type { ExitReason, OpenPositionEntry, OpenTradeEvent, OrchestratorConfig, OrchestratorEvent, SkippedEntryEvent, SymbolState } from './types.js';

export interface ProcessCandleInput {
  symbol: string;
  /** Ending at "now" — last element is the 5m candle that just closed. Caller controls window size (no look-ahead). */
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  /** TICKET-017 Phần A: daily candles, ending at "now" like the other timeframes — feeds the macro trend filter (unused unless EntryRouterConfig.macroTrendFilterEnabled is true). */
  candles1d: CandleData[];
  /**
   * TICKET-024 Phần B: 1h candles ending at "now", SEPARATE from `candles1h` above and sized much
   * longer (>= EMA_1H_SLOW_PERIOD = 200 candles) — momentum's emaRatioSlow needs 200 1h candles of
   * history, far more than regime/entry's own `candles1h` window (40) ever needed. Deliberately kept
   * as its own field rather than just enlarging `candles1h` itself: Wilder's RMA-style smoothing
   * (used throughout regime/) is NOT invariant to how far back the window starts — a longer window
   * changes the seed point and therefore the tail ADX/DI values regime classification reads, which
   * would silently change entry/backtest results this ticket must not touch. Unused unless
   * momentumFilterConfig.momentumFilterEnabled is true.
   */
  candles1hMomentum: CandleData[];
  /**
   * TICKET-028: 5m candles ending at "now", SEPARATE from `candles5m` above and sized for
   * RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS+ days of history — same reasoning as
   * `candles1hMomentum` above (LOW_LIQUIDITY's session-relative volume needs far more 5m history
   * than regime/entry's own candles5m window ever needed). Optional: omit to leave LOW_LIQUIDITY
   * permanently unreachable (no error) rather than change any existing metric's behavior.
   */
  candles5mSessionVolume?: CandleData[];
  /**
   * TICKET-030: pre-computed cross-symbol correlation ratio (regime/correlatedRisk.ts), same value
   * for all 4 symbols at this time-step — the caller (backtest.ts / live wiring) computes this ONCE
   * per step across all 4 coins and passes the same number into every symbol's processCandle() call.
   * Orchestrator does NOT compute this itself, only passes it through to detectRegime(). Optional:
   * omit to leave CORRELATED_RISK permanently unreachable (no error).
   */
  correlatedRiskRatio?: number;
  accountBalance: number;
  /**
   * TICKET-056: renamed from `otherOpenPositionsRisk` — MUST now include THIS symbol's own
   * already-open position(s) too (previously excluded by construction, since a symbol could never
   * have an open position when routeEntry() was tried). Caller (backtest.ts) is responsible for
   * summing/listing every currently open position across every symbol, including this one.
   */
  allOpenPositionsRisk: OpenPositionRisk[];
}

export interface ProcessCandleResult {
  symbolState: SymbolState;
  accountBalance: number;
  /** TICKET-056: was `event: OrchestratorEvent | null` — a single candle can now produce multiple events (e.g. one or more CLOSEs plus an OPEN/SKIPPED) since a symbol may hold multiple concurrent positions. Empty array = no events this candle. */
  events: OrchestratorEvent[];
}

/**
 * TICKET-027 — diagnostic-only payload for the moment regime freshly transitions into MANIPULATED
 * (fast-in confirmation, not just candidate). Not part of normal orchestrator output — only built
 * and delivered when the caller passes onManipulatedConfirmed to processCandle.
 */
export interface ManipulatedDiagnostic {
  symbol: string;
  timestamp: number;
  upperSweepCount: number;
  lowerSweepCount: number;
  volumeZScore5m: number;
  lookbackWindow: CandleData[];
}

/**
 * TICKET-033 — diagnostic-only payload for the moment regime freshly transitions into DANGER_ZONE
 * (fast-in confirmation, not just candidate). Same pattern as ManipulatedDiagnostic/TICKET-027 —
 * not part of normal orchestrator output, only built and delivered when the caller passes
 * onDangerZoneConfirmed to processCandle.
 */
export interface DangerZoneDiagnostic {
  symbol: string;
  timestamp: number;
  atrPercentile5m: number;
  volumeZScore5m: number;
}

/**
 * TICKET-055 — TEMPORARY, verification-only payload: fires whenever regime is confirmed TREND_RIDER
 * and routeEntry() returns without ever firing a stage='SETUP' FunnelEvent — i.e. runTrendStyle()
 * took some early-return path before reaching either `onFunnelEvent(..., {stage:'SETUP', passed:true})`
 * or the `NO_SETUP_FOUND`-replacement fail event. Exists to verify TICKET-054's claim (all 1,677
 * SETUP-FAIL-breakdown gap cases are the single known adxDirection1h undefined/FLAT early return in
 * entryRouter.ts's runTrendStyle()) with real counted data instead of trusting the code-reading alone.
 * Not part of normal orchestrator output — only built/delivered when the caller passes
 * onSetupNotFiredDiagnostic to processCandle. Not required to be kept long-term once verified.
 */
export interface SetupNotFiredDiagnostic {
  symbol: string;
  timestamp: number;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
}

function touchesFavorable(side: 'LONG' | 'SHORT', candle: CandleData, price: number): boolean {
  return side === 'LONG' ? isTpHit(side, candle.high, price) : isTpHit(side, candle.low, price);
}

function touchesAdverse(side: 'LONG' | 'SHORT', candle: CandleData, price: number): boolean {
  return side === 'LONG' ? isSlHitAtPrice(side, candle.low, price) : isSlHitAtPrice(side, candle.high, price);
}

/**
 * Step 3 (Part B): advance an already-open position by one 5m candle. Returns the new state and,
 * if it closed this candle, the exit reason + price. Exported (TICKET-019): generateTrainingData.ts
 * reuses this exact function for its parallel shadow simulation, instead of re-deriving SL/TP logic.
 */
export function advancePosition(
  pos: ManagedPositionState,
  candle: CandleData,
  candles5m: CandleData[],
  isLowConfidenceOrLowLiquidity: boolean,
): { position: ManagedPositionState; exitReason: ExitReason | null; exitPrice: number | null } {
  if (pos.scenario === 'COUNTER_TREND') {
    const tp = pos.tpLevels[0];
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tpTouched = tp.price !== null && touchesFavorable(pos.side, candle, tp.price);
    if (slTouched && tpTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice }; // same-candle rule: SL first
    if (tpTouched) return { position: onCounterTrendTpHit(pos), exitReason: 'COUNTER_TREND_TP', exitPrice: tp.price as number };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  const tp1 = pos.tpLevels.find((t) => t.label === 'TP1');
  const tp2 = pos.tpLevels.find((t) => t.label === 'TP2');
  const tp1Filled = pos.filledTiers.includes('TP1');
  const tp2Filled = pos.filledTiers.includes('TP2');

  if (!tp1Filled && tp1) {
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tp1Touched = tp1.price !== null && touchesFavorable(pos.side, candle, tp1.price);
    if (slTouched && tp1Touched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    if (tp1Touched) return { position: onTp1Hit(pos), exitReason: null, exitPrice: null };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  if (!tp2Filled && tp2) {
    // TICKET-016: TP1 already filled here, so this SL is the post-TP1 breakeven+fee stop, not a
    // raw loss — distinct label from the !tp1Filled branch above.
    const slTouched = touchesAdverse(pos.side, candle, pos.currentSlPrice);
    const tp2Touched = tp2.price !== null && touchesFavorable(pos.side, candle, tp2.price);
    if (slTouched && tp2Touched) return { position: onSlHit(pos), exitReason: 'BREAKEVEN_SL', exitPrice: pos.currentSlPrice };
    if (tp2Touched) return { position: onTp2Hit(pos), exitReason: null, exitPrice: null };
    if (slTouched) return { position: onSlHit(pos), exitReason: 'BREAKEVEN_SL', exitPrice: pos.currentSlPrice };
    return { position: pos, exitReason: null, exitPrice: null };
  }

  // Runner phase — trail with ATR (Structure trailing not used this ticket), then Giveback, then check the (possibly tightened) SL.
  const favorablePrice = pos.side === 'LONG' ? candle.high : candle.low;
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  let trailed = pos;
  if (atr !== undefined) {
    trailed = applyAtrTrailing(pos, favorablePrice, atr);
    trailed = updateGivebackProtection(trailed, favorablePrice, isLowConfidenceOrLowLiquidity);
  }
  const slTouched = touchesAdverse(trailed.side, candle, trailed.currentSlPrice);
  if (slTouched) return { position: onSlHit(trailed), exitReason: 'RUNNER_SL', exitPrice: trailed.currentSlPrice };
  return { position: trailed, exitReason: null, exitPrice: null };
}

// TICKET-024 Phần B.1 / TICKET-025 Phần C: cached across calls — read once, never re-parsed per
// candle. Schema content itself is still always read fresh from disk on first use, never
// hard-coded in TS. Bullish (LONG) and bearish (SHORT) are separately-trained models — their
// schemas are NOT assumed identical (category order can legitimately differ) and are cached apart.
let cachedMomentumSchema: FeatureSchema | undefined;
function getMomentumSchema(): FeatureSchema {
  if (cachedMomentumSchema === undefined) {
    cachedMomentumSchema = loadFeatureSchema(MOMENTUM_SCHEMA_PATH);
  }
  return cachedMomentumSchema;
}

let cachedMomentumBearishSchema: FeatureSchema | undefined;
function getMomentumBearishSchema(): FeatureSchema {
  if (cachedMomentumBearishSchema === undefined) {
    cachedMomentumBearishSchema = loadFeatureSchema(MOMENTUM_BEARISH_SCHEMA_PATH);
  }
  return cachedMomentumBearishSchema;
}

/**
 * Shared by the soft momentumMultiplier (TICKET-024/025) and the hard NEUTRAL_TRANSITION Momentum
 * Gate (TICKET-036) — same scoring call, same LONG/SHORT model split, never re-derived twice.
 * Undefined = insufficient EMA/ATR history for computeMomentumCrossFeatures (never itself an error;
 * each caller decides what "no score" means for its own purpose).
 */
async function scoreMomentumForSide(
  side: 'LONG' | 'SHORT',
  symbol: string,
  candles5m: CandleData[],
  candles1hMomentum: CandleData[],
  regimeOutput: RegimeOutput,
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
): Promise<number | undefined> {
  const crossFeatures = computeMomentumCrossFeatures(candles5m, candles1hMomentum);
  if (crossFeatures === undefined) return undefined;
  const isLong = side === 'LONG';
  const modelPath = isLong ? MOMENTUM_MODEL_PATH : MOMENTUM_BEARISH_MODEL_PATH;
  const schema = isLong ? getMomentumSchema() : getMomentumBearishSchema();
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
      ...crossFeatures,
    },
    schema,
  );
  return scoreMomentum(modelPath, featureVector);
}

/**
 * TICKET-052 — AI-driven Plan A/B selection. Pure function, no formula changes to computeTpLevels()
 * itself: a highly-confident entry (own-side momentum score >= threshold) uses PLAN_B, everything
 * else — including an undetermined score (insufficient EMA/ATR history), same "an toàn" requirement
 * as every other gate in this file — falls back to whatever tpPlan the caller already chose.
 * Off by default: config.planAutoSelectionEnabled=false always returns defaultPlan unchanged.
 * TREND scenario only by construction: only ever called from the one place that builds a TREND
 * SlTpManagerInput (entryRouter.ts has had no COUNTER_TREND path since TICKET-051 removed BOX_BOUNCE
 * — Plan A/B has no meaning for COUNTER_TREND's single-exit Mục 7 design regardless).
 */
export function selectTpPlan(defaultPlan: TpPlan, momentumScore: number | undefined, config: PlanAutoSelectionConfig): TpPlan {
  if (!config.planAutoSelectionEnabled) return defaultPlan;
  if (momentumScore !== undefined && momentumScore >= config.planAutoSelectionMomentumThreshold) return 'PLAN_B';
  return defaultPlan;
}

/**
 * TICKET-059 — mirrors scripts/entryFunnelReport.ts's STATE_FAIL_REGIMES (same 5 MarketRegime
 * values, "Entry Funnel Analytics 'STATE PASS'"). Duplicated locally rather than imported: src/ is
 * its own compilation unit and cannot depend on scripts/ (which itself depends on dist/, built FROM
 * src/ — importing the other way would be a wrong-direction/circular dependency).
 */
const MOMENTUM_DIRECT_BLOCKED_REGIMES: readonly MarketRegime[] = [
  MarketRegime.DANGER_ZONE,
  MarketRegime.MANIPULATED,
  MarketRegime.LOW_LIQUIDITY,
  MarketRegime.VOLATILE_CHOP,
  MarketRegime.CORRELATED_RISK,
];

/**
 * TICKET-059 Phần B — the AI momentum score used DIRECTLY as an entry signal, independent of
 * OB/FVG/Sweep/Box Breakout/MSS. Only ever tried by the caller when routeEntry()'s cascade already
 * returned null for this candle (see tryOpenNewPosition below) — never replaces or short-circuits it.
 * Mirrors (does not call — entryRouter.ts stays untouched per the ticket) the same macro-trend-filter
 * condition and ATR-based SL buffer formula runTrendStyle() uses for its Sweep fallback.
 */
async function tryMomentumDirect(
  input: ProcessCandleInput,
  config: OrchestratorConfig,
  regimeOutput: RegimeOutput,
  currentCandle: CandleData,
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined,
): Promise<DraftSetup | null> {
  if (MOMENTUM_DIRECT_BLOCKED_REGIMES.includes(regimeOutput.regime)) return null;

  // TICKET-062 — volatility cap: TICKET-061 found MOMENTUM_DIRECT fires mostly during extreme
  // volatility (atrPercentile5m mean 83.90 vs ~48.5 baseline), and that exact high-volatility group
  // drags winrate down (30.05% vs 42.05% for the rest). Undefined (insufficient 5m ATR history)
  // can't be confirmed within the cap, so it blocks too — never defaults to passing on missing data,
  // same "an toàn" convention as every other gate in this file.
  const atrPercentile5m = regimeOutput.computedMetrics.atrPercentile5m;
  if (atrPercentile5m === undefined || atrPercentile5m > config.momentumDirectMaxAtrPercentile) return null;

  const longScore = await scoreMomentumForSide('LONG', input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection);
  const shortScore = await scoreMomentumForSide('SHORT', input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection);
  const longPasses = longScore !== undefined && detectMomentumDirect(longScore, 'LONG', config.momentumDirectThreshold);
  const shortPasses = shortScore !== undefined && detectMomentumDirect(shortScore, 'SHORT', config.momentumDirectThreshold);
  if (!longPasses && !shortPasses) return null;

  // Both sides rarely pass at once (opposite-direction models scoring the same candle) — if they
  // do, take the higher-scoring side rather than leaving this undefined behavior.
  const side: 'LONG' | 'SHORT' =
    longPasses && shortPasses ? ((longScore as number) >= (shortScore as number) ? 'LONG' : 'SHORT') : longPasses ? 'LONG' : 'SHORT';

  // Mandatory macro alignment check — unlike routeEntry()'s cascade, NOT gated behind
  // entryRouterConfig.macroTrendFilterEnabled (TICKET-059 Phần B lists this as an unconditional
  // step for MOMENTUM_DIRECT, not an A/B-testable optional filter).
  if ((side === 'LONG' && macroDirection === 'DOWN') || (side === 'SHORT' && macroDirection === 'UP')) return null;

  const atr = lastDefined(wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined) return null; // not enough 5m history to size the SL buffer

  const entryPrice = currentCandle.close;
  // Sweep-style SL: nearest extreme point (current candle's own low/high, since MOMENTUM_DIRECT has
  // no OB/FVG/Sweep zone to anchor to) ± ATR buffer.
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;

  // TICKET-064 Phần A — TICKET-063 found the raw ATR-based SL is often so narrow that the fixed
  // 2-way taker fee eats a disproportionate share of it (median 32.64% of SL distance). Widen the
  // SL out to momentumDirectMinSlPercent when the ATR-based distance is narrower than that floor;
  // leave it untouched when it's already wider.
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < config.momentumDirectMinSlPercent) {
    const flooredDistance = (config.momentumDirectMinSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }

  // TICKET-064 Phần B — replaces the old fixed 0.5% TP (EntryConfig.MOMENTUM_DIRECT_TP_PCT, removed
  // by this ticket) with an R-multiple of the (possibly floored) SL distance above, reusing
  // slTpManager.ts's own priceAtR() rather than re-deriving the R-multiple math here.
  const r = Math.abs(entryPrice - slPrice);
  const tpPriceOverride = priceAtR(entryPrice, r, config.momentumDirectTpRMultiple, side);

  return {
    side,
    entryPrice,
    slPrice,
    setupType: 'MOMENTUM_DIRECT',
    regime: regimeOutput.regime,
    riskMultiplier: config.entryRouterConfig.regimeRiskMultiplier[regimeOutput.regime],
    tpPriceOverride,
  };
}

interface EntryAttemptResult {
  event: OpenTradeEvent | SkippedEntryEvent | null;
  newEntry: OpenPositionEntry | null;
}

/**
 * TICKET-056 — extracted verbatim from the old single-position Step 2 (no behavior change, only
 * restructured to RETURN its outcome instead of early-returning from processCandle() directly) so
 * a symbol that already has an open position can still attempt another one, up to
 * config.maxConcurrentPositionsPerSymbol. Does NOT loosen any signal-detection condition — the same
 * Regime/OB/FVG/Sweep/Breakout/MSS/Momentum Gate pipeline runs independently for this attempt,
 * exactly as it did for the very first position on this symbol.
 */
async function tryOpenNewPosition(
  input: ProcessCandleInput,
  config: OrchestratorConfig,
  regimeOutput: RegimeOutput,
  currentCandle: CandleData,
  accountBalance: number,
  onFunnelEvent: FunnelCallback | undefined,
  onSetupNotFiredDiagnostic: ((diagnostic: SetupNotFiredDiagnostic) => void) | undefined,
): Promise<EntryAttemptResult> {
  // TICKET-017 Phần A: same direction function as adxDirection1h, applied to 1D candles instead.
  const macroDirectionSeries = wilderDIDirectionSeries(input.candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
  const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

  // TICKET-055: TEMPORARY verification wrapper — tracks whether routeEntry() ever fired a
  // stage='SETUP' event this call, without changing what onFunnelEvent itself receives or how
  // routeEntry() decides anything. Only wraps when onSetupNotFiredDiagnostic is actually passed
  // (opt-in, same as every other diagnostic in this file).
  let setupEventFired = false;
  const funnelEventWrapper: FunnelCallback | undefined = onSetupNotFiredDiagnostic
    ? (symbol, timestamp, event) => {
        if (event.stage === 'SETUP') setupEventFired = true;
        onFunnelEvent?.(symbol, timestamp, event);
      }
    : onFunnelEvent;

  const draftSetup = routeEntry(
    {
      regime: regimeOutput.regime,
      symbol: input.symbol,
      adxDirection1h: regimeOutput.adxDirection1h,
      macroDirection,
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      candlesMss: input.candles1m,
      bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m,
    },
    config.entryRouterConfig,
    funnelEventWrapper,
  );

  if (onSetupNotFiredDiagnostic && regimeOutput.regime === MarketRegime.TREND_RIDER && !setupEventFired) {
    onSetupNotFiredDiagnostic({ symbol: input.symbol, timestamp: currentCandle.timestamp, adxDirection1h: regimeOutput.adxDirection1h });
  }

  // TICKET-059 Phần B — only tried when the cascade above found NOTHING for this candle. Runs
  // entirely parallel to routeEntry(): never replaces it, never runs when routeEntry() already
  // succeeded. Off by default (config.momentumDirectEnabled=false) — draftSetup===null still falls
  // straight through to the early return below, byte-identical to every ticket before this one.
  let effectiveDraftSetup: DraftSetup | null = draftSetup;
  if (effectiveDraftSetup === null && config.momentumDirectEnabled) {
    effectiveDraftSetup = await tryMomentumDirect(input, config, regimeOutput, currentCandle, macroDirection);
  }

  if (effectiveDraftSetup === null) return { event: null, newEntry: null };

  // TICKET-036 — mandatory Momentum Gate, NEUTRAL_TRANSITION only. Runs BEFORE anything else
  // (account-balance check, soft momentumMultiplier below) since it can outright discard the
  // DraftSetup rather than just scale it. entryRouter.ts's routeEntry() always builds a real
  // DraftSetup for NEUTRAL_TRANSITION now (Phần A) — neutralTransitionTradingEnabled=false must
  // still reproduce the exact pre-TICKET-036 behavior (no event at all, same as draftSetup===null
  // above), NOT a SKIPPED event, since NEUTRAL_TRANSITION genuinely never entered before this ticket.
  // TICKET-059: excludes MOMENTUM_DIRECT-sourced setups — this gate is specific to routeEntry()'s
  // own NEUTRAL_TRANSITION cascade path, a different mechanism from MOMENTUM_DIRECT's own threshold
  // check (tryMomentumDirect already applied its own gating above).
  if (effectiveDraftSetup.regime === MarketRegime.NEUTRAL_TRANSITION && effectiveDraftSetup.setupType !== 'MOMENTUM_DIRECT') {
    if (!config.neutralTransitionGateConfig.neutralTransitionTradingEnabled) {
      return { event: null, newEntry: null };
    }
    const gateScore = await scoreMomentumForSide(effectiveDraftSetup.side, input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection);
    // Missing score (insufficient EMA/ATR history) -> gateScore undefined -> comparison is false ->
    // rejected, same as an explicit low score. Never defaults to passing (PM's explicit "an toàn" requirement).
    const gatePassed = gateScore !== undefined && gateScore >= config.neutralTransitionGateConfig.neutralTransitionMomentumGateThreshold;
    if (!gatePassed) {
      return {
        event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'NEUTRAL_GATE_REJECTED' },
        newEntry: null,
      };
    }
    // Gate passed — falls through to the normal pipeline below (account-balance check, sizing,
    // riskPool, AND the soft momentumMultiplier below still applies on top — this gate is an
    // ADDITIONAL hard filter before entry, not a replacement for the existing soft one).
  }

  // Account blown (balance <= 0): no new positions can be sized. Not a NOT_IMPLEMENTED-style
  // error — a real, expected end state for a backtest/live account, so it's just "no entry"
  // rather than an exception (PositionSizingInput itself throws on accountBalance <= 0).
  // TICKET-056: `accountBalance` here already reflects any same-candle close on this same symbol
  // (PM-confirmed sequencing — see processCandle's Step 3, which runs before this is called).
  if (accountBalance <= 0) return { event: null, newEntry: null };

  // TICKET-024 Phần C/D — soft risk-multiplier from the momentum model, applied to the sizer's
  // REQUESTED risk (riskDollarOrPercent) so it flows through maxMarginCap capping the same way a
  // smaller riskDollarOrPercent naturally would. Never gates entry outright — only scales size.
  // Off by default: momentumMultiplier stays 1.0 and combinedRiskMultiplier === effectiveDraftSetup.riskMultiplier
  // (itself always 1.0 for every regime that currently reaches this point), so behavior is
  // byte-for-byte unchanged from before this ticket unless momentumFilterConfig.momentumFilterEnabled.
  //
  // TICKET-052: TREND-scenario Plan A/B selection (below, right before openInput) also needs this
  // exact same own-side momentum score — computed ONCE here and reused, never re-scored twice for
  // two purposes. Score is fetched whenever EITHER feature needs it, independent of each other
  // (either can be on while the other stays off).
  let momentumScore: number | undefined;
  if (config.momentumFilterConfig.momentumFilterEnabled || config.planAutoSelectionConfig.planAutoSelectionEnabled) {
    // TICKET-036: reuses the same scoreMomentumForSide() helper the Gate above calls — no
    // re-derivation of the LONG/SHORT model split or feature vector construction.
    momentumScore = await scoreMomentumForSide(effectiveDraftSetup.side, input.symbol, input.candles5m, input.candles1hMomentum, regimeOutput, macroDirection);
  }
  let momentumMultiplier = 1.0;
  if (config.momentumFilterConfig.momentumFilterEnabled && momentumScore !== undefined) {
    momentumMultiplier = computeMomentumMultiplier(momentumScore, config.momentumFilterConfig);
  }
  // momentumScore undefined (insufficient EMA/ATR history) -> momentumMultiplier stays 1.0, same as disabled.
  const combinedRiskMultiplier = effectiveDraftSetup.riskMultiplier * momentumMultiplier;

  const slDistancePercent = Math.abs(effectiveDraftSetup.entryPrice - effectiveDraftSetup.slPrice) / effectiveDraftSetup.entryPrice;
  const sizingOutput = new DynamicRMarginSizer().calculate({
    accountBalance,
    riskDollarOrPercent: config.riskDollarOrPercent * combinedRiskMultiplier,
    entryPrice: effectiveDraftSetup.entryPrice,
    slDistancePercent,
    leverage: config.leverage,
    maxMarginCap: config.maxMarginCap,
  });

  // TICKET-056 Phần C: `input.allOpenPositionsRisk` must now include this symbol's own already-open
  // position(s) too (caller's responsibility) — no longer excludes "this symbol" by construction.
  if (wouldExceedRiskPool(input.allOpenPositionsRisk, sizingOutput.actualRiskDollar, accountBalance, { riskPoolMaxPct: config.riskPoolMaxPct })) {
    return {
      event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'RISK_POOL_EXCEEDED' },
      newEntry: null,
    };
  }

  // TICKET-052: AI-driven Plan A/B selection — TREND scenario only, reuses momentumScore already
  // computed above (never re-scored). Off by default: returns config.tpPlan unchanged. Meaningless
  // for MOMENTUM_DIRECT's COUNTER_TREND scenario below (single fixed-price exit, no tiers) — still
  // computed unconditionally (cheap, pure) but simply unused in that branch.
  const selectedTpPlan = selectTpPlan(config.tpPlan, momentumScore, config.planAutoSelectionConfig);

  // TICKET-059: MOMENTUM_DIRECT uses Mục 7's COUNTER_TREND scenario (single fixed-price exit at
  // tpPriceOverride, no tiers, no Runner) — everything else (OB/FVG/Sweep/Breakout) stays on the
  // TREND scenario exactly as before this ticket; entryRouter.ts has no COUNTER_TREND path itself.
  const openInput: SlTpManagerInput =
    effectiveDraftSetup.setupType === 'MOMENTUM_DIRECT'
      ? {
          scenario: 'COUNTER_TREND',
          entryPrice: effectiveDraftSetup.entryPrice,
          slPrice: effectiveDraftSetup.slPrice,
          side: effectiveDraftSetup.side,
          tpPlan: config.tpPlan, // ignored by computeTpLevels() for COUNTER_TREND — field is required but unused
          tpPriceOverride: effectiveDraftSetup.tpPriceOverride,
          positionSize: sizingOutput.positionSize,
          takerFeeRate: config.takerFeeRate,
        }
      : {
          scenario: 'TREND',
          entryPrice: effectiveDraftSetup.entryPrice,
          slPrice: effectiveDraftSetup.slPrice,
          side: effectiveDraftSetup.side,
          tpPlan: selectedTpPlan,
          positionSize: sizingOutput.positionSize,
          takerFeeRate: config.takerFeeRate,
        };
  const newPosition = openPosition(openInput);

  const event: OpenTradeEvent = {
    type: 'OPEN',
    symbol: input.symbol,
    side: effectiveDraftSetup.side,
    regime: effectiveDraftSetup.regime,
    setupType: effectiveDraftSetup.setupType,
    tpPlan: openInput.tpPlan,
    entryTimestamp: currentCandle.timestamp,
    entryPrice: effectiveDraftSetup.entryPrice,
    riskMultiplier: combinedRiskMultiplier,
    actualRiskDollar: sizingOutput.actualRiskDollar,
    marginRequired: sizingOutput.marginRequired,
  };

  return {
    event,
    newEntry: {
      position: newPosition,
      meta: {
        regime: effectiveDraftSetup.regime,
        setupType: effectiveDraftSetup.setupType,
        entryTimestamp: currentCandle.timestamp,
        actualRiskDollar: sizingOutput.actualRiskDollar,
        marginRequired: sizingOutput.marginRequired,
        riskMultiplier: combinedRiskMultiplier,
      },
    },
  };
}

export async function processCandle(
  input: ProcessCandleInput,
  state: SymbolState,
  config: OrchestratorConfig,
  onManipulatedConfirmed?: (diagnostic: ManipulatedDiagnostic) => void,
  onDangerZoneConfirmed?: (diagnostic: DangerZoneDiagnostic) => void,
  // TICKET-042: pure pass-through to entryRouter.ts's routeEntry() — pure observability, never
  // read here, never affects any decision in this function.
  onFunnelEvent?: FunnelCallback,
  // TICKET-055: TEMPORARY verification-only diagnostic — see SetupNotFiredDiagnostic doc comment.
  onSetupNotFiredDiagnostic?: (diagnostic: SetupNotFiredDiagnostic) => void,
): Promise<ProcessCandleResult> {
  // Step 1 — regime, always runs.
  const regimeOutput = detectRegime({
    candles5m: input.candles5m,
    candles15m: input.candles15m,
    candles1h: input.candles1h,
    previousRegime: state.regimeState.previousRegime,
    previousCandidateRegime: state.regimeState.previousCandidateRegime,
    streakCount: state.regimeState.streakCount,
    previousDangerZoneTimestamp: state.regimeState.previousDangerZoneTimestamp,
    candles5mSessionVolume: input.candles5mSessionVolume,
    correlatedRiskRatio: input.correlatedRiskRatio,
  });
  const regimeState = {
    previousRegime: regimeOutput.regime,
    previousCandidateRegime: regimeOutput.candidateRegime,
    streakCount: regimeOutput.streakCount,
    previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
  };
  const currentCandle = input.candles5m[input.candles5m.length - 1];

  // TICKET-027 — diagnostic-only, no effect on any decision below: fires once per fresh transition
  // into MANIPULATED (state.regimeState.previousRegime was something else, now confirmed MANIPULATED).
  if (
    onManipulatedConfirmed &&
    regimeOutput.regime === MarketRegime.MANIPULATED &&
    state.regimeState.previousRegime !== MarketRegime.MANIPULATED
  ) {
    onManipulatedConfirmed({
      symbol: input.symbol,
      timestamp: currentCandle.timestamp,
      upperSweepCount: regimeOutput.computedMetrics.upperSweepCount5m as number,
      lowerSweepCount: regimeOutput.computedMetrics.lowerSweepCount5m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
      lookbackWindow: input.candles5m.slice(-RegimeConfig.MANIPULATED_LOOKBACK_CANDLES),
    });
  }

  // TICKET-033 — diagnostic-only, no effect on any decision below: fires once per fresh transition
  // into DANGER_ZONE (state.regimeState.previousRegime was something else, now confirmed DANGER_ZONE).
  // Same pattern as the MANIPULATED block above (TICKET-027).
  if (
    onDangerZoneConfirmed &&
    regimeOutput.regime === MarketRegime.DANGER_ZONE &&
    state.regimeState.previousRegime !== MarketRegime.DANGER_ZONE
  ) {
    onDangerZoneConfirmed({
      symbol: input.symbol,
      timestamp: currentCandle.timestamp,
      atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m as number,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
    });
  }

  const events: OrchestratorEvent[] = [];
  let accountBalance = input.accountBalance;
  const remainingPositions: OpenPositionEntry[] = [];

  // Step 3 — advance every currently open position for this symbol, independently. TICKET-056: was
  // "the one open position, if any" — now a loop, since a symbol can hold more than one. A same-candle
  // close of one position never affects any other still-open position's own SL/TP/trailing state.
  for (const entry of state.openPositions) {
    const { position, exitReason, exitPrice } = advancePosition(entry.position, currentCandle, input.candles5m, config.isLowConfidenceOrLowLiquidity);

    if (!position.closed) {
      remainingPositions.push({ position, meta: entry.meta });
      continue;
    }

    // Closed this candle: log + free up this slot.
    const pnlUsd = computeRealizedPnl(position, exitPrice as number);
    accountBalance += pnlUsd;
    const pnlPct = (pnlUsd / entry.meta.marginRequired) * 100;
    events.push({
      type: 'CLOSE',
      symbol: input.symbol,
      side: position.side,
      regime: entry.meta.regime,
      setupType: entry.meta.setupType,
      tpPlan: position.tpPlan,
      entryTimestamp: entry.meta.entryTimestamp,
      entryPrice: position.entryPrice,
      exitTimestamp: currentCandle.timestamp,
      exitPrice: exitPrice as number,
      exitReason: exitReason as ExitReason,
      pnlUsd,
      pnlPct,
      riskMultiplier: entry.meta.riskMultiplier,
      accountBalanceAfter: accountBalance,
    });
  }

  // Step 2 — try a new entry iff still under the per-symbol concurrency limit. TICKET-056: gated on
  // the INCOMING position count (state.openPositions.length), NOT `remainingPositions.length` — a
  // same-candle close must not unlock a same-candle re-entry, so behavior at the default limit of 1
  // stays byte-for-byte identical to every ticket before this one (close now, re-enter next candle).
  // PM-confirmed (2026-07-22): `accountBalance` passed to the sizer here already reflects this same
  // candle's own close(s) above, same sequencing already used across symbols within one backtest step.
  if (state.openPositions.length < config.maxConcurrentPositionsPerSymbol) {
    const { event, newEntry } = await tryOpenNewPosition(input, config, regimeOutput, currentCandle, accountBalance, onFunnelEvent, onSetupNotFiredDiagnostic);
    if (event) events.push(event);
    if (newEntry) remainingPositions.push(newEntry);
  }

  return {
    symbolState: { regimeState, openPositions: remainingPositions },
    accountBalance,
    events,
  };
}
