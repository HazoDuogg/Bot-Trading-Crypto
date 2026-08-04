/**
 * TICKET-125 Việc B — "recent, sided" structural-break check, replacing TICKET-124's
 * `hasMSS = detectMarketStructureShift(w1m.window, direction, {...}) !== null` shadow-audit proxy,
 * which TICKET-124 confirmed is true on ~99.8% of candles (non-discriminating — see
 * data/ticket124-tactical-regime-audit-report.md ghi chú giới hạn #7) BECAUSE
 * detectMarketStructureShift() returns the FIRST confirming candle found ANYWHERE in the given
 * window (here, a ~3.3h/200-candle 1m window) with no recency check at all.
 *
 * This module is READ-ONLY and additive. Originally used ONLY by shadow-audit scripts; TICKET-130
 * added a second, real caller: orchestrator.ts's neutral5mDirectionSelector.ts (opt-in,
 * config.neutral5mDirectionSelectorEnabled, only active while regime===NEUTRAL_TRANSITION) reuses
 * this verbatim for its "recent structural break" sub-check. Still never called from
 * entryRouter.ts directly, and never imported by tactical/tacticalRegimeClassifier.ts, which stays
 * decoupled from entry/ detectors per its own header comment.
 *
 * Fix, per ticket spec's 4 requirements:
 *   1. Recency — only count a confirmation within RECENT_TOLERANCE_CANDLES of "now" (the end of
 *      the given window), not "anywhere in the whole window". Ticket spec's own suggested literal
 *      conversion: "3-5 5m candles ≈ 15-25 minutes ≈ 15-25 1m candles" (since the underlying
 *      detector still runs on the 1m window the audit script already builds, same wiring as
 *      TICKET-124 — switching the detector itself to run on 5m candles directly would need far
 *      more 5m history than the classifier's own trailing-5m-candle input provides, and would lose
 *      the "confirm on a smaller timeframe" intent B.4's own doc comment describes; kept on 1m).
 *      RECENT_TOLERANCE_CANDLES = 20 (middle of the ticket's own 15-25 1m-candle range) — a
 *      TODO_CONFIRM first-principles pick, NOT tuned against any outcome/PnL data. Cites production
 *      precedent: entry/config.ts's EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES = 5, which
 *      entryRouter.ts applies to a window ALREADY filtered down to "since the OB/FVG/Sweep zone
 *      formed" (see entryRouter.ts runTrendStyle()). This shadow context has no such zone to anchor
 *      to (the tactical classifier has no OB/FVG/Sweep concept) — a wider absolute-candle tolerance
 *      is the reasonable adaptation of the same "don't act on a stale confirmation" principle, not
 *      a re-derivation of the 5-candle constant itself.
 *   2. Sided — caller passes the SAME BULLISH/BEARISH direction the tactical candidate itself is
 *      being scored for (LONG->BULLISH, SHORT->BEARISH), never the coarse 1h adxDirection1h macro
 *      proxy TICKET-124's script used. This function itself is side-agnostic (just takes
 *      `direction`); the caller (audit script) computes it for BOTH directions once per candle and
 *      lets the tactical classifier pick per the side it's evaluating.
 *   3. Not stale relative to "now" — see (1); age is `window.length - 1 - index` in 1m candles.
 *   4. Anchored to the nearest actual swing/range boundary — inherited for free from
 *      detectMarketStructureShiftWithLevel()'s own swing-based reference (referenceHigh/Low.price),
 *      never an arbitrary distance.
 */
import type { CandleData } from '../../regime/types.js';
import type { Direction } from '../types.js';
import { detectMarketStructureShiftWithLevel, type MssConfig } from './marketStructureShift.js';

/** TODO_CONFIRM (see module doc): middle of ticket's own "15-25 1m candles" literal conversion of "3-5 5m candles". */
export const RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES = 20;

export interface RecentStructuralBreak {
  side: 'LONG' | 'SHORT';
  /** Index within the given `candles` window (not a global index — caller maps to a timestamp). */
  index: number;
  timestamp: number;
  /** window.length - 1 - index, in 1m candles (or whatever timeframe `candles` is). */
  ageCandles: number;
  /** The swing-anchored reference price level that was broken to confirm the shift. */
  levelPrice: number;
}

const DIRECTION_TO_SIDE: Record<Direction, 'LONG' | 'SHORT'> = { BULLISH: 'LONG', BEARISH: 'SHORT' };

/**
 * Returns the recent, non-stale, swing-anchored structural break for `direction` on this window,
 * or null if there is no confirmation at all, or the only confirmation found is stale (older than
 * RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES from the end of the window).
 */
export function detectRecentStructuralBreak(
  candles: CandleData[],
  direction: Direction,
  config: MssConfig,
  toleranceCandles: number = RECENT_STRUCTURAL_BREAK_TOLERANCE_CANDLES,
): RecentStructuralBreak | null {
  const result = detectMarketStructureShiftWithLevel(candles, direction, config);
  if (result === null) return null;
  const ageCandles = candles.length - 1 - result.index;
  if (ageCandles >= toleranceCandles) return null; // confirmation is stale — don't count it
  return {
    side: DIRECTION_TO_SIDE[direction],
    index: result.index,
    timestamp: candles[result.index].timestamp,
    ageCandles,
    levelPrice: result.levelPrice,
  };
}
