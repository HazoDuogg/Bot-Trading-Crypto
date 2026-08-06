/**
 * TICKET-143/143A — Momentum Context Decision Matrix, V1 and V2. Pure function, no side effects, no
 * state. Replaces MOMENTUM_DIRECT's unconditional macro-conflict hard-block with a 3-way context
 * decision: ALLOW_NORMAL / ALLOW_REDUCED_RISK / BLOCK. Ticket-given rules only — no new indicator.
 *
 * V1 (TICKET-143): hard-block {BTCUSDT}, reduced-risk {ETHUSDT,SOLUSDT,XRPUSDT}.
 * V2 (TICKET-143A): hard-block {BTCUSDT,ETHUSDT}, reduced-risk {SOLUSDT,XRPUSDT} — TICKET-143's real
 * backtest found ETHUSDT's ALLOW_REDUCED_RISK group net-negative while SOL/XRP were net-positive, so
 * V2 moves ETHUSDT into the hard-block set. `version` defaults to 'V1' so every existing call site
 * (orchestrator.ts's V1 branch, V1's own unit tests) stays byte-identical without passing it.
 *
 * BLOCK: SafetyState5m in {SHOCK, MANIPULATED}; or MomentumThesis invalid; or macroConflict on a
 * hard-block symbol; or (safe-default) macroConflict on a symbol outside the reduced-risk set below.
 * ALLOW_NORMAL: no macroConflict AND SafetyState5m not in the BLOCK set.
 * ALLOW_REDUCED_RISK: macroConflict AND symbol in the reduced-risk set AND SafetyState5m not in the
 * BLOCK set AND MomentumThesis=VALID. riskMultiplier=0.30 (existing TICKET-138 constant, not tuned).
 */
import { SafetyState5m } from '../regime/htfSafetyTypes.js';

export type MomentumContextDecisionMatrixVersion = 'V1' | 'V2';

const V1_HARD_BLOCK_SYMBOLS = new Set(['BTCUSDT']);
const V1_REDUCED_RISK_SYMBOLS = new Set(['ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
// TICKET-143A — ETHUSDT moves from V1's reduced-risk set into the hard-block set (net-negative finding).
const V2_HARD_BLOCK_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT']);
const V2_REDUCED_RISK_SYMBOLS = new Set(['SOLUSDT', 'XRPUSDT']);

const BLOCK_SAFETY_STATES = new Set([SafetyState5m.SHOCK, SafetyState5m.MANIPULATED]);
export const MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER = 0.3;

export interface MomentumContextDecisionInput {
  symbol: string;
  macroConflict: boolean;
  safetyState5m: SafetyState5m;
  /** Structurally true by construction in the real tryMomentumDirect() wiring — see TICKET-143 report. */
  momentumThesisValid: boolean;
}

export interface MomentumContextDecisionResult {
  decision: 'ALLOW_NORMAL' | 'ALLOW_REDUCED_RISK' | 'BLOCK';
  riskMultiplier: number;
  reason: string;
}

export function computeMomentumContextDecision(
  input: MomentumContextDecisionInput,
  version: MomentumContextDecisionMatrixVersion = 'V1',
): MomentumContextDecisionResult {
  const hardBlockSymbols = version === 'V2' ? V2_HARD_BLOCK_SYMBOLS : V1_HARD_BLOCK_SYMBOLS;
  const reducedRiskSymbols = version === 'V2' ? V2_REDUCED_RISK_SYMBOLS : V1_REDUCED_RISK_SYMBOLS;

  if (BLOCK_SAFETY_STATES.has(input.safetyState5m)) {
    return { decision: 'BLOCK', riskMultiplier: 0, reason: `safety_state_${input.safetyState5m.toLowerCase()}` };
  }
  if (!input.momentumThesisValid) {
    return { decision: 'BLOCK', riskMultiplier: 0, reason: 'invalid_momentum_thesis' };
  }
  if (hardBlockSymbols.has(input.symbol) && input.macroConflict) {
    // e.g. 'btc_macro_conflict' (V1/V2) or 'eth_macro_conflict' (V2 only) — same naming convention.
    return { decision: 'BLOCK', riskMultiplier: 0, reason: `${input.symbol.replace('USDT', '').toLowerCase()}_macro_conflict` };
  }
  if (!input.macroConflict) {
    return { decision: 'ALLOW_NORMAL', riskMultiplier: 1.0, reason: 'no_macro_conflict' };
  }
  if (reducedRiskSymbols.has(input.symbol)) {
    return { decision: 'ALLOW_REDUCED_RISK', riskMultiplier: MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER, reason: 'macro_conflict_reduced_risk' };
  }
  // Safe-default: macroConflict on a symbol outside hardBlockSymbols ∪ reducedRiskSymbols is not
  // covered by this version's rules — block rather than silently ALLOW_NORMAL (same convention as V1).
  return { decision: 'BLOCK', riskMultiplier: 0, reason: 'macro_conflict_unlisted_symbol' };
}
