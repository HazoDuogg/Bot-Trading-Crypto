import type { Direction } from './types.js';

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

// Entry is assumed market/taker (signal-driven, must fill immediately — no waiting).
// Exit legs (TP1/TP2) can be maker (limit order, resting in the book) or taker (market) — configurable per scenario.
// A filled maker/limit order gets exactly its set price, so exitSlippagePct should be 0 for a maker exit config;
// only a market/taker exit realistically incurs slippage.
export interface ExecutionFeeConfig {
  entryFeePct: number;
  entrySlippagePct: number;
  exitFeePct: number;
  exitSlippagePct: number;
}

// Baseline: everything taker (matches the old single-rate FeeConfig behavior).
export const TAKER_ONLY_FEE_CONFIG: ExecutionFeeConfig = {
  entryFeePct: 0.05,
  entrySlippagePct: 0.05,
  exitFeePct: 0.05,
  exitSlippagePct: 0.05,
};

// Entry stays taker (must fill on signal); TP1/TP2 assumed to fill as maker limit orders — 0 slippage since a
// filled limit order fills at its set price. TODO_CONFIRM: real maker fill rate not yet measured (see TICKET-RT-011).
export const MAKER_EXIT_FEE_CONFIG: ExecutionFeeConfig = {
  entryFeePct: 0.05,
  entrySlippagePct: 0.05,
  exitFeePct: 0.02,
  exitSlippagePct: 0,
};

export interface PartialTpInput {
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  feeConfig?: ExecutionFeeConfig;
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
