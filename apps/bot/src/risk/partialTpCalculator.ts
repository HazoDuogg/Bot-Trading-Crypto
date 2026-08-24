import type { ExecutionFeeConfig, PartialTpInput, PartialTpResult } from './partialTp.js';
import { DEFAULT_PARTIAL_TP_CONFIG, TAKER_ONLY_FEE_CONFIG } from './partialTp.js';

const EPSILON = 1e-9;

// Cost = one entry fill + the full position eventually exiting (TP1 50% + TP2 50% = 100% of notional exits,
// so exit legs contribute exitFeePct+exitSlippagePct once in total, regardless of the TP1/TP2 split).
function executionCost(entryPrice: number, fees: ExecutionFeeConfig): number {
  const pctSum = fees.entryFeePct + fees.entrySlippagePct + fees.exitFeePct + fees.exitSlippagePct;
  return (entryPrice * pctSum) / 100;
}

// TP1/TP2 are fixed multiples (not solved-for) — cost simply eats into the blended reward.
// Entry is assumed taker; exit legs use fees.exitFeePct/exitSlippagePct, which the caller sets to a maker
// rate (0 slippage) or taker rate (with slippage) depending on the execution scenario being modeled.
export function calculatePartialTp(input: PartialTpInput): PartialTpResult {
  const feeConfig = input.feeConfig ?? TAKER_ONLY_FEE_CONFIG;
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

  const cost = executionCost(input.entryPrice, feeConfig);
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
