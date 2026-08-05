/**
 * TICKET-138 — Neutral 5m Conditional Override for HTF (1D macro) Conflict.
 *
 * `is5mConfirmed()` is a NEW, deliberately SIMPLER 5m confirmation rule than TICKET-130's
 * computeDirection5m() (3-of-3: EMA+slope, DI, structural break, plus an anti-chase overextension
 * override) and TICKET-131's computeDirection5mRelaxed() (2-of-2 EMA+slope+DI, still with the
 * overextension override). Per the ticket: "Không dùng computeDirection5m() 3/3 cũ" — this rule has
 * NO slope requirement on EMA21, NO structural break check, and NO overextension override. It is a
 * raw 2-of-2 AND:
 *   1. EMA confirmation: LONG -> EMA9 (fast) > EMA21 (slow); SHORT -> EMA9 < EMA21.
 *   2. DI confirmation: LONG -> +DI > -DI (wilderDIDirectionSeries()==='UP'); SHORT -> -DI > +DI
 *      (wilderDIDirectionSeries()==='DOWN').
 * Both must agree with the candidate's own side for the candidate to be `5M_CONFIRMED`.
 *
 * Reuses this project's own established "5m EMA fast/slow" convention (NEUTRAL_5M_EMA_FAST_PERIOD=9,
 * NEUTRAL_5M_EMA_SLOW_PERIOD=21 from neutral5mDirectionSelector.ts, TICKET-130) and the same DI period
 * (NEUTRAL_5M_DI_PERIOD = RegimeConfig.ATR_PERIOD_5M = 14) — no new indicator, no new period, no
 * tuning, per the ticket's explicit constraints.
 */
import type { CandleData } from '../regime/types.js';
import { emaSeries, wilderDIDirectionSeries } from '../regime/indicators.js';
import { NEUTRAL_5M_EMA_FAST_PERIOD, NEUTRAL_5M_EMA_SLOW_PERIOD, NEUTRAL_5M_DI_PERIOD } from './neutral5mDirectionSelector.js';

/**
 * Raw EMA9-vs-EMA21 + raw +DI-vs--DI, both agreeing with `side` — a 2-of-2 AND, no slope, no
 * structural break, no overextension override (see file doc comment for why this is deliberately
 * simpler than TICKET-130/131's rules). Insufficient warm-up history for either sub-check resolves
 * to `false` (not confirmed) — this codebase's "an toàn" convention: undefined/ambiguous data never
 * defaults to permissive.
 */
export function is5mConfirmed(candles5m: CandleData[], side: 'LONG' | 'SHORT'): boolean {
  const n = candles5m.length;
  if (n < NEUTRAL_5M_EMA_SLOW_PERIOD) return false;

  const emaFastSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_FAST_PERIOD);
  const emaSlowSeries = emaSeries(candles5m, NEUTRAL_5M_EMA_SLOW_PERIOD);
  const emaFastNow = emaFastSeries[n - 1];
  const emaSlowNow = emaSlowSeries[n - 1];
  if (Number.isNaN(emaFastNow) || Number.isNaN(emaSlowNow)) return false;
  const emaConfirmed = side === 'LONG' ? emaFastNow > emaSlowNow : emaFastNow < emaSlowNow;
  if (!emaConfirmed) return false;

  const diSeries = wilderDIDirectionSeries(candles5m, NEUTRAL_5M_DI_PERIOD);
  const diLast = diSeries.length > 0 ? diSeries[diSeries.length - 1] : undefined;
  return side === 'LONG' ? diLast === 'UP' : diLast === 'DOWN';
}
