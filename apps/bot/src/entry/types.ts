export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Direction = 'LONG' | 'SHORT';

export interface PinBarResult {
  isPinBar: boolean;
  direction?: Direction;
}

export interface PinBarConfig {
  minWickToBodyRatio: number;
  maxBodyToRangeRatio: number;
  closeZoneRatio: number; // close must land in the outer this-fraction of the range
}

// Values as specified by Vinh Tam: 2:1 wick:body is standard price-action practice.
export const DEFAULT_PIN_BAR_CONFIG: PinBarConfig = {
  minWickToBodyRatio: 2,
  maxBodyToRangeRatio: 0.3,
  closeZoneRatio: 1 / 3,
};

export interface EngulfingResult {
  isEngulfing: boolean;
  direction?: Direction;
}

export interface BosResult {
  isBos: boolean;
  direction?: Direction;
  brokenLevel?: number;
}

export interface BosConfig {
  swingPivotWidth: number;
  confirmationCandles: number;
  minBreakoutAtrMultiplier: number;
  atrPeriod: number;
  maxSwingAgeCandles: number; // swing points older than this (candles before the break) are ignored as stale
}

// TODO_CONFIRM: calibrated against real BTCUSDT M15 data — confirmationCandles/minBreakoutAtrMultiplier/maxSwingAgeCandles
// tuned to land BOS event frequency at ~5.3% of candles (~5/day), matching Vinh Tam's 5-10% target range. Still not
// backtest-calibrated against the full strategy; re-verify once real M5 data and the full entry pipeline exist.
export const DEFAULT_BOS_CONFIG: BosConfig = {
  swingPivotWidth: 2,
  confirmationCandles: 3,
  minBreakoutAtrMultiplier: 0.3,
  atrPeriod: 14,
  maxSwingAgeCandles: 25,
};
