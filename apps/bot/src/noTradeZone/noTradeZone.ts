import type { Candle, NoTradeZoneConfig, NoTradeZoneResult } from './types.js';
import { DEFAULT_NO_TRADE_ZONE_CONFIG } from './types.js';
import { isSpreadTooHigh } from './spreadCheck.js';
import { isVolatilityExtreme } from './volatilityCheck.js';
import { isShockEvent } from './shockEventCheck.js';
import { isPumpDump } from './pumpDumpCheck.js';
import { isNewsRisk } from './newsRiskCheck.js';

export interface NoTradeZoneInput {
  nowMs: number;
  bid: number;
  ask: number;
  h1Candles: Candle[];
  m15Candles: Candle[];
  config?: NoTradeZoneConfig;
}

// Runs all 5 conditions from spec section 1; any true condition blocks entry. Order-independent, all checked.
export function checkNoTradeZone(input: NoTradeZoneInput): NoTradeZoneResult {
  const cfg = input.config ?? DEFAULT_NO_TRADE_ZONE_CONFIG;
  const reasons: NoTradeZoneResult['reasons'] = [];

  if (isNewsRisk(input.nowMs)) reasons.push('news_risk');
  if (isSpreadTooHigh(input.bid, input.ask, cfg.spreadPctThreshold)) reasons.push('spread_too_high');
  if (isVolatilityExtreme(input.h1Candles, cfg.atrRatioThreshold, cfg.h1RangePctThreshold))
    reasons.push('volatility_extreme');
  if (isShockEvent(input.h1Candles, cfg.shockEventPctThreshold)) reasons.push('shock_event');
  if (
    isPumpDump(
      input.m15Candles,
      cfg.pumpDumpMinConsecutive,
      cfg.pumpDumpAtrMultiplier,
      cfg.pumpDumpVolumeSpikeMultiplier,
    )
  )
    reasons.push('pump_dump_flag');

  return { blocked: reasons.length > 0, reasons };
}
