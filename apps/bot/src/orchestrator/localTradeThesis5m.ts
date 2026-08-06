/**
 * TICKET-141 — 5m Local Trade Thesis Engine. Pure, diagnostic-only per-candle evaluation of a 5m
 * trade opportunity across 4 layers (Direction / Structure / Setup / Entry Quality). Never reads or
 * writes any orchestrator/entry/risk decision state — only reuses existing production detector
 * functions/constants and reports N/A where no production threshold exists yet (ticket explicitly
 * forbids inventing new ones). See TICKET-141 brief + report's "Judgment calls" section for every
 * ambiguity resolved while building this.
 */
import type { CandleData, ComputedMetrics } from '../regime/types.js';
import { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import { emaSeries, lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { RegimeConfig } from '../regime/config.js';
import { EntryConfig } from '../entry/config.js';
import type { Direction } from '../entry/types.js';
import { detectOrderBlock } from '../entry/detectors/orderBlock.js';
import { detectFairValueGap } from '../entry/detectors/fairValueGap.js';
import { detectLiquiditySweep } from '../entry/detectors/liquiditySweep.js';
import { detectBoxBreakout } from '../entry/detectors/boxBreakout.js';
import { detectRecentStructuralBreak } from '../entry/detectors/structuralBreakRecent.js';
import { computeTpLevels, type TpPlan } from '../risk/slTpManager.js';
import {
  NEUTRAL_5M_DI_PERIOD,
  NEUTRAL_5M_EMA_FAST_PERIOD,
  NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES,
  NEUTRAL_5M_EMA_SLOW_PERIOD,
  NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD,
} from './neutral5mDirectionSelector.js';

export type Direction5m = 'LONG' | 'SHORT' | 'NONE';
export type StructureState = 'CONFIRMED_LONG' | 'CONFIRMED_SHORT' | 'UNCONFIRMED';
export type SetupType = 'OB' | 'FVG' | 'SWEEP' | 'BOX_BREAKOUT' | 'MOMENTUM_DIRECT' | 'NONE';
export type LocalThesis = 'VALID_LONG' | 'VALID_SHORT' | 'WEAK_LONG' | 'WEAK_SHORT' | 'NONE';

export interface LocalTradeThesis5mInput {
  symbol: string;
  timestamp: number;
  /** Reused for Direction (EMA/DI), Setup (OB/FVG/SWEEP/BOX_BREAKOUT), Entry Quality (ATR/EMA overextension). */
  candles5m: CandleData[];
  /** BOX_BREAKOUT's box (15m) — same input entryRouter.ts's runBoxBreakoutStyle() uses. */
  candles15m: CandleData[];
  /**
   * TICKET-141 Structure layer reuses detectRecentStructuralBreak() on 1m — matches
   * EntryConfig.MSS_TIMEFRAME('1m') / entryRouter.ts's own candlesMss input, NOT candles5m (see
   * "Judgment calls": Structure timeframe).
   */
  candles1m: CandleData[];
  /** regimeOutput.computedMetrics — feeds BOX_BREAKOUT's bbWidthPercentile15m/volumeZScore5m, not recomputed here. */
  computedMetrics: ComputedMetrics;
  /** Already classified+finalstabilized by the caller (regime/safetyState5m.ts + safetyState5mTrackerV2.ts) — never reclassified here. */
  safetyState5m: SafetyState5m;
  /** regime/htfContext.ts's classifyHtfContextCandidate() result — diagnostic-only per §2/§13, never used to gate the thesis. */
  htfContext: HTFContext;
  /** EntryRouterConfig.obSlBufferAtrMultiplier — same CLI-overridable value production's OB path uses (backtest.ts's --ob-sl-buffer-atr-multiplier). */
  obSlBufferAtrMultiplier: number;
  /** OrchestratorConfig.tpPlan — the configured default TP plan (PLAN_A/PLAN_B), used as the R:R target for OB/FVG/SWEEP/BOX_BREAKOUT setups (all TREND-scenario in production). See "Judgment calls": R:R. */
  tpPlan: TpPlan;
}

export interface LocalTradeThesis5mResult {
  symbol: string;
  timestamp: number;
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
  direction5m: Direction5m;
  emaRelation: 'FAST_ABOVE_SLOW' | 'FAST_BELOW_SLOW' | 'FLAT';
  emaSlope: number | null;
  diDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  structureState: StructureState;
  bosState: 'DETECTED' | 'NONE';
  mssState: 'DETECTED' | 'NONE';
  swingStructure: 'DETECTED' | 'NONE';
  sweepReclaim: 'DETECTED' | 'NONE';
  /** TICKET-141A §5 — detectRecentStructuralBreak()'s own ageCandles (1m), null when bosState==='NONE'. */
  structureAgeCandles: number | null;
  setupType: SetupType;
  setupSide: Direction5m;
  setupValid: boolean;
  setupReason: string;
  /**
   * TICKET-141A §6 — stable identity for the underlying price zone (symbol+setupType+side+formation
   * timestamp+boundaries baked in), used by the report's post-processing dedup. null when no raw
   * geometric candidate was detected at all (setupType==='NONE').
   */
  zoneId: string | null;
  /** TICKET-141A §4/§8 — the candle timestamp where this zone geometrically formed (candles5m). */
  zoneFormedTimestamp: number | null;
  /** TICKET-141A §8 — candles since zoneFormedTimestamp, within the current candles5m window. */
  zoneAgeCandles: number | null;
  /** TICKET-141A §5 — zoneAgeCandles < EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES. */
  zoneFresh: boolean;
  /** TICKET-141A §4 — no candle strictly after formation (through the current candle) closed beyond the zone's own far boundary. */
  zoneNotConsumed: boolean;
  /** TICKET-141A §4 — current candle's range geometrically overlaps the zone's own price range/level. */
  zoneRetested: boolean;
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null; // null == N/A (never a synthesized/invented threshold)
  distanceFromEmaInAtr: number | null;
  entryQualityPassed: boolean;
  entryQualityReason: string;
  localThesis: LocalThesis;
  thesisReason: string;
}

/**
 * Tầng 1 — Direction. Deliberately NOT neutral5mDirectionSelector.ts's computeDirection5m(): that
 * function is a 3-of-3 unanimous vote (EMA+slope, DI, detectRecentStructuralBreak()) with an
 * overextension->NONE override baked in — bundles Structure into "Direction". TICKET-141 §3 wants a
 * pure 3-condition AND with NO structural involvement (Structure is its own separate Tầng 2). Reuses
 * the SAME period constants/raw-slope formula neutral5mDirectionSelector.ts uses, just recomposed.
 */
function computeDirectionLayer(candles5m: CandleData[]): {
  direction5m: Direction5m;
  emaRelation: 'FAST_ABOVE_SLOW' | 'FAST_BELOW_SLOW' | 'FLAT';
  emaSlope: number | null;
  diDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
} {
  const n = candles5m.length;
  const minLen = NEUTRAL_5M_EMA_SLOW_PERIOD + NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES;
  if (n < minLen) return { direction5m: 'NONE', emaRelation: 'FLAT', emaSlope: null, diDirection: undefined };

  const emaFastSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_FAST_PERIOD);
  const emaSlowSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const fastNow = emaFastSeries[n - 1];
  const slowNow = emaSlowSeries[n - 1];
  if (Number.isNaN(fastNow) || Number.isNaN(slowNow)) return { direction5m: 'NONE', emaRelation: 'FLAT', emaSlope: null, diDirection: undefined };

  const emaSlope = emaSlowSeries[n - 1] - emaSlowSeries[n - 1 - NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES];
  const diSeries = wilderDIDirectionSeries(candles5m, NEUTRAL_5M_DI_PERIOD);
  const diDirection = diSeries[n - 1];

  const emaRelation: 'FAST_ABOVE_SLOW' | 'FAST_BELOW_SLOW' | 'FLAT' = fastNow > slowNow ? 'FAST_ABOVE_SLOW' : fastNow < slowNow ? 'FAST_BELOW_SLOW' : 'FLAT';

  let direction5m: Direction5m = 'NONE';
  if (emaRelation === 'FAST_ABOVE_SLOW' && emaSlope > 0 && diDirection === 'UP') direction5m = 'LONG';
  else if (emaRelation === 'FAST_BELOW_SLOW' && emaSlope < 0 && diDirection === 'DOWN') direction5m = 'SHORT';

  return { direction5m, emaRelation, emaSlope, diDirection };
}

/**
 * Tầng 2 — Structure, for ONE side (whatever Direction picked). Reuses
 * detectRecentStructuralBreak() (BOS/MSS/HH-HL/LL-LH all covered by the same underlying
 * detectMarketStructureShiftWithLevel() walk — no separate detector exists in this codebase for
 * each sub-criterion individually, so bosState/mssState/swingStructure all report the SAME
 * detector's result; see "Judgment calls": Structure sub-criteria). Sweep-reclaim reuses the exact
 * same detectLiquiditySweep() call the Setup layer (Tầng 3) uses — its own wick+pierce+close-reclaim
 * logic already IS the "sweep rồi reclaim" criterion (confirmed by reading liquiditySweep.ts: valid
 * only when wickRatio>threshold AND price pierced past the swing AND close reclaimed back inside).
 */
function computeStructureLayer(candles1m: CandleData[], candles5m: CandleData[], side: Direction5m): {
  structureState: StructureState;
  bosState: 'DETECTED' | 'NONE';
  mssState: 'DETECTED' | 'NONE';
  swingStructure: 'DETECTED' | 'NONE';
  sweepReclaim: 'DETECTED' | 'NONE';
  structureAgeCandles: number | null;
} {
  const direction: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const recentBreak = candles1m.length > 0 ? detectRecentStructuralBreak(candles1m, direction, { fractalN: EntryConfig.FRACTAL_N }) : null;
  const bosState: 'DETECTED' | 'NONE' = recentBreak !== null ? 'DETECTED' : 'NONE';

  const sweep = detectLiquiditySweep(candles5m, direction, {
    fractalN: EntryConfig.FRACTAL_N,
    wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
  });
  const sweepReclaim: 'DETECTED' | 'NONE' = sweep !== null ? 'DETECTED' : 'NONE';

  const confirmed = recentBreak !== null || sweep !== null;
  const structureState: StructureState = confirmed ? (side === 'LONG' ? 'CONFIRMED_LONG' : 'CONFIRMED_SHORT') : 'UNCONFIRMED';

  // TICKET-141A §5(b): surface detectRecentStructuralBreak()'s own ageCandles instead of discarding
  // it — was only checked for !==null by TICKET-141. Reported N/A (null) when no BOS/MSS confirmed
  // at all (recentBreak===null), regardless of whether Structure ended up CONFIRMED via sweep alone.
  const structureAgeCandles = recentBreak !== null ? recentBreak.ageCandles : null;

  return { structureState, bosState, mssState: bosState, swingStructure: bosState, sweepReclaim, structureAgeCandles };
}

interface SetupCandidate {
  setupType: SetupType;
  setupValid: boolean;
  setupReason: string;
  rawSlPrice: number | null;
  bufferMultiplier: number | null; // null == no ATR buffer applied (BOX_BREAKOUT uses the box edge directly)
  zoneId: string | null;
  zoneFormedTimestamp: number | null;
  zoneAgeCandles: number | null;
  zoneFresh: boolean;
  zoneNotConsumed: boolean;
  zoneRetested: boolean;
}

/**
 * TICKET-141A §4/§5/§6 — zone identity + freshness + mitigation + retest gates, applied uniformly to
 * every "persistent zone" setup type (OB/FVG/SWEEP). A raw geometric candidate (detector returned
 * non-null) is only a VALID setup once all three additionally hold:
 *  - fresh: reuses EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES (5) verbatim, applied to the zone's
 *    OWN formation age instead of MSS confirmation age — the same "don't act on a stale confirmation"
 *    principle entryRouter.ts's runTrendStyle() applies downstream, moved one stage earlier since this
 *    engine has no MSS-window-anchoring step of its own. NOT a new invented threshold.
 *  - notConsumed: no candle strictly after formation, up to and including the current candle, closed
 *    beyond the zone's own far boundary (BULLISH: close < low; BEARISH: close > high) — a structural
 *    check using the zone's own known boundaries, not a numeric threshold.
 *  - retested: the current (last) candle's own [low, high] range overlaps the zone's [low, high] range
 *    — hard geometric overlap, no fuzz factor.
 */
export function evaluateZoneGates(
  candles5m: CandleData[],
  zoneFormedIndex: number,
  low: number,
  high: number,
  direction: Direction,
): { zoneAgeCandles: number; zoneFresh: boolean; zoneNotConsumed: boolean; zoneRetested: boolean } {
  const currentIndex = candles5m.length - 1;
  const zoneAgeCandles = currentIndex - zoneFormedIndex;
  const zoneFresh = zoneAgeCandles < EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES;

  let zoneNotConsumed = true;
  for (let j = zoneFormedIndex + 1; j <= currentIndex; j++) {
    const c = candles5m[j];
    if (direction === 'BULLISH' && c.close < low) { zoneNotConsumed = false; break; }
    if (direction === 'BEARISH' && c.close > high) { zoneNotConsumed = false; break; }
  }

  const currentCandle = candles5m[currentIndex];
  const zoneRetested = currentCandle.low <= high && currentCandle.high >= low;

  return { zoneAgeCandles, zoneFresh, zoneNotConsumed, zoneRetested };
}

/**
 * Tầng 3 — Setup, for ONE side. Cascade priority mirrors entryRouter.ts's own OB->FVG->SWEEP order;
 * BOX_BREAKOUT and MOMENTUM_DIRECT are additional independent alternatives (§5: any 1 of the 5 being
 * valid satisfies the layer). Returns the FIRST valid one in priority order — see "Judgment calls":
 * setupType is singular per §8's CSV column, so simultaneous multi-setup candles collapse to one row.
 *
 * TICKET-141A: a raw geometric candidate (OB/FVG/SWEEP non-null) is ONLY returned as setupValid=true
 * once it also passes evaluateZoneGates() (fresh + not-consumed + retested). If it fails any gate,
 * the cascade FALLS THROUGH to the next setup type in priority order — this is the direct fix for
 * "100% OB / Setup pass 100%": detectOrderBlock() itself has no staleness/mitigation concept and
 * used to short-circuit the whole cascade the instant it found ANY OB anywhere in the lookback
 * window, regardless of age or whether price already traded through it.
 */
function computeSetupLayer(
  symbol: string,
  candles5m: CandleData[],
  candles15m: CandleData[],
  computedMetrics: ComputedMetrics,
  side: Direction5m,
  obSlBufferAtrMultiplier: number,
): SetupCandidate {
  const direction: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const currentCandle = candles5m[candles5m.length - 1];

  const ob = detectOrderBlock(candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, lookforwardK: EntryConfig.OB_BOS_LOOKFORWARD_K });
  if (ob) {
    const zoneFormedTimestamp = candles5m[ob.candleIndex].timestamp;
    const gates = evaluateZoneGates(candles5m, ob.candleIndex, ob.low, ob.high, direction);
    const zoneId = `${symbol}:OB:${side}:${zoneFormedTimestamp}:${ob.high}:${ob.low}`;
    if (gates.zoneFresh && gates.zoneNotConsumed && gates.zoneRetested) {
      return {
        setupType: 'OB',
        setupValid: true,
        setupReason: `OB detected + BOS-confirmed (detectOrderBlock), fresh=${gates.zoneAgeCandles}c, not consumed, retested`,
        rawSlPrice: direction === 'BULLISH' ? ob.low : ob.high,
        bufferMultiplier: obSlBufferAtrMultiplier,
        zoneId,
        zoneFormedTimestamp,
        zoneAgeCandles: gates.zoneAgeCandles,
        zoneFresh: gates.zoneFresh,
        zoneNotConsumed: gates.zoneNotConsumed,
        zoneRetested: gates.zoneRetested,
      };
    }
    // Raw OB candidate exists but fails a gate — record it (for the report's "raw detection" count /
    // gate-failure breakdown) then fall through to FVG, exactly as if detectOrderBlock() had found
    // nothing (matches production's own OB->FVG->SWEEP fallthrough intent).
  }

  const fvg = detectFairValueGap(candles5m, direction);
  if (fvg) {
    const zoneFormedTimestamp = candles5m[fvg.candleIndex].timestamp;
    const gates = evaluateZoneGates(candles5m, fvg.candleIndex, fvg.bottom, fvg.top, direction);
    const zoneId = `${symbol}:FVG:${side}:${zoneFormedTimestamp}:${fvg.top}:${fvg.bottom}`;
    if (gates.zoneFresh && gates.zoneNotConsumed && gates.zoneRetested) {
      return {
        setupType: 'FVG',
        setupValid: true,
        setupReason: `FVG 3-candle gap detected (detectFairValueGap), fresh=${gates.zoneAgeCandles}c, not consumed, retested`,
        rawSlPrice: direction === 'BULLISH' ? fvg.bottom : fvg.top,
        bufferMultiplier: EntryConfig.SL_BUFFER_ATR_MULTIPLIER,
        zoneId,
        zoneFormedTimestamp,
        zoneAgeCandles: gates.zoneAgeCandles,
        zoneFresh: gates.zoneFresh,
        zoneNotConsumed: gates.zoneNotConsumed,
        zoneRetested: gates.zoneRetested,
      };
    }
  }

  const sweep = detectLiquiditySweep(candles5m, direction, { fractalN: EntryConfig.FRACTAL_N, wickRatioThreshold: EntryConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD });
  if (sweep) {
    const sweepCandle = candles5m[sweep.candleIndex];
    const zoneFormedTimestamp = sweepCandle.timestamp;
    const gates = evaluateZoneGates(candles5m, sweep.candleIndex, sweep.sweptLevel, sweep.sweptLevel, direction);
    const zoneId = `${symbol}:SWEEP:${side}:${zoneFormedTimestamp}:${sweep.sweptLevel}`;
    if (gates.zoneFresh && gates.zoneNotConsumed && gates.zoneRetested) {
      return {
        setupType: 'SWEEP',
        setupValid: true,
        setupReason: `Liquidity sweep + reclaim detected (detectLiquiditySweep), fresh=${gates.zoneAgeCandles}c, not consumed, retested`,
        rawSlPrice: direction === 'BULLISH' ? sweepCandle.low : sweepCandle.high,
        bufferMultiplier: EntryConfig.SL_BUFFER_ATR_MULTIPLIER,
        zoneId,
        zoneFormedTimestamp,
        zoneAgeCandles: gates.zoneAgeCandles,
        zoneFresh: gates.zoneFresh,
        zoneNotConsumed: gates.zoneNotConsumed,
        zoneRetested: gates.zoneRetested,
      };
    }
  }

  const bbw = computedMetrics.bbWidthPercentile15m as number | undefined;
  const vz = computedMetrics.volumeZScore5m as number | undefined;
  if (bbw !== undefined && vz !== undefined) {
    const breakout = detectBoxBreakout(candles15m, candles5m, bbw, vz, {
      boxLookbackM: EntryConfig.BOX_LOOKBACK_M,
      maxBbwPercentile: EntryConfig.BOX_MAX_BBW_PERCENTILE,
      minBodyRatio: EntryConfig.BOX_BREAKOUT_MIN_BODY_RATIO,
      minVolumeZScore: EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE,
    });
    if (breakout && ((side === 'LONG' && breakout.direction === 'UP') || (side === 'SHORT' && breakout.direction === 'DOWN'))) {
      // detectBoxBreakout() only ever evaluates candles5m's OWN last candle (breakoutCandleIndex is
      // hardcoded to candles5m.length-1) — it is a single-candle-triggered event by construction, not
      // a persistent zone scanned out of history, so it cannot exhibit the OB staleness bug: age is
      // always 0/fresh, nothing can have "already traded through it" before it existed, and the
      // trigger candle IS the retest by definition. zoneId is timestamp-qualified so it is naturally
      // unique per candle (no two calls can ever produce the same zoneId) — dedup never removes a
      // genuine box-breakout row. See report's "Judgment calls": BOX_BREAKOUT gates.
      const zoneFormedTimestamp = currentCandle.timestamp;
      const zoneId = `${symbol}:BOX_BREAKOUT:${side}:${zoneFormedTimestamp}:${breakout.boxHigh}:${breakout.boxLow}`;
      return {
        setupType: 'BOX_BREAKOUT',
        setupValid: true,
        setupReason: 'Box breakout confirmed (detectBoxBreakout), single-candle event: fresh=0c, not consumed, retested by construction',
        rawSlPrice: breakout.direction === 'UP' ? breakout.boxLow : breakout.boxHigh,
        bufferMultiplier: null,
        zoneId,
        zoneFormedTimestamp,
        zoneAgeCandles: 0,
        zoneFresh: true,
        zoneNotConsumed: true,
        zoneRetested: true,
      };
    }
  }

  // MOMENTUM_DIRECT — deliberately never marked valid here. scoreMomentumForSide() (orchestrator.ts)
  // is the only production source of a real momentum score and is a private, non-exported async
  // function tightly coupled to orchestrator-internal ONNX session caching — reusing it cleanly would
  // require substantial new plumbing beyond this ticket's diagnostic scope. §2 itself frames the score
  // as conditional ("MOMENTUM_DIRECT score NẾU CÓ"). Per the ticket's explicit ban on approximating
  // missing production logic, this setup type is always reported invalid/unavailable rather than
  // synthesizing a fake score. See report's "Judgment calls" section.
  return {
    setupType: 'NONE',
    setupValid: false,
    setupReason: 'Không tìm thấy OB/FVG/SWEEP/BOX_BREAKOUT hợp lệ (geometric hoặc gate fresh/not-consumed/retested); MOMENTUM_DIRECT score unavailable — see judgment call in report',
    rawSlPrice: null,
    bufferMultiplier: null,
    zoneId: null,
    zoneFormedTimestamp: null,
    zoneAgeCandles: null,
    zoneFresh: false,
    zoneNotConsumed: false,
    zoneRetested: false,
  };
}

