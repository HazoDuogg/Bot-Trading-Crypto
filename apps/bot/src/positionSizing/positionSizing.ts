import type { PositionSizingInput, PositionSizingResult } from './types.js';

// Risk-based sizing, clamped by a per-trade margin cap. Never scales qty UP to hit a target —
// only ever clamps DOWN, so actualRiskUsd <= riskUsd is an invariant, never violated.
export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult | null {
  const slDistance = Math.abs(input.entryPrice - input.slPrice);
  if (
    slDistance <= 0 ||
    input.balance <= 0 ||
    input.riskUsd <= 0 ||
    input.leverage <= 0 ||
    input.maxMarginPct <= 0
  ) {
    return null;
  }

  const riskBasedNotional = (input.riskUsd / slDistance) * input.entryPrice;
  const marginBasedNotional = input.balance * input.maxMarginPct * input.leverage;

  const notional = Math.min(riskBasedNotional, marginBasedNotional);
  const qty = notional / input.entryPrice;

  return {
    qty,
    notional,
    requiredMargin: notional / input.leverage,
    actualRiskUsd: qty * slDistance,
    clampedByMargin: marginBasedNotional < riskBasedNotional,
  };
}
