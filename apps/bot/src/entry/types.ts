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

