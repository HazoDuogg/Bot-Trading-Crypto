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

export interface EntryRouterConfig {
  /**
   * @deprecated TICKET-012: NEUTRAL_TRANSITION no longer enters (backtest showed it's net
   * negative regardless of style/risk multiplier) — routeEntry() ignores this field entirely.
   * Kept on the type, not removed, in case PM wants to revisit with different logic later.
   */
  entryStyleForNeutral: EntryStyleForNeutral;
  regimeRiskMultiplier: Record<MarketRegime, number>;
  /** TICKET-017 Phần A: only take TREND_RIDER (OB/FVG/Sweep) entries aligned with the 1D macro trend. A/B-testable via backtest.ts CLI, not hard-coded. */
  macroTrendFilterEnabled: boolean;
  /** TICKET-017 Phần B: symbols to skip OB detection for (FVG/Sweep still run) — e.g. ['XRPUSDT']. A/B-testable via backtest.ts CLI, not hard-coded. */
  obDisabledSymbols: string[];
  /** TICKET-018: extends the macro trend filter to Box Breakout (SIDEWAY_SCALPER + COMPRESSION) — independent of macroTrendFilterEnabled, both must be true for the Box Breakout path to be filtered. A/B-testable via backtest.ts CLI, not hard-coded. */
  macroTrendFilterAppliesToBoxBreakout: boolean;
}
