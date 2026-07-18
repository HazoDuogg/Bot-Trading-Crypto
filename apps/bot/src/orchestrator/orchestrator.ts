/**
 * TICKET-010 Phần B — wires Regime -> Entry -> Position Sizing -> RiskPool -> SL/TP Manager for
 * one symbol's newly-closed 5m candle. Pure function: caller persists the returned SymbolState
 * and accountBalance, feeding them back on the next call (same pattern as regime/'s hysteresis).
 * Does NOT invent TP/SL/fee/sizing formulas — only calls the existing functions in risk/.
 */
import { detectRegime } from '../regime/regimeDetector.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import type { CandleData } from '../regime/types.js';
import { routeEntry } from '../entry/entryRouter.js';
import { EntryConfig } from '../entry/config.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type FeatureSchema } from '../xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../xgbFilter/momentumScorer.js';
import { computeMomentumMultiplier } from '../xgbFilter/momentumMultiplier.js';
import { MOMENTUM_MODEL_PATH, MOMENTUM_SCHEMA_PATH } from '../xgbFilter/config.js';
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
  updateGivebackProtection,
  type ManagedPositionState,
  type SlTpManagerInput,
} from '../risk/slTpManager.js';
import type { CloseTradeEvent, ExitReason, OpenTradeEvent, OrchestratorConfig, OrchestratorEvent, SymbolState } from './types.js';

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
  accountBalance: number;
  /** Other symbols' currently open positions — THIS symbol's own position must not be included (checked separately by construction: only called when this symbol has none open). */
  otherOpenPositionsRisk: OpenPositionRisk[];
}

