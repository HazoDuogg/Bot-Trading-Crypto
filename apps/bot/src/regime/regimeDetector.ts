import {
  MarketRegime,
  NOT_IMPLEMENTED_REGIMES,
  type ComputedMetrics,
  type RegimeInput,
  type RegimeOutput,
} from './types.js';
import { RegimeConfig, type Threshold } from './config.js';
import {
  bollingerBandwidthSeries,
  lastDefined,
  percentileRankSeries,
  sessionRelativeVolumeRatio,
  trendDirection,
  wickRatios,
  wilderADXSeries,
  wilderATRSeries,
  wilderDIDirectionSeries,
  zScoreSeries,
} from './indicators.js';

export class RegimeNotImplementedError extends Error {
  constructor(regime: MarketRegime) {
    super(`regimeDetector: classification formula for ${regime} not specified by PM yet (NOT_IMPLEMENTED)`);
    this.name = 'RegimeNotImplementedError';
  }
}

/** Throws for any regime whose formula PM hasn't specified — see NOT_IMPLEMENTED_REGIMES in types.ts. */
export function assertRegimeImplemented(regime: MarketRegime): void {
  if (NOT_IMPLEMENTED_REGIMES.has(regime)) {
    throw new RegimeNotImplementedError(regime);
  }
}

// Explicit stubs per NOT_IMPLEMENTED regime, so each has a callable, testable entry point
// that throws rather than silently returning a guessed classification.
export function detectEventRisk(_input: RegimeInput): never {
  throw new RegimeNotImplementedError(MarketRegime.EVENT_RISK);
}

/** Last `count` non-NaN values of `series`, oldest to newest. Fewer than `count` if not enough valid history yet. */
function lastDefinedN(series: number[], count: number): number[] {
  const valid = series.filter((v) => !Number.isNaN(v));
  return valid.slice(-count);
}

