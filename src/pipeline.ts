/**
 * The intended data flow for the (not-yet-locked) TypeScript framework:
 *
 *   data -> strategy (signal) -> ai (score, advisory) -> risk (final authority, can always block) -> execution
 *
 * - `strategy` (see src/strategy/Strategy.ts) looks at market data and
 *   produces a candidate signal. No sizing, no order placement.
 * - `ai` (see src/ai/ScoringModel.ts) is ADVISORY ONLY: it scores a
 *   candidate signal and returns that score plus the inputs it used
 *   (recorded via src/ai/FeatureRecorder.ts). It never places an order
 *   and never blocks one on its own authority - `risk` decides what, if
 *   anything, the score changes.
 * - If the model is missing, fails to load, or throws at scoring time,
 *   the engine falls back to rule-based only (as if `ai` were absent
 *   from the pipeline entirely) - a missing/broken model is never a
 *   reason to block or alter a trade by itself.
 * - `risk` is the FINAL authority: it can always block a trade
 *   regardless of what `strategy` or `ai` returned, and nothing
 *   downstream of `risk` can override that.
 * - `execution` (see src/execution/Broker.ts) is the only stage allowed
 *   to place/modify/cancel real or simulated orders.
 *
 * Deliberately placed at src/ top level, not inside src/core/ - that
 * folder already holds an EARLIER, different pipeline/wiring concept
 * (regime -> direction -> entry -> risk -> exit, see src/core/README.md)
 * from a prior SMC-based implementation attempt. Putting a same-named-
 * sounding but different "pipeline" concept inside that folder would be
 * confusing. See docs/decisions.md for the proposal to relocate that
 * prior work to research/ - pending approval, nothing under src/core/
 * has been touched.
 *
 * This file is documentation only - no logic, no implementation.
 * Strategy itself is not locked yet; this skeleton exists so the
 * eventual chosen strategy has somewhere to land, not to presuppose
 * what it will be.
 */
export const PIPELINE_STAGES = ["data", "strategy", "ai", "risk", "execution"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
