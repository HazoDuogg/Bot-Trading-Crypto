import type { MarketRegime } from '../regime/types.js';
import type { ManagedPositionState, TpPlan } from '../risk/slTpManager.js';
import type { EntryRouterConfig } from '../entry/types.js';
import type { MomentumFilterConfig, NeutralTransitionGateConfig, PlanAutoSelectionConfig } from '../xgbFilter/config.js';

export interface RegimeHysteresisState {
  previousRegime: MarketRegime | null;
  previousCandidateRegime: MarketRegime | null;
  streakCount: number;
  /** TICKET-014 Phần B: timestamp (ms) of the last candle where regime was confirmed DANGER_ZONE. Null if never. */
  previousDangerZoneTimestamp: number | null;
}

/**
 * Attributes of the trade at OPEN time that neither ManagedPositionState nor the entry/regime
 * layers persist on their own, but Part D's trade log needs at CLOSE time (regime/setupType can
 * change or go out of scope after entry; ManagedPositionState doesn't know about them at all).
 */
export interface OpenTradeMeta {
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  entryTimestamp: number;
  actualRiskDollar: number;
  marginRequired: number;
  riskMultiplier: number;
}

/**
 * TICKET-056: position + its trade-log metadata always created/removed together — paired into one
 * entry (rather than two parallel arrays) so there is no possibility of an index-sync bug between them.
 */
export interface OpenPositionEntry {
  position: ManagedPositionState;
  meta: OpenTradeMeta;
}

export interface SymbolState {
  regimeState: RegimeHysteresisState;
  /** TICKET-056: was `openPosition: ManagedPositionState | null` + `openMeta` — up to config.maxConcurrentPositionsPerSymbol entries now, each tracked fully independently (its own TP/SL/trailing). */
  openPositions: OpenPositionEntry[];
}

export const INITIAL_SYMBOL_STATE: SymbolState = {
  regimeState: { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null },
  openPositions: [],
};

export type ExitReason = 'TP1' | 'TP2' | 'RUNNER_SL' | 'SL' | 'BREAKEVEN_SL' | 'COUNTER_TREND_TP';

export interface OpenTradeEvent {
  type: 'OPEN';
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  tpPlan: TpPlan;
  entryTimestamp: number;
  entryPrice: number;
  riskMultiplier: number;
  actualRiskDollar: number;
  marginRequired: number;
}

export interface CloseTradeEvent {
  type: 'CLOSE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: MarketRegime;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP' | 'MOMENTUM_DIRECT';
  tpPlan: TpPlan;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: ExitReason;
  pnlUsd: number;
  /** % return on margin deployed at open (marginRequired), not on notional. */
  pnlPct: number;
  riskMultiplier: number;
  accountBalanceAfter: number;
}

export interface SkippedEntryEvent {
  type: 'SKIPPED';
  symbol: string;
  timestamp: number;
  /** TICKET-036: NEUTRAL_GATE_REJECTED = the mandatory Momentum Gate rejected a NEUTRAL_TRANSITION DraftSetup — a distinct reason from risk-pool capacity, never conflated. */
  reason: 'RISK_POOL_EXCEEDED' | 'NEUTRAL_GATE_REJECTED';
}

export type OrchestratorEvent = OpenTradeEvent | CloseTradeEvent | SkippedEntryEvent;

export interface OrchestratorConfig {
  entryRouterConfig: EntryRouterConfig;
  tpPlan: TpPlan;
  takerFeeRate: number;
  riskDollarOrPercent: number;
  maxMarginCap: number;
  leverage: number;
  riskPoolMaxPct: number;
  /** No Confidence Score exists yet to set this dynamically — defaults false (normal 60% Giveback lock). */
  isLowConfidenceOrLowLiquidity: boolean;
  /** TICKET-024 Phần C: soft risk-multiplier from the momentum ONNX model — backtest-only A/B testing, not wired into live. */
  momentumFilterConfig: MomentumFilterConfig;
  /** TICKET-036: hard Momentum Gate for NEUTRAL_TRANSITION only — backtest-only A/B testing, not wired into live. */
  neutralTransitionGateConfig: NeutralTransitionGateConfig;
  /** TICKET-052: AI-driven Plan A/B selection, TREND scenario only — backtest-only A/B testing, not wired into live. */
  planAutoSelectionConfig: PlanAutoSelectionConfig;
  /**
   * TICKET-056: max simultaneously-open positions per symbol. Default 1 — matches every behavior
   * before this ticket exactly (routeEntry() only ever tried when the symbol had zero open positions).
   * Does NOT loosen any signal-detection condition — each additional slot still goes through the
   * exact same Regime/OB/FVG/Sweep/Breakout/MSS/Momentum Gate pipeline independently.
   */
  maxConcurrentPositionsPerSymbol: number;
  /**
   * TICKET-059 — AI momentum score used DIRECTLY as an independent entry signal (not just a
   * filter/multiplier on top of OB/FVG/Sweep/Breakout), only tried when routeEntry()'s existing
   * cascade found NOTHING for this candle. Default false — matches every ticket before this one exactly.
   */
  momentumDirectEnabled: boolean;
  /** TODO_CONFIRM: PM suggested 0.75. Momentum score (own-side model) must be >= this to trigger MOMENTUM_DIRECT. */
  momentumDirectThreshold: number;
  /**
   * TICKET-062 — TODO_CONFIRM: PM suggested 80 (matches TICKET-061's group-split threshold).
   * atrPercentile5m at the candidate candle must be <= this for MOMENTUM_DIRECT to trigger; undefined
   * (insufficient history) always blocks. Default 100 = no real-world cap (percentile rank never
   * exceeds 100), matching every ticket before this one exactly.
   */
  momentumDirectMaxAtrPercentile: number;
  /**
   * TICKET-064 Phần A — TODO_CONFIRM: PM suggested 0.5 (%). After computing the ATR-based SL for
   * MOMENTUM_DIRECT, if the resulting SL distance (%) is narrower than this floor, the SL is widened
   * out to exactly this floor instead — dilutes the fixed 2-way taker fee against a wider risk
   * distance (TICKET-063: fees ate 32.64% of the median SL distance pre-ticket).
   */
  momentumDirectMinSlPercent: number;
  /**
   * TICKET-064 Phần B — TODO_CONFIRM: PM suggested 2.0. Replaces the old fixed 0.5% TP
   * (EntryConfig.MOMENTUM_DIRECT_TP_PCT, removed by this ticket): TP = this × R, where R is the SL
   * distance AFTER the momentumDirectMinSlPercent floor above has already been applied.
   */
  momentumDirectTpRMultiple: number;
}
