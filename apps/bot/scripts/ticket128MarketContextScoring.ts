/**
 * TICKET-128 — 5M-PRIORITY MARKET CONTEXT AUDIT — scoring library.
 *
 * PURE, READ-ONLY, ADDITIVE. Never imported by production code (entryRouter.ts / orchestrator.ts /
 * risk/ / xgbFilter/) and never imported by tactical/ — this ticket is an explicitly SEPARATE,
 * independent scoring layer (see ticket spec's own framing: "this ticket does NOT create new
 * candidates and does NOT touch tactical/"). Small helper formulas that already exist in
 * tactical/tacticalRegimeClassifier.ts (chop-flip counting, body ratio, candle direction) are
 * REPLICATED here independently rather than imported, per the ticket's own instruction, to keep this
 * ticket's code fully decoupled from the TICKET-124-127 series.
 *
 * Three layers, each independently classified/scored, NEVER merged into one "Final Entry Score"
 * (explicit ticket constraint):
 *   A. 5m Direction Strength — BULLISH/BEARISH/NONE + score 0-100 (per side, so a candidate's own
 *      side can be looked up directly for "how strong is 5m in the direction I'd actually trade").
 *   B. 5m Market Quality — CLEAN_TREND/EXPANSION/COMPRESSION/CHOP/SHOCK (side-independent character
 *      of price action).
 *   C. Higher-Timeframe Context — ALIGNED/NEUTRAL/CONFLICT_WEAK/CONFLICT_STRONG/DANGER (15m/1H vs the
 *      candidate's own side). DESCRIPTIVE ONLY — never gates anything in this ticket's own code.
 *
 * All thresholds below were chosen BEFORE running any outcome/PnL analysis (see
 * data/ticket128-5m-priority-market-context-report.md's methodology section for the same
 * before/after discipline TICKET-124-127 used) — never tuned afterward to make results look better.
 * Every threshold either cites an existing bot convention (RegimeConfig/EntryConfig, cited by name)
 * or is marked TODO_CONFIRM with the first-principles reasoning that produced it.
 */
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { lastDefined, wilderATRSeries, wickRatios } from '../dist/regime/indicators.js';
import { detectSwingPoints } from '../dist/entry/detectors/swingPoints.js';

export type Side = 'LONG' | 'SHORT';
export type LayerADirection = 'BULLISH' | 'BEARISH' | 'NONE';
export type LayerBQuality = 'CLEAN_TREND' | 'EXPANSION' | 'COMPRESSION' | 'CHOP' | 'SHOCK';
export type LayerCContext = 'ALIGNED' | 'NEUTRAL' | 'CONFLICT_WEAK' | 'CONFLICT_STRONG' | 'DANGER';

/**
 * All TICKET-128 thresholds — same "no inline magic number" convention as regime/config.ts and
 * tactical/tacticalRegimeClassifier.ts's TacticalConfig. Reused-from-bot values cite the exact
 * constant; new ones are TODO_CONFIRM with the reasoning that produced them.
 */
