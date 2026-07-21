import type { CandleData } from '../../regime/types.js';
import type { BoxBreakout } from '../types.js';

export interface BoxBreakoutConfig {
  boxLookbackM: number;
  maxBbwPercentile: number;
  minBodyRatio: number;
  minVolumeZScore: number;
}

export interface Box {
  boxHigh: number;
  boxLow: number;
}

/**
 * Box = [min(low), max(high)] over the trailing `boxLookbackM` 15m candles. Shared by
 * detectBoxBreakout() below and detectBoxBounce() (TICKET-047) — the ONE place this calculation
 * lives, never re-derived elsewhere.
 */
export function computeBox(candles15m: CandleData[], boxLookbackM: number): Box | null {
  if (candles15m.length < boxLookbackM) return null;
  const window = candles15m.slice(-boxLookbackM);
  return { boxHigh: Math.max(...window.map((c) => c.high)), boxLow: Math.min(...window.map((c) => c.low)) };
}

/**
 * B.5 — shared by SIDEWAY_SCALPER and COMPRESSION (COMPRESSION just calls this every candle in
 * "armed" mode and gets null until a real breakout happens). Box computed by computeBox() above;
 * only valid if bbWidthPercentile15m (from regime/, not recomputed) is <= maxBbwPercentile.
 * Breakout confirmed on the latest 5m candle only if ALL 3: (a) close clears the box edge, (b) body
 * is a real push (not a wick), (c) volume is elevated. A wick-only poke past the edge does NOT
 * confirm (fails (a), since (a) checks close not high/low).
 */
export function detectBoxBreakout(
  candles15m: CandleData[],
  candles5m: CandleData[],
  bbWidthPercentile15m: number,
  volumeZScore5m: number,
  config: BoxBreakoutConfig,
): BoxBreakout | null {
  if (candles5m.length === 0) return null;
  if (bbWidthPercentile15m > config.maxBbwPercentile) return null;

  const box = computeBox(candles15m, config.boxLookbackM);
  if (box === null) return null;
  const { boxHigh, boxLow } = box;

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
