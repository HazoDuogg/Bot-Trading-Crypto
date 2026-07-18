import type { MomentumFilterConfig } from './config.js';

/**
 * TICKET-024 Phần C — soft risk multiplier from the momentum model's calibrated probability `p`
 * (LONG: scoreMomentum() directly; SHORT: 1 - scoreMomentum(), an approximation PM accepted for
 * this first test round — the model only ever learned "probability of an upward move").
 * <= momentumLowThreshold -> momentumLowMultiplier; >= momentumHighThreshold -> 1.0;
 * linear interpolation between the two thresholds.
 */
export function computeMomentumMultiplier(p: number, config: MomentumFilterConfig): number {
  if (p <= config.momentumLowThreshold) return config.momentumLowMultiplier;
  if (p >= config.momentumHighThreshold) return 1.0;

  const t = (p - config.momentumLowThreshold) / (config.momentumHighThreshold - config.momentumLowThreshold);
  return config.momentumLowMultiplier + t * (1.0 - config.momentumLowMultiplier);
}