export const Ticket128Config = {
  // ---- Layer A: 5m Direction Strength ----
  /** Reused verbatim: same tolerance tactical/tacticalRegimeClassifier.ts's TacticalConfig.EMA_ALIGNMENT_TOLERANCE
   * uses for "aligned rather than noise sitting at 1.0000" (5m EMA9/21 ratio). Independently re-declared
   * here (not imported) per this ticket's decoupling constraint — same value/meaning, not a coincidence. */
  EMA_ALIGNMENT_TOLERANCE: 0.0005,
  /** Reused verbatim: tactical/tacticalRegimeClassifier.ts's TacticalConfig.TACTICAL_MICRO_TREND_RETURN_ATR_MIN
   * — "sustained smaller push holding direction" bar for returnInAtr5m, weaker than the expansion-burst
   * bar (0.8). Reused here as Layer A's directional-return check (not a fast single-candle burst check). */
  RETURN_IN_ATR_MIN: 0.3,
  /** TODO_CONFIRM: momentum persistence window — ticket spec says "2-3 nến" (2-3 candles); 3 is the
   * upper end of that range, same as tactical's HYSTERESIS_WINDOW=3 (a coincidental but reasonable
   * "short lookback" convention already established in this codebase). >=2 of the last 3 candles must
   * agree in direction to count as "persistent". */
  MOMENTUM_PERSISTENCE_LOOKBACK: 3,
  MOMENTUM_PERSISTENCE_MIN_AGREE: 2,
  /** TODO_CONFIRM: "very fresh" structural break = within HALF of the already-established staleness
   * tolerance (entry/detectors/structuralBreakRecent.ts's RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES=20
   * 1m candles) — a first-principles "still hot, not just barely non-stale" bar, not a re-derivation
   * of the 20-candle constant itself. */
  STRUCTURAL_BREAK_FRESH_AGE_CANDLES: 10,
  /** Reused verbatim: tactical/tacticalRegimeClassifier.ts's TacticalConfig.CHOP_LOOKBACK_CANDLES/CHOP_MIN_FLIPS
   * — "trailing window of 5m candles checked for direction flips", independently re-declared here. */
  CHOP_LOOKBACK_CANDLES: 4,
  CHOP_MIN_FLIPS: 2,

  // ---- Layer B: 5m Market Quality ----
  /** Reused verbatim: RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter — the bot's own existing
   * "abnormal volume spike" bar, reused as one of SHOCK's two OR'd triggers. */
  SHOCK_VOLUME_ZSCORE_MIN: RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD.enter,
  /** Reused verbatim: RegimeConfig.DANGER_ATR_PCT_THRESHOLD.enter — the Regime Engine's own DANGER_ZONE
   * ATR-percentile bar, reused as SHOCK's other OR'd trigger (extreme volatility, regardless of volume). */
  SHOCK_ATR_PCT_MIN: RegimeConfig.DANGER_ATR_PCT_THRESHOLD.enter,
  /** Reused verbatim: RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter — same "extreme-low bandwidth"
   * bar the Regime Engine's own COMPRESSION regime uses. */
  COMPRESSION_BBW_PCT_MAX: RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter,
  /** TODO_CONFIRM: no existing "low ATR percentile" bot threshold to reuse (regime/config.ts only has
   * HIGH-side ATR bars). Same value/reasoning as tactical/tacticalRegimeClassifier.ts's
   * TacticalConfig.ATR_PCT_LOW_MAX (bottom-third-of-distribution "quiet" cutoff), independently
   * re-declared here. */
  COMPRESSION_ATR_PCT_MAX: 30,
  /** Reused verbatim: RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter — already means "volume NOT
   * elevated" in this codebase; reused here with the identical meaning for COMPRESSION. */
  COMPRESSION_VOLUME_ZSCORE_MAX: RegimeConfig.MANIPULATED_MAX_VOLUME_ZSCORE.enter,
  /** TODO_CONFIRM: same value/reasoning as tactical's TacticalConfig.ATR_PCT_EXPANSION_MIN — deliberately
   * BELOW RegimeConfig.TREND_ENTER_ATR_PCT.enter (65), since this is a 5m-only quality read, not the
   * full 1h-driven Regime Engine trend. 55 = just above the median (50th percentile). */
  EXPANSION_ATR_PCT_MIN: 55,
  /** Same numeric value as COMPRESSION_VOLUME_ZSCORE_MAX by construction — the line volume must CROSS
   * to count as "expanding" instead of staying under (same convention as tactical's
   * VOLUME_EXPANSION_ZSCORE_MIN). */
  EXPANSION_VOLUME_ZSCORE_MIN: 1.5,
  /** Reused verbatim: RegimeConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD is a genuine-sweep bar (0.65);
   * CHOP only needs "roughly half the candle is wick" — same looser bar tactical's
   * TacticalConfig.CHOP_WICK_RATIO_MIN uses, independently re-declared here. */
  CHOP_WICK_RATIO_MIN: 0.5,
  /** Reused verbatim: entry/config.ts's EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO ("a real push, not a
   * wick" bar) — same value tactical's TacticalConfig.BODY_RATIO_STRONG cites. Used here as CHOP's
   * "body weak" check (body ratio below this = indecisive candle). */
  BODY_RATIO_STRONG: 0.5,

  // ---- Layer C: Higher-Timeframe Context ----
  /** Reused verbatim: RegimeConfig.TREND_ENTER_ADX — {enter:32, exit:25} PM-confirmed pair (see
   * regime/config.ts's own calibration-report.md citation). `exit` (25) is used here as the "1H has
   * ANY meaningful trend at all" floor (below it, 1H is NEUTRAL regardless of DI direction); `enter`
   * (32) is used as the "1H trend is CONFIRMED strong enough to matter" bar (below it but above exit,
   * an opposing DI direction is only a CONFLICT_WEAK "forming" trend, not yet a hard opposition). */
  HTF_ADX_NEUTRAL_MAX: RegimeConfig.TREND_ENTER_ADX.exit,
  HTF_ADX_CONFIRMED_MIN: RegimeConfig.TREND_ENTER_ADX.enter,
} as const;

