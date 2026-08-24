import type { Candle, Direction } from './types.js';
import { findSwingPoints } from '../regime/swingPoints.js';

export interface PullbackZoneInput {
  direction: Direction;
  entryPrice: number;
  m15Candles: Candle[];
  swingPivotWidth: number;
  atrM5: number;
  toleranceAtrMultiplier: number;
}

export interface PullbackZoneResult {
  valid: boolean;
  nearestZonePrice: number | null;
  distanceAtr: number | null;
}

export interface PullbackZoneConfig {
  toleranceAtrMultiplier: number;
}

// TODO_CONFIRM: not backtest-calibrated yet — TICKET-RT-019 flags this for a follow-up sweep
// (0.3/0.5/0.75/1.0x ATR) once the base filter's impact on outcome distribution is measured.
export const DEFAULT_PULLBACK_ZONE_CONFIG: PullbackZoneConfig = {
  toleranceAtrMultiplier: 0.5,
};

// Per spec (Chien_luoc_giao_dich_khung_M5, Phan IV muc 1.1): TREND_PULLBACK requires price to have
// pulled back to a real M15 support/resistance zone before a candlestick signal counts. LONG checks
// distance to the MOST RECENT confirmed M15 swing low; SHORT checks the most recent swing high —
// "most recent", not "nearest by price", matching this codebase's existing convention for "the level
// being traded from" (slCalculator.ts's slFromTrendPullback picks the same way).
export function checkPullbackZone(input: PullbackZoneInput): PullbackZoneResult {
  if (input.atrM5 <= 0) return { valid: false, nearestZonePrice: null, distanceAtr: null };

  const swings = findSwingPoints(input.m15Candles, input.swingPivotWidth);
  const relevant = swings.filter((p) => (input.direction === 'LONG' ? p.type === 'low' : p.type === 'high'));
  if (relevant.length === 0) return { valid: false, nearestZonePrice: null, distanceAtr: null };

  const zone = relevant[relevant.length - 1];
  const distanceAtr = Math.abs(input.entryPrice - zone.price) / input.atrM5;

  return {
    valid: distanceAtr <= input.toleranceAtrMultiplier,
    nearestZonePrice: zone.price,
    distanceAtr,
  };
}
