/**
 * TICKET-G1R Checkpoint D (G1-F04) — current-risk recomputation, replacing riskPool.ts's callers'
 * old habit of trusting a position's FULL INITIAL actualRiskDollar (frozen at open time) for the
 * lifetime of the position. TP1/TP2 partial fills shrink remainingPositionSize; SL ratchets/
 * breakeven/trailing/giveback-protection move currentSlPrice — none of that ever fed back into the
 * pool's bookkeeping before this fix, so the pool understated available capacity (or could drift
 * the other way) versus the position's true current worst-case loss.
 *
 * Pure, rebuild-from-scratch design (no `pool.committedRisk += x` / `-= y` anywhere): every function
 * here recomputes from the CURRENT state handed to it, every time — never accumulates.
 */
import type { Side } from './slTpManager.js';

export interface PositionRiskBasis {
  side: Side;
  /** Canonical executed entry (already corrected by reconcileExecutedOpenState() when applicable) — never moves once set. */
  entryPrice: number;
  /** Current resting SL price — moves with TP1/TP2 choreography, structure/ATR trailing, giveback protection. */
  currentSlPrice: number;
  /** USD notional still open (ManagedPositionState.remainingPositionSize convention) — NOT base-asset qty. */
  remainingPositionSize: number;
}

export interface CurrentPositionRisk {
  /** USD-margined linear futures: baseQty * |entry - SL|, never negative (max(0, ...) once SL clears breakeven favorably). */
  openRiskDollar: number;
  /** Non-zero only once currentSlPrice has moved past entryPrice in the favorable direction — the profit guaranteed if SL fills exactly there. Informational; never treated as spare risk-pool capacity. */
  lockedProfitDollar: number;
}

/**
 * TICKET-G1R Final Closure item 5 — explicit per-side formula (doc-only fix, implementation
 * unchanged; verified mathematically equivalent below):
 *   LONG:  openRisk = qty × max(0, entry − SL)
 *   SHORT: openRisk = qty × max(0, SL − entry)
 * where qty = remainingBaseQty = remainingPositionSize / entryPrice (same USD-notional-to-base-qty
 * convention as liveStateSync.ts's sumRemainingBaseQty()). Linear USD-margined contract, no extra
 * multiplier.
 *
 * Equivalence with the `Math.abs(slDelta)` + `favorable` implementation below:
 *   slDelta = currentSlPrice − entryPrice.
 *   LONG: favorable ⇔ slDelta ≥ 0 (SL at/above entry) ⇒ openRisk = 0 = qty×max(0, entry−SL) since
 *     entry−SL ≤ 0 in that case. Unfavorable ⇔ slDelta < 0 ⇒ openRisk = qty×|slDelta| =
 *     qty×(entry−SL) = qty×max(0, entry−SL) since entry−SL > 0 there. Equal in both branches.
 *   SHORT: favorable ⇔ slDelta ≤ 0 (SL at/below entry) ⇒ openRisk = 0 = qty×max(0, SL−entry) since
 *     SL−entry ≤ 0. Unfavorable ⇔ slDelta > 0 ⇒ openRisk = qty×slDelta = qty×(SL−entry) =
 *     qty×max(0, SL−entry). Equal in both branches.
 * So the single `Math.abs()`+`favorable` implementation is exactly the two side-specific formulas
 * above, just expressed without an explicit per-side `max(0, ...)` — no code change needed.
 */
export function computeCurrentPositionRisk(basis: PositionRiskBasis): CurrentPositionRisk {
  const remainingBaseQty = basis.remainingPositionSize / basis.entryPrice;
  const slDelta = basis.currentSlPrice - basis.entryPrice; // >0 = SL above entry, <0 = SL below entry
  const favorable = basis.side === 'LONG' ? slDelta >= 0 : slDelta <= 0;
  const distance = remainingBaseQty * Math.abs(slDelta);
  return {
    openRiskDollar: favorable ? 0 : distance,
    lockedProfitDollar: favorable ? distance : 0,
  };
}

export type RiskLedgerEntryStatus = 'KNOWN' | 'UNKNOWN_EXPOSURE';