// ---------------------------------------------------------------------------------------------
// Small independent helpers (replicated from tactical/tacticalRegimeClassifier.ts's SMALL formulas
// per this ticket's own decoupling instruction — not imported).
// ---------------------------------------------------------------------------------------------

export function candleDirection128(candle: CandleData): 'UP' | 'DOWN' | 'FLAT' {
  if (candle.close > candle.open) return 'UP';
  if (candle.close < candle.open) return 'DOWN';
  return 'FLAT';
}

export function bodyRatioOf128(candle: CandleData): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

export function countDirectionFlips128(candles: CandleData[], lookback: number): number {
  const window = candles.slice(-lookback);
  if (window.length < 2) return 0;
  let flips = 0;
  let prevSign = Math.sign(window[0].close - window[0].open);
  for (let i = 1; i < window.length; i++) {
    const sign = Math.sign(window[i].close - window[i].open);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  return flips;
}

/**
 * TICKET-126's fixed, unit-normalized formula (NOT xgbFilter/featureBuilder.ts's `volAdjReturn5m`,
 * which mixes a percent numerator with an absolute-price ATR denominator — see TICKET-126's report
 * for why that breaks on BTC/ETH). `returnInAtr5m = (close - previousClose) / atr5mRaw`. Independently
 * re-declared here (identical formula to tactical/tacticalRegimeClassifier.ts's computeReturnInAtr5m)
 * per this ticket's decoupling instruction.
 */
export function computeReturnInAtr5m128(candles5m: CandleData[]): number | undefined {
  if (candles5m.length < 2) return undefined;
  const currentCandle = candles5m[candles5m.length - 1];
  const previousCandle = candles5m[candles5m.length - 2];
  const atr5mRaw = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr5mRaw === undefined || atr5mRaw === 0) return undefined;
  return (currentCandle.close - previousCandle.close) / atr5mRaw;
}

/**
 * HH-HL (bullish structure) / LL-LH (bearish structure) pattern from the latest two confirmed swing
 * highs and latest two confirmed swing lows on candles5m (swingPoints.ts's detectSwingPoints(), no
 * new formula). Returns 'NONE' when fewer than 2 confirmed swings of either type exist yet, or when
 * highs and lows don't move in the same direction (mixed/ambiguous structure).
 */
export function computeHhHlPattern(candles5m: CandleData[], fractalN: number): 'HH_HL' | 'LL_LH' | 'NONE' {
  const swings = detectSwingPoints(candles5m, fractalN);
  const highs = swings.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
  const lows = swings.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);
  if (highs.length < 2 || lows.length < 2) return 'NONE';
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) return 'HH_HL';
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) return 'LL_LH';
  return 'NONE';
}

// ---------------------------------------------------------------------------------------------
// Layer A — 5m Direction Strength
// ---------------------------------------------------------------------------------------------

export interface LayerAInput {
  candles5m: CandleData[];
  crossFeatures: { emaRatioFast: number; emaRatioSlow: number } | undefined;
  /** Recent, sided, swing-anchored structural break for BOTH directions (entry/detectors/structuralBreakRecent.ts), per candle. */
  structuralBreak: { LONG: { ageCandles: number } | null; SHORT: { ageCandles: number } | null };
  fractalN: number;
}

export interface LayerASideScore {
  score: number; // 0-100
  checksTrue: number;
  checksTotal: number;
  reasonCodes: string[];
}

export interface LayerAResult {
  direction: LayerADirection;
  score: number; // 0-100, of the winning (or tied-max) direction
  long: LayerASideScore;
  short: LayerASideScore;
}

