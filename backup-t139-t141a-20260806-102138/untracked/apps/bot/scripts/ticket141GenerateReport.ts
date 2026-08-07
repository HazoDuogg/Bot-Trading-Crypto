/**
 * TICKET-141 — 5m Local Trade Thesis Engine report generator. Pure post-processing: reads the
 * per-candle diagnostic CSV backtest.ts wrote (data/ticket141-5m-local-trade-thesis-<suffix>.csv,
 * one row per closed 5m candle per symbol — see localTradeThesis5m.ts), computes §9's required
 * tables (distribution / funnel / by-HTFContext / by-SafetyState5m / by-setup), then for every
 * VALID_LONG/VALID_SHORT row runs an ISOLATED offline outcome simulation (§10) reusing the EXACT
 * production functions ticket132NeutralCandidateAudit.ts already established as the reusable
 * pattern: risk/slTpManager.ts's openPosition()/computeRealizedPnl() + orchestrator.ts's
 * advancePosition()/selectTpPlan() (all from dist/, compiled — run `npm run build` first). No risk
 * pool, no concurrency between candidates (§10 explicit). Never re-derives SL/TP/trailing formulas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type CandleData } from '../dist/regime/types.js';
import { advancePosition, selectTpPlan } from '../dist/orchestrator/orchestrator.js';
import type { OrchestratorConfig } from '../dist/orchestrator/types.js';
import { openPosition, computeRealizedPnl, type ManagedPositionState, type TpPlan } from '../dist/risk/slTpManager.js';

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const WINDOW_5M = 320; // matches backtest.ts's own trailing-ATR window size

const POSITION_SIZE_USD = 1000; // JUDGMENT CALL — same fixed notional precedent as ticket132NeutralCandidateAudit.ts, no risk pool per §10.
const TAKER_FEE_RATE = 0.0004; // Same constant used throughout the codebase (config.ts/backtest.ts default).

interface ThesisRow {
  symbol: string;
  timestamp: number;
  htfContext: string;
  safetyState5m: string;
  direction5m: string;
  emaRelation: string;
  emaSlope: string;
  diDirection: string;
  structureState: string;
  bosState: string;
  mssState: string;
  swingStructure: string;
  sweepReclaim: string;
  setupType: string;
  setupSide: string;
  setupValid: boolean;
  setupReason: string;
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  distanceFromEmaInAtr: number | null;
  entryQualityPassed: boolean;
  entryQualityReason: string;
  localThesis: string;
  thesisReason: string;
}

/** Minimal CSV line parser handling double-quoted fields with embedded commas/escaped quotes (setupReason/entryQualityReason/thesisReason columns). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readThesisCsv(csvPath: string): ThesisRow[] {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const idx = (name: string): number => header.indexOf(name);
  return lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    const numOrNull = (v: string): number | null => (v === '' ? null : Number(v));
    return {
      symbol: c[idx('symbol')],
      timestamp: Number(c[idx('timestamp')]),
      htfContext: c[idx('htfContext')],
      safetyState5m: c[idx('safetyState5m')],
      direction5m: c[idx('direction5m')],
      emaRelation: c[idx('emaRelation')],
      emaSlope: c[idx('emaSlope')],
      diDirection: c[idx('diDirection')],
      structureState: c[idx('structureState')],
      bosState: c[idx('bosState')],
      mssState: c[idx('mssState')],
      swingStructure: c[idx('swingStructure')],
      sweepReclaim: c[idx('sweepReclaim')],
      setupType: c[idx('setupType')],
      setupSide: c[idx('setupSide')],
      setupValid: c[idx('setupValid')] === 'true',
      setupReason: c[idx('setupReason')],
      entryPrice: numOrNull(c[idx('entryPrice')]),
      stopLoss: numOrNull(c[idx('stopLoss')]),
      riskReward: numOrNull(c[idx('riskReward')]),
      distanceFromEmaInAtr: numOrNull(c[idx('distanceFromEmaInAtr')]),
      entryQualityPassed: c[idx('entryQualityPassed')] === 'true',
      entryQualityReason: c[idx('entryQualityReason')],
      localThesis: c[idx('localThesis')],
      thesisReason: c[idx('thesisReason')],
    };
  });
}

function readOhlcvCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

interface OutcomeRow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  localThesis: string;
  htfContext: string;
  setupType: string;
  tpPlan: TpPlan;
  outcome: 'RESOLVED_WIN' | 'RESOLVED_LOSS' | 'UNRESOLVED';
  pnlUsd: number | null;
  rMultiple: number | null; // pnlUsd / (positionSize * r/entryPrice) — actual realized R, for Avg R
}

/** §10 outcome stats: WR/PF/Avg R/Net PnL over RESOLVED rows only (UNRESOLVED excluded, never force-resolved). */
interface OutcomeStats {
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  wr: number;
  grossProfit: number;
  grossLoss: number;
  pf: number;
  avgR: number;
  netPnl: number;
}

