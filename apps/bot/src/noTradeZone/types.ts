export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type NoTradeReason =
  | 'news_risk'
  | 'spread_too_high'
  | 'volatility_extreme'
  | 'shock_event'
  | 'pump_dump_flag';

export interface NoTradeZoneResult {
  blocked: boolean;
  reasons: NoTradeReason[];
}

export interface NoTradeZoneConfig {
  spreadPctThreshold: number;
  atrRatioThreshold: number;
  h1RangePctThreshold: number;
  shockEventPctThreshold: number;
  pumpDumpMinConsecutive: number;
  pumpDumpAtrMultiplier: number;
  pumpDumpVolumeSpikeMultiplier: number;
}

// TODO_CONFIRM: all thresholds below are doc-range midpoints, not yet backtest-calibrated.
export const DEFAULT_NO_TRADE_ZONE_CONFIG: NoTradeZoneConfig = {
  spreadPctThreshold: 0.075,
  atrRatioThreshold: 1.75,
  h1RangePctThreshold: 4,
  shockEventPctThreshold: 7.5,
  pumpDumpMinConsecutive: 6,
  pumpDumpAtrMultiplier: 1.75,
  pumpDumpVolumeSpikeMultiplier: 2,
};
