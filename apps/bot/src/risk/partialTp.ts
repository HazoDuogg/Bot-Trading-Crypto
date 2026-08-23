import type { Direction, FeeConfig } from './types.js';
import { DEFAULT_FEE_CONFIG } from './types.js';

export interface PartialTpConfig {
  tp1RMultiple: number;
  tp1ClosePct: number;
  tp2RMultiple: number;
  tp2ClosePct: number;
  minNominalRMultiple: number; // checked against tp1RMultiple (the "worst case" R if TP1 alone is hit)
  minRealRMultiple: number; // checked against the blended net R:R after cost
}

// Per revised design: TP1 1.5R closes 50%, TP2 3.0R closes remaining 50%. Nominal floor 1.5R, real floor 1.2R.
export const DEFAULT_PARTIAL_TP_CONFIG: PartialTpConfig = {
  tp1RMultiple: 1.5,
  tp1ClosePct: 0.5,
  tp2RMultiple: 3.0,
  tp2ClosePct: 0.5,
  minNominalRMultiple: 1.5,
  minRealRMultiple: 1.2,
};

export interface PartialTpInput {
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  feeConfig?: FeeConfig;
  config?: PartialTpConfig;
}

export interface PartialTpResult {
  slDistance: number;
  tp1Price: number;
  tp2Price: number;
  nominalRMultiple: number; // = config.tp1RMultiple, the worst-case R if only TP1 is ever reached
  blendedGrossRMultiple: number; // weighted average of TP1/TP2 R multiples, before cost
  netRMultiple: number; // blended reward, net of round-trip fee+slippage
  passesNominalThreshold: boolean;
  passesRealThreshold: boolean;
  passes: boolean;
}
