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

// TICKET-054 Phần A — same "tổng khớp" discipline, applied to the new SETUP FAIL breakdown.
// SETUP is the direct child of STATE PASS on TREND_RIDER's TREND_STYLE cascade, so the
// reconciliation target is STATE PASS - SETUP PASS.
describe('funnelReportMarkdown — SETUP FAIL total must match STATE PASS - SETUP PASS (TICKET-054)', () => {
  it('sums NO_OB_CANDIDATE + OB_FOUND_NO_BOS to exactly the actual SETUP FAIL count, and reports "khớp"', () => {
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      setupPass: 3,
      macroPass: 3, // no MACRO fail in this fixture — keeps the unrelated MACRO FAIL section at "khớp"
      mssPass: 3, // no MSS fail either — keeps the unrelated MSS FAIL section at "khớp"
      setupFailReasons: {
        NO_OB_CANDIDATE: 12,
        OB_FOUND_NO_BOS: 5, // 12+5 = 17 = state(20) - setupPass(3)
      },
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 20 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('| NO_OB_CANDIDATE | 12 |');
    expect(report).toContain('| OB_FOUND_NO_BOS | 5 |');
    expect(report).toContain('| NO_FVG_CANDIDATE | 0 |');
    expect(report).toContain('| NO_SWEEP_CANDIDATE | 0 |');
    expect(report).toContain('Tổng cộng (đối chiếu STATE PASS − SETUP PASS = 17)');
    expect(report).toContain('17 — khớp');
    expect(report).not.toContain('LỆCH');
  });

  it('would report LỆCH if a reason were ever missing from the tally', () => {
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      setupPass: 3,
      macroPass: 3,
      setupFailReasons: { NO_OB_CANDIDATE: 12 }, // OB_FOUND_NO_BOS missing -> sums to 12, not 17
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 20 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('12 — LỆCH, kiểm tra lại!');
  });
});

// TICKET-054 Phần B — MACRO FAIL split by side (not a new reason — still MACRO_TREND_OPPOSITE only).
// MACRO is the direct child of SETUP PASS on TREND_RIDER's TREND_STYLE cascade, so the
// reconciliation target is SETUP PASS - MACRO PASS.
describe('funnelReportMarkdown — MACRO FAIL by side total must match SETUP PASS - MACRO PASS (TICKET-054)', () => {
  it('sums LONG + SHORT to exactly the actual MACRO FAIL count, and reports "khớp"', () => {
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      setupPass: 20,
      setupFailReasons: { NO_OB_CANDIDATE: 10 }, // matches state(30) - setupPass(20), keeps the unrelated SETUP FAIL section at "khớp"
      macroPass: 5,
      macroFailBySide: { LONG: 9, SHORT: 6 }, // 9+6 = 15 = setupPass(20) - macroPass(5)
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 30 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(30, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('| LONG (macroDirection=DOWN) | 9 |');
    expect(report).toContain('| SHORT (macroDirection=UP) | 6 |');
    expect(report).toContain('Tổng cộng (đối chiếu SETUP PASS − MACRO PASS = 15)');
    expect(report).toContain('15 — khớp');
  });

  it('would report LỆCH if the side split under/over-counts relative to actual MACRO FAIL', () => {
    const trendRiderStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      setupPass: 20,
      macroPass: 5,
      macroFailBySide: { LONG: 9, SHORT: 0 }, // sums to 9, not 15
    };
    const stateCounts = { [MarketRegime.TREND_RIDER]: 30 };
    const funnelStats = { [MarketRegime.TREND_RIDER]: trendRiderStats };

    const report = funnelReportMarkdown(30, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('9 — LỆCH, kiểm tra lại!');
  });
});

// TICKET-053 — same "tổng khớp" discipline as TICKET-044's MSS_TIMEOUT lesson, applied to the new
// BREAKOUT FAIL breakdown. BREAKOUT is the direct child of STATE PASS on SIDEWAY_STYLE regimes (no
// separate MACRO stage), so the reconciliation target is STATE PASS - BREAKOUT PASS.
describe('funnelReportMarkdown — BREAKOUT FAIL total must match STATE PASS - BREAKOUT PASS (TICKET-053)', () => {
  it('sums all 3 reasons to exactly the actual BREAKOUT FAIL count, and reports "khớp"', () => {
    const sidewayStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      breakoutPass: 3,
      breakoutFailReasons: {
        NO_EDGE_TOUCH: 10,
        BODY_TOO_SMALL: 4,
        VOLUME_NOT_ELEVATED: 3, // 10+4+3 = 17 = state(20) - breakoutPass(3)
      },
      riskPoolSkip: 0,
      opens: 3,
    };
    const stateCounts = { [MarketRegime.SIDEWAY_SCALPER]: 20 };
    const funnelStats = { [MarketRegime.SIDEWAY_SCALPER]: sidewayStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('| NO_EDGE_TOUCH | 10 |');
    expect(report).toContain('| BODY_TOO_SMALL | 4 |');
    expect(report).toContain('| VOLUME_NOT_ELEVATED | 3 |');
    expect(report).toContain('Tổng cộng (đối chiếu STATE PASS − BREAKOUT PASS = 17)');
    expect(report).toContain('17 — khớp');
    expect(report).not.toContain('LỆCH');
  });

  it('would report LỆCH if a reason were ever missing from the tally (e.g. a future MACRO_TREND_OPPOSITE-like omission)', () => {
    const sidewayStats: RegimeFunnelStats = {
      ...emptyFunnelStats(),
      breakoutPass: 3,
      breakoutFailReasons: { NO_EDGE_TOUCH: 10, BODY_TOO_SMALL: 4 }, // VOLUME_NOT_ELEVATED missing -> sums to 14, not 17
    };
    const stateCounts = { [MarketRegime.SIDEWAY_SCALPER]: 20 };
    const funnelStats = { [MarketRegime.SIDEWAY_SCALPER]: sidewayStats };

    const report = funnelReportMarkdown(20, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain('14 — LỆCH, kiểm tra lại!');
  });

  it('renders a separate breakdown section per SIDEWAY_STYLE regime (SIDEWAY_SCALPER, COMPRESSION, NEUTRAL_TRANSITION)', () => {
    const stats = (breakoutPass: number): RegimeFunnelStats => ({
      ...emptyFunnelStats(),
      breakoutPass,
      breakoutFailReasons: { NO_EDGE_TOUCH: 1 },
    });
    const stateCounts = {
      [MarketRegime.SIDEWAY_SCALPER]: 2,
      [MarketRegime.COMPRESSION]: 2,
      [MarketRegime.NEUTRAL_TRANSITION]: 2,
    };
    const funnelStats = {
      [MarketRegime.SIDEWAY_SCALPER]: stats(1),
      [MarketRegime.COMPRESSION]: stats(1),
      [MarketRegime.NEUTRAL_TRANSITION]: stats(1),
    };

    const report = funnelReportMarkdown(6, stateCounts, funnelStats, 0, 'SIDEWAY_STYLE');

    expect(report).toContain(`### Chi tiết lý do BREAKOUT FAIL (regime: ${MarketRegime.SIDEWAY_SCALPER})`);
    expect(report).toContain(`### Chi tiết lý do BREAKOUT FAIL (regime: ${MarketRegime.COMPRESSION})`);
    expect(report).toContain(`### Chi tiết lý do BREAKOUT FAIL (regime: ${MarketRegime.NEUTRAL_TRANSITION})`);
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