function scoreSide(input: LayerAInput, side: Side): LayerASideScore {
  const { candles5m, crossFeatures, structuralBreak, fractalN } = input;
  const currentIndex = candles5m.length - 1;
  const reasonCodes: string[] = [];

  const structBreak = structuralBreak[side];
  const hasStructBreak = structBreak !== null;
  if (hasStructBreak) reasonCodes.push('STRUCTURAL_BREAK_SIDE');

  const emaAligned =
    crossFeatures !== undefined &&
    (side === 'LONG'
      ? crossFeatures.emaRatioFast > 1 + Ticket128Config.EMA_ALIGNMENT_TOLERANCE
      : crossFeatures.emaRatioFast < 1 - Ticket128Config.EMA_ALIGNMENT_TOLERANCE);
  if (emaAligned) reasonCodes.push('EMA_ALIGNED');

  const returnInAtr5m = computeReturnInAtr5m128(candles5m);
  const returnOk =
    returnInAtr5m !== undefined &&
    (side === 'LONG' ? returnInAtr5m >= Ticket128Config.RETURN_IN_ATR_MIN : returnInAtr5m <= -Ticket128Config.RETURN_IN_ATR_MIN);
  if (returnOk) reasonCodes.push('RETURN_IN_ATR_OK');

  const persistLookback = candles5m.slice(-Ticket128Config.MOMENTUM_PERSISTENCE_LOOKBACK);
  const agreeCount = persistLookback.filter((c) => candleDirection128(c) === (side === 'LONG' ? 'UP' : 'DOWN')).length;
  const persistenceOk = agreeCount >= Ticket128Config.MOMENTUM_PERSISTENCE_MIN_AGREE;
  if (persistenceOk) reasonCodes.push('MOMENTUM_PERSISTENCE');

  const hhHl = computeHhHlPattern(candles5m, fractalN);
  const structurePatternOk = side === 'LONG' ? hhHl === 'HH_HL' : hhHl === 'LL_LH';
  if (structurePatternOk) reasonCodes.push('STRUCTURE_PATTERN');

  const fresh = hasStructBreak && structBreak!.ageCandles <= Ticket128Config.STRUCTURAL_BREAK_FRESH_AGE_CANDLES;
  if (fresh) reasonCodes.push('STRUCTURE_FRESH');

  const flips = countDirectionFlips128(candles5m, Ticket128Config.CHOP_LOOKBACK_CANDLES);
  const notChoppy = flips < Ticket128Config.CHOP_MIN_FLIPS;
  if (notChoppy) reasonCodes.push('NOT_CHOPPY');

  const checksTrue = [hasStructBreak, emaAligned, returnOk, persistenceOk, structurePatternOk, fresh, notChoppy].filter(Boolean).length;
  const checksTotal = 7;
  void currentIndex;
  return { score: (checksTrue / checksTotal) * 100, checksTrue, checksTotal, reasonCodes };
}

export function computeLayerA(input: LayerAInput): LayerAResult {
  const long = scoreSide(input, 'LONG');
  const short = scoreSide(input, 'SHORT');
  let direction: LayerADirection;
  let score: number;
  if (long.score > short.score) {
    direction = 'BULLISH';
    score = long.score;
  } else if (short.score > long.score) {
    direction = 'BEARISH';
    score = short.score;
  } else {
    direction = 'NONE';
    score = long.score; // === short.score
  }
  return { direction, score, long, short };
}

/** Layer A score in the direction of a specific candidate's own side — the metric all ticket
 * cross-tabs bucket by (0-39/40-59/60-79/80-100), since what matters for a candidate is "how strong
 * is 5m FOR the side I'd actually trade", not which of LONG/SHORT abstractly scored higher. */
export function layerAScoreForSide(result: LayerAResult, side: Side): number {
  return side === 'LONG' ? result.long.score : result.short.score;
}

export function strengthBandOf(score: number): '0-39' | '40-59' | '60-79' | '80-100' {
  if (score < 40) return '0-39';
  if (score < 60) return '40-59';
  if (score < 80) return '60-79';
  return '80-100';
}

// ---------------------------------------------------------------------------------------------
// Layer B — 5m Market Quality (side-independent)
// ---------------------------------------------------------------------------------------------

