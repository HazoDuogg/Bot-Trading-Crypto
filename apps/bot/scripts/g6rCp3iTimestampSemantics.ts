/**
 * G6R CP3I — minimal, pure, offline helper for the canonical timestamp semantics locked in
 * `data/g6r-cp3i-timestamp-semantics.md`. Adds exactly ONE derived quantity
 * (`confirmingCandleAvailableAt`, per that document's §4/§6) that does not otherwise exist as a
 * named field anywhere in the frozen `g6rShadowAnalyzer.ts` / `g6rCp3hForensicSchema.ts` modules.
 *
 * This file deliberately does NOT reimplement `evaluateStage()`, `auditDecisionFeatureProvenance()`,
 * `classifyTimestamp()`, or any detector/MSS/staleness/ATR/SL formula. It only re-exports the
 * `ONE_MINUTE_MS` constant already defined in `g6rShadowAnalyzer.ts` (never redefines it) and adds
 * one pure arithmetic helper plus one small comparison helper used by the CP3I fixture tests.
 */
import { ONE_MINUTE_MS } from './g6rShadowAnalyzer.js';

export { ONE_MINUTE_MS };

/**
 * Canonical `decisionAvailableAt` per `data/g6r-cp3i-timestamp-semantics.md` §4/§6/§16: the earliest
 * moment the CONFIRMING candle itself (the one that produced `decisionTimestamp`) is closed and
 * therefore legitimately readable. Deliberately NOT `mssMaxAvailableAt` — see §6 of the semantics
 * doc for why that would be a conflation of two different concepts.
 */
export function confirmingCandleAvailableAt(decisionTimestamp: number): number {
  return decisionTimestamp + ONE_MINUTE_MS;
}

/**
 * Per the semantics doc §11: `maxFeatureAvailableAt` is always >= `confirmingCandleAvailableAt`,
 * by construction (the confirming candle is always one of the features read). Pure comparison
 * helper, no detector logic — used by CP3I tests to assert this invariant directly against real
 * `DecisionFeatureProvenance` values produced by the real `evaluateStage()`/`observeDecision()`.
 */
export function isConfirmingCandleAvailableAtBeforeOrEqualToMaxFeatureAvailableAt(decisionTimestamp: number, maxFeatureAvailableAt: number): boolean {
  return confirmingCandleAvailableAt(decisionTimestamp) <= maxFeatureAvailableAt;
}
