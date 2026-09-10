export type Side = "LONG" | "SHORT";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type RegimeState = "UPTREND" | "DOWNTREND" | "SIDEWAY" | "DANGER_ZONE";

export interface RegimeSnapshot {
  state: RegimeState;
  detectedAt: number;
}

export interface DirectionBias {
  side: Side | "NEUTRAL";
  confidence: number;
}

export interface EntrySignal {
  side: Side;
  price: number;
  reason: string;
  detectedAt: number;
}

export interface TradePlan {
  side: Side;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  size: number;
}

export interface Position {
  side: Side;
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
}
