import type { PartialTpInput, PartialTpResult } from './partialTp.js';
import { DEFAULT_PARTIAL_TP_CONFIG } from './partialTp.js';
import { DEFAULT_FEE_CONFIG } from './types.js';
import { roundTripCost } from './rrCalculator.js';

const EPSILON = 1e-9;

// TP1/TP2 are fixed multiples (not solved-for) — cost simply eats into the blended reward, same round-trip
// cost formula as a single exit (see roundTripCost comment: total traded volume is unchanged by splitting the exit).
export function calculatePartialTp(input: PartialTpInput): PartialTpResult {
  const feeConfig = input.feeConfig ?? DEFAULT_FEE_CONFIG;
  const config = input.config ?? DEFAULT_PARTIAL_TP_CONFIG;

  const slDistance = Math.abs(input.entryPrice - input.slPrice);
  const tp1Price =
    input.direction === 'LONG'
      ? input.entryPrice + config.tp1RMultiple * slDistance
      : input.entryPrice - config.tp1RMultiple * slDistance;
  const tp2Price =
    input.direction === 'LONG'
      ? input.entryPrice + config.tp2RMultiple * slDistance
      : input.entryPrice - config.tp2RMultiple * slDistance;

  const blendedGrossRMultiple = config.tp1ClosePct * config.tp1RMultiple + config.tp2ClosePct * config.tp2RMultiple;

  const cost = roundTripCost(input.entryPrice, feeConfig.takerFeePct, feeConfig.slippagePct);
  const netRisk = slDistance + cost;
  const netReward = blendedGrossRMultiple * slDistance - cost;
  const netRMultiple = netReward / netRisk;

  const passesNominalThreshold = config.tp1RMultiple >= config.minNominalRMultiple - EPSILON;
  const passesRealThreshold = netRMultiple >= config.minRealRMultiple - EPSILON;

  return {
    slDistance,
    tp1Price,
    tp2Price,
    nominalRMultiple: config.tp1RMultiple,
    blendedGrossRMultiple,
    netRMultiple,
    passesNominalThreshold,
    passesRealThreshold,
    passes: passesNominalThreshold && passesRealThreshold,
  };
}
