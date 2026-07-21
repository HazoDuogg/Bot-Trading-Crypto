import { describe, expect, it } from 'vitest';
import { MarketRegime } from '../dist/regime/types.js';
import { emptyFunnelStats, funnelReportMarkdown, percentile, type RegimeFunnelStats } from './entryFunnelReport.js';

// TICKET-044 — the bug this guards against: TICKET-043's "Chi tiết lý do MSS FAIL" table only summed
// 3 of the 4 possible reasons (omitted MSS_TIMEOUT), silently under-reporting the total by however
// many MSS_TIMEOUT events occurred. This test mocks a small set of funnel events/stats and verifies
// the report's own "Tổng cộng" row sums to exactly MACRO PASS − MSS PASS (the real MSS FAIL count).
describe('funnelReportMarkdown — MSS FAIL total must match MACRO PASS - MSS PASS (TICKET-044)', () => {
  it('sums all 4 reasons (including MSS_TIMEOUT) to exactly the actual MSS FAIL count, and reports "khớp"', () => {
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      setupPass: 20,
      macroPass: 20,
      mssPass: 2,
      mssFailReasons: {
        NO_HIGHER_LOW_PATTERN: 5,
        NO_REFERENCE_BETWEEN: 3,
        NEVER_BROKE_REFERENCE: 4,
        MSS_TIMEOUT: 6, // 5+3+4+6 = 18 = macroPass(20) - mssPass(2)
      },
      mssTimeoutCandlesLate: [5, 6, 7, 8, 9, 20],
      riskPoolSkip: 0,
      opens: 2,
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 20 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    // The 4 individual reason rows are all present with their exact counts.
    expect(report).toContain('| NO_HIGHER_LOW_PATTERN | 5 |');
    expect(report).toContain('| NO_REFERENCE_BETWEEN | 3 |');
    expect(report).toContain('| NEVER_BROKE_REFERENCE | 4 |');
    expect(report).toContain('| MSS_TIMEOUT | 6 |');
    // The cross-check row: sum (18) must equal macroPass - mssPass (20 - 2 = 18), reported as "khớp".
    expect(report).toContain('Tổng cộng (đối chiếu MACRO PASS − MSS PASS = 18)');
    expect(report).toContain('18 — khớp');
    expect(report).not.toContain('LỆCH');
  });

  it('would report LỆCH if a reason were ever missing from the tally (regression guard for the exact TICKET-043 bug)', () => {
    // Same fixture as above, but with MSS_TIMEOUT dropped from mssFailReasons — reproduces the
    // exact TICKET-043 bug (4th reason silently excluded from the sum) to prove the check row catches it.
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      macroPass: 20,
      mssPass: 2,
      mssFailReasons: { NO_HIGHER_LOW_PATTERN: 5, NO_REFERENCE_BETWEEN: 3, NEVER_BROKE_REFERENCE: 4 }, // MSS_TIMEOUT missing -> sums to 12, not 18
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 20 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('12 — LỆCH, kiểm tra lại!');
  });
});

describe('percentile — linear interpolation, same method as calibrateThresholds.ts (TICKET-044)', () => {
  it('matches known values for a simple sorted series', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 50)).toBeCloseTo(5.5, 5);
    expect(percentile(sorted, 100)).toBe(10);
  });
});
