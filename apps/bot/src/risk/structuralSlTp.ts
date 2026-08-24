import { findSwingPoints } from '../regime/swingPoints.js';
import type { Candle } from '../regime/types.js';

export type Direction = 'LONG' | 'SHORT';

export interface StructuralSlTpInput {
  direction: Direction;
  entryPrice: number;
  m5Candles: Candle[];
  swingPivotWidth: number;
  minSlPctFloor: number; // TODO_CONFIRM
}

export interface StructuralSlTpResult {
  slPrice: number;
  tpPrice: number;
  rMultiple: number; // measured only — NOT used to reject in this first version
}

// Chien luoc 1: SL/TP both read on M5 structure (per the video: both the SL step and the TP step
// show the "· 5" chart, not H1). No partial TP — a single TP.
//
// "Nearest" per the ticket is qualified by side: the nearest swing LOW *below* entry (for LONG's
// SL) and the nearest swing HIGH *above* entry (for LONG's TP) — i.e. nearest-by-price among swings
// on the correct side of entry, not "most recent chronologically" like the old slCalculator.ts's
// slFromTrendPullback. A swing on the wrong side of entry (e.g. a "low" that's actually above the
// current price) can't be a stop-loss floor or take-profit ceiling, so it's excluded outright.
export function calculateStructuralSlTp(input: StructuralSlTpInput): StructuralSlTpResult | null {
  const swings = findSwingPoints(input.m5Candles, input.swingPivotWidth);
  const lows = swings.filter((p) => p.type === 'low');
  const highs = swings.filter((p) => p.type === 'high');

  let slPrice: number | null;
  let tpPrice: number | null;

  if (input.direction === 'LONG') {
    slPrice = nearestBelow(lows.map((p) => p.price), input.entryPrice);
    tpPrice = nearestAbove(highs.map((p) => p.price), input.entryPrice);
  } else {
    slPrice = nearestAbove(highs.map((p) => p.price), input.entryPrice);
    tpPrice = nearestBelow(lows.map((p) => p.price), input.entryPrice);
  }

  if (slPrice === null || tpPrice === null) return null;

  const slDistance = Math.abs(input.entryPrice - slPrice);
  if (slDistance <= 0) return null;

  const slPct = (slDistance / input.entryPrice) * 100;
  if (slPct < input.minSlPctFloor) return null;

  const tpDistance = Math.abs(tpPrice - input.entryPrice);
  const rMultiple = tpDistance / slDistance;

  return { slPrice, tpPrice, rMultiple };
}

function nearestBelow(prices: number[], entryPrice: number): number | null {
  const candidates = prices.filter((p) => p < entryPrice);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function nearestAbove(prices: number[], entryPrice: number): number | null {
  const candidates = prices.filter((p) => p > entryPrice);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
