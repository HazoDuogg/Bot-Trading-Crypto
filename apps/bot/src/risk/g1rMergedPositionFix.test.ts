/**
 * TICKET-G1R-B "Runtime Wiring Pass" item 5 — same-side merged-position exchange-qty safety.
 * `checkMergedPositionAllocation()` (liveStateSync.ts) covers the runtime CHECK; `rebuildPortfolioRisk()`
 * (currentRisk.ts) proves the exposure itself is NEVER dropped from the risk ledger regardless of the
 * allocation-quality outcome — only the PER-ENTRY split's provenance is flagged, never the presence of
 * risk.
 */
import { describe, it, expect } from 'vitest';
import { checkMergedPositionAllocation } from '../live/liveStateSync.js';
import { rebuildPortfolioRisk, type KnownPositionForRisk } from './currentRisk.js';

describe('Item 5 — checkMergedPositionAllocation', () => {
  it('sum matches exchange qty, 2 logical entries -> RECONCILED / UNVERIFIED_SPLIT (never re-splits by a guessed ratio)', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: null,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('RECONCILED');
    if (result.status === 'RECONCILED') expect(result.allocationQuality).toBe('UNVERIFIED_SPLIT');
  });

  it('a single persisted entry (not actually merged) -> VERIFIED_SPLIT', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [{ id: 'A', remainingBaseQty: 1.0 }],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: null,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('RECONCILED');
    if (result.status === 'RECONCILED') expect(result.allocationQuality).toBe('VERIFIED_SPLIT');
  });

  it('sum matches exchange qty AND protective (SL) qty matches too -> RECONCILED / UNVERIFIED_SPLIT', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: 1.0,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('RECONCILED');
  });

  it('persisted sum does NOT match exchange qty -> ACCOUNT_STATE_UNKNOWN (whole-portfolio block, never a guessed re-split)', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.5, // mismatch
      protectiveTotalBaseQty: null,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('ACCOUNT_STATE_UNKNOWN');
  });

  it('sum matches exchange qty but protective (SL) qty does NOT reconcile with the total -> ACCOUNT_STATE_UNKNOWN', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4 },
      ],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: 0.5, // under-protected — only half the merged qty has a resting SL
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('ACCOUNT_STATE_UNKNOWN');
  });

  it('differences within tolerance are NOT flagged as mismatches', () => {
    const result = checkMergedPositionAllocation({
      persistedEntries: [
        { id: 'A', remainingBaseQty: 0.6 },
        { id: 'B', remainingBaseQty: 0.4000005 },
      ],
      exchangeBaseQty: 1.0,
      protectiveTotalBaseQty: null,
      quantityTolerance: 0.001,
    });
    expect(result.status).toBe('RECONCILED');
  });
});

describe('Item 5 — rebuildPortfolioRisk never drops merged-position exposure regardless of allocationQuality', () => {
  it('two same-side logical entries (UNVERIFIED_SPLIT allocation) both still contribute their own full risk to the portfolio total — total is NOT reduced/zeroed because the split is unverified', () => {
    const knownPositions: KnownPositionForRisk[] = [
      { id: 'BTCUSDT:LONG:A', basis: { side: 'LONG', entryPrice: 100, currentSlPrice: 95, remainingPositionSize: 60 }, allocationQuality: 'UNVERIFIED_SPLIT' },
      { id: 'BTCUSDT:LONG:B', basis: { side: 'LONG', entryPrice: 100, currentSlPrice: 95, remainingPositionSize: 40 }, allocationQuality: 'UNVERIFIED_SPLIT' },
    ];
    const result = rebuildPortfolioRisk({ knownPositions, unknownExposures: [] });
    // openRisk per entry = (notional/entryPrice) * |entry-SL| = (60/100)*5=3.0 and (40/100)*5=2.0 -> total 5.0,
    // identical to what ONE unsplit 100-notional position at the same entry/SL would risk — no exposure lost.
    expect(result.totalRiskDollar).toBeCloseTo(5.0, 6);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.status === 'KNOWN' && e.quantifiable)).toBe(true);
    expect(result.entries.map((e) => e.allocationQuality)).toEqual(['UNVERIFIED_SPLIT', 'UNVERIFIED_SPLIT']);
    expect(result.hasUnquantifiableExposure).toBe(false); // allocation uncertainty is NOT the same as "no data at all" — never blocks admission by itself
  });

  it('allocationQuality is a passthrough-only field — omitting it produces the exact same arithmetic as before this ticket (zero regression on ordinary, non-merged positions)', () => {
    const withFlag = rebuildPortfolioRisk({ knownPositions: [{ id: 'X', basis: { side: 'LONG', entryPrice: 100, currentSlPrice: 95, remainingPositionSize: 100 }, allocationQuality: 'VERIFIED_SPLIT' }], unknownExposures: [] });
    const withoutFlag = rebuildPortfolioRisk({ knownPositions: [{ id: 'X', basis: { side: 'LONG', entryPrice: 100, currentSlPrice: 95, remainingPositionSize: 100 } }], unknownExposures: [] });
    expect(withFlag.totalRiskDollar).toBe(withoutFlag.totalRiskDollar);
    expect(withoutFlag.entries[0].allocationQuality).toBeUndefined();
  });
});
