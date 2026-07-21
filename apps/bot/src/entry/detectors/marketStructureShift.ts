import type { CandleData } from '../../regime/types.js';
import type { Direction } from '../types.js';
import { detectSwingPoints } from './swingPoints.js';

export interface MssConfig {
  fractalN: number;
}

/** TICKET-043 — granular reason detectMarketStructureShift() found no confirmation, for funnel reporting only. */
export type MssFailReason = 'NO_HIGHER_LOW_PATTERN' | 'NO_REFERENCE_BETWEEN' | 'NEVER_BROKE_REFERENCE';

/**
 * B.4 — confirms a reversal on a smaller timeframe (1m/3m) before entry. Caller passes only the
 * candles since the 5m setup (OB/FVG/Sweep) formed; returns the index (in `candles`) of the
 * candle whose close confirmed the mini-BOS, or null if not confirmed yet in the given window.
 *
 * TICKET-009: reference point is the swing that already exists BETWEEN the two lows/highs being
 * compared (closest one to the later low/high), not one that forms after — enters sooner, at the
 * cost of more false signals. Intentional per PM: SL is already tight (0.1×ATR), so a false entry
 * costs little while a real move is caught earlier.
 * BULLISH: higher-low (lows[k] > lows[k-1]), referenceHigh = highest-index swing high with
 *   lows[k-1].index < index < lows[k].index, then close > referenceHigh.price after lows[k].index.
 * BEARISH: mirror — lower-high, referenceLow between the two highs, then close < referenceLow.price.
 */
export function detectMarketStructureShift(candles: CandleData[], direction: Direction, config: MssConfig): number | null {
  const swings = detectSwingPoints(candles, config.fractalN);

  if (direction === 'BULLISH') {
    const lows = swings.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);
    const highs = swings.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
    for (let k = 1; k < lows.length; k++) {
      if (lows[k].price <= lows[k - 1].price) continue; // not a higher-low
      const between = highs.filter((h) => h.index > lows[k - 1].index && h.index < lows[k].index);
      if (between.length === 0) continue; // no reference high formed between these two lows
      const referenceHigh = between.reduce((closest, h) => (h.index > closest.index ? h : closest));
      for (let j = lows[k].index + 1; j < candles.length; j++) {
        if (candles[j].close > referenceHigh.price) return j;
      }
    }
    return null;
  }

  const highs = swings.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
  const lows = swings.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);
  for (let k = 1; k < highs.length; k++) {
    if (highs[k].price >= highs[k - 1].price) continue; // not a lower-high
    const between = lows.filter((l) => l.index > highs[k - 1].index && l.index < highs[k].index);
    if (between.length === 0) continue; // no reference low formed between these two highs
    const referenceLow = between.reduce((closest, l) => (l.index > closest.index ? l : closest));
    for (let j = highs[k].index + 1; j < candles.length; j++) {
      if (candles[j].close < referenceLow.price) return j;
    }
  }
  return null;
}

/**
 * TICKET-043 — read-only diagnostic mirroring detectMarketStructureShift()'s own walk, called ONLY
 * for funnel reporting when that function has already returned null. Never used to decide anything;
 * duplicates the same pattern/reference conditions so its "found" flags match what the real walk
 * saw, without altering detectMarketStructureShift() itself.
 */
export function classifyMssFailReason(candles: CandleData[], direction: Direction, config: MssConfig): MssFailReason {
  const swings = detectSwingPoints(candles, config.fractalN);
  let foundPattern = false;
  let foundReference = false;

  if (direction === 'BULLISH') {
    const lows = swings.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);
    const highs = swings.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
    for (let k = 1; k < lows.length; k++) {
      if (lows[k].price <= lows[k - 1].price) continue;
      foundPattern = true;
      const between = highs.filter((h) => h.index > lows[k - 1].index && h.index < lows[k].index);
      if (between.length === 0) continue;
      foundReference = true;
    }
  } else {
    const highs = swings.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
    const lows = swings.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);
    for (let k = 1; k < highs.length; k++) {
      if (highs[k].price >= highs[k - 1].price) continue;
      foundPattern = true;
      const between = lows.filter((l) => l.index > highs[k - 1].index && l.index < highs[k].index);
      if (between.length === 0) continue;
      foundReference = true;
    }
  }

  if (!foundPattern) return 'NO_HIGHER_LOW_PATTERN';
  if (!foundReference) return 'NO_REFERENCE_BETWEEN';
  return 'NEVER_BROKE_REFERENCE';
}