function computeOutcomeStats(rows: OutcomeRow[]): OutcomeStats {
  const resolvedRows = rows.filter((r) => r.outcome !== 'UNRESOLVED');
  const wins = resolvedRows.filter((r) => r.outcome === 'RESOLVED_WIN');
  const losses = resolvedRows.filter((r) => r.outcome === 'RESOLVED_LOSS');
  const grossProfit = wins.reduce((sum, r) => sum + (r.pnlUsd as number), 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + (r.pnlUsd as number), 0));
  const netPnl = resolvedRows.reduce((sum, r) => sum + (r.pnlUsd as number), 0);
  const rValues = resolvedRows.map((r) => r.rMultiple as number).filter((v) => Number.isFinite(v));
  const avgR = rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : 0;
  return {
    resolved: resolvedRows.length,
    unresolved: rows.length - resolvedRows.length,
    wins: wins.length,
    losses: losses.length,
    wr: resolvedRows.length > 0 ? (wins.length / resolvedRows.length) * 100 : 0,
    grossProfit,
    grossLoss,
    pf: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : 0,
    avgR,
    netPnl,
  };
}

function statsRow(label: string, s: OutcomeStats): string {
  const pfStr = s.pf === Infinity ? '∞' : s.pf.toFixed(2);
  return `| ${label} | ${s.resolved} (${s.unresolved} UNRESOLVED) | ${s.wr.toFixed(1)}% | ${pfStr} | ${s.avgR.toFixed(2)}R | $${s.netPnl.toFixed(2)} |`;
}

/** TICKET-137's buildPeriods() algorithm (lines 564-575 of ticket137NeutralMomentumSideBiasTrace.ts) — percentile-of-sorted-timestamps tercile split by CANDIDATE COUNT, not equal calendar time. */
function buildPeriods(sortedTimestamps: number[]): { label: string; fromMs: number; toMsExclusive: number }[] {
  const n = sortedTimestamps.length;
  if (n === 0) return [];
  const p1 = sortedTimestamps[Math.floor(n / 3)];
  const p2 = sortedTimestamps[Math.floor((2 * n) / 3)];
  const min = sortedTimestamps[0];
  const max = sortedTimestamps[n - 1] + 1;
  return [
    { label: 'P1', fromMs: min, toMsExclusive: p1 },
    { label: 'P2', fromMs: p1, toMsExclusive: p2 },
    { label: 'P3', fromMs: p2, toMsExclusive: max },
  ];
}

