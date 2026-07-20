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
export const NOT_IMPLEMENTED_REGIMES: ReadonlySet<MarketRegime> = new Set([
  MarketRegime.EVENT_RISK,
  MarketRegime.CORRELATED_RISK,
  MarketRegime.LOW_LIQUIDITY,
]);

export interface RegimeInput {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  /** Returns of 4 correlated coins, for CORRELATED_RISK — optional, NOT_IMPLEMENTED regardless. */
  correlatedCoinsReturns?: number[][];
  /** From external economic calendar — optional, NOT_IMPLEMENTED regardless. */
  eventRiskFlag?: boolean;
  /** Hysteresis state fed back from the previous call's RegimeOutput. Null/omit on the first call. */
  previousRegime?: MarketRegime | null;
  streakCount?: number;
  /** candidateRegime the streak above was counting toward — needed to reset the streak on a flip. */
  previousCandidateRegime?: MarketRegime | null;
  /** TICKET-014 Phần B: timestamp (ms) of the last candle where `regime` was confirmed DANGER_ZONE. Null/omit if never. */
  previousDangerZoneTimestamp?: number | null;
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
