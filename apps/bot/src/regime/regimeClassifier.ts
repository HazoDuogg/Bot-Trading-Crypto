import type { Candle, RegimeConfig, RegimeResult } from './types.js';
import { DEFAULT_REGIME_CONFIG } from './types.js';
import { computeEma } from './ema.js';
import { findSwingPoints } from './swingPoints.js';
import { classifyStructure } from './structure.js';

// UPTREND: price>EMA200 + slope up + HH/HL. DOWNTREND: mirror. Else SIDEWAY. Per spec section 2.
export function classifyRegime(candles: Candle[], config: RegimeConfig = DEFAULT_REGIME_CONFIG): RegimeResult {
  const emaValues = computeEma(candles, config.emaPeriod);
  if (emaValues.length <= config.slopeLookback) {
    return { state: 'SIDEWAY', emaSlopePct: 0, priceAboveEma: false };
  }

  const currentEma = emaValues[emaValues.length - 1];
  const pastEma = emaValues[emaValues.length - 1 - config.slopeLookback];
  const emaSlopePct = ((currentEma - pastEma) / pastEma) * 100;

  const currentPrice = candles[candles.length - 1].close;
  const priceAboveEma = currentPrice > currentEma;

  const swingPoints = findSwingPoints(candles, config.swingPivotWidth);
  const structure = classifyStructure(swingPoints);

  const slopeUp = emaSlopePct > config.slopeFlatThresholdPct;
  const slopeDown = emaSlopePct < -config.slopeFlatThresholdPct;

  if (priceAboveEma && slopeUp && structure === 'HH_HL') {
    return { state: 'UPTREND', emaSlopePct, priceAboveEma };
  }
  if (!priceAboveEma && slopeDown && structure === 'LH_LL') {
    return { state: 'DOWNTREND', emaSlopePct, priceAboveEma };
  }
  return { state: 'SIDEWAY', emaSlopePct, priceAboveEma };
}