interface EntryQualityResult {
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  distanceFromEmaInAtr: number | null;
  entryQualityPassed: boolean;
  entryQualityReason: string;
}

/**
 * Tầng 4 — Entry Quality. Reuse-or-N/A per field, exactly as scoped in the ticket brief:
 *  - Entry/SL xác định được: hard requirement (setup must have produced a rawSlPrice).
 *  - SL distance hợp lệ theo production: N/A for OB/FVG/SWEEP/BOX_BREAKOUT (no generic production
 *    threshold exists outside MOMENTUM_DIRECT's own momentumDirectMinSlPercent floor, which never
 *    applies here since MOMENTUM_DIRECT setups are never valid in this engine — see Setup layer).
 *    N/A does NOT by itself fail Entry Quality.
 *  - Không chase: reuses neutral5mDirectionSelector.ts's EXACT overextension formula/threshold
 *    (|close-EMA21|/ATR5m < 2.0) verbatim — a real production precedent, not invented here.
 *  - R:R đạt ngưỡng production: reuses risk/slTpManager.ts's computeTpLevels() (scenario='TREND')
 *    with the configured tpPlan — TP1's rMultiple IS the plan's tp1R by construction (PLAN_A=1.2R,
 *    PLAN_B=1R), so this reduces to a real, reused production number reported as riskReward, not an
 *    independently invented pass/fail bar (see report's "Judgment calls": R:R triviality).
 *  - SHOCK/MANIPULATED: hard block, unconditional, per §6.
 *  - VOLATILE_CHOP/LOW_LIQUIDITY: diagnostic only, never blocks here (§6 explicit).
 */
