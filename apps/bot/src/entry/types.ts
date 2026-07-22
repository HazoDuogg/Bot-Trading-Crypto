import type { MarketRegime } from '../regime/types.js';

export type Direction = 'BULLISH' | 'BEARISH';

export interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface OrderBlock {
  type: Direction;
  high: number;
  low: number;
  /** Index of the OB candle itself (the last opposite-direction candle before the impulse). */
  candleIndex: number;
  /** Index of the candle whose close confirmed BOS. */
  confirmedAtIndex: number;
}

export interface FairValueGap {
  type: Direction;
  top: number;
  bottom: number;
  /** Index of the 3rd candle in the 3-candle pattern (the gap is confirmed at this candle). */
  candleIndex: number;
}

export interface LiquiditySweep {
  /** BULLISH = swept a swing low (reversal up expected); BEARISH = swept a swing high. */
  type: Direction;
  sweptLevel: number;
  candleIndex: number;
}

export interface BoxBreakout {
  direction: 'UP' | 'DOWN';
  boxHigh: number;
  boxLow: number;
  /** Index (in the 5m candle array) of the candle that confirmed the breakout. */
  breakoutCandleIndex: number;
}

export interface DraftSetup {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  slPrice: number;
  setupType: 'OB' | 'FVG' | 'BOX_BREAKOUT' | 'SWEEP';
  regime: MarketRegime;
  /** From EntryRouterConfig.regimeRiskMultiplier — risk/ layer (not wired up this sprint) reads this. */
  riskMultiplier: number;
}

export type EntryStyleForNeutral = 'TREND_STYLE' | 'SIDEWAY_STYLE';

/**
 * TICKET-054 — granular reason the OB->FVG->Sweep cascade found no setup at all, for funnel
 * reporting only. PM-confirmed design: since detectOrderBlock()'s own outcome (candidate found vs
 * none at all) is an exhaustive 2-way split covering every case reaching this classification, it
 * always takes priority — 'NO_FVG_CANDIDATE'/'NO_SWEEP_CANDIDATE' are structurally unreachable given
 * the current cascade (FVG/Sweep are only ever tried when OB has already fully failed, and by that
 * point both are guaranteed null too) but are kept in the type/report for forward-compatibility.
 */
export type SetupFailReason = 'NO_OB_CANDIDATE' | 'OB_FOUND_NO_BOS' | 'NO_FVG_CANDIDATE' | 'NO_SWEEP_CANDIDATE';

/**
 * TICKET-042 — Entry Funnel Analytics. Pure observability: routeEntry()'s decision logic is
 * unchanged whether or not a caller passes a FunnelCallback. 'SETUP' = did the OB->FVG->Sweep
 * cascade find anything; 'MACRO' = 1D macro-trend-filter (TREND path only); 'MSS' = market
 * structure shift confirmation (TREND path only); 'BREAKOUT' = the box-breakout detector's 3
 * conditions PLUS the macro-trend-filter-for-breakout check (TICKET-018), collapsed into one
 * stage/event since SIDEWAY_STYLE has no separate MACRO stage of its own.
 */
export type FunnelStage = 'SETUP' | 'MACRO' | 'MSS' | 'BREAKOUT';

export interface FunnelEvent {
  stage: FunnelStage;
  passed: boolean;
  /**
   * e.g. 'MACRO_TREND_OPPOSITE', 'MSS_TIMEOUT'. Only set when passed=false. For stage='SETUP' with
   * no setup found at all (TICKET-054), one of SetupFailReason's 'NO_OB_CANDIDATE' |
   * 'OB_FOUND_NO_BOS' | 'NO_FVG_CANDIDATE' | 'NO_SWEEP_CANDIDATE'. For stage='MSS' with no
   * confirmation at all (TICKET-043), one of MssFailReason's 'NO_HIGHER_LOW_PATTERN' |
   * 'NO_REFERENCE_BETWEEN' | 'NEVER_BROKE_REFERENCE'. For stage='BREAKOUT' with no breakout detected
   * at all (TICKET-053), one of BoxBreakoutFailReason's 'NO_EDGE_TOUCH' | 'BODY_TOO_SMALL' |
   * 'VOLUME_NOT_ELEVATED'.
   */
  reason?: string;
  /** Only set when stage='SETUP' and passed=true. */
  setupType?: 'OB' | 'FVG' | 'SWEEP';
  /** TICKET-044: only set when reason === 'MSS_TIMEOUT' — how many candles past the staleness tolerance the confirmation was. */
  candlesLate?: number;
  /** TICKET-054: only set when stage='MACRO' and passed=false — which side got blocked (to check for skew toward one direction; a market characteristic, not a bug). */
  side?: 'LONG' | 'SHORT';
}

/** Return value is ignored by routeEntry() — reporting only, never influences the entry decision. */
export type FunnelCallback = (symbol: string, timestamp: number, event: FunnelEvent) => void;

export interface EntryRouterConfig {
  /**
   * TICKET-036: NEUTRAL_TRANSITION re-enabled (was disabled by TICKET-012) — routeEntry() picks
   * runTrendStyle() or runBoxBreakoutStyle() per this field, same as TREND_RIDER/SIDEWAY_SCALPER.
   * Gated behind orchestrator.ts's mandatory Momentum Gate (xgbFilter/config.ts's
   * NeutralTransitionGateConfig), not a soft risk-multiplier like the other regimes.
   */
  entryStyleForNeutral: EntryStyleForNeutral;
  regimeRiskMultiplier: Record<MarketRegime, number>;
  /** TICKET-017 Phần A: only take TREND_RIDER (OB/FVG/Sweep) entries aligned with the 1D macro trend. A/B-testable via backtest.ts CLI, not hard-coded. */
  macroTrendFilterEnabled: boolean;
  /** TICKET-017 Phần B: symbols to skip OB detection for (FVG/Sweep still run) — e.g. ['XRPUSDT']. A/B-testable via backtest.ts CLI, not hard-coded. */
  obDisabledSymbols: string[];
  /** TICKET-018: extends the macro trend filter to Box Breakout (SIDEWAY_SCALPER + COMPRESSION) — independent of macroTrendFilterEnabled, both must be true for the Box Breakout path to be filtered. A/B-testable via backtest.ts CLI, not hard-coded. */
  macroTrendFilterAppliesToBoxBreakout: boolean;
  /** TICKET-040: same value as EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES by default (TICKET-011) — threaded through here so backtest.ts's CLI can A/B test it without touching that constant. */
  mssStalenessToleranceCandles: number;
  /** TICKET-041: same value as EntryConfig.OB_BOS_LOOKFORWARD_K by default (TICKET-008) — threaded through here so backtest.ts's CLI can A/B test it without touching that constant. */
  obBosLookforwardK: number;
}
