import { computeEma } from '../regime/ema.js';
import type { Candle } from '../regime/types.js';

export type TrendH1 = 'UPTREND' | 'DOWNTREND';

// Chien luoc 1: trend is simply "close vs EMA200 H1", no slope/HH-LL structure requirement (unlike
// the old 3-timeframe regime/classifyRegime.ts, which this replaces for this strategy).
//
// DEVIATION FROM TICKET'S LITERAL SIGNATURE: the ticket writes the return type as exactly
// 'UPTREND' | 'DOWNTREND' with no null case. Returning null when there isn't yet enough H1 history
// for EMA200 matches the established convention of every other null-returning function in this
// codebase (calculateSl, calculatePositionSize, checkPullbackZone's zone fields, etc.) rather than
// throwing or silently guessing a direction with no basis — flagging this as a deliberate, minor
// deviation rather than a silent one.
export function classifyTrendH1(h1Candles: Candle[], emaPeriod: number): TrendH1 | null {
  const emaValues = computeEma(h1Candles, emaPeriod);
  if (emaValues.length === 0) return null;

  const currentEma = emaValues[emaValues.length - 1];
  const currentClose = h1Candles[h1Candles.length - 1].close;
  return currentClose >= currentEma ? 'UPTREND' : 'DOWNTREND';
}