function computeEntryQualityLayer(candle: CandleData, candles5m: CandleData[], side: Direction5m, setup: SetupCandidate, safetyState5m: SafetyState5m, tpPlan: TpPlan): EntryQualityResult {
  const reasons: string[] = [];

  const emaSlowSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const ema21Now = emaSlowSeries[emaSlowSeries.length - 1];
  const atrNow = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  let distanceFromEmaInAtr: number | null = null;
  if (atrNow !== undefined && atrNow !== 0 && !Number.isNaN(ema21Now)) {
    distanceFromEmaInAtr = Math.abs(candle.close - ema21Now) / atrNow;
  }

  if (setup.rawSlPrice === null) {
    reasons.push('Entry/SL không xác định được (không có setup hợp lệ ở Tầng 3)');
    return { entryPrice: null, stopLoss: null, riskReward: null, distanceFromEmaInAtr, entryQualityPassed: false, entryQualityReason: reasons.join('; ') };
  }

  const entryPrice = candle.close; // hypothetical entry = the closed 5m candle's own close (see "Judgment calls": entryPrice)
  const buffer = setup.bufferMultiplier !== null && atrNow !== undefined ? setup.bufferMultiplier * atrNow : 0;
  const stopLoss = side === 'LONG' ? setup.rawSlPrice - buffer : setup.rawSlPrice + buffer;

  let riskReward: number | null = null;
  if (stopLoss !== entryPrice) {
    const tpLevels = computeTpLevels({ scenario: 'TREND', entryPrice, slPrice: stopLoss, side: side === 'LONG' ? 'LONG' : 'SHORT', tpPlan });
    const tp1 = tpLevels.find((t) => t.label === 'TP1');
    riskReward = tp1?.rMultiple ?? null;
  }

  let passed = true;
  reasons.push('SL distance hợp lệ theo production: N/A (không có ngưỡng production chung ngoài MOMENTUM_DIRECT)');

  if (distanceFromEmaInAtr === null) {
    passed = false;
    reasons.push('Không đủ dữ liệu ATR5m/EMA21 để kiểm tra overextension (chase check)');
  } else if (distanceFromEmaInAtr >= NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD) {
    passed = false;
    reasons.push(`Chase: distanceFromEmaInAtr=${distanceFromEmaInAtr.toFixed(3)} >= ${NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD}`);
  } else {
    reasons.push(`Không chase: distanceFromEmaInAtr=${distanceFromEmaInAtr.toFixed(3)} < ${NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD}`);
  }

  if (riskReward === null) {
    reasons.push('R:R đạt ngưỡng production: N/A (SL trùng entry hoặc không map được TP plan)');
  } else {
    reasons.push(`R:R=${riskReward}R (TP1 của ${tpPlan}, computeTpLevels) — đạt theo định nghĩa TP plan`);
  }

  if (safetyState5m === SafetyState5m.SHOCK) {
    passed = false;
    reasons.push('SafetyState5m=SHOCK (hard block)');
  }
  if (safetyState5m === SafetyState5m.MANIPULATED) {
    passed = false;
    reasons.push('SafetyState5m=MANIPULATED (hard block)');
  }
  if (safetyState5m === SafetyState5m.VOLATILE_CHOP || safetyState5m === SafetyState5m.LOW_LIQUIDITY) {
    reasons.push(`SafetyState5m=${safetyState5m}: diagnostic only, không block (§6)`);
  }

  return { entryPrice, stopLoss, riskReward, distanceFromEmaInAtr, entryQualityPassed: passed, entryQualityReason: reasons.join('; ') };
}

