/**
 * All classification thresholds live here — regimeDetector.ts must never inline a
 * magic number. Every TODO_CONFIRM value is a starting point, not a backtested
 * number; PM must confirm/replace before this runs against real capital.
 */

/** Asymmetric enter/exit threshold pair for hysteresis (generic, config-driven). */
export interface Threshold {
  enter: number;
  /** TODO_CONFIRM: PM only gave "enter" values; exit mirrors enter until PM backtests an asymmetric one. */
  exit: number;
}

function symmetric(enter: number): Threshold {
  return { enter, exit: enter };
}

export const RegimeConfig = {
  // ---- Indicator periods ----
  /** PM-confirmed: ADX(14) on 1H. */
  ADX_PERIOD_1H: 14,
  /** PM-confirmed: ATR(14) on 5m. */
  ATR_PERIOD_5M: 14,
  /** TODO_CONFIRM: PM did not specify a Bollinger period; 20 is the John Bollinger standard default. */
  BB_PERIOD_15M: 20,

  // ---- Percentile-rank lookback windows (rolling, in candles of the stated timeframe) ----
  /**
   * TODO_CONFIRM (PM's own flag): 300 candles ≈ 3.1 days, not yet backtested.
   * Ranks 5m ATR against its own 5m history (not 15m) — cross-timeframe ranking mixes
   * incompatible scales; PM pre-approved this same-timeframe fallback.
   */
  ATR_PCT_LOOKBACK_5M: 300,
  /** TODO_CONFIRM (PM's own flag): same 300-candle rationale, on 15m candles for Bollinger Bandwidth. */
  BBW_PCT_LOOKBACK_15M: 300,

  // ---- Derived-metric windows ----
  /** TODO_CONFIRM: N candles back to compare ATR(14) 5m against for atrTrend5m direction. */
  ATR_TREND_LOOKBACK_N: 3,
  /** TODO_CONFIRM: rolling window for volumeZScore5m mean/stddev. */
  VOLUME_ZSCORE_LOOKBACK_5M: 20,

  // ---- Hysteresis ----
  /** TODO_CONFIRM: consecutive 5m candles a candidate regime must hold before it becomes the confirmed regime. */
  N_CANDLE_CONFIRM: 3,

  // ---- Decision-tree thresholds (priority order enforced in regimeDetector.ts) ----
  /** TODO_CONFIRM, PM suggested ~95. */
  DANGER_ATR_PCT_THRESHOLD: symmetric(95),
  /** TODO_CONFIRM, PM suggested ~4. */
  DANGER_VOLUME_ZSCORE_THRESHOLD: symmetric(4),

  /** TODO_CONFIRM: not suggested by PM, 25 is the conventional Wilder ADX trend-strength cutoff. */
  TREND_ENTER_ADX: symmetric(25),
  /** TODO_CONFIRM: not suggested by PM, placeholder midpoint. */
  TREND_ENTER_ATR_PCT: symmetric(50),

  /** TODO_CONFIRM, PM suggested ~10. Also used as the SIDEWAY_SCALPER/COMPRESSION boundary. */
  COMPRESSION_BBW_PCT_THRESHOLD: symmetric(10),

  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  CHOP_ATR_PCT_THRESHOLD: symmetric(70),
  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  CHOP_ADX_THRESHOLD: symmetric(20),

  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  SIDEWAY_ADX_THRESHOLD: symmetric(20),
} as const;
