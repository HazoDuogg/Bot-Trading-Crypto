import type { RrInput, RrResult } from './types.js';
import { DEFAULT_FEE_CONFIG } from './types.js';

// Round-trip cost (open+close, fee+slippage) expressed as a price distance, per spec section 4.
// Exported for reuse by partialTp.ts — total traded volume (open+close, whether 1 exit or 2 partial exits)
// is the same 200% of notional either way, so this single-exit cost formula applies unchanged to partial TP.
export function roundTripCost(entryPrice: number, feePct: number, slippagePct: number): number {
  return (entryPrice * ((feePct + slippagePct) * 2)) / 100;
}

export function calculateRr(input: RrInput): RrResult {
  const feeConfig = input.feeConfig ?? DEFAULT_FEE_CONFIG;
  const slDistance = Math.abs(input.entryPrice - input.slPrice);
  const cost = roundTripCost(input.entryPrice, feeConfig.takerFeePct, feeConfig.slippagePct);
  const netRisk = slDistance + cost;

  const idealRewardDistance = input.targetRMultiple * netRisk + cost;
  const idealTpPrice =
    input.direction === 'LONG' ? input.entryPrice + idealRewardDistance : input.entryPrice - idealRewardDistance;

  let tpPrice = idealTpPrice;
  if (input.cappedTpPrice !== undefined) {
    const capDistance = Math.abs(input.cappedTpPrice - input.entryPrice);
    if (capDistance < idealRewardDistance) tpPrice = input.cappedTpPrice;
  }

  const actualRewardDistance = Math.abs(tpPrice - input.entryPrice);
  const netReward = actualRewardDistance - cost;
  const netRMultiple = netReward / netRisk;

  // Epsilon guards against floating-point rounding landing just under the target when tpPrice==idealTpPrice by construction.
  const EPSILON = 1e-9;
  return {
    slDistance,
    idealTpPrice,
    tpPrice,
    netRMultiple,
    passesThreshold: netRMultiple >= input.targetRMultiple - EPSILON,
  };
}