export interface ProcessCandleResult {
  symbolState: SymbolState;
  accountBalance: number;
  event: OrchestratorEvent | null;
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

// TICKET-024 Phần B.1: cached across calls — read once, never re-parsed per candle. Schema content
// itself is still always read fresh from disk on first use, never hard-coded in TS.
let cachedMomentumSchema: FeatureSchema | undefined;
function getMomentumSchema(): FeatureSchema {
  if (cachedMomentumSchema === undefined) {
    cachedMomentumSchema = loadFeatureSchema(MOMENTUM_SCHEMA_PATH);
  }
  return cachedMomentumSchema;
}

export async function processCandle(input: ProcessCandleInput, state: SymbolState, config: OrchestratorConfig): Promise<ProcessCandleResult> {
  // Step 1 — regime, always runs.
  const regimeOutput = detectRegime({
    candles5m: input.candles5m,
    candles15m: input.candles15m,
    candles1h: input.candles1h,
    previousRegime: state.regimeState.previousRegime,
    previousCandidateRegime: state.regimeState.previousCandidateRegime,
    streakCount: state.regimeState.streakCount,
    previousDangerZoneTimestamp: state.regimeState.previousDangerZoneTimestamp,
  });
  const regimeState = {
    previousRegime: regimeOutput.regime,
    previousCandidateRegime: regimeOutput.candidateRegime,
    streakCount: regimeOutput.streakCount,
    previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
  };
  const currentCandle = input.candles5m[input.candles5m.length - 1];

  // Step 2 — no open position: try to enter.
  if (state.openPosition === null) {
    // TICKET-017 Phần A: same direction function as adxDirection1h, applied to 1D candles instead.
    const macroDirectionSeries = wilderDIDirectionSeries(input.candles1d, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

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
    );

    if (draftSetup === null) {
      return { symbolState: { ...state, regimeState }, accountBalance: input.accountBalance, event: null };
    }

    // Account blown (balance <= 0): no new positions can be sized. Not a NOT_IMPLEMENTED-style
    // error — a real, expected end state for a backtest/live account, so it's just "no entry"
    // rather than an exception (PositionSizingInput itself throws on accountBalance <= 0).
    if (input.accountBalance <= 0) {
      return { symbolState: { ...state, regimeState }, accountBalance: input.accountBalance, event: null };
    }

    // TICKET-024 Phần C/D — soft risk-multiplier from the momentum model, applied to the sizer's
    // REQUESTED risk (riskDollarOrPercent) so it flows through maxMarginCap capping the same way a
    // smaller riskDollarOrPercent naturally would. Never gates entry outright — only scales size.
    // Off by default: momentumMultiplier stays 1.0 and combinedRiskMultiplier === draftSetup.riskMultiplier
    // (itself always 1.0 for every regime that currently reaches this point), so behavior is
    // byte-for-byte unchanged from before this ticket unless momentumFilterConfig.momentumFilterEnabled.
    let momentumMultiplier = 1.0;
    if (config.momentumFilterConfig.momentumFilterEnabled) {
      const crossFeatures = computeMomentumCrossFeatures(input.candles5m, input.candles1hMomentum);
      if (crossFeatures !== undefined) {
        const schema = getMomentumSchema();
        const featureVector = buildFeatureVector(
          {
            symbol: input.symbol,
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
        const rawScore = await scoreMomentum(MOMENTUM_MODEL_PATH, featureVector);
        // PM-approved approximation (TICKET-024): the model only learned P(upward move); SHORT uses
        // 1-p as its "supporting score" instead of a real down-move probability.
        const p = draftSetup.side === 'LONG' ? rawScore : 1 - rawScore;
        momentumMultiplier = computeMomentumMultiplier(p, config.momentumFilterConfig);
      }
      // crossFeatures undefined (insufficient EMA/ATR history) -> momentumMultiplier stays 1.0, same as disabled.
    }
    const combinedRiskMultiplier = draftSetup.riskMultiplier * momentumMultiplier;

    const slDistancePercent = Math.abs(draftSetup.entryPrice - draftSetup.slPrice) / draftSetup.entryPrice;
    const sizingOutput = new DynamicRMarginSizer().calculate({
      accountBalance: input.accountBalance,
      riskDollarOrPercent: config.riskDollarOrPercent * combinedRiskMultiplier,
      entryPrice: draftSetup.entryPrice,
      slDistancePercent,
      leverage: config.leverage,
      maxMarginCap: config.maxMarginCap,
    });

    if (wouldExceedRiskPool(input.otherOpenPositionsRisk, sizingOutput.actualRiskDollar, input.accountBalance, { riskPoolMaxPct: config.riskPoolMaxPct })) {
      return {
        symbolState: { ...state, regimeState },
        accountBalance: input.accountBalance,
        event: { type: 'SKIPPED', symbol: input.symbol, timestamp: currentCandle.timestamp, reason: 'RISK_POOL_EXCEEDED' },
      };
    }

    // scenario is always TREND — entryRouter has no COUNTER_TREND path (OB/FVG/Sweep are all
    // direction-aligned with adxDirection1h; box breakout isn't a reversal play either).
    const openInput: SlTpManagerInput = {
      scenario: 'TREND',
      entryPrice: draftSetup.entryPrice,
      slPrice: draftSetup.slPrice,
      side: draftSetup.side,
      tpPlan: config.tpPlan,
      positionSize: sizingOutput.positionSize,
      takerFeeRate: config.takerFeeRate,
    };
    const newPosition = openPosition(openInput);

    const event: OpenTradeEvent = {
      type: 'OPEN',
      symbol: input.symbol,
      side: draftSetup.side,
      regime: draftSetup.regime,
      setupType: draftSetup.setupType,
      tpPlan: config.tpPlan,
      entryTimestamp: currentCandle.timestamp,
      entryPrice: draftSetup.entryPrice,
      riskMultiplier: combinedRiskMultiplier,
      actualRiskDollar: sizingOutput.actualRiskDollar,
      marginRequired: sizingOutput.marginRequired,
    };

    return {
      symbolState: {
        regimeState,
        openPosition: newPosition,
        openMeta: {
          regime: draftSetup.regime,
          setupType: draftSetup.setupType,
          entryTimestamp: currentCandle.timestamp,
          actualRiskDollar: sizingOutput.actualRiskDollar,
          marginRequired: sizingOutput.marginRequired,
          riskMultiplier: combinedRiskMultiplier,
        },
      },
      accountBalance: input.accountBalance,
      event,
    };
  }

  // Step 3 — already have an open position: advance it.
  const { position, exitReason, exitPrice } = advancePosition(state.openPosition, currentCandle, input.candles5m, config.isLowConfidenceOrLowLiquidity);

  if (!position.closed) {
    return { symbolState: { regimeState, openPosition: position, openMeta: state.openMeta }, accountBalance: input.accountBalance, event: null };
  }

  // Step 4 — closed this candle: log + free up the symbol for a new entry next candle.
  const meta = state.openMeta as NonNullable<SymbolState['openMeta']>;
  const pnlUsd = computeRealizedPnl(position, exitPrice as number);
  const accountBalance = input.accountBalance + pnlUsd;
  const pnlPct = (pnlUsd / meta.marginRequired) * 100;

  const event: CloseTradeEvent = {
    type: 'CLOSE',
    symbol: input.symbol,
    side: position.side,
    regime: meta.regime,
    setupType: meta.setupType,
    tpPlan: position.tpPlan,
    entryTimestamp: meta.entryTimestamp,
    entryPrice: position.entryPrice,
    exitTimestamp: currentCandle.timestamp,
    exitPrice: exitPrice as number,
    exitReason: exitReason as ExitReason,
    pnlUsd,
    pnlPct,
    riskMultiplier: meta.riskMultiplier,
    accountBalanceAfter: accountBalance,
  };

  return {
    symbolState: { regimeState, openPosition: null, openMeta: null },
    accountBalance,
    event,
  };
}
