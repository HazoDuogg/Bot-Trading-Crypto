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
  trendDirection,
  wilderADXSeries,
  wilderATRSeries,
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
export function detectCorrelatedRisk(_input: RegimeInput): never {
  throw new RegimeNotImplementedError(MarketRegime.CORRELATED_RISK);
}
export function detectLowLiquidity(_input: RegimeInput): never {
  throw new RegimeNotImplementedError(MarketRegime.LOW_LIQUIDITY);
}
export function detectManipulated(_input: RegimeInput): never {
  throw new RegimeNotImplementedError(MarketRegime.MANIPULATED);
}

function computeMetrics(input: RegimeInput): ComputedMetrics {
  const adxSeries1h = wilderADXSeries(input.candles1h, RegimeConfig.ADX_PERIOD_1H);
  const adx1h = lastDefined(adxSeries1h);

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

  return { adx1h, atrPercentile5m, bbWidthPercentile15m, atrTrend5m, volumeZScore5m };
}

function thresholdFor(t: Threshold, isCurrentRegime: boolean): number {
  return isCurrentRegime ? t.exit : t.enter;
}

/** Priority-order decision tree per PM's spec — first matching branch wins. Thresholds in config.ts. */
function classifyCandidate(metrics: ComputedMetrics, previousRegime: MarketRegime | null): MarketRegime {
  const { adx1h, atrPercentile5m, bbWidthPercentile15m, atrTrend5m, volumeZScore5m } = metrics;

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

  // 2. TREND_RIDER
  const trendAdxThreshold = thresholdFor(RegimeConfig.TREND_ENTER_ADX, isCurrently(MarketRegime.TREND_RIDER));
  const trendAtrThreshold = thresholdFor(RegimeConfig.TREND_ENTER_ATR_PCT, isCurrently(MarketRegime.TREND_RIDER));
  if (adx1h >= trendAdxThreshold && atrPercentile5m >= trendAtrThreshold) {
    return MarketRegime.TREND_RIDER;
  }

  // 3. COMPRESSION — bbWidth in the extreme-low percentile band AND actively tightening (dynamic, not static).
  const compressionBbwThreshold = thresholdFor(
    RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD,
    isCurrently(MarketRegime.COMPRESSION),
  );
  if (bbWidthPercentile15m <= compressionBbwThreshold && atrTrend5m === 'decreasing') {
    return MarketRegime.COMPRESSION;
  }

  // 4. VOLATILE_CHOP — high ATR without trend strength (choppy, non-directional volatility).
  const chopAtrThreshold = thresholdFor(RegimeConfig.CHOP_ATR_PCT_THRESHOLD, isCurrently(MarketRegime.VOLATILE_CHOP));
  const chopAdxThreshold = thresholdFor(RegimeConfig.CHOP_ADX_THRESHOLD, isCurrently(MarketRegime.VOLATILE_CHOP));
  if (atrPercentile5m >= chopAtrThreshold && adx1h < chopAdxThreshold) {
    return MarketRegime.VOLATILE_CHOP;
  }

  // 5. SIDEWAY_SCALPER — low ADX, stable range (bbWidth NOT in the extreme-low/compressing band).
  const sidewayAdxThreshold = thresholdFor(RegimeConfig.SIDEWAY_ADX_THRESHOLD, isCurrently(MarketRegime.SIDEWAY_SCALPER));
  if (adx1h <= sidewayAdxThreshold && bbWidthPercentile15m > RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter) {
    return MarketRegime.SIDEWAY_SCALPER;
  }

  // 6. NEUTRAL_TRANSITION — fallback: grey zone between Sideway and Trend.
  return MarketRegime.NEUTRAL_TRANSITION;
}

/**
 * Pure function (PM-confirmed): caller persists RegimeOutput.{regime, candidateRegime,
 * streakCount} and feeds them back as RegimeInput on the next 5m candle close. Confirms a
 * candidate regime after N_CANDLE_CONFIRM consecutive candles. Does NOT import entry/ or risk/.
 */
export function detectRegime(input: RegimeInput): RegimeOutput {
  const metrics = computeMetrics(input);
  const previousRegime = input.previousRegime ?? null;
  const previousCandidateRegime = input.previousCandidateRegime ?? null;
  const priorStreak = input.streakCount ?? 0;

  const candidateRegime = classifyCandidate(metrics, previousRegime);

  let confirmedRegime: MarketRegime;
  let streakCount: number;

  if (previousRegime === null) {
    // First call ever (bot just started) — no history to confirm against.
    confirmedRegime = candidateRegime;
    streakCount = 1;
  } else if (candidateRegime === previousRegime) {
    // Already the confirmed regime — nothing pending.
    confirmedRegime = candidateRegime;
    streakCount = 0;
  } else {
    const continuingSameCandidate = candidateRegime === previousCandidateRegime;
    const newStreak = continuingSameCandidate ? priorStreak + 1 : 1;
    if (newStreak >= RegimeConfig.N_CANDLE_CONFIRM) {
      confirmedRegime = candidateRegime;
      streakCount = 0;
    } else {
      confirmedRegime = previousRegime; // hold until confirmed
      streakCount = newStreak;
    }
  }

  return {
    regime: confirmedRegime,
    candidateRegime,
    streakCount,
    computedMetrics: metrics,
    timestamp: Date.now(),
  };
}