function computeMetrics(input: RegimeInput): ComputedMetrics {
  const adxSeries1h = wilderADXSeries(input.candles1h, RegimeConfig.ADX_PERIOD_1H);
  const adx1h = lastDefined(adxSeries1h);
  // TICKET-014 Phần A: TREND_RIDER persistence check needs more than the latest value.
  const adx1hRecent = lastDefinedN(adxSeries1h, RegimeConfig.TREND_ADX_PERSISTENCE_CANDLES);

  const adxDirectionSeries1h = wilderDIDirectionSeries(input.candles1h, RegimeConfig.ADX_PERIOD_1H);
  const adxDirection1h = adxDirectionSeries1h.length > 0 ? adxDirectionSeries1h[adxDirectionSeries1h.length - 1] : undefined;

  const atrSeries5m = wilderATRSeries(input.candles5m, RegimeConfig.ATR_PERIOD_5M);
  const atrPercentileSeries5m = percentileRankSeries(atrSeries5m, RegimeConfig.ATR_PCT_LOOKBACK_5M);
  const atrPercentile5m = lastDefined(atrPercentileSeries5m);

  const bbwSeries15m = bollingerBandwidthSeries(input.candles15m, RegimeConfig.BB_PERIOD_15M);
  const bbwPercentileSeries15m = percentileRankSeries(bbwSeries15m, RegimeConfig.BBW_PCT_LOOKBACK_15M);
  const bbWidthPercentile15m = lastDefined(bbwPercentileSeries15m);

  const atrTrend5m = trendDirection(atrSeries5m, RegimeConfig.ATR_TREND_LOOKBACK_N);

  const volumeSeries5m = input.candles5m.map((c) => c.volume);
  const volumeZScoreSeries5m = zScoreSeries(volumeSeries5m, RegimeConfig.VOLUME_ZSCORE_LOOKBACK_5M);
  const volumeZScore5m = lastDefined(volumeZScoreSeries5m);

  // TICKET-026: MANIPULATED — count 5m candles in the trailing MANIPULATED_LOOKBACK_CANDLES window
  // whose wick ratio (regime/indicators.ts's wickRatios(), same formula as
  // entry/detectors/liquiditySweep.ts's single-candle sweep check) exceeds the shared sweep
  // threshold, per side. classifyCandidate() does the >= MANIPULATED_MIN_SWEEPS_EACH_SIDE comparison
  // — this only computes the raw counts, same separation as every other metric here.
  const manipulatedWindow = input.candles5m.slice(-RegimeConfig.MANIPULATED_LOOKBACK_CANDLES);
  let upperSweepCount5m: number | undefined;
  let lowerSweepCount5m: number | undefined;
  if (manipulatedWindow.length === RegimeConfig.MANIPULATED_LOOKBACK_CANDLES) {
    upperSweepCount5m = 0;
    lowerSweepCount5m = 0;
    for (const candle of manipulatedWindow) {
      const { upperWickRatio, lowerWickRatio } = wickRatios(candle);
      if (upperWickRatio > RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD) upperSweepCount5m++;
      if (lowerWickRatio > RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD) lowerSweepCount5m++;
    }
  }

  // TICKET-028: LOW_LIQUIDITY — session-relative volume ratio, needs far more history
  // (RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS days) than every other metric above. Only
  // computed when the caller supplies the dedicated candles5mSessionVolume window; omitted
  // entirely otherwise (stays undefined — classifyCandidate() treats that as "not enough data yet",
  // never throws).
  let lowLiquidityRatio: number | undefined;
  if (input.candles5mSessionVolume !== undefined) {
    const lowLiquidityRatioSeries = sessionRelativeVolumeRatio(input.candles5mSessionVolume, RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    lowLiquidityRatio = lastDefined(lowLiquidityRatioSeries);
  }

  return {
    adx1h,
    adx1hRecent,
    adxDirection1h,
    atrPercentile5m,
    bbWidthPercentile15m,
    atrTrend5m,
    volumeZScore5m,
    upperSweepCount5m,
    lowerSweepCount5m,
    lowLiquidityRatio,
    // TICKET-030: pure pass-through, never computed here — detectRegime() stays single-symbol,
    // the caller pre-computes this once across all 4 coins (regime/correlatedRisk.ts) and feeds it in.
    correlatedRiskRatio: input.correlatedRiskRatio,
  };
}

function thresholdFor(t: Threshold, isCurrentRegime: boolean): number {
  return isCurrentRegime ? t.exit : t.enter;
}

/**
 * Priority-order decision tree per PM's spec — first matching branch wins. Thresholds in config.ts.
 * Exported so calibration scripts (apps/bot/scripts/) can reuse the exact live classification
 * logic against precomputed metric series, instead of re-deriving it.
 */
export function classifyCandidate(metrics: ComputedMetrics, previousRegime: MarketRegime | null): MarketRegime {
  const {
    adx1h,
    adx1hRecent,
    atrPercentile5m,
    bbWidthPercentile15m,
    atrTrend5m,
    volumeZScore5m,
    upperSweepCount5m,
    lowerSweepCount5m,
    lowLiquidityRatio,
    correlatedRiskRatio,
  } = metrics;

  if (
    adx1h === undefined ||
    atrPercentile5m === undefined ||
    bbWidthPercentile15m === undefined ||
    atrTrend5m === undefined ||
    volumeZScore5m === undefined
  ) {
    throw new Error(
      'regimeDetector: insufficient candle history to compute all required metrics ' +
        '(need enough candles for ADX/ATR/BBW periods plus their percentile-rank lookback windows)',
    );
  }

  const isCurrently = (r: MarketRegime): boolean => previousRegime === r;

  // 1. DANGER_ZONE
  const dangerAtrThreshold = thresholdFor(RegimeConfig.DANGER_ATR_PCT_THRESHOLD, isCurrently(MarketRegime.DANGER_ZONE));
  const dangerVolThreshold = thresholdFor(
    RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD,
    isCurrently(MarketRegime.DANGER_ZONE),
  );
  if (atrPercentile5m >= dangerAtrThreshold && volumeZScore5m >= dangerVolThreshold) {
    return MarketRegime.DANGER_ZONE;
  }

  // 2. MANIPULATED — TICKET-026: repeated 2-sided liquidity-style wick sweeps (same wick-ratio
  // formula/threshold as entry/detectors/liquiditySweep.ts's single-setup sweep check) within a
  // short trailing window, WITHOUT a volume spike — distinguishes staged "dắt giá" moves from
  // DANGER_ZONE's real high-volatility+high-volume ones. BOTH sides required (upper AND lower) —
  // one side repeating alone is a real trend, not manipulation. Undefined counts (lookback window
  // not fully populated yet) fall through, same as any other not-yet-available derived metric.
  const manipulatedMaxVolThreshold = thresholdFor(RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE, isCurrently(MarketRegime.MANIPULATED));
  if (
    upperSweepCount5m !== undefined &&
    lowerSweepCount5m !== undefined &&
    upperSweepCount5m >= RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE &&
    lowerSweepCount5m >= RegimeConfig.MANIPULATED_MIN_SWEEPS_EACH_SIDE &&
    volumeZScore5m < manipulatedMaxVolThreshold
  ) {
    return MarketRegime.MANIPULATED;
  }

  // 3. TREND_RIDER — TICKET-014 Phần A: adx1h must clear the threshold for
  // TREND_ADX_PERSISTENCE_CANDLES consecutive 1H candles, not just the latest one (post-crash
  // chop was producing 1-candle ADX spikes that looked like a trend but weren't). Not enough
  // history for the full window -> persistence fails, falls through to the next branch.
  // TICKET-032: moved ahead of CORRELATED_RISK — a confirmed real trend (ADX+ATR both clear) means
  // every coin moving together is the TREND_RIDER opportunity itself, not portfolio-wide liquidation
  // risk. Real backtest evidence: 71% of TREND_RIDER trades CORRELATED_RISK blocked (old order) were
  // winners, including all 3 during the Jan BTC-crash month. CORRELATED_RISK now only protects
  // non-trending periods (range-bound/choppy correlation spikes), its actually-intended target.
  const trendAdxThreshold = thresholdFor(RegimeConfig.TREND_ENTER_ADX, isCurrently(MarketRegime.TREND_RIDER));
  const trendAtrThreshold = thresholdFor(RegimeConfig.TREND_ENTER_ATR_PCT, isCurrently(MarketRegime.TREND_RIDER));
  const adxPersistent =
    adx1hRecent !== undefined &&
    adx1hRecent.length === RegimeConfig.TREND_ADX_PERSISTENCE_CANDLES &&
    adx1hRecent.every((v) => v >= trendAdxThreshold);
  if (adxPersistent && atrPercentile5m >= trendAtrThreshold) {
    return MarketRegime.TREND_RIDER;
  }

  // 4. SIDEWAY_SCALPER — low ADX, stable range (bbWidth NOT in the extreme-low/compressing band).
  // TICKET-034: moved ahead of CORRELATED_RISK — same reasoning as TREND_RIDER's move in TICKET-032.
  // A confirmed Box Breakout setup can be perfectly valid even while the 4 coins are highly
  // correlated (that's not itself abnormal risk). Real backtest evidence: 2/3 SIDEWAY_SCALPER trades
  // CORRELATED_RISK blocked (post-TICKET-032 order) were winners. Condition itself unchanged, only
  // its position in the priority chain moved.
  const sidewayAdxThreshold = thresholdFor(RegimeConfig.SIDEWAY_ADX_THRESHOLD, isCurrently(MarketRegime.SIDEWAY_SCALPER));
  if (adx1h <= sidewayAdxThreshold && bbWidthPercentile15m > RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter) {
    return MarketRegime.SIDEWAY_SCALPER;
  }

  // 5. CORRELATED_RISK — TICKET-030: cross-symbol correlation (regime/correlatedRisk.ts), pre-computed
  // ONCE per time-step across all 4 coins by the caller and passed in as a plain number — detectRegime()
  // never reads another symbol's candles itself. Portfolio-wide risk (chained liquidation across
  // Cross Margin positions when every coin moves together) — placed ahead of LOW_LIQUIDITY (which only
  // affects one coin at a time), same "stand aside" severity ordering reasoning as MANIPULATED before
  // it. Skipped entirely (falls through, never throws) whenever correlatedRiskRatio is undefined/NaN.
  if (correlatedRiskRatio !== undefined && !Number.isNaN(correlatedRiskRatio)) {
    const correlatedRiskThreshold = thresholdFor(RegimeConfig.CORRELATED_RISK_THRESHOLD, isCurrently(MarketRegime.CORRELATED_RISK));
    if (correlatedRiskRatio > correlatedRiskThreshold) {
      return MarketRegime.CORRELATED_RISK;
    }
  }

  // 6. LOW_LIQUIDITY — TICKET-028: session-relative volume (current volume vs the SAME time-of-day
  // on prior days, not a plain rolling average — crypto volume has a strong Asia/Europe/US session
  // cycle). No order book depth data available, so this is volume-only, a narrower scope than the
  // original design. Skipped entirely (falls through, never throws) whenever lowLiquidityRatio is
  // undefined/NaN — that only means "not enough session history yet" (needs
  // LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS days), not an error condition.
  if (lowLiquidityRatio !== undefined && !Number.isNaN(lowLiquidityRatio)) {
    const lowLiquidityThreshold = thresholdFor(RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD, isCurrently(MarketRegime.LOW_LIQUIDITY));
    if (lowLiquidityRatio < lowLiquidityThreshold) {
      return MarketRegime.LOW_LIQUIDITY;
    }
  }

  // 7. COMPRESSION — bbWidth in the extreme-low percentile band AND actively tightening (dynamic, not static).
  const compressionBbwThreshold = thresholdFor(
    RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD,
    isCurrently(MarketRegime.COMPRESSION),
  );
  if (bbWidthPercentile15m <= compressionBbwThreshold && atrTrend5m === 'decreasing') {
    return MarketRegime.COMPRESSION;
  }

  // 8. VOLATILE_CHOP — high ATR without trend strength (choppy, non-directional volatility).
  const chopAtrThreshold = thresholdFor(RegimeConfig.CHOP_ATR_PCT_THRESHOLD, isCurrently(MarketRegime.VOLATILE_CHOP));
  const chopAdxThreshold = thresholdFor(RegimeConfig.CHOP_ADX_THRESHOLD, isCurrently(MarketRegime.VOLATILE_CHOP));
  if (atrPercentile5m >= chopAtrThreshold && adx1h < chopAdxThreshold) {
    return MarketRegime.VOLATILE_CHOP;
  }

  // 9. NEUTRAL_TRANSITION — fallback: grey zone between Sideway and Trend.
  return MarketRegime.NEUTRAL_TRANSITION;
}

export interface HysteresisState {
  regime: MarketRegime;
  candidateRegime: MarketRegime | null;
  streakCount: number;
}

// TICKET-007 Phần A / TICKET-026 Phần B / TICKET-030: all three are protective "stand aside" states
// requiring an immediate reaction — confirm entering immediately, but still require the normal
// N_CANDLE_CONFIRM streak to leave. Better to be overly cautious than slow to react. CORRELATED_RISK
// joins DANGER_ZONE/MANIPULATED here (unlike LOW_LIQUIDITY, which is a slowly-changing session
// characteristic and deliberately uses normal symmetric hysteresis instead).
const FAST_IN_SLOW_OUT_REGIMES = new Set<MarketRegime>([MarketRegime.DANGER_ZONE, MarketRegime.MANIPULATED, MarketRegime.CORRELATED_RISK]);

/**
 * Hysteresis bookkeeping, isolated from metric computation so it can run cheaply over a
 * precomputed metric series (calibration scripts) without recomputing indicators per step.
 * `previous: null` means no prior state (first call ever). Confirms `candidateRegime` as the
 * new `regime` only after it holds for RegimeConfig.N_CANDLE_CONFIRM consecutive calls —
 * EXCEPT entering a FAST_IN_SLOW_OUT_REGIMES member, which bypasses that wait entirely.
 */
export function applyHysteresis(candidateRegime: MarketRegime, previous: HysteresisState | null): HysteresisState {
  const previouslyInSameFastInRegime = previous !== null && previous.regime === candidateRegime && FAST_IN_SLOW_OUT_REGIMES.has(candidateRegime);
  if (FAST_IN_SLOW_OUT_REGIMES.has(candidateRegime) && !previouslyInSameFastInRegime) {
    return { regime: candidateRegime, candidateRegime, streakCount: 0 };
  }

  if (previous === null) {
    return { regime: candidateRegime, candidateRegime, streakCount: 1 };
  }
  if (candidateRegime === previous.regime) {
    return { regime: candidateRegime, candidateRegime, streakCount: 0 };
  }
  const continuingSameCandidate = candidateRegime === previous.candidateRegime;
  const newStreak = continuingSameCandidate ? previous.streakCount + 1 : 1;
  if (newStreak >= RegimeConfig.N_CANDLE_CONFIRM) {
    return { regime: candidateRegime, candidateRegime, streakCount: 0 };
  }
  return { regime: previous.regime, candidateRegime, streakCount: newStreak }; // hold until confirmed (also covers leaving a FAST_IN_SLOW_OUT_REGIMES member, unchanged)
}

/**
 * Pure function (PM-confirmed): caller persists RegimeOutput.{regime, candidateRegime,
 * streakCount} and feeds them back as RegimeInput on the next 5m candle close. Does NOT import
 * entry/ or risk/.
 */
export function detectRegime(input: RegimeInput): RegimeOutput {
  const metrics = computeMetrics(input);
  const previousRegime = input.previousRegime ?? null;
  let candidateRegime = classifyCandidate(metrics, previousRegime);

  // TICKET-014/015 Phần B: Post-Danger Cooldown — overrides the CANDIDATE (Phần A persistence has
  // already run inside classifyCandidate above), before hysteresis sees it. "Now" is the latest
  // 5m candle's own timestamp, not Date.now() — detectRegime() is also called by backtest.ts
  // replaying historical data, where Date.now() would be the wrong (real, not simulated) clock.
  const currentTimestamp = input.candles5m[input.candles5m.length - 1].timestamp;
  const previousDangerZoneTimestamp = input.previousDangerZoneTimestamp ?? null;
  const inDangerCooldown =
    previousDangerZoneTimestamp !== null &&
    currentTimestamp - previousDangerZoneTimestamp < RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 60 * 60 * 1000;
  // TICKET-015: same detectBoxBreakout() false-breakout root cause as TREND_RIDER, so SIDEWAY_SCALPER
  // and COMPRESSION are suppressed too, same shared POST_DANGER_COOLDOWN_HOURS window.
  const regimesSuppressedDuringCooldown = new Set<MarketRegime>([
    MarketRegime.TREND_RIDER,
    MarketRegime.SIDEWAY_SCALPER,
    MarketRegime.COMPRESSION,
  ]);
  if (inDangerCooldown && regimesSuppressedDuringCooldown.has(candidateRegime)) {
    candidateRegime = MarketRegime.NEUTRAL_TRANSITION;
  }

  const previousState: HysteresisState | null =
    previousRegime === null
      ? null
      : { regime: previousRegime, candidateRegime: input.previousCandidateRegime ?? null, streakCount: input.streakCount ?? 0 };

  const { regime, streakCount } = applyHysteresis(candidateRegime, previousState);

  // Refresh on every candle DANGER_ZONE stays confirmed (not just first entry) — cooldown counts
  // from when danger was LAST seen, so a prolonged DANGER_ZONE naturally extends the cooldown.
  const lastDangerZoneTimestamp = regime === MarketRegime.DANGER_ZONE ? currentTimestamp : previousDangerZoneTimestamp;

  return {
    regime,
    candidateRegime,
    streakCount,
    computedMetrics: metrics,
    adxDirection1h: metrics.adxDirection1h,
    lastDangerZoneTimestamp,
    timestamp: Date.now(),
  };
}
