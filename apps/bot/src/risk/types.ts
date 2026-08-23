export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Direction = 'LONG' | 'SHORT';
export type EntryStrategy = 'TREND_PULLBACK' | 'RANGE_TRADING' | 'BREAKOUT_WATCH';

export interface SlInput {
  strategy: EntryStrategy;
  direction: Direction;
  entryPrice: number;
  m5Candles: Candle[]; // used by TREND_PULLBACK to find the nearest swing low/high
  swingPivotWidth: number; // must match the width used elsewhere (regime/entry modules) for consistency
  rangeLevel?: number; // required for RANGE_TRADING: the support/resistance level being traded from
  brokenLevel?: number; // required for BREAKOUT_WATCH: detectBos()'s brokenLevel
  atrM5: number;
}

export interface SlConfig {
  rangeBufferAtrMultiplier: number; // per spec section 3, strategy 2: 0.2-0.3x ATR
  breakoutBufferAtrMultiplier: number; // per spec section 3, strategy 3: buffer near the broken level
}

// TODO_CONFIRM: doc gives 0.2-0.3x ATR as a range for strategy 2; breakoutBufferAtrMultiplier has no doc number at all.
// Real R:R semantics: idealTpPrice is solved so net R:R (after cost) = targetRMultiple exactly; passesThreshold
// only turns false when a resistance/support zone caps TP short of that ideal level (see rrCalculator.ts).
export const DEFAULT_SL_CONFIG: SlConfig = {
  rangeBufferAtrMultiplier: 0.25,
  breakoutBufferAtrMultiplier: 0.25,
};

export interface SlResult {
  slPrice: number;
  distance: number; // always positive
}

export interface FeeConfig {
  takerFeePct: number; // per side, e.g. 0.05 = 0.05%
  slippagePct: number; // per side
}

// takerFeePct: Binance USDT-M Futures taker fee as of Aug 2026 (confirmed via web search).
// slippagePct: TODO_CONFIRM — assumed, not measured from real testnet fills yet.
export const DEFAULT_FEE_CONFIG: FeeConfig = {
  takerFeePct: 0.05,
  slippagePct: 0.05,
};

export interface RrInput {
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  targetRMultiple: number; // 3, per spec
  feeConfig?: FeeConfig;
  cappedTpPrice?: number; // optional: nearest resistance/support zone that may limit TP short of the ideal level
}

export interface RrResult {
  slDistance: number;
  idealTpPrice: number; // the cost-adjusted price that yields exactly targetRMultiple net R:R, unconstrained
  tpPrice: number; // idealTpPrice, or cappedTpPrice if a nearby zone is tighter than that
  netRMultiple: number; // net R:R actually realized at tpPrice
  passesThreshold: boolean; // netRMultiple >= targetRMultiple — false only when a resistance/support cap forces a shorter TP
}
