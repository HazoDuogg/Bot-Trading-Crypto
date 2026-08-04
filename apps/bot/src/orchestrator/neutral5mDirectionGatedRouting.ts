/**
 * TICKET-131 — Neutral 5m Direction-Gated Setup Routing. Pure function, no side effects: computes a
 * RELAXED 5m directional verdict (LONG/SHORT/NONE) used ONLY inside NEUTRAL_TRANSITION to decide
 * whether an OB/FVG/SWEEP/BOX_BREAKOUT candidate (built by routeEntry()'s cascade, never by this
 * module) is allowed to reach the existing AI momentum gate check in orchestrator.ts's
 * tryOpenNewPosition() — see that file's wiring comment for exactly how this plugs in.
 *
 * DIFFERENT rule from TICKET-130's neutral5mDirectionSelector.ts (which vetoes tryMomentumDirect()'s
 * own LONG/SHORT candidates via a 3-of-3-unanimous rule including structural break as a hard
 * requirement). TICKET-130's finding: the 3/3 rule returned NONE ~98.4% of the time and made Net PnL
 * slightly worse. TICKET-131 uses a RELAXED 2-of-2 rule (EMA + DI only) — structural break is computed
 * and reported but NEVER a decision input here:
 *   1. EMA 5m: EMA9 vs EMA21 + EMA21 slope over the last 3 candles (identical formula to TICKET-130).
 *   2. DI Direction 5m: reuses regime/indicators.ts's wilderDIDirectionSeries() verbatim (identical to TICKET-130).
 *   3. Recent Structural Break 5m (TICKET-125, on candles1m): computed and returned as a diagnostic
 *      field only — never combined into the direction5m verdict.
 *
 * Plus the SAME anti-chase override as TICKET-130 (verbatim formula/threshold, not tuned here):
 * overextensionAtr = |close - EMA21| / ATR5m > 2.0 forces NONE even when EMA+DI agree.
 *
 * Does not modify neutral5mDirectionSelector.ts (TICKET-130) at all — this is a sibling module that
 * reuses the same underlying formulas/constants (re-declared here, not re-exported from there, to
 * avoid touching TICKET-130's file) for its own, different top-level combination rule.
 */
