export interface CandleData {
  timestamp: number; // epoch ms UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export enum MarketRegime {
  TREND_RIDER = 'TREND_RIDER',
  SIDEWAY_SCALPER = 'SIDEWAY_SCALPER',
  NEUTRAL_TRANSITION = 'NEUTRAL_TRANSITION',
  VOLATILE_CHOP = 'VOLATILE_CHOP',
  EVENT_RISK = 'EVENT_RISK',
  DANGER_ZONE = 'DANGER_ZONE',
  CORRELATED_RISK = 'CORRELATED_RISK',
  COMPRESSION = 'COMPRESSION',
  LOW_LIQUIDITY = 'LOW_LIQUIDITY',
  MANIPULATED = 'MANIPULATED',
}

/** States with no PM-specified formula yet — detectRegime() throws instead of guessing. */
export const NOT_IMPLEMENTED_REGIMES: ReadonlySet<MarketRegime> = new Set([MarketRegime.EVENT_RISK]);

export interface RegimeInput {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  /** From external economic calendar — optional, NOT_IMPLEMENTED regardless. */
  eventRiskFlag?: boolean;
  /** Hysteresis state fed back from the previous call's RegimeOutput. Null/omit on the first call. */
  previousRegime?: MarketRegime | null;
  streakCount?: number;
  /** candidateRegime the streak above was counting toward — needed to reset the streak on a flip. */
  previousCandidateRegime?: MarketRegime | null;
  /** TICKET-014 Phần B: timestamp (ms) of the last candle where `regime` was confirmed DANGER_ZONE. Null/omit if never. */
  previousDangerZoneTimestamp?: number | null;
  /**
   * TICKET-028: 5m candles ending at "now", SEPARATE from `candles5m` above and sized for
   * RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS+ days of history — sessionRelativeVolumeRatio
   * needs many days of same-time-of-day samples, far more than `candles5m`'s own window (used by
   * ATR/ADX/etc, whose Wilder-smoothing is NOT invariant to window length — same reasoning as
   * orchestrator's candles1hMomentum). Optional: omit to leave lowLiquidityRatio always undefined
   * (LOW_LIQUIDITY simply never fires), no error.
   */
  candles5mSessionVolume?: CandleData[];
  /**
   * TICKET-030: pre-computed cross-symbol correlation ratio (average Pearson correlation of this
   * symbol's coin universe's 1H returns against BTCUSDT, see regime/correlatedRisk.ts). Computed
   * ONCE per time-step OUTSIDE detectRegime() (by the caller — backtest.ts/orchestrator — across
   * all 4 symbols at once) and passed in as a plain number, same value for every symbol at that
   * step — detectRegime() stays single-symbol and never reads another coin's candles itself.
   * Optional: omit to leave correlatedRiskRatio always undefined (CORRELATED_RISK never fires).
   */
  correlatedRiskRatio?: number;
}

export interface ComputedMetrics {
  adx1h?: number;
  /**
   * TICKET-014 Phần A: last RegimeConfig.TREND_ADX_PERSISTENCE_CANDLES valid adx1h values
   * (oldest to newest, last entry === adx1h), for the TREND_RIDER persistence check only —
   * COMPRESSION/CHOP/SIDEWAY still use the single `adx1h` value, unchanged.
   */
  adx1hRecent?: number[];
  /** +DI vs -DI on 1H, same period as adx1h. ADX only measures trend STRENGTH, not direction — this is direction. */
  adxDirection1h?: 'UP' | 'DOWN' | 'FLAT';
  atrPercentile5m?: number;
  bbWidthPercentile15m?: number;
  atrTrend5m?: 'increasing' | 'decreasing' | 'flat';
  volumeZScore5m?: number;
  /** TICKET-026: number of 5m candles in the trailing MANIPULATED_LOOKBACK_CANDLES window whose upper/lower wick ratio exceeds LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD. Undefined until the lookback window is fully populated. */
  upperSweepCount5m?: number;
  lowerSweepCount5m?: number;
  /**
   * TICKET-028: currentVolume / sessionAvgVolume (same time-of-day on prior days). OPTIONAL and
   * deliberately NOT in classifyCandidate()'s mandatory-undefined check — needs far more history
   * (LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS, ~14 days) than every other metric here (~1 day); making
   * it mandatory would silently disable the entire Regime Detector for the first 14 days of any
   * dataset. Undefined/NaN -> the LOW_LIQUIDITY branch is skipped, classification proceeds normally.
   */
  lowLiquidityRatio?: number;
  /**
   * TICKET-030: pass-through of RegimeInput.correlatedRiskRatio (see there) — OPTIONAL, deliberately
   * NOT in classifyCandidate()'s mandatory-undefined check, same reasoning as lowLiquidityRatio.
   */
  correlatedRiskRatio?: number;
  // Extensible — audit trail for metrics used by regimes not yet implemented.
  [key: string]: number | string | number[] | undefined;
}

export interface RegimeOutput {
  /** Confirmed regime after hysteresis (only changes once candidateRegime holds for N candles). */
  regime: MarketRegime;
  /** Raw regime the decision tree matched this call, before hysteresis confirmation — already reflects Phần A/B overrides. */
  candidateRegime: MarketRegime;
  /** Consecutive 5m candles candidateRegime has held — feed into next call's RegimeInput.streakCount. */
  streakCount: number;
  computedMetrics: ComputedMetrics;
  /** Same value as computedMetrics.adxDirection1h — top-level for entry/ layer convenience. */
  adxDirection1h?: 'UP' | 'DOWN' | 'FLAT';
  /** TICKET-014 Phần B: timestamp (ms) of the last candle where `regime` was confirmed DANGER_ZONE — feed into next call's RegimeInput.previousDangerZoneTimestamp. Null if never. */
  lastDangerZoneTimestamp: number | null;
  timestamp: number;
}
