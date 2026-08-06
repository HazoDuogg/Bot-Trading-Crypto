/** TICKET-139: HTFContext = slow, higher-timeframe directional/structural state (1H ADX/DI, 15m BBW). */
export enum HTFContext {
  TREND_UP = 'TREND_UP',
  TREND_DOWN = 'TREND_DOWN',
  RANGE = 'RANGE',
  NEUTRAL = 'NEUTRAL',
}

/** TICKET-139: SafetyState5m = fast 5m danger/safety state (ATR pct, wick/sweep, volume, liquidity). */
export enum SafetyState5m {
  NORMAL = 'NORMAL',
  MANIPULATED = 'MANIPULATED',
  VOLATILE_CHOP = 'VOLATILE_CHOP',
  LOW_LIQUIDITY = 'LOW_LIQUIDITY',
  SHOCK = 'SHOCK',
}