export interface LayerBInput {
  candles5m: CandleData[];
  atrPercentile5m: number | undefined;
  bbWidthPercentile15m: number | undefined;
  volumeZScore5m: number | undefined;
  atrTrend5m: 'increasing' | 'decreasing' | 'flat' | undefined;
}

/**
 * Priority order (most-severe-first, mirrors regime/regimeDetector.ts's own decision-tree style):
 * SHOCK (danger-level abnormal) > COMPRESSION (quiet) > EXPANSION (strong directional push) >
 * CHOP (noisy, no edge) > CLEAN_TREND (fallback: none of the above strictly matched).
 */
export function computeLayerB(input: LayerBInput): LayerBQuality {
  const { candles5m, atrPercentile5m, bbWidthPercentile15m, volumeZScore5m, atrTrend5m } = input;

  if (atrPercentile5m === undefined || bbWidthPercentile15m === undefined || volumeZScore5m === undefined || atrTrend5m === undefined) {
    // Insufficient regime metrics — default to the most conservative "no clear quality read" label.
    return 'CHOP';
  }

  const isShock = volumeZScore5m >= Ticket128Config.SHOCK_VOLUME_ZSCORE_MIN || atrPercentile5m >= Ticket128Config.SHOCK_ATR_PCT_MIN;
  if (isShock) return 'SHOCK';

  const isCompression =
    bbWidthPercentile15m <= Ticket128Config.COMPRESSION_BBW_PCT_MAX &&
    atrPercentile5m <= Ticket128Config.COMPRESSION_ATR_PCT_MAX &&
    volumeZScore5m < Ticket128Config.COMPRESSION_VOLUME_ZSCORE_MAX;
  if (isCompression) return 'COMPRESSION';

  const isExpansion =
    atrTrend5m === 'increasing' && atrPercentile5m >= Ticket128Config.EXPANSION_ATR_PCT_MIN && volumeZScore5m >= Ticket128Config.EXPANSION_VOLUME_ZSCORE_MIN;
  if (isExpansion) return 'EXPANSION';

  const currentCandle = candles5m[candles5m.length - 1];
  const bodyRatio = bodyRatioOf128(currentCandle);
  const { upperWickRatio, lowerWickRatio } = wickRatios(currentCandle);
  const flips = countDirectionFlips128(candles5m, Ticket128Config.CHOP_LOOKBACK_CANDLES);
  const isChop = flips >= Ticket128Config.CHOP_MIN_FLIPS && Math.max(upperWickRatio, lowerWickRatio) >= Ticket128Config.CHOP_WICK_RATIO_MIN && bodyRatio < Ticket128Config.BODY_RATIO_STRONG;
  if (isChop) return 'CHOP';

  return 'CLEAN_TREND';
}

// ---------------------------------------------------------------------------------------------
// Layer C — Higher-Timeframe Context (15m/1H) vs the candidate's own side. DESCRIPTIVE ONLY.
// ---------------------------------------------------------------------------------------------

export interface LayerCInput {
  side: Side;
  adx1h: number | undefined;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
}

export function computeLayerC(input: LayerCInput): LayerCContext {
  const { side, adx1h, adxDirection1h, macroDirection } = input;

  if (adx1h === undefined || adxDirection1h === undefined || adxDirection1h === 'FLAT') return 'NEUTRAL';
  if (adx1h < Ticket128Config.HTF_ADX_NEUTRAL_MAX) return 'NEUTRAL';

  const oneHWith = (side === 'LONG' && adxDirection1h === 'UP') || (side === 'SHORT' && adxDirection1h === 'DOWN');
  if (oneHWith) return 'ALIGNED';

  // 1H direction is against the candidate's side, and adx1h >= HTF_ADX_NEUTRAL_MAX (some trend strength).
  if (adx1h < Ticket128Config.HTF_ADX_CONFIRMED_MIN) return 'CONFLICT_WEAK';

  const macroAgainst = macroDirection !== undefined && ((side === 'LONG' && macroDirection === 'DOWN') || (side === 'SHORT' && macroDirection === 'UP'));
  if (macroAgainst) return 'DANGER';
  return 'CONFLICT_STRONG';
}
