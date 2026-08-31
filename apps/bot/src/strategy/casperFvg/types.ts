export type CasperState =
  | 'UNINITIALIZED'
  | 'OR_BUILDING'
  | 'OR_LOCKED'
  | 'BULLISH_BREAKOUT'
  | 'BEARISH_BREAKOUT'
  | 'WINDOW_CLOSED'
  | 'INVALID_DATA';

export interface CasperCandle {
  startTimeMs: number;
  endTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OpeningRange {
  high: number;
  low: number;
}