export async function generateTicket141Report(csvPath: string, outputPath: string, config: OrchestratorConfig, suffix: string): Promise<void> {
  const rows = readThesisCsv(csvPath);
  const symbols = Array.from(new Set(rows.map((r) => r.symbol))).sort();

  // ---- §9.1 Phân bố thesis ----
  const thesisCategories = ['VALID_LONG', 'VALID_SHORT', 'WEAK_LONG', 'WEAK_SHORT', 'NONE'];
  const thesisCounts: Record<string, number> = {};
  for (const t of thesisCategories) thesisCounts[t] = rows.filter((r) => r.localThesis === t).length;
  const distributionRows = thesisCategories.map((t) => `| ${t} | ${thesisCounts[t]} | ${pct(thesisCounts[t], rows.length)} |`);

  // ---- §9.2 Funnel (Stage|LONG|SHORT) ----
  const directionClearLong = rows.filter((r) => r.direction5m === 'LONG').length;
  const directionClearShort = rows.filter((r) => r.direction5m === 'SHORT').length;
  const structureConfirmedLong = rows.filter((r) => r.direction5m === 'LONG' && r.structureState === 'CONFIRMED_LONG').length;
  const structureConfirmedShort = rows.filter((r) => r.direction5m === 'SHORT' && r.structureState === 'CONFIRMED_SHORT').length;
  const hasSetupLong = rows.filter((r) => r.direction5m === 'LONG' && r.setupValid).length;
  const hasSetupShort = rows.filter((r) => r.direction5m === 'SHORT' && r.setupValid).length;
  const entryQualityPassLong = rows.filter((r) => r.direction5m === 'LONG' && r.entryQualityPassed).length;
  const entryQualityPassShort = rows.filter((r) => r.direction5m === 'SHORT' && r.entryQualityPassed).length;
  const validLong = thesisCounts['VALID_LONG'];
  const validShort = thesisCounts['VALID_SHORT'];
  const funnelRows = [
    `| Direction rõ | ${directionClearLong} | ${directionClearShort} |`,
    `| Structure xác nhận | ${structureConfirmedLong} | ${structureConfirmedShort} |`,
    `| Có setup | ${hasSetupLong} | ${hasSetupShort} |`,
    `| Entry Quality PASS | ${entryQualityPassLong} | ${entryQualityPassShort} |`,
    `| VALID thesis | ${validLong} | ${validShort} |`,
  ];

  // ---- §9.3 Theo HTFContext ----
  const htfContexts = Array.from(new Set(rows.map((r) => r.htfContext))).sort();
  const byHtfRows = htfContexts.map((ctx) => {
    const subset = rows.filter((r) => r.htfContext === ctx);
    const vLong = subset.filter((r) => r.localThesis === 'VALID_LONG').length;
    const vShort = subset.filter((r) => r.localThesis === 'VALID_SHORT').length;
    const weak = subset.filter((r) => r.localThesis === 'WEAK_LONG' || r.localThesis === 'WEAK_SHORT').length;
    const none = subset.filter((r) => r.localThesis === 'NONE').length;
    return `| ${ctx} | ${vLong} | ${vShort} | ${weak} | ${none} |`;
  });

  // ---- §9.4 Theo SafetyState5m ----
  const safetyStates = Array.from(new Set(rows.map((r) => r.safetyState5m))).sort();
  const bySafetyRows = safetyStates.map((st) => {
    const subset = rows.filter((r) => r.safetyState5m === st);
    const vLong = subset.filter((r) => r.localThesis === 'VALID_LONG').length;
    const vShort = subset.filter((r) => r.localThesis === 'VALID_SHORT').length;
    const weak = subset.filter((r) => r.localThesis === 'WEAK_LONG' || r.localThesis === 'WEAK_SHORT').length;
    const none = subset.filter((r) => r.localThesis === 'NONE').length;
    return `| ${st} | ${vLong} | ${vShort} | ${weak} | ${none} |`;
  });

  // ---- §9.5 Theo setup (Setup|Side|Candidates|VALID|WEAK) ----
  const setupTypes = ['OB', 'FVG', 'SWEEP', 'BOX_BREAKOUT', 'MOMENTUM_DIRECT'];
  const bySetupRows: string[] = [];
  for (const st of setupTypes) {
    for (const side of ['LONG', 'SHORT'] as const) {
      const subset = rows.filter((r) => r.setupType === st && r.setupSide === side);
      if (subset.length === 0) continue;
      const valid = subset.filter((r) => r.localThesis === (side === 'LONG' ? 'VALID_LONG' : 'VALID_SHORT')).length;
      const weak = subset.filter((r) => r.localThesis === (side === 'LONG' ? 'WEAK_LONG' : 'WEAK_SHORT')).length;
      bySetupRows.push(`| ${st} | ${side} | ${subset.length} | ${valid} | ${weak} |`);
    }
  }

  // ---- §10 Outcome offline simulation for VALID_LONG/VALID_SHORT rows ----
  const validRows = rows.filter((r) => r.localThesis === 'VALID_LONG' || r.localThesis === 'VALID_SHORT');
  const candlesBySymbol: Record<string, CandleData[]> = {};
  for (const s of symbols) {
    candlesBySymbol[s] = readOhlcvCsv(path.join(OHLCV_DIR, `${s}_5m.csv`));
  }

  const outcomeRows: OutcomeRow[] = [];
  for (const r of validRows) {
    if (r.entryPrice === null || r.stopLoss === null) continue; // should never happen for VALID rows, but guard anyway
    const side: 'LONG' | 'SHORT' = r.localThesis === 'VALID_LONG' ? 'LONG' : 'SHORT';
    const candles = candlesBySymbol[r.symbol];
    const entryStep = candles.findIndex((c) => c.timestamp === r.timestamp);
    if (entryStep === -1) {
      outcomeRows.push({ symbol: r.symbol, timestamp: r.timestamp, side, localThesis: r.localThesis, htfContext: r.htfContext, setupType: r.setupType, tpPlan: config.tpPlan, outcome: 'UNRESOLVED', pnlUsd: null, rMultiple: null });
      continue;
    }

    // TICKET-141 §10: no real momentumScore available for OB/FVG/SWEEP/BOX_BREAKOUT candidates
    // (MOMENTUM_DIRECT is never a valid setup in this engine — see localTradeThesis5m.ts's judgment
    // call). selectTpPlan(undefined momentumScore) always returns config.tpPlan unchanged regardless
    // of planAutoSelectionConfig — still called (not bypassed) to use the SAME reusable production
    // function/config the official baseline uses, per the ticket's own instruction.
    const tpPlan = selectTpPlan(config.tpPlan, undefined, config.planAutoSelectionConfig);

    let pos: ManagedPositionState;
    try {
      pos = openPosition({ scenario: 'TREND', entryPrice: r.entryPrice, slPrice: r.stopLoss, side, tpPlan, positionSize: POSITION_SIZE_USD, takerFeeRate: TAKER_FEE_RATE });
    } catch {
      outcomeRows.push({ symbol: r.symbol, timestamp: r.timestamp, side, localThesis: r.localThesis, htfContext: r.htfContext, setupType: r.setupType, tpPlan, outcome: 'UNRESOLVED', pnlUsd: null, rMultiple: null });
      continue;
    }

    let resolved = false;
    let exitPrice: number | null = null;
    for (let step = entryStep + 1; step < candles.length; step++) {
      const candle = candles[step];
      const window5m = candles.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const { position, exitPrice: ep } = advancePosition(pos, candle, window5m, config.isLowConfidenceOrLowLiquidity);
      pos = position;
      if (pos.closed) {
        resolved = true;
        exitPrice = ep;
        break;
      }
    }

    if (!resolved) {
      outcomeRows.push({ symbol: r.symbol, timestamp: r.timestamp, side, localThesis: r.localThesis, htfContext: r.htfContext, setupType: r.setupType, tpPlan, outcome: 'UNRESOLVED', pnlUsd: null, rMultiple: null });
      continue;
    }
    const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
    const rMultiple = pnlUsd / (POSITION_SIZE_USD * (pos.r / pos.entryPrice));
    outcomeRows.push({ symbol: r.symbol, timestamp: r.timestamp, side, localThesis: r.localThesis, htfContext: r.htfContext, setupType: r.setupType, tpPlan, outcome: pnlUsd > 0 ? 'RESOLVED_WIN' : 'RESOLVED_LOSS', pnlUsd, rMultiple });
  }

  const overall = computeOutcomeStats(outcomeRows);
  const longOutcome = computeOutcomeStats(outcomeRows.filter((r) => r.side === 'LONG'));
  const shortOutcome = computeOutcomeStats(outcomeRows.filter((r) => r.side === 'SHORT'));
  const byHtfOutcome = htfContexts.map((ctx) => ({ ctx, stats: computeOutcomeStats(outcomeRows.filter((r) => r.htfContext === ctx)) })).filter((x) => x.stats.resolved + x.stats.unresolved > 0);
  const bySetupOutcome = setupTypes.map((st) => ({ st, stats: computeOutcomeStats(outcomeRows.filter((r) => r.setupType === st)) })).filter((x) => x.stats.resolved + x.stats.unresolved > 0);
  const byCoinOutcome = symbols.map((s) => ({ s, stats: computeOutcomeStats(outcomeRows.filter((r) => r.symbol === s)) })).filter((x) => x.stats.resolved + x.stats.unresolved > 0);

  // 3 tercile periods with ~equal candidate counts (TICKET-137's buildPeriods algorithm)
  const sortedTs = outcomeRows.map((r) => r.timestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedTs);
  const byPeriodOutcome = periods.map((p) => ({
    label: p.label,
    stats: computeOutcomeStats(outcomeRows.filter((r) => r.timestamp >= p.fromMs && r.timestamp < p.toMsExclusive)),
  }));

  // ---- §12 PASS/FAIL criteria ----
  const totalRows = rows.length;
  const validPct = pct(validLong + validShort, totalRows);
  const validPctNum = totalRows > 0 ? ((validLong + validShort) / totalRows) * 100 : 0;
  const bothSidesHaveSample = validLong > 0 && validShort > 0;
  const pfOverall = overall.pf;
  const pfAboveThreshold = pfOverall > 1.1;
  const netPnlPositive = overall.netPnl > 0;
  const periodsWithPfAbove1 = byPeriodOutcome.filter((p) => p.stats.resolved > 0 && p.stats.pf > 1).length;
  const atLeast2of3PeriodsPfAbove1 = periodsWithPfAbove1 >= 2;

  const winRows = outcomeRows.filter((r) => r.outcome === 'RESOLVED_WIN').sort((a, b) => (b.pnlUsd as number) - (a.pnlUsd as number));
  const top3GrossProfit = winRows.slice(0, 3).reduce((sum, r) => sum + (r.pnlUsd as number), 0);
  const top3PctOfGrossProfit = overall.grossProfit > 0 ? (top3GrossProfit / overall.grossProfit) * 100 : 0;
  const notTop3Dependent = top3PctOfGrossProfit <= 60 || overall.grossProfit === 0;

  const validNotTooWide = validPctNum <= 30; // no ticket-given exact bar for "quá rộng bất thường" — 30% chosen as a conservative sanity bound, documented in report, not tuned after seeing outcomes.

  const pass1 = validNotTooWide;
  const pass2 = bothSidesHaveSample;
  const pass3 = pfAboveThreshold;
  const pass4 = netPnlPositive;
  const pass5 = atLeast2of3PeriodsPfAbove1;
  const pass6 = notTop3Dependent;

  // Which layer filters most (Direction/Structure/Setup/EntryQuality) — for §12's mandatory explanation when VALID is too small.
  const directionTotal = directionClearLong + directionClearShort;
  const structureTotal = structureConfirmedLong + structureConfirmedShort;
  const setupTotal = hasSetupLong + hasSetupShort;
  const eqTotal = entryQualityPassLong + entryQualityPassShort;
  const layerDropoffs = [
    { layer: 'Direction', kept: directionTotal, of: totalRows * 2 },
    { layer: 'Structure', kept: structureTotal, of: directionTotal },
    { layer: 'Setup', kept: setupTotal, of: directionTotal },
    { layer: 'EntryQuality', kept: eqTotal, of: directionTotal },
  ];

  // ---- §14 mandatory conclusion ----
  let conclusion: string;
  if (!bothSidesHaveSample || (validLong + validShort) < 30) {
    conclusion = 'B — Thesis hợp lý nhưng quá ít mẫu để kết luận chắc chắn; xem funnel §Phân tích tầng bóp bên dưới để biết tầng nào đang chặt nhất.';
  } else if (pass1 && pass2 && pass3 && pass4 && pass5 && pass6) {
    conclusion = 'A — Local Thesis có edge và đủ mẫu để sang Decision Matrix.';
  } else if (!pass3 && !pass4) {
    conclusion = 'C — Thesis tạo tín hiệu nhưng không có edge rõ ràng (PF/Net PnL không đạt).';
  } else {
    conclusion = 'B — Thesis hợp lý nhưng chưa đạt đủ tiêu chí PASS; xem bảng PASS/FAIL để biết tiêu chí nào fail.';
  }

  const lines: string[] = [
    '# TICKET-141 — 5m Local Trade Thesis Engine',
    '',
    `Nguồn CSV: \`${csvPath}\` (${rows.length} dòng, symbols: ${symbols.join(', ')}).`,
    `Config suffix: ${suffix}. tpPlan mặc định: ${config.tpPlan}.`,
    '',
    '## 1. Phân bố thesis (§9)',
    '',
    '| Thesis | Count | % |',
    '|---|---|---|',
    ...distributionRows,
    '',
    '## 2. Funnel (§9)',
    '',
    '| Stage | LONG | SHORT |',
    '|---|---|---|',
    ...funnelRows,
    '',
    '## 3. Theo HTFContext (§9)',
    '',
    '| HTFContext | VALID_LONG | VALID_SHORT | WEAK | NONE |',
    '|---|---|---|---|---|',
    ...byHtfRows,
    '',
    '## 4. Theo SafetyState5m (§9)',
    '',
    '| SafetyState5m | VALID_LONG | VALID_SHORT | WEAK | NONE |',
    '|---|---|---|---|---|',
    ...bySafetyRows,
    '',
    '## 5. Theo setup (§9)',
    '',
    '| Setup | Side | Candidates | VALID | WEAK |',
    '|---|---|---|---|---|',
    ...bySetupRows,
    '',
    '## 6. Outcome offline — Tổng quan (§10)',
    '',
    `VALID_LONG + VALID_SHORT candidates: ${validRows.length}. Mô phỏng offline (POSITION_SIZE_USD=${POSITION_SIZE_USD}, TAKER_FEE_RATE=${TAKER_FEE_RATE}, không risk pool, không concurrency — JUDGMENT CALL, xem "Judgment calls" trong báo cáo cuối).`,
    '',
    '| Thesis | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    statsRow('TỔNG VALID', overall),
    statsRow('LONG', longOutcome),
    statsRow('SHORT', shortOutcome),
    '',
    '## 7. Outcome theo HTFContext (§10)',
    '',
    '| HTFContext | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byHtfOutcome.map((x) => statsRow(x.ctx, x.stats)),
    '',
    '## 8. Outcome theo Setup (§10)',
    '',
    '| Setup | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...bySetupOutcome.map((x) => statsRow(x.st, x.stats)),
    '',
    '## 9. Outcome theo Coin (§10)',
    '',
    '| Coin | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byCoinOutcome.map((x) => statsRow(x.s, x.stats)),
    '',
    '## 10. Outcome theo 3 giai đoạn (candidate count gần bằng nhau, TICKET-137 buildPeriods) (§10)',
    '',
    '| Giai đoạn | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byPeriodOutcome.map((x) => statsRow(x.label, x.stats)),
    '',
    '## 11. Phân tích tầng bóp (khi VALID quá ít) (§12)',
    '',
    '| Tầng | Giữ lại | Trên tổng | % giữ lại |',
    '|---|---|---|---|',
    ...layerDropoffs.map((d) => `| ${d.layer} | ${d.kept} | ${d.of} | ${pct(d.kept, d.of)} |`),
    '',
    '## 12. Kết luận PASS/FAIL (§12)',
    '',
    '| # | Tiêu chí | Ngưỡng | Kết quả thực tế | PASS/FAIL |',
    '|---|---|---|---|---|',
    `| 1 | VALID không chiếm quá rộng bất thường | <= 30% (JUDGMENT CALL, không có số ticket cho) | ${validPct} | ${pass1 ? 'PASS' : 'FAIL'} |`,
    `| 2 | VALID_LONG và VALID_SHORT đều có mẫu | > 0 cả hai | LONG=${validLong}, SHORT=${validShort} | ${pass2 ? 'PASS' : 'FAIL'} |`,
    `| 3 | PF tổng VALID | > 1.10 | ${overall.pf === Infinity ? '∞' : overall.pf.toFixed(2)} | ${pass3 ? 'PASS' : 'FAIL'} |`,
    `| 4 | Net PnL tổng VALID | > 0 | $${overall.netPnl.toFixed(2)} | ${pass4 ? 'PASS' : 'FAIL'} |`,
    `| 5 | Ít nhất 2/3 giai đoạn có PF > 1 | >= 2/3 | ${periodsWithPfAbove1}/3 | ${pass5 ? 'PASS' : 'FAIL'} |`,
    `| 6 | Không phụ thuộc top-3 winner quá 60% gross profit | <= 60% | ${top3PctOfGrossProfit.toFixed(1)}% | ${pass6 ? 'PASS' : 'FAIL'} |`,
    '| 7 | Baseline giữ nguyên khi flag OFF | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '| 8 | Test/build pass | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '',
    '## 13. Kết luận bắt buộc (§14)',
    '',
    conclusion,
    '',
  ];

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket141GenerateReport.js <csvPath> <configJsonPath> <suffix> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket141GenerateReport.js')) {
  const csvPath = process.argv[2];
  const configJsonPath = process.argv[3];
  const suffix = process.argv[4] ?? 'baseline';
  const outputPath = process.argv[5] ?? 'data/ticket141-5m-local-trade-thesis.md';
  if (!csvPath || !configJsonPath) {
    console.error('Usage: node ticket141GenerateReport.js <csvPath> <configJsonPath> <suffix> [outputPath]');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configJsonPath, 'utf-8')) as OrchestratorConfig;
  generateTicket141Report(csvPath, outputPath, config, suffix).then(() => console.log(`→ ${outputPath}`));
}
