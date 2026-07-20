import { RegimeConfig } from '../regime/config.js';

/** All entry/ thresholds live here, same convention as regime/config.ts — never inline a magic number in detectors/. */
export const EntryConfig = {
  /** TODO_CONFIRM: PM suggested N=2 (standard 5-candle fractal) as the default swing-point width. */
  FRACTAL_N: 2,

  /** TODO_CONFIRM: PM suggested K=10 — max candles forward from an OB candidate to find BOS before giving up. */
  OB_BOS_LOOKFORWARD_K: 10,

  /**
   * TODO_CONFIRM: PM-given formula, threshold not yet backtested. lowerWickRatio/upperWickRatio > this = a sweep.
   * TICKET-026: canonical value now lives in RegimeConfig (regime/regimeDetector.ts's MANIPULATED
   * check reuses it too, and regime/ must not import entry/) — this just points at it, same number.
   */
  LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD: RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,

  /** TODO_CONFIRM: PM suggested 1m as the default MSS confirmation timeframe (alternative: 3m). */
  MSS_TIMEFRAME: '1m' as '1m' | '3m',
  /**
   * TICKET-011: MSS confirmation must fall within the last N candles of the MSS window (relative
   * to "now") to be actionable — otherwise it's a stale historical confirmation (found a bug where
   * entries used a confirmation price up to ~85 minutes old, since detectMarketStructureShift
   * returns the FIRST match in the window, which can be arbitrarily old). PM-picked N=5, TODO_CONFIRM.
   */
  MSS_STALENESS_TOLERANCE_CANDLES: 5,

  /** TODO_CONFIRM: PM suggested M=40 candles on 15m for the box lookback window (B.5). */
  BOX_LOOKBACK_M: 40,
  /**
   * TODO_CONFIRM: not given by PM — bbWidthPercentile15m must be <= this for the box to count as
   * "stable enough" to trade. Looser than COMPRESSION_BBW_PCT_THRESHOLD (10) since SIDEWAY_SCALPER's
   * natural range is wider (calibration median ~50); this just excludes clearly-too-wide ranges.
   */
  BOX_MAX_BBW_PERCENTILE: 60,
  /** TODO_CONFIRM: not given by PM — |close-open|/(high-low) must be >= this for a breakout candle to count as a real push, not a wick. */
  BOX_BREAKOUT_MIN_BODY_RATIO: 0.5,
  /** PM's own suggestion (TODO_CONFIRM on the exact number, but the >0 direction and ballpark are given). */
  BOX_BREAKOUT_MIN_VOLUME_ZSCORE: 1.0,

  /** PM's own suggestion: SL buffer outside an OB/FVG zone = this × ATR(14) 5m. TODO_CONFIRM. */
  SL_BUFFER_ATR_MULTIPLIER: 0.1,

  /** TICKET-017: period for the 1D macro-trend direction (wilderDIDirectionSeries on daily candles, same function as adxDirection1h). PM didn't specify a 1D-specific period — defaults to RegimeConfig.ADX_PERIOD_1H's value. TODO_CONFIRM. */
  MACRO_TREND_ADX_PERIOD_1D: 14,
} as const;
