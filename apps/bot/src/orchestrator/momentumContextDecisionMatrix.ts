/**
 * TICKET-143 — Momentum Context Decision Matrix V1. Pure function, no side effects, no state.
 * Replaces MOMENTUM_DIRECT's unconditional macro-conflict hard-block with a 3-way context decision:
 * ALLOW_NORMAL / ALLOW_REDUCED_RISK / BLOCK. Ticket-given rules only — no new indicator/threshold.
 *
 * BLOCK: SafetyState5m in {SHOCK, MANIPULATED}; or MomentumThesis invalid; or BTCUSDT+macroConflict;
 * or (safe-default) macroConflict on a symbol outside the ALLOW_REDUCED_RISK set below.
 * ALLOW_NORMAL: no macroConflict AND SafetyState5m not in the BLOCK set.
 * ALLOW_REDUCED_RISK: macroConflict AND symbol in {ETHUSDT,SOLUSDT,XRPUSDT} AND SafetyState5m not in
 * the BLOCK set AND MomentumThesis=VALID. riskMultiplier=0.30 (existing TICKET-138 constant, not tuned).
 */
import { SafetyState5m } from '../regime/htfSafetyTypes.js';

const REDUCED_RISK_SYMBOLS = new Set(['ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
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

export function computeMomentumContextDecision(input: MomentumContextDecisionInput): MomentumContextDecisionResult {
  if (BLOCK_SAFETY_STATES.has(input.safetyState5m)) {
    return { decision: 'BLOCK', riskMultiplier: 0, reason: `safety_state_${input.safetyState5m.toLowerCase()}` };
  }
  if (!input.momentumThesisValid) {
    return { decision: 'BLOCK', riskMultiplier: 0, reason: 'invalid_momentum_thesis' };
  }
  if (input.symbol === 'BTCUSDT' && input.macroConflict) {
    return { decision: 'BLOCK', riskMultiplier: 0, reason: 'btc_macro_conflict' };
  }
  if (!input.macroConflict) {
    return { decision: 'ALLOW_NORMAL', riskMultiplier: 1.0, reason: 'no_macro_conflict' };
  }
  if (REDUCED_RISK_SYMBOLS.has(input.symbol)) {
    return { decision: 'ALLOW_REDUCED_RISK', riskMultiplier: MOMENTUM_CONTEXT_REDUCED_RISK_MULTIPLIER, reason: 'macro_conflict_reduced_risk' };
  }
  // Safe-default: macroConflict on a symbol outside {BTCUSDT} ∪ REDUCED_RISK_SYMBOLS is not covered
  // by V1's rules — block rather than silently ALLOW_NORMAL (same "an toàn" convention as elsewhere).
  return { decision: 'BLOCK', riskMultiplier: 0, reason: 'macro_conflict_unlisted_symbol' };
}
