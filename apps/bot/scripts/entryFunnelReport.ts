// TICKET-042/043/044 — Entry Funnel Analytics report builder. Pure functions, no side effects, no
// top-level execution — split out of backtest.ts (which calls main() unconditionally on import) so
// this aggregation logic is independently testable.
import { MarketRegime } from '../dist/regime/types.js';
import type { EntryStyleForNeutral } from '../dist/entry/types.js';

export const STATE_PASS_REGIMES = [MarketRegime.TREND_RIDER, MarketRegime.SIDEWAY_SCALPER, MarketRegime.COMPRESSION, MarketRegime.NEUTRAL_TRANSITION] as const;
export const STATE_FAIL_REGIMES = [MarketRegime.DANGER_ZONE, MarketRegime.MANIPULATED, MarketRegime.LOW_LIQUIDITY, MarketRegime.VOLATILE_CHOP, MarketRegime.CORRELATED_RISK] as const;

// TICKET-043/044: every possible reason a stage='MSS' event can carry passed=false — the 3 granular
// "never confirmed" reasons from classifyMssFailReason(), PLUS 'MSS_TIMEOUT' (a confirmation WAS
// found, just too stale — TICKET-011/040's existing staleness check). TICKET-043 originally omitted
// MSS_TIMEOUT from this list, which silently dropped 173 events (54.7% of MSS FAIL) from the
// breakdown table — fixed here by including all 4, with an explicit total-matches-actual row in the
// report so this class of bug is visible immediately if it ever recurs.
export const MSS_FAIL_REASONS = ['NO_HIGHER_LOW_PATTERN', 'NO_REFERENCE_BETWEEN', 'NEVER_BROKE_REFERENCE', 'MSS_TIMEOUT'] as const;

export interface RegimeFunnelStats {
  setupPass: number;
  macroPass: number;
  mssPass: number;
  breakoutPass: number;
  riskPoolSkip: number;
  opens: number;
  mssFailReasons: Record<string, number>;
  /** TICKET-044: candlesLate for every MSS_TIMEOUT event, for the distribution table. */
  mssTimeoutCandlesLate: number[];
}

export function emptyFunnelStats(): RegimeFunnelStats {
  return { setupPass: 0, macroPass: 0, mssPass: 0, breakoutPass: 0, riskPoolSkip: 0, opens: 0, mssFailReasons: {}, mssTimeoutCandlesLate: [] };
}

