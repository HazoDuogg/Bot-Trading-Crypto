import type { CandleData } from '../regime/types.js';
import { HTFContext, SafetyState5m } from '../regime/htfSafetyTypes.js';
import { lastDefined, wilderATRSeries, zScoreSeries } from '../regime/indicators.js';
import type { Direction } from '../entry/types.js';
import { detectSwingPoints, latestSwingPointBefore } from '../entry/detectors/swingPoints.js';
import { detectLiquiditySweep } from '../entry/detectors/liquiditySweep.js';
import { detectMarketStructureShift } from '../entry/detectors/marketStructureShift.js';
import { ScalpConfig } from './config.js';

export type ScalpTimeframe = '15m' | '5m';

export interface SweepReversalEntryInput {
  symbol: string;
  /** Must end at "now" (last element = most recently closed candle). */
  candles15m: CandleData[];
  /** Must end at "now". */
  candles5m: CandleData[];
  /** 1m/3m per EntryConfig.MSS_TIMEFRAME, must end at "now" — same contract as entryRouter.ts's candlesMss. */
  candlesMss: CandleData[];
  htfContext: HTFContext;
  safetyState5m: SafetyState5m;
}

export interface SweepReversalSetup {
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: ScalpTimeframe;
  entryPrice: number;
  slPrice: number;
  tpPriceOverride: number;
  sweptLevel: number;
  timestamp: number;
}

const DIRECTION_TO_SIDE: Record<Direction, 'LONG' | 'SHORT'> = { BULLISH: 'LONG', BEARISH: 'SHORT' };

/**
 * Ticket §2 — "current price touches swing zone within a small ATR buffer". Checked against the
 * latest candle's low (BULLISH, sweeping a swing low) / high (BEARISH, sweeping a swing high)
 * against the nearest PRIOR swing of the matching type. A genuine sweep (§3) always satisfies
 * this trivially (crossing implies touching within any buffer >= 0) — this step exists to give
 * "no swing nearby" its own early exit, distinct from "swing nearby but wick too small".
 */
function touchesSwingZone(candles: CandleData[], direction: Direction, atr: number): boolean {
  const swings = detectSwingPoints(candles, ScalpConfig.FRACTAL_N);
  const currentIndex = candles.length - 1;
  const swingType = direction === 'BULLISH' ? 'LOW' : 'HIGH';
  const nearestSwing = latestSwingPointBefore(swings, swingType, currentIndex);
  if (nearestSwing === null) return false;

  const current = candles[currentIndex];
  const buffer = ScalpConfig.SWING_TOUCH_ATR_BUFFER_MULTIPLIER * atr;
  return direction === 'BULLISH' ? current.low <= nearestSwing.price + buffer : current.high >= nearestSwing.price - buffer;
}

/**
 * Ticket §6 (HTF veto) — reject only when the 1H trend is strong AND in the same direction as the
 * swept level's fake breakout, not the reversal we'd be taking. Sweeping a swing LOW means the
 * wick broke DOWN before reversing UP (LONG candidate) — that breakout direction is DOWN, so a
 * strong TREND_DOWN 1H context vetoes it (don't fade a real downtrend). Mirror for BEARISH/SHORT.
 */
function htfVetoes(direction: Direction, htfContext: HTFContext): boolean {
  return direction === 'BULLISH' ? htfContext === HTFContext.TREND_DOWN : htfContext === HTFContext.TREND_UP;
}

/**
 * TICKET-SCALP-003 Phần A — TP is a fixed R_MULTIPLE of THIS trade's real SL distance; margin (and
 * so actualRiskDollar) is fixed elsewhere (scripts/scalpBacktest.ts), not derived from this.
 */
function computeScalpTpPriceOverride(entryPrice: number, slPrice: number, side: 'LONG' | 'SHORT'): number {
  const slDistancePercent = Math.abs(entryPrice - slPrice) / entryPrice;
  const tpDistancePercent = slDistancePercent * ScalpConfig.R_MULTIPLE;
  const direction = side === 'LONG' ? 1 : -1;
  return entryPrice + direction * tpDistancePercent * entryPrice;
}

/**
 * Ticket §1-6 pipeline for one timeframe/direction combination. Returns null the moment any step
 * fails — "không qua được bước nào ở trên -> không có setup, không ép" (ticket §7).
 */
