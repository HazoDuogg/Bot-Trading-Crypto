export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TrendState = 'UPTREND' | 'DOWNTREND' | 'SIDEWAY';

export interface RegimeResult {
  state: TrendState;
  emaSlopePct: number; // % change of EMA200 vs 20 candles ago
  priceAboveEma: boolean;
}

export type SwingType = 'high' | 'low';

export interface SwingPoint {
  index: number; // index into the candles array
  price: number;
  type: SwingType;
}

export interface RegimeConfig {
  emaPeriod: number;
  slopeLookback: number;
  slopeFlatThresholdPct: number; // below this abs% = "flat" slope
  swingPivotWidth: number; // candles required on each side to confirm a swing point
}

// TODO_CONFIRM: doc gives no numeric slope/swing threshold; these are reasonable defaults, not backtest-calibrated.
export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  emaPeriod: 200,
  slopeLookback: 20,
  slopeFlatThresholdPct: 0.5,
  swingPivotWidth: 2,
};
