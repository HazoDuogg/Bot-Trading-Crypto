import { RegimeConfig } from '../regime/config.js';
import { EntryConfig } from '../entry/config.js';
import { TacticalConfig } from '../tactical/tacticalRegimeClassifier.js';

/**
 * TICKET-SCALP-001. All new scalp thresholds live here, same "no inline magic number"
 * convention as regime/config.ts and entry/config.ts. Values that are REUSED from an existing
 * calibrated config are referenced directly (not copy-pasted) so a future change to the source
 * propagates automatically. Values with no existing calibrated source are marked TODO_CONFIRM.
 */
export const ScalpConfig = {
  // ---- Reused from entry/regime/tactical config (ticket-mandated, not re-derived) ----
  /** Same fractal width swingPoints.ts/liquiditySweep.ts/marketStructureShift.ts already use elsewhere. */
  FRACTAL_N: EntryConfig.FRACTAL_N,
  /** Wick-ratio bar for detectLiquiditySweep() — ticket §3. */
  LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD: RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
  /** Rolling window for the sweep-candle volume z-score — same convention as ComputedMetrics.volumeZScore5m. */
  VOLUME_ZSCORE_LOOKBACK: RegimeConfig.VOLUME_ZSCORE_LOOKBACK_5M,
  /** Volume z-score bar at the sweep candle — ticket §4. */
  VOLUME_EXPANSION_ZSCORE_MIN: TacticalConfig.VOLUME_EXPANSION_ZSCORE_MIN,
  /** MSS confirmation must fall within this many candles of "now" — ticket §5. */
  MSS_STALENESS_TOLERANCE_CANDLES: EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES,
  /** SL sits this many ATR(14) 5m outside the swept level — ticket's Risk/Entry mapping section. */
  SL_BUFFER_ATR_MULTIPLIER: EntryConfig.SL_BUFFER_ATR_MULTIPLIER,
  /** ATR period for both the SL buffer and the touch-proximity buffer below — same series entryRouter.ts already computes. */
  ATR_PERIOD_5M: RegimeConfig.ATR_PERIOD_5M,

  // ---- New to this ticket ----
  /**
   * TODO_CONFIRM: no existing "swing touch proximity" constant to reuse. Ticket §2 asks for a
   * "buffer ATR nhỏ" gate distinct from §3's detectLiquiditySweep() wick-ratio confirmation.
   * Deliberately smaller than SL_BUFFER_ATR_MULTIPLIER (0.1) — this only pre-filters which
   * candles are even worth running the sweep check on, not a survivable price distance.
   */
  SWING_TOUCH_ATR_BUFFER_MULTIPLIER: 0.05,

  /** PM-given, not TODO_CONFIRM: ticket's Phạm vi section states leverage 10x explicitly. */
  LEVERAGE: 10,

  /**
   * TICKET-SCALP-003 Phần A — PM-given, not TODO_CONFIRM: back to fixed margin (positionSize
   * always MARGIN_USD * LEVERAGE = $300), replacing TICKET-SCALP-002's risk$-inverted sizing
   * (that let positionSize blow up to tens of thousands of $ whenever real SL% was tiny).
   */
  MARGIN_USD: 30,

  /**
   * TICKET-SCALP-003 Phần A (TODO_CONFIRM, ticket's own "= 3, chưa backtest xác nhận"):
   * tpDistancePercent = slDistancePercent * R_MULTIPLE — actualRiskDollar floats with real SL%
   * (normal, not a bug — SL is structure-based), but R:R stays fixed at this ratio per trade.
   */
  R_MULTIPLE: 3,

  /**
   * TICKET-SCALP-003 Phần B (TODO_CONFIRM — ticket explicitly not decided yet, this is the sweep
   * baseline/no-filter default). Setups with real slDistancePercent below this are skipped — too
   * close to entry, more prone to random noise sweeping the SL. scripts/scalpBacktest.ts overrides
   * this per sweep level; production wiring should read the value the sweep picks, not this default.
   */
  MIN_SL_DISTANCE_PERCENT: 0,

  /** Ticket's Phạm vi section — the 5 coins this module is authorized to trade. */
  SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT'] as const,
} as const;