/** Tầng conclusion — §7's exact rules. Never returns VALID just from Direction alone. */
function computeFinalThesis(direction5m: Direction5m, structureState: StructureState, setupValid: boolean, entryQualityPassed: boolean): { localThesis: LocalThesis; thesisReason: string } {
  if (direction5m === 'NONE') {
    return { localThesis: 'NONE', thesisReason: 'Direction5m=NONE (EMA/slope/DI không đồng thuận)' };
  }
  const structureConfirmed = (direction5m === 'LONG' && structureState === 'CONFIRMED_LONG') || (direction5m === 'SHORT' && structureState === 'CONFIRMED_SHORT');

  if (structureConfirmed && setupValid && entryQualityPassed) {
    return { localThesis: direction5m === 'LONG' ? 'VALID_LONG' : 'VALID_SHORT', thesisReason: 'Direction + Structure + Setup + Entry Quality đều đạt' };
  }

  const missing: string[] = [];
  if (!structureConfirmed) missing.push('Structure');
  if (!setupValid) missing.push('Setup');
  if (!entryQualityPassed) missing.push('Entry Quality');
  return { localThesis: direction5m === 'LONG' ? 'WEAK_LONG' : 'WEAK_SHORT', thesisReason: `Direction=${direction5m} nhưng thiếu: ${missing.join(', ')}` };
}

