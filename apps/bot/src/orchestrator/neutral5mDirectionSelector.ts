/**
 * TICKET-130 — Neutral 5m Direction Selector. Pure function, no side effects: computes a 5m
 * directional verdict (LONG/SHORT/NONE) used ONLY inside NEUTRAL_TRANSITION to reject the
 * disagreeing side of tryMomentumDirect()'s LONG/SHORT candidates (orchestrator.ts). Never creates
 * a candidate, never flips LONG<->SHORT, never bypasses the AI gate/macro filter — see
 * orchestrator.ts's tryMomentumDirect() wiring comment for how this plugs in.
 *
 * Exactly 3 sub-confirmations per ticket spec, unanimous (3-of-3) required — no majority vote, no
 * weighting, no ADX-magnitude threshold, no tuning of any constant below:
 *   1. EMA 5m: EMA9 vs EMA21 + EMA21 slope over the last 3 candles.
 *   2. DI Direction 5m: reuses regime/indicators.ts's wilderDIDirectionSeries() verbatim.
 *   3. Recent Structural Break 5m: reuses entry/detectors/structuralBreakRecent.ts's
 *      detectRecentStructuralBreak() verbatim (sided/recent/swing-anchored, TICKET-125) — run on
 *      candles1m, mirroring how entryRouter.ts's own candlesMss:input.candles1m is wired
 *      (orchestrator.ts already passes the same 1m window through for the OB/FVG cascade's MSS
 *      confirmation).
 *
 * Plus an anti-chase override: overextensionAtr = |close - EMA21| / ATR5m > 2.0 forces NONE even
 * when the 3 sub-confirmations unanimously agree.
 */
import type { CandleData } from '../regime/types.js';
import { emaSeries, wilderATRSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { RegimeConfig } from '../regime/config.js';
import { EntryConfig } from '../entry/config.js';
import { detectRecentStructuralBreak } from '../entry/detectors/structuralBreakRecent.js';

export type Direction5m = 'LONG' | 'SHORT' | 'NONE';

/** Ticket-given constants, not tunable within TICKET-130's scope. */
export const NEUTRAL_5M_EMA_FAST_PERIOD = 9;
export const NEUTRAL_5M_EMA_SLOW_PERIOD = 21;
export const NEUTRAL_5M_EMA_SLOPE_LOOKBACK_CANDLES = 3;
/**
 * DI period for the 5m sub-check — the ticket doesn't specify a new number, only "reuse
 * wilderDIDirectionSeries()". Reuses the codebase's existing standard Wilder period (14), already
 * used for RegimeConfig.ADX_PERIOD_1H and RegimeConfig.ATR_PERIOD_5M — not a new tuned value.
 */
export const NEUTRAL_5M_DI_PERIOD = RegimeConfig.ATR_PERIOD_5M;
export const NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD = 2.0;

/** EMA9/EMA21 cross + EMA21-slope-over-3-candles sub-check. NONE on insufficient warm-up or no agreement. */
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

/** +DI vs -DI sub-check — no ADX magnitude threshold, just the direction label. */
function diDirection(candles5m: CandleData[]): Direction5m {
  const series = wilderDIDirectionSeries(candles5m, NEUTRAL_5M_DI_PERIOD);
  const last = series.length > 0 ? series[series.length - 1] : undefined;
  if (last === 'UP') return 'LONG';
  if (last === 'DOWN') return 'SHORT';
  return 'NONE'; // 'FLAT' or undefined (missing data) both fall here per ticket spec
}

/** Recent/sided/swing-anchored structural break sub-check (TICKET-125), run on the 1m window. */
function structureDirection(candles1m: CandleData[]): Direction5m {
  const bullish = detectRecentStructuralBreak(candles1m, 'BULLISH', { fractalN: EntryConfig.FRACTAL_N });
  const bearish = detectRecentStructuralBreak(candles1m, 'BEARISH', { fractalN: EntryConfig.FRACTAL_N });
  if (bullish !== null && bearish === null) return 'LONG';
  if (bearish !== null && bullish === null) return 'SHORT';
  return 'NONE'; // no break, or both sides confirm (ambiguous) — never guess
}

/**
 * Computes direction5m per the ticket's exact rules: 3-of-3 unanimous sub-confirmations, then the
 * overextension override. Never throws — insufficient history (EMA21/ATR warm-up) or a
 * degenerate/zero ATR both resolve to 'NONE', matching this codebase's "an toàn" convention
 * (undefined/ambiguous data never defaults to permissive behavior).
 */
export function computeDirection5m(candles5m: CandleData[], candles1m: CandleData[]): Direction5m {
  const ema = emaDirection(candles5m);
  const di = diDirection(candles5m);
  const structure = structureDirection(candles1m);

  let verdict: Direction5m = 'NONE';
  if (ema === 'LONG' && di === 'LONG' && structure === 'LONG') verdict = 'LONG';
  else if (ema === 'SHORT' && di === 'SHORT' && structure === 'SHORT') verdict = 'SHORT';
  if (verdict === 'NONE') return 'NONE';

  // Anti-chase override — even a unanimous verdict is discarded when price is too far from EMA21.
  const n = candles5m.length;
  const ema21Series = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const ema21Now = ema21Series[n - 1]; // already validated non-NaN by emaDirection() above for verdict !== 'NONE' to be reachable
  const atrSeries = wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M);
  const atrNow = atrSeries[n - 1];
  if (Number.isNaN(atrNow) || atrNow === 0) return 'NONE'; // guard: can't confirm not-overextended -> safe NONE, never NaN/Infinity

  const closeNow = candles5m[n - 1].close;
  const overextensionAtr = Math.abs(closeNow - ema21Now) / atrNow;
  if (overextensionAtr > NEUTRAL_5M_OVEREXTENSION_ATR_THRESHOLD) return 'NONE';

  return verdict;
}
