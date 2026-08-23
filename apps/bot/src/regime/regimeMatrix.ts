import type { RegimeMatrixResult, TrendState } from './types.js';

// Routes H1+M15 regime combination to a strategy, per spec section 2's 9-cell matrix.
export function routeRegimeMatrix(h1: TrendState, m15: TrendState): RegimeMatrixResult {
  if (h1 === 'UPTREND' && m15 === 'UPTREND') return { strategy: 'TREND_PULLBACK', direction: 'LONG' };
  if (h1 === 'DOWNTREND' && m15 === 'DOWNTREND') return { strategy: 'TREND_PULLBACK', direction: 'SHORT' };
  if (h1 === 'SIDEWAY' && m15 === 'SIDEWAY') return { strategy: 'RANGE_TRADING' };
  if (h1 === 'UPTREND' && m15 === 'SIDEWAY') return { strategy: 'BREAKOUT_WATCH', direction: 'LONG' };
  if (h1 === 'DOWNTREND' && m15 === 'SIDEWAY') return { strategy: 'BREAKOUT_WATCH', direction: 'SHORT' };
  return { strategy: 'STANDBY' }; // SIDEWAY/trending mismatch, or conflicting H1 vs M15 direction
}
