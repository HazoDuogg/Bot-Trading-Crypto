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
  /** TODO_CONFIRM, PM suggested ~95. Still achievable in real data (percentile reaches 100) — not the broken one. */
  DANGER_ATR_PCT_THRESHOLD: symmetric(95),
  /** PM-confirmed từ data thật 60 ngày (xem calibration-report.md 2026-07-17). */
  DANGER_VOLUME_ZSCORE_THRESHOLD: symmetric(2.5),

  /** PM-confirmed từ data thật 60 ngày (xem calibration-report.md 2026-07-17). */
  TREND_ENTER_ADX: { enter: 32, exit: 25 },
  /** PM-confirmed từ data thật 60 ngày (xem calibration-report.md 2026-07-17). */
  TREND_ENTER_ATR_PCT: { enter: 65, exit: 45 },

  /** TODO_CONFIRM, PM suggested ~10. Also used as the SIDEWAY_SCALPER/COMPRESSION boundary. */
  COMPRESSION_BBW_PCT_THRESHOLD: symmetric(10),

  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  CHOP_ATR_PCT_THRESHOLD: symmetric(70),
  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  CHOP_ADX_THRESHOLD: symmetric(20),

  /** TODO_CONFIRM: not suggested by PM, placeholder. */
  SIDEWAY_ADX_THRESHOLD: symmetric(20),

  // ---- TICKET-014: post-crash false-trend filters (TREND_RIDER only) ----
  /** TODO_CONFIRM, PM suggested 3. Consecutive 1H candles adx1h must clear the threshold for, not just the latest one. */
  TREND_ADX_PERSISTENCE_CANDLES: 3,
  /** TODO_CONFIRM, PM suggested 72. Hours after a confirmed DANGER_ZONE during which TREND_RIDER candidates are forced down to NEUTRAL_TRANSITION. */
  POST_DANGER_COOLDOWN_HOURS: 72,

  // ---- TICKET-026: MANIPULATED (repeated 2-sided liquidity sweep, no volume spike) ----
  /** TODO_CONFIRM, PM suggested 10. Trailing 5m-candle window checked for repeated 2-sided wick sweeps. */
  MANIPULATED_LOOKBACK_CANDLES: 10,
  /** TODO_CONFIRM, PM suggested 2. EACH side (upper AND lower) needs at least this many sweep candles within the lookback window — one side repeating alone is a real trend, not manipulation. */
  MANIPULATED_MIN_SWEEPS_EACH_SIDE: 2,
  /**
   * TODO_CONFIRM, PM suggested 1.5. volumeZScore5m must stay BELOW this — manipulation typically
   * doesn't need high volume, unlike DANGER_ZONE's real high-volatility+high-volume moves. Threshold
   * pair (not a plain number) for the same enter/exit hysteresis-asymmetry consistency as
   * DANGER_VOLUME_ZSCORE_THRESHOLD above — PM only gave one number, exit mirrors enter for now.
   */
  MANIPULATED_MAX_VOLUME_ZSCORE: symmetric(1.5),
  /**
   * TODO_CONFIRM: PM-given formula, threshold not yet backtested. lowerWickRatio/upperWickRatio >
   * this = a sweep (single 5m candle, entry/detectors/liquiditySweep.ts B.3) — same threshold TICKET-026's
   * MANIPULATED regime check reuses per-candle within its lookback window.
   * Canonical home moved here from entry/config.ts (TICKET-026): regime/regimeDetector.ts's
   * MANIPULATED check needs it too, and regime/ must not import entry/ (see regimeDetector.ts's
   * detectRegime() doc comment). entry/config.ts's EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD
   * now just points at this value (entry/ already imports regime/ freely elsewhere) — one source,
   * not a duplicate; value/meaning unchanged from the original entry/config.ts constant.
   */
  LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD: 0.65,

  // ---- TICKET-028: LOW_LIQUIDITY (session-relative volume, no order book depth data available) ----
  /** TODO_CONFIRM, PM suggested 14. Days of same-time-of-day history sessionRelativeVolumeRatio averages over. */
  LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS: 14,
  /** TODO_CONFIRM, PM suggested 0.3. currentVolume must fall below this fraction of the same-time-of-day average across prior days. */
  LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD: symmetric(0.3),
} as const;
