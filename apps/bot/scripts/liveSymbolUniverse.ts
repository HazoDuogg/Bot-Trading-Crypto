/**
 * TICKET-LIVE-R0 / LIVE-R0R — single authoritative source for the live-trading symbol universe.
 *
 * `liveRunner.ts` imports `LIVE_SYMBOL_UNIVERSE` instead of declaring its own symbol array, so
 * there is exactly one place live symbol membership can be edited — no second hard-coded list to
 * drift out of sync. This module is pure (no imports, no side effects) and scoped to the live
 * executable path only: backtest/replay/research scripts are unaffected and keep using whatever
 * symbol set they already pass in.
 *
 * Frozen at the type level (`readonly`) AND at runtime (`Object.freeze`) so the authoritative list
 * itself can never be mutated in place by any caller — `Object.freeze` makes a `.push()`/`.splice()`
 * call throw in strict mode (ESM modules are strict by default) rather than silently succeeding.
 * Callers needing a plain mutable `string[]` (pre-existing APIs in `liveRunner.ts` that predate this
 * module) must spread it into a fresh array at the call site — never cast away the readonly-ness.
 */

export const LIVE_SYMBOL_UNIVERSE: readonly string[] = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