export interface RiskLedgerEntry {
  /** Reporting only, e.g. symbol or symbol+side — never used in the arithmetic. */
  id: string;
  status: RiskLedgerEntryStatus;
  openRiskDollar: number;
  lockedProfitDollar: number;
  /** False only for an UNKNOWN_EXPOSURE entry with no basis at all (no persisted/last-known data to even estimate from). */
  quantifiable: boolean;
  /** TICKET-G1R-B item 5 — visibility only, never affects the arithmetic above. Set when this entry is
   * one of 2+ logical positions sharing a Binance one-way-mode merged exchange qty and the per-entry
   * split couldn't be individually proven (liveStateSync.ts's checkMergedPositionAllocation()) —
   * 'UNVERIFIED_SPLIT' means the qty THIS entry claims is the persisted-as-is value, not a re-derived
   * one; undefined for every ordinary (non-merged) position. */
  allocationQuality?: 'VERIFIED_SPLIT' | 'UNVERIFIED_SPLIT';
}

/** A normal, currently-tracked open position — always quantifiable. */
export interface KnownPositionForRisk {
  id: string;
  basis: PositionRiskBasis;
  /** TICKET-G1R-B item 5 — passthrough only, see RiskLedgerEntry.allocationQuality's doc comment. */
  allocationQuality?: 'VERIFIED_SPLIT' | 'UNVERIFIED_SPLIT';
}

/**
 * An exchange-only/unreconciled/quarantined position (Checkpoint C's QUARANTINED, Checkpoint B's
 * unreconciled fill). `basis: null` = genuinely no data to estimate from (e.g. a pure ghost
 * exchange position with no persisted record ever proving ownership) — MUST NOT be treated as
 * risk 0; callers must block admission portfolio-wide in that case (see rebuildPortfolioRisk's
 * `hasUnquantifiableExposure`). `basis: <PositionRiskBasis>` = a conservative estimate exists
 * (persisted/last-known qty, entry, SL) and is used exactly like a known position's risk formula.
 */
export interface UnknownExposureForRisk {
  id: string;
  basis: PositionRiskBasis | null;
}

export interface PortfolioRiskResult {
  totalRiskDollar: number;
  totalLockedProfitDollar: number;
  entries: RiskLedgerEntry[];
  /** True when ANY unknown exposure has no basis to estimate from — admission must be blocked for the WHOLE portfolio, not just the affected symbol, until it's reconciled with evidence. */
  hasUnquantifiableExposure: boolean;
}

/**
 * THE rebuild-from-scratch entrypoint: takes every currently open position (known + unknown/
 * quarantined) and returns the portfolio's current total committed risk. Callers must call this
 * again every time they need the number (e.g. right before the risk-pool admission check) rather
 * than maintaining a running total — deliberately no incremental add/subtract API exists here.
 * Pure and deterministic: same input always yields the same output, any number of times.
 */
export function rebuildPortfolioRisk(params: { knownPositions: KnownPositionForRisk[]; unknownExposures: UnknownExposureForRisk[] }): PortfolioRiskResult {
  const entries: RiskLedgerEntry[] = [];

  for (const p of params.knownPositions) {
    const { openRiskDollar, lockedProfitDollar } = computeCurrentPositionRisk(p.basis);
    entries.push({ id: p.id, status: 'KNOWN', openRiskDollar, lockedProfitDollar, quantifiable: true, ...(p.allocationQuality ? { allocationQuality: p.allocationQuality } : {}) });
  }

  for (const u of params.unknownExposures) {
    if (u.basis === null) {
      entries.push({ id: u.id, status: 'UNKNOWN_EXPOSURE', openRiskDollar: 0, lockedProfitDollar: 0, quantifiable: false });
      continue;
    }
    const { openRiskDollar, lockedProfitDollar } = computeCurrentPositionRisk(u.basis);
    entries.push({ id: u.id, status: 'UNKNOWN_EXPOSURE', openRiskDollar, lockedProfitDollar, quantifiable: true });
  }

  return {
    totalRiskDollar: entries.reduce((sum, e) => sum + e.openRiskDollar, 0),
    totalLockedProfitDollar: entries.reduce((sum, e) => sum + e.lockedProfitDollar, 0),
    entries,
    hasUnquantifiableExposure: entries.some((e) => !e.quantifiable),
  };
}
