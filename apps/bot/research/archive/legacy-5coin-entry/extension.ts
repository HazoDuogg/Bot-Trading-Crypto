// D8 — CONVENTION v1: distribution-selected no-chase distance, not outcome/PnL optimization.
export const D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO = 2.0;

export interface ExtensionInput {
  currentClose: number;
  breakLevel: number;
  frozenAtr: number;
}

export interface ExtensionResult {
  isOverExtended: boolean;
  distanceAtrRatio: number;
}

export function detectNoChaseExtension(input: ExtensionInput): ExtensionResult {
  if (!Number.isFinite(input.currentClose) || !Number.isFinite(input.breakLevel)) {
    throw new Error('currentClose and breakLevel must be finite');
  }
  if (!Number.isFinite(input.frozenAtr) || input.frozenAtr <= 0) {
    throw new Error('frozenAtr must be finite and greater than zero');
  }
  const distanceAtrRatio = Math.abs(input.currentClose - input.breakLevel) / input.frozenAtr;
  return {
    isOverExtended: distanceAtrRatio >= D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO,
    distanceAtrRatio,
  };
}
