import type { CandleData } from '../../regime/types.js';
import type { BoxBreakout } from '../types.js';

export interface BoxBreakoutConfig {
  boxLookbackM: number;
  maxBbwPercentile: number;
  minBodyRatio: number;
  minVolumeZScore: number;
}

/**
 * B.5 — shared by SIDEWAY_SCALPER and COMPRESSION (COMPRESSION just calls this every candle in
 * "armed" mode and gets null until a real breakout happens). Box = [min(low), max(high)] over the
 * trailing `boxLookbackM` 15m candles; only valid if bbWidthPercentile15m (from regime/, not
 * recomputed) is <= maxBbwPercentile. Breakout confirmed on the latest 5m candle only if ALL 3:
 * (a) close clears the box edge, (b) body is a real push (not a wick), (c) volume is elevated.
 * A wick-only poke past the edge does NOT confirm (fails (a), since (a) checks close not high/low).
 */
export function detectBoxBreakout(
  candles15m: CandleData[],
  candles5m: CandleData[],
  bbWidthPercentile15m: number,
  volumeZScore5m: number,
  config: BoxBreakoutConfig,
): BoxBreakout | null {
  if (candles15m.length < config.boxLookbackM || candles5m.length === 0) return null;
  if (bbWidthPercentile15m > config.maxBbwPercentile) return null;

  const window = candles15m.slice(-config.boxLookbackM);
  const boxHigh = Math.max(...window.map((c) => c.high));
  const boxLow = Math.min(...window.map((c) => c.low));

  const breakoutCandleIndex = candles5m.length - 1;
  const candle = candles5m[breakoutCandleIndex];
  const range = candle.high - candle.low;
  if (range === 0) return null;
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  if (bodyRatio < config.minBodyRatio || volumeZScore5m <= config.minVolumeZScore) return null;

  if (candle.close > boxHigh) return { direction: 'UP', boxHigh, boxLow, breakoutCandleIndex };
  if (candle.close < boxLow) return { direction: 'DOWN', boxHigh, boxLow, breakoutCandleIndex };
  return null;
}

/** TICKET-053 — granular reason detectBoxBreakout() found no confirmation, for funnel reporting only. */
export type BoxBreakoutFailReason = 'NO_EDGE_TOUCH' | 'BODY_TOO_SMALL' | 'VOLUME_NOT_ELEVATED';

/**
 * TICKET-053 — read-only diagnostic mirroring detectBoxBreakout()'s own box/edge computation, called
 * ONLY for funnel reporting when that function has already returned null. Never used to decide
 * anything; never alters detectBoxBreakout() itself or any of its thresholds.
 *
 * Classifies in the PM-specified priority order (edge touch -> body size -> volume), which is a
 * reporting-only convention distinct from detectBoxBreakout()'s own (equivalent, order-independent
 * since it's a conjunction) short-circuit evaluation order.
 */
export function classifyBoxBreakoutFailReason(
  candles15m: CandleData[],
  candles5m: CandleData[],
  bbWidthPercentile15m: number,
  volumeZScore5m: number,
  config: BoxBreakoutConfig,
): BoxBreakoutFailReason {
  // Box itself never formed/valid (not enough 15m history, or too wide to trade) -> no edge to touch.
  if (candles15m.length < config.boxLookbackM || candles5m.length === 0 || bbWidthPercentile15m > config.maxBbwPercentile) {
    return 'NO_EDGE_TOUCH';
  }

  const window = candles15m.slice(-config.boxLookbackM);
  const boxHigh = Math.max(...window.map((c) => c.high));
  const boxLow = Math.min(...window.map((c) => c.low));

  const candle = candles5m[candles5m.length - 1];
  if (!(candle.close > boxHigh || candle.close < boxLow)) return 'NO_EDGE_TOUCH';

  const range = candle.high - candle.low;
  const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0; // range===0 -> no real push possible
  if (bodyRatio < config.minBodyRatio) return 'BODY_TOO_SMALL';

  return 'VOLUME_NOT_ELEVATED'; // edge cleared + body real -> the only remaining reason detectBoxBreakout() returned null
}