import type { CandleData } from '../regime/types.js';
import { emaSeries, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { RegimeConfig } from '../regime/config.js';
import { EntryConfig } from '../entry/config.js';
import { detectRecentStructuralBreak } from '../entry/detectors/structuralBreakRecent.js';
import {
  NEUTRAL_5M_EMA_FAST_PERIOD,
  NEUTRAL_5M_EMA_SLOW_PERIOD,
  NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES,
  NEUTRAL_5M_DI_PERIOD,
  NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD,
  type Direction5m,
} from './neutral5mDirectionSelector.js';

export type { Direction5m };

/** Re-exported verbatim (same values, TICKET-130's constants — not re-tuned in this ticket). */
export {
  NEUTRAL_5M_EMA_FAST_PERIOD,
  NEUTRAL_5M_EMA_SLOW_PERIOD,
  NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES,
  NEUTRAL_5M_DI_PERIOD,
  NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD,
};

export interface Direction5mRelaxedResult {
  /** The 2-of-2 (EMA+DI) verdict, after the overextension override — the ONLY field this ticket's routing logic may read. */
  direction5m: Direction5m;
  /**
   * Diagnostic-only, TICKET-125's sided/recent/swing-anchored structural break on the 1m window.
   * Never influences direction5m — logged purely so the report can cross-tabulate "did the new
   * Neutral trades happen to also have a structural break confirmed". Same convention as the LONG
   * verdict meaning a bullish break and SHORT a bearish one; NONE = neither confirmed (or both,
   * ambiguous).
   */
  structuralBreakDiagnostic: Direction5m;
}

/** EMA9/EMA21 cross + EMA21-slope-over-3-candles sub-check — verbatim formula, shared with TICKET-130. */
function emaDirection(candles5m: CandleData[]): Direction5m {
  const n = candles5m.length;
  if (n < NEUTRAL_5M_EMA_SLOW_PERIOD + NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES) return 'NONE';

  const ema9Series = emaSeries(candles5m, NEUTRAL_5M_EMA_FAST_PERIOD);
  const ema21Series = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const ema9Now = ema9Series[n - 1];
  const ema21Now = ema21Series[n - 1];
  const ema21Prior = ema21Series[n - 1 - NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES];
  if (Number.isNaN(ema9Now) || Number.isNaN(ema21Now) || Number.isNaN(ema21Prior)) return 'NONE';

  const ema21Slope = ema21Now - ema21Prior;
  if (ema9Now > ema21Now && ema21Slope > 0) return 'LONG';
  if (ema9Now < ema21Now && ema21Slope < 0) return 'SHORT';
  return 'NONE';
}

/** +DI vs -DI sub-check — verbatim formula, shared with TICKET-130. */
function diDirection(candles5m: CandleData[]): Direction5m {
  const series = wilderDIDirectionSeries(candles5m, NEUTRAL_5M_DI_PERIOD);
  const last = series.length > 0 ? series[series.length - 1] : undefined;
  if (last === 'UP') return 'LONG';
  if (last === 'DOWN') return 'SHORT';
  return 'NONE'; // 'FLAT' or undefined (missing data) both fall here per ticket spec
}

/** Diagnostic-only sided structural break (TICKET-125) on the 1m window — never a decision input for TICKET-131. */
function structureDirectionDiagnostic(candles1m: CandleData[]): Direction5m {
  const bullish = detectRecentStructuralBreak(candles1m, 'BULLISH', { fractalN: EntryConfig.FRACTAL_N });
  const bearish = detectRecentStructuralBreak(candles1m, 'BEARISH', { fractalN: EntryConfig.FRACTAL_N });
  if (bullish !== null && bearish === null) return 'LONG';
  if (bearish !== null && bullish === null) return 'SHORT';
  return 'NONE';
}

/**
 * Computes the RELAXED direction5m per TICKET-131's exact rules: 2-of-2 (EMA+DI) agreement, then the
 * SAME overextension override TICKET-130 uses. Structural break is computed and returned purely as a
 * diagnostic — it can never flip or block the verdict. Never throws — insufficient history (EMA21/ATR
 * warm-up) or a degenerate/zero ATR both resolve to 'NONE' for direction5m ("an toàn" convention).
 */
export function computeDirection5mRelaxed(candles5m: CandleData[], candles1m: CandleData[]): Direction5mRelaxedResult {
  const ema = emaDirection(candles5m);
  const di = diDirection(candles5m);
  const structuralBreakDiagnostic = structureDirectionDiagnostic(candles1m);

  let verdict: Direction5m = 'NONE';
  if (ema === 'LONG' && di === 'LONG') verdict = 'LONG';
  else if (ema === 'SHORT' && di === 'SHORT') verdict = 'SHORT';
  if (verdict === 'NONE') return { direction5m: 'NONE', structuralBreakDiagnostic };

  // Anti-chase override — verbatim formula/threshold as TICKET-130, still applies even to a 2-of-2 verdict.
  const n = candles5m.length;
  const ema21Series = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const ema21Now = ema21Series[n - 1]; // already validated non-NaN by emaDirection() above for verdict !== 'NONE' to be reachable
  const atrSeries = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M);
  const atrNow = atrSeries[n - 1];
  if (Number.isNaN(atrNow) || atrNow === 0) return { direction5m: 'NONE', structuralBreakDiagnostic }; // guard: can't confirm not-overextended -> safe NONE, never NaN/Infinity

  const closeNow = candles5m[n - 1].close;
  const overextensionAtr = Math.abs(closeNow - ema21Now) / atrNow;
  if (overextensionAtr > NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD) return { direction5m: 'NONE', structuralBreakDiagnostic };

  return { direction5m: verdict, structuralBreakDiagnostic };
}