/** Same linear-interpolation method as calibrateThresholds.ts's describeSeries(), for consistency. */
export function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** TREND_RIDER/SIDEWAY_SCALPER/COMPRESSION always use one fixed cascade; NEUTRAL_TRANSITION follows entryStyleForNeutral (config-driven, same rule as entryRouter.ts's routeEntry()). */
export function pathFor(regime: MarketRegime, entryStyleForNeutral: EntryStyleForNeutral): 'TREND_STYLE' | 'SIDEWAY_STYLE' {
  if (regime === MarketRegime.TREND_RIDER) return 'TREND_STYLE';
  if (regime === MarketRegime.NEUTRAL_TRANSITION) return entryStyleForNeutral;
  return 'SIDEWAY_STYLE'; // SIDEWAY_SCALPER, COMPRESSION
}

export function pct(numerator: number, denominator: number): string {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : '—';
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function funnelReportMarkdown(
  totalStepsEvaluated: number,
  stateCounts: Record<string, number>,
  funnelStats: Record<string, RegimeFunnelStats>,
  neutralGateRejectedCount: number,
  entryStyleForNeutral: EntryStyleForNeutral,
): string {
  const statePass = STATE_PASS_REGIMES.reduce((sum, r) => sum + (stateCounts[r] ?? 0), 0);

  // Per-regime pre-gate/gate/risk-pool/entry counts, computed once and reused by both the aggregate
  // and per-regime sections below (single source of truth, never re-derived differently twice).
  const perRegime = STATE_PASS_REGIMES.map((regime) => {
    const stats = funnelStats[regime] ?? emptyFunnelStats();
    const path = pathFor(regime, entryStyleForNeutral);
    const preGate = path === 'TREND_STYLE' ? stats.mssPass : stats.breakoutPass;
    const gatePass = regime === MarketRegime.NEUTRAL_TRANSITION ? preGate - neutralGateRejectedCount : preGate;
    const riskPoolPass = gatePass - stats.riskPoolSkip;
    return { regime, path, stats, preGate, gatePass, riskPoolPass };
  });

  const setupPassTotal = perRegime.filter((r) => r.path === 'TREND_STYLE').reduce((sum, r) => sum + r.stats.setupPass, 0);
  const macroOrBreakoutPassTotal = perRegime.reduce((sum, r) => sum + (r.path === 'TREND_STYLE' ? r.stats.macroPass : r.stats.breakoutPass), 0);
  const mssPassTotal = perRegime.filter((r) => r.path === 'TREND_STYLE').reduce((sum, r) => sum + r.stats.mssPass, 0);
  const aiGatePassTotal = perRegime.find((r) => r.regime === MarketRegime.NEUTRAL_TRANSITION)?.gatePass ?? 0;
  const aiGatePreGate = perRegime.find((r) => r.regime === MarketRegime.NEUTRAL_TRANSITION)?.preGate ?? 0;
  const riskPoolPassTotal = perRegime.reduce((sum, r) => sum + r.riskPoolPass, 0);
  const entryTotal = perRegime.reduce((sum, r) => sum + r.stats.opens, 0);
  // "Cửa trước" for RISK POOL PASS: everything that reached the risk-pool check this step —
  // TREND_STYLE/SIDEWAY_STYLE regimes go straight from MSS/BREAKOUT, NEUTRAL_TRANSITION goes through
  // the AI gate first. Mirrors exactly what orchestrator.ts checks immediately before the pool.
  const reachedRiskPoolCheckTotal = perRegime.reduce((sum, r) => sum + (r.regime === MarketRegime.NEUTRAL_TRANSITION ? r.gatePass : r.preGate), 0);

  const aggregateRows = [
    `| Tổng bước đánh giá | ${fmtInt(totalStepsEvaluated)} | — |`,
    `| STATE PASS | ${fmtInt(statePass)} | ${pct(statePass, totalStepsEvaluated)} |`,
    `| SETUP PASS (nhánh TREND_STYLE) | ${fmtInt(setupPassTotal)} | ${pct(setupPassTotal, statePass)} |`,
    `| MACRO/BREAKOUT PASS | ${fmtInt(macroOrBreakoutPassTotal)} | ${pct(macroOrBreakoutPassTotal, setupPassTotal)} |`,
    `| MSS PASS (nhánh TREND_STYLE) | ${fmtInt(mssPassTotal)} | ${pct(mssPassTotal, macroOrBreakoutPassTotal)} |`,
    `| AI GATE PASS (NEUTRAL_TRANSITION) | ${fmtInt(aiGatePassTotal)} | ${pct(aiGatePassTotal, aiGatePreGate)} |`,
    `| RISK POOL PASS | ${fmtInt(riskPoolPassTotal)} | ${pct(riskPoolPassTotal, reachedRiskPoolCheckTotal)} |`,
    `| ENTRY (mở lệnh thật) | ${fmtInt(entryTotal)} | ${pct(entryTotal, riskPoolPassTotal)} |`,
  ];

  const regimeSections = perRegime.map(({ regime, path, stats, preGate, gatePass, riskPoolPass }) => {
    const state = stateCounts[regime] ?? 0;

    const rows: string[] = [`| STATE PASS | ${fmtInt(state)} | — |`];
    if (path === 'TREND_STYLE') {
      rows.push(`| SETUP PASS | ${fmtInt(stats.setupPass)} | ${pct(stats.setupPass, state)} |`);
      rows.push(`| MACRO PASS | ${fmtInt(stats.macroPass)} | ${pct(stats.macroPass, stats.setupPass)} |`);
      rows.push(`| MSS PASS | ${fmtInt(stats.mssPass)} | ${pct(stats.mssPass, stats.macroPass)} |`);
    } else {
      rows.push(`| BREAKOUT PASS | ${fmtInt(stats.breakoutPass)} | ${pct(stats.breakoutPass, state)} |`);
    }
    if (regime === MarketRegime.NEUTRAL_TRANSITION) {
      rows.push(`| AI GATE PASS | ${fmtInt(gatePass)} | ${pct(gatePass, preGate)} |`);
    }
    rows.push(`| RISK POOL PASS | ${fmtInt(riskPoolPass)} | ${pct(riskPoolPass, gatePass)} |`);
    rows.push(`| ENTRY (mở lệnh thật) | ${fmtInt(stats.opens)} | ${pct(stats.opens, riskPoolPass)} |`);

    const section = [`### ${regime} (nhánh ${path})`, '', '| Cửa | Số lượng | Tỷ lệ chuyển đổi từ cửa trước |', '|---|---|---|', ...rows, ''].join('\n');

    // TICKET-043/044 — MSS fail breakdown, TREND_RIDER only (the only regime whose fixed cascade is
    // TREND_STYLE in every config this session has run; SIDEWAY_STYLE has no MSS stage at all).
    if (regime === MarketRegime.TREND_RIDER) {
      const mssFailTotal = MSS_FAIL_REASONS.reduce((sum, r) => sum + (stats.mssFailReasons[r] ?? 0), 0);
      // TICKET-044: actual MSS FAIL = every MACRO-passed step that didn't also pass MSS — the same
      // number the 4 reasons above must sum to exactly. Rendered as its own row so a future omission
      // (like TICKET-043 dropping MSS_TIMEOUT) is caught by inspection instead of silently under-counting.
      const actualMssFail = stats.macroPass - stats.mssPass;
      const mssFailRows = MSS_FAIL_REASONS.map(
        (r) => `| ${r} | ${fmtInt(stats.mssFailReasons[r] ?? 0)} | ${pct(stats.mssFailReasons[r] ?? 0, mssFailTotal)} |`,
      );
      mssFailRows.push(
        `| **Tổng cộng (đối chiếu MACRO PASS − MSS PASS = ${fmtInt(actualMssFail)})** | ${fmtInt(mssFailTotal)}${mssFailTotal === actualMssFail ? ' — khớp' : ' — LỆCH, kiểm tra lại!'} | 100.0% |`,
      );
      const mssFailSection = [
        '### Chi tiết lý do MSS FAIL (nhánh TREND_RIDER)',
        '',
        '| Lý do | Số lượng | % trên tổng MSS FAIL |',
        '|---|---|---|',
        ...mssFailRows,
        '',
      ].join('\n');

      // TICKET-044 Phần B — distribution of candlesLate across every MSS_TIMEOUT event.
      const sortedLate = [...stats.mssTimeoutCandlesLate].sort((a, b) => a - b);
      const distRows =
        sortedLate.length > 0
          ? [
              `| min | ${fmtInt(sortedLate[0])} |`,
              `| p25 | ${percentile(sortedLate, 25).toFixed(1)} |`,
              `| p50 (median) | ${percentile(sortedLate, 50).toFixed(1)} |`,
              `| p75 | ${percentile(sortedLate, 75).toFixed(1)} |`,
              `| p90 | ${percentile(sortedLate, 90).toFixed(1)} |`,
              `| max | ${fmtInt(sortedLate[sortedLate.length - 1])} |`,
            ]
          : [`| (không có case MSS_TIMEOUT nào) | — |`];
      const mssTimeoutDistSection = [
        '### Phân phối độ trễ MSS_TIMEOUT (nhánh TREND_RIDER)',
        '',
        '| Thống kê | Giá trị (số nến 1m trễ) |',
        '|---|---|',
        ...distRows,
        '',
      ].join('\n');

      return section + '\n' + mssFailSection + '\n' + mssTimeoutDistSection;
    }
    return section;
  });

  return [
    '# Entry Funnel Analytics — TICKET-042',
    '',
    'Công cụ quan sát (observability) — không đổi bất kỳ logic quyết định giao dịch nào. Số liệu nguyên văn, không tự kết luận.',
    '',
    '## Funnel tổng hợp (toàn bộ 4 coin, 180 ngày)',
    '',
    '| Cửa | Số lượng | Tỷ lệ chuyển đổi từ cửa trước |',
    '|---|---|---|',
    ...aggregateRows,
    '',
    '## Funnel theo từng regime',
    '',
    ...regimeSections,
  ].join('\n');
}