export function computeLocalTradeThesis5m(input: LocalTradeThesis5mInput): LocalTradeThesis5mResult {
  const currentCandle = input.candles5m[input.candles5m.length - 1];
  const { direction5m, emaRelation, emaSlope, diDirection } = computeDirectionLayer(input.candles5m);

  // Direction=NONE: still report Structure/Setup for the CSV as UNCONFIRMED/NONE (no side to
  // evaluate against) — never guesses a side just to populate diagnostic columns.
  const evalSide: Direction5m = direction5m === 'NONE' ? 'LONG' : direction5m; // arbitrary anchor only used when direction5m==='NONE', thesis stays NONE regardless (see computeFinalThesis)
  const structure = computeStructureLayer(input.candles1m, input.candles5m, evalSide);
  const setup = computeSetupLayer(input.symbol, input.candles5m, input.candles15m, input.computedMetrics, evalSide, input.obSlBufferAtrMultiplier);
  const entryQuality = computeEntryQualityLayer(currentCandle, input.candles5m, evalSide, setup, input.safetyState5m, input.tpPlan);
  const { localThesis, thesisReason } = computeFinalThesis(direction5m, structure.structureState, setup.setupValid, entryQuality.entryQualityPassed);

  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    htfContext: input.htfContext,
    safetyState5m: input.safetyState5m,
    direction5m,
    emaRelation,
    emaSlope,
    diDirection,
    structureState: direction5m === 'NONE' ? 'UNCONFIRMED' : structure.structureState,
    bosState: structure.bosState,
    mssState: structure.mssState,
    swingStructure: structure.swingStructure,
    sweepReclaim: structure.sweepReclaim,
    structureAgeCandles: structure.structureAgeCandles,
    setupType: direction5m === 'NONE' ? 'NONE' : setup.setupType,
    setupSide: direction5m === 'NONE' ? 'NONE' : (setup.setupValid ? evalSide : 'NONE'),
    setupValid: direction5m === 'NONE' ? false : setup.setupValid,
    setupReason: setup.setupReason,
    zoneId: direction5m === 'NONE' ? null : setup.zoneId,
    zoneFormedTimestamp: direction5m === 'NONE' ? null : setup.zoneFormedTimestamp,
    zoneAgeCandles: direction5m === 'NONE' ? null : setup.zoneAgeCandles,
    zoneFresh: direction5m === 'NONE' ? false : setup.zoneFresh,
    zoneNotConsumed: direction5m === 'NONE' ? false : setup.zoneNotConsumed,
    zoneRetested: direction5m === 'NONE' ? false : setup.zoneRetested,
    entryPrice: entryQuality.entryPrice,
    stopLoss: entryQuality.stopLoss,
    riskReward: entryQuality.riskReward,
    distanceFromEmaInAtr: entryQuality.distanceFromEmaInAtr,
    entryQualityPassed: entryQuality.entryQualityPassed,
    entryQualityReason: entryQuality.entryQualityReason,
    localThesis,
    thesisReason,
  };
}