function evaluateSweepReversal(
  candles: CandleData[],
  timeframe: ScalpTimeframe,
  direction: Direction,
  atr5m: number,
  minSlDistancePercent: number,
  input: Pick<SweepReversalEntryInput, 'symbol' | 'candlesMss' | 'htfContext' | 'safetyState5m'>,
): SweepReversalSetup | null {
  if (input.safetyState5m !== SafetyState5m.NORMAL) return null; // §6
  if (htfVetoes(direction, input.htfContext)) return null; // §6

  if (!touchesSwingZone(candles, direction, atr5m)) return null; // §2

  // TICKET-SCALP-002 Bug 1 fix: requiring the sweep to be literally the current candle left MSS
  // (§5) with an always-empty window (nothing in candlesMss is ever timestamped >= "now"), so §5
  // never confirmed on the 5m branch. Freshness is enforced by §5's own staleness check instead —
  // same convention entryRouter.ts already uses for its own SWEEP setups.
  const sweep = detectLiquiditySweep(candles, direction, {
    fractalN: ScalpConfig.FRACTAL_N,
    wickRatioThreshold: ScalpConfig.LIQUIDITY_SWEEP_WICK_RATIO_THRESHOLD,
  });
  if (sweep === null) return null; // §3

  // Z-score AT THE SWEEP CANDLE specifically — sweep.candleIndex is no longer always the last
  // candle after the Bug 1 fix above, so lastDefined() (last-in-array) would read the wrong candle.
  const volumeSeries = candles.map((c) => c.volume);
  const volumeZScore = zScoreSeries(volumeSeries, ScalpConfig.VOLUME_ZSCORE_LOOKBACK)[sweep.candleIndex];
  if (Number.isNaN(volumeZScore) || volumeZScore < ScalpConfig.VOLUME_EXPANSION_ZSCORE_MIN) return null; // §4

  const sweepTimestamp = candles[sweep.candleIndex].timestamp;
  const mssWindow = input.candlesMss.filter((c) => c.timestamp >= sweepTimestamp);
  const mssConfirmedIndex = detectMarketStructureShift(mssWindow, direction, { fractalN: ScalpConfig.FRACTAL_N });
  if (mssConfirmedIndex === null) return null; // §5

  const candlesFromEnd = mssWindow.length - 1 - mssConfirmedIndex;
  if (candlesFromEnd >= ScalpConfig.MSS_STALENESS_TOLERANCE_CANDLES) return null; // §5

  const side = DIRECTION_TO_SIDE[direction];
  const entryPrice = mssWindow[mssConfirmedIndex].close;

  const rawSlPrice = direction === 'BULLISH' ? candles[sweep.candleIndex].low : candles[sweep.candleIndex].high;
  const buffer = ScalpConfig.SL_BUFFER_ATR_MULTIPLIER * atr5m;
  const slPrice = direction === 'BULLISH' ? rawSlPrice - buffer : rawSlPrice + buffer;

  // TICKET-SCALP-003 Phần B — SL too close to entry is more prone to random noise sweeping it.
  if (Math.abs(entryPrice - slPrice) / entryPrice < minSlDistancePercent) return null;

  return {
    symbol: input.symbol,
    side,
    timeframe,
    entryPrice,
    slPrice,
    tpPriceOverride: computeScalpTpPriceOverride(entryPrice, slPrice, side),
    sweptLevel: sweep.sweptLevel,
    timestamp: mssWindow[mssConfirmedIndex].timestamp,
  };
}

/**
 * TICKET-SCALP-001 — module entry point. Checks 15m and 5m swing points identically ("bất kỳ
 * khung nào ra kết quả đều xét, không ưu tiên khung nào" — ticket §1); the [15m, 5m] x
 * [BULLISH, BEARISH] iteration order below is for determinism only, not a priority ranking.
 * Returns the first combination that clears every step, or null if none does.
 */
export function detectSweepReversalEntry(
  input: SweepReversalEntryInput,
  minSlDistancePercent: number = ScalpConfig.MIN_SL_DISTANCE_PERCENT,
): SweepReversalSetup | null {
  const atr5m = lastDefined(wilderATRSeries(input.candles5m, ScalpConfig.ATR_PERIOD_5M));
  if (atr5m === undefined) return null; // not enough 5m history to size any buffer

  const timeframeCandles: Array<[ScalpTimeframe, CandleData[]]> = [
    ['15m', input.candles15m],
    ['5m', input.candles5m],
  ];
  const directions: Direction[] = ['BULLISH', 'BEARISH'];

  for (const [timeframe, candles] of timeframeCandles) {
    for (const direction of directions) {
      const setup = evaluateSweepReversal(candles, timeframe, direction, atr5m, minSlDistancePercent, input);
      if (setup !== null) return setup;
    }
  }
  return null;
}
