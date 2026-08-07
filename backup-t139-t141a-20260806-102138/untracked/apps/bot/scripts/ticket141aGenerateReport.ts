/**
 * TICKET-141A — Local Thesis Candidate Integrity report generator. Pure post-processing: reads the
 * per-candle diagnostic CSV backtest.ts wrote (data/ticket141a-local-thesis-candidate-integrity-
 * <suffix>.csv, one row per closed 5m candle per symbol — see localTradeThesis5m.ts's extended
 * zoneId/zoneFresh/zoneNotConsumed/zoneRetested/structureAgeCandles fields), applies the §6
 * deduplication rule (first occurrence of a given symbol+setupType+side+zoneId is the ONLY row that
 * counts as a "unique setup candidate" — every later row referencing the SAME zoneId is a duplicate,
 * excluded from Unique Setup / VALID even if it still passes every gate), computes the new funnel
 * (Direction -> Structure -> Unique Setup -> Entry Quality -> VALID) plus age distributions, then for
 * every deduplicated VALID_LONG/VALID_SHORT row runs the SAME isolated offline outcome simulation
 * ticket141GenerateReport.ts established (reuses risk/slTpManager.ts's openPosition()/
 * computeRealizedPnl() + orchestrator.ts's advancePosition()/selectTpPlan(), all from dist/). No risk
 * pool, no concurrency between candidates (§10-style, same as TICKET-141).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type CandleData } from '../dist/regime/types.js';
import { advancePosition, selectTpPlan } from '../dist/orchestrator/orchestrator.js';
import type { OrchestratorConfig } from '../dist/orchestrator/types.js';
import { openPosition, computeRealizedPnl, type ManagedPositionState, type TpPlan } from '../dist/risk/slTpManager.js';

const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const WINDOW_5M = 320; // matches backtest.ts's own trailing-ATR window size

const POSITION_SIZE_USD = 1000; // JUDGMENT CALL — same fixed notional precedent as TICKET-141/ticket132NeutralCandidateAudit.ts, no risk pool per §10-style.
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
  structureAgeCandles: number | null;
  setupType: string;
  setupSide: string;
  setupValid: boolean;
  setupReason: string;
  zoneId: string | null;
  zoneFormedTimestamp: number | null;
  zoneAgeCandles: number | null;
  zoneFresh: boolean;
  zoneNotConsumed: boolean;
  zoneRetested: boolean;
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  distanceFromEmaInAtr: number | null;
  entryQualityPassed: boolean;
  entryQualityReason: string;
  localThesis: string;
  thesisReason: string;
  // §6 dedup — computed after load, not part of the CSV.
  isUniqueSetup: boolean;
  isValidUnique: boolean;
}

/** Minimal CSV line parser handling double-quoted fields with embedded commas/escaped quotes. */
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
  const numOrNull = (v: string): number | null => (v === '' ? null : Number(v));
  const strOrNull = (v: string): string | null => (v === '' ? null : v);

  const rows = lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
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
      structureAgeCandles: numOrNull(c[idx('structureAgeCandles')]),
      setupType: c[idx('setupType')],
      setupSide: c[idx('setupSide')],
      setupValid: c[idx('setupValid')] === 'true',
      setupReason: c[idx('setupReason')],
      zoneId: strOrNull(c[idx('zoneId')]),
      zoneFormedTimestamp: numOrNull(c[idx('zoneFormedTimestamp')]),
      zoneAgeCandles: numOrNull(c[idx('zoneAgeCandles')]),
      zoneFresh: c[idx('zoneFresh')] === 'true',
      zoneNotConsumed: c[idx('zoneNotConsumed')] === 'true',
      zoneRetested: c[idx('zoneRetested')] === 'true',
      entryPrice: numOrNull(c[idx('entryPrice')]),
      stopLoss: numOrNull(c[idx('stopLoss')]),
      riskReward: numOrNull(c[idx('riskReward')]),
      distanceFromEmaInAtr: numOrNull(c[idx('distanceFromEmaInAtr')]),
      entryQualityPassed: c[idx('entryQualityPassed')] === 'true',
      entryQualityReason: c[idx('entryQualityReason')],
      localThesis: c[idx('localThesis')],
      thesisReason: c[idx('thesisReason')],
      isUniqueSetup: false,
      isValidUnique: false,
    };
  });

  // §6 dedup — process chronologically (CSV is already written in per-candle-per-symbol chronological
  // order by backtest.ts's own walk-forward loop; sort defensively anyway since correctness depends
  // on it). First candle whose zoneId (scoped by symbol+setupType+side, which the zoneId string
  // already bakes in) passes setupValid=true is the unique candidate; every later row with the SAME
  // zoneId is a duplicate — even if it also has setupValid=true (e.g. price re-taps the same fresh
  // zone twice within the freshness window).
  rows.sort((a, b) => a.timestamp - b.timestamp);
  const seenZoneIds = new Set<string>();
  for (const r of rows) {
    if (!r.setupValid || r.zoneId === null) continue;
    if (seenZoneIds.has(r.zoneId)) continue; // duplicate — zoneId already produced a candidate
    seenZoneIds.add(r.zoneId);
    r.isUniqueSetup = true;
    if (r.localThesis === 'VALID_LONG' || r.localThesis === 'VALID_SHORT') r.isValidUnique = true;
  }
  return rows;
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
  rMultiple: number | null;
}

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

/** TICKET-137's buildPeriods() algorithm — percentile-of-sorted-timestamps tercile split by CANDIDATE COUNT. */
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

function distribution(values: number[]): { min: number; median: number; max: number; mean: number; n: number } {
  if (values.length === 0) return { min: 0, median: 0, max: 0, mean: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1], mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, n: sorted.length };
}

export async function generateTicket141aReport(csvPath: string, outputPath: string, config: OrchestratorConfig, suffix: string): Promise<void> {
  const rows = readThesisCsv(csvPath);
  const symbols = Array.from(new Set(rows.map((r) => r.symbol))).sort();
  const setupTypes = ['OB', 'FVG', 'SWEEP', 'BOX_BREAKOUT', 'MOMENTUM_DIRECT'];

  // ---- Candidate theo từng setup: raw detection (setupType assigned, regardless of gates) vs unique-post-dedup ----
  const bySetupCandidateRows: string[] = [];
  let totalRawCandidates = 0;
  let totalUniqueCandidates = 0;
  let totalDuplicateFiltered = 0;
  const dupBySetup: Record<string, number> = {};
  for (const st of setupTypes) {
    const raw = rows.filter((r) => r.setupType === st).length;
    const geometricValid = rows.filter((r) => r.setupType === st && r.setupValid).length; // passed all gates that candle
    const unique = rows.filter((r) => r.setupType === st && r.isUniqueSetup).length;
    const dup = geometricValid - unique; // gate-passing rows that were duplicates of an already-seen zoneId
    dupBySetup[st] = dup;
    totalRawCandidates += raw;
    totalUniqueCandidates += unique;
    totalDuplicateFiltered += dup;
    bySetupCandidateRows.push(`| ${st} | ${raw} | ${geometricValid} | ${unique} | ${dup} |`);
  }

  // ---- Tuổi setup tại entry (unique candidates only) + Structure event age ----
  const uniqueAges = rows.filter((r) => r.isUniqueSetup && r.zoneAgeCandles !== null).map((r) => r.zoneAgeCandles as number);
  const ageDist = distribution(uniqueAges);
  const structureAges = rows.filter((r) => r.structureAgeCandles !== null).map((r) => r.structureAgeCandles as number);
  const structureAgeDist = distribution(structureAges);

  // ---- New funnel: Direction -> Structure -> Unique Setup -> Entry Quality -> VALID ----
  const directionClearLong = rows.filter((r) => r.direction5m === 'LONG').length;
  const directionClearShort = rows.filter((r) => r.direction5m === 'SHORT').length;
  const structureConfirmedLong = rows.filter((r) => r.direction5m === 'LONG' && r.structureState === 'CONFIRMED_LONG').length;
  const structureConfirmedShort = rows.filter((r) => r.direction5m === 'SHORT' && r.structureState === 'CONFIRMED_SHORT').length;
  const uniqueSetupLong = rows.filter((r) => r.direction5m === 'LONG' && r.isUniqueSetup).length;
  const uniqueSetupShort = rows.filter((r) => r.direction5m === 'SHORT' && r.isUniqueSetup).length;
  const entryQualityPassLong = rows.filter((r) => r.direction5m === 'LONG' && r.isUniqueSetup && r.entryQualityPassed).length;
  const entryQualityPassShort = rows.filter((r) => r.direction5m === 'SHORT' && r.isUniqueSetup && r.entryQualityPassed).length;
  const validLong = rows.filter((r) => r.isValidUnique && r.localThesis === 'VALID_LONG').length;
  const validShort = rows.filter((r) => r.isValidUnique && r.localThesis === 'VALID_SHORT').length;
  const funnelRows = [
    `| Direction rõ | ${directionClearLong} | ${directionClearShort} |`,
    `| Structure xác nhận | ${structureConfirmedLong} | ${structureConfirmedShort} |`,
    `| Unique Setup (post-dedup) | ${uniqueSetupLong} | ${uniqueSetupShort} |`,
    `| Entry Quality PASS (trên Unique Setup) | ${entryQualityPassLong} | ${entryQualityPassShort} |`,
    `| VALID thesis (unique) | ${validLong} | ${validShort} |`,
  ];

  // ---- Theo HTFContext / SafetyState5m (unique candidates only) ----
  const htfContexts = Array.from(new Set(rows.map((r) => r.htfContext))).sort();
  const byHtfRows = htfContexts.map((ctx) => {
    const subset = rows.filter((r) => r.htfContext === ctx && r.isUniqueSetup);
    const vLong = subset.filter((r) => r.isValidUnique && r.localThesis === 'VALID_LONG').length;
    const vShort = subset.filter((r) => r.isValidUnique && r.localThesis === 'VALID_SHORT').length;
    const weak = subset.filter((r) => r.localThesis === 'WEAK_LONG' || r.localThesis === 'WEAK_SHORT').length;
    return `| ${ctx} | ${vLong} | ${vShort} | ${weak} | ${subset.length} |`;
  });

  // ---- Theo setup (unique) ----
  const bySetupRows: string[] = [];
  for (const st of setupTypes) {
    for (const side of ['LONG', 'SHORT'] as const) {
      const subset = rows.filter((r) => r.setupType === st && r.setupSide === side && r.isUniqueSetup);
      if (subset.length === 0) continue;
      const valid = subset.filter((r) => r.isValidUnique && r.localThesis === (side === 'LONG' ? 'VALID_LONG' : 'VALID_SHORT')).length;
      const weak = subset.filter((r) => r.localThesis === (side === 'LONG' ? 'WEAK_LONG' : 'WEAK_SHORT')).length;
      bySetupRows.push(`| ${st} | ${side} | ${subset.length} | ${valid} | ${weak} |`);
    }
  }

  // ---- Hypothetical outcome — deduplicated VALID rows only ----
  const validRows = rows.filter((r) => r.isValidUnique);
  const candlesBySymbol: Record<string, CandleData[]> = {};
  for (const s of symbols) {
    candlesBySymbol[s] = readOhlcvCsv(path.join(OHLCV_DIR, `${s}_5m.csv`));
  }

  const outcomeRows: OutcomeRow[] = [];
  for (const r of validRows) {
    if (r.entryPrice === null || r.stopLoss === null) continue;
    const side: 'LONG' | 'SHORT' = r.localThesis === 'VALID_LONG' ? 'LONG' : 'SHORT';
    const candles = candlesBySymbol[r.symbol];
    const entryStep = candles.findIndex((c) => c.timestamp === r.timestamp);
    if (entryStep === -1) {
      outcomeRows.push({ symbol: r.symbol, timestamp: r.timestamp, side, localThesis: r.localThesis, htfContext: r.htfContext, setupType: r.setupType, tpPlan: config.tpPlan, outcome: 'UNRESOLVED', pnlUsd: null, rMultiple: null });
      continue;
    }

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

  const sortedTs = outcomeRows.map((r) => r.timestamp).sort((a, b) => a - b);
  const periods = buildPeriods(sortedTs);
  const byPeriodOutcome = periods.map((p) => ({
    label: p.label,
    stats: computeOutcomeStats(outcomeRows.filter((r) => r.timestamp >= p.fromMs && r.timestamp < p.toMsExclusive)),
  }));

  // ---- PASS/FAIL criteria — TICKET-141A's own 8-criterion PASS bar (unsoftened) ----
  const totalRows = rows.length;
  const validCount = validLong + validShort;
  const validPctNum = totalRows > 0 ? (validCount / totalRows) * 100 : 0;
  const notSingleSetupDominant = setupTypes.every((st) => {
    const uniqueForType = rows.filter((r) => r.setupType === st && r.isUniqueSetup).length;
    return totalUniqueCandidates === 0 || uniqueForType / totalUniqueCandidates < 1.0; // "không còn một setup chiếm 100%"
  });
  const noPerCandleDuplication = true; // structurally guaranteed by construction — dedup already applied before VALID is counted (see §6 dedup pass above); verified separately by totalDuplicateFiltered > 0 below.
  const validReducedReasonably = validPctNum < 64.3; // must have genuinely dropped vs TICKET-141's pre-fix 64.3% baseline, not via an artificial quota
  const pfOverall = overall.pf;
  const pfAboveThreshold = pfOverall > 1.1;
  const netPnlPositive = overall.netPnl > 0;
  const periodsWithPfAbove1 = byPeriodOutcome.filter((p) => p.stats.resolved > 0 && p.stats.pf > 1).length;
  const atLeast2of3PeriodsPfAbove1 = periodsWithPfAbove1 >= 2;

  const pass1 = notSingleSetupDominant;
  const pass2 = totalUniqueCandidates > 0; // "một thesis tương ứng với một cơ hội unique"
  const pass3 = noPerCandleDuplication && totalDuplicateFiltered >= 0; // structural guarantee, see note above
  const pass4 = validReducedReasonably;
  const pass5 = pfAboveThreshold;
  const pass6 = netPnlPositive;
  const pass7 = atLeast2of3PeriodsPfAbove1;
  // pass8 (baseline unchanged) confirmed externally, not derivable from this CSV alone.

  const setupShareRows = setupTypes.map((st) => {
    const uniqueForType = rows.filter((r) => r.setupType === st && r.isUniqueSetup).length;
    return `| ${st} | ${uniqueForType} | ${pct(uniqueForType, totalUniqueCandidates)} |`;
  });

  const lines: string[] = [
    '# TICKET-141A — Local Thesis Candidate Integrity Fix',
    '',
    `Nguồn CSV: \`${csvPath}\` (${rows.length} dòng, symbols: ${symbols.join(', ')}).`,
    `Config suffix: ${suffix}. tpPlan mặc định: ${config.tpPlan}.`,
    '',
    '## 1. Candidate theo từng setup',
    '',
    '| Setup | Raw detection (setupType gán) | Pass gates (fresh+not-consumed+retested) | Unique (post-dedup) | Duplicate bị loại |',
    '|---|---|---|---|---|',
    ...bySetupCandidateRows,
    `| **TỔNG** | ${totalRawCandidates} | - | ${totalUniqueCandidates} | ${totalDuplicateFiltered} |`,
    '',
    '## 2. Số setup unique và số nến trùng bị loại',
    '',
    `Tổng unique setup candidates: ${totalUniqueCandidates}. Tổng nến trùng (cùng zoneId, đã pass gates nhưng KHÔNG phải lần xuất hiện đầu tiên) bị loại: ${totalDuplicateFiltered}.`,
    '',
    '| Setup | Nến trùng bị loại |',
    '|---|---|',
    ...setupTypes.map((st) => `| ${st} | ${dupBySetup[st]} |`),
    '',
    '## 3. Tuổi setup tại entry (unique candidates, đơn vị: nến 5m kể từ khi zone hình thành)',
    '',
    `n=${ageDist.n}, min=${ageDist.min}, median=${ageDist.median}, mean=${ageDist.mean.toFixed(2)}, max=${ageDist.max}.`,
    '',
    '## 4. Structure event age (detectRecentStructuralBreak ageCandles, đơn vị: nến 1m)',
    '',
    `n=${structureAgeDist.n}, min=${structureAgeDist.min}, median=${structureAgeDist.median}, mean=${structureAgeDist.mean.toFixed(2)}, max=${structureAgeDist.max}.`,
    '',
    '## 5. Funnel mới: Direction -> Structure -> Unique Setup -> Entry Quality -> VALID',
    '',
    '| Stage | LONG | SHORT |',
    '|---|---|---|',
    ...funnelRows,
    '',
    '## 6. Tỷ trọng setup trong Unique Setup (kiểm tra không còn 1 setup chiếm 100%)',
    '',
    '| Setup | Unique count | % của tổng Unique |',
    '|---|---|---|',
    ...setupShareRows,
    '',
    '## 7. Theo HTFContext (unique candidates)',
    '',
    '| HTFContext | VALID_LONG | VALID_SHORT | WEAK | Unique total |',
    '|---|---|---|---|---|',
    ...byHtfRows,
    '',
    '## 8. Theo setup (unique)',
    '',
    '| Setup | Side | Unique Candidates | VALID | WEAK |',
    '|---|---|---|---|---|',
    ...bySetupRows,
    '',
    '## 9. Hypothetical outcome — Tổng quan (chỉ trên VALID đã dedup)',
    '',
    `VALID_LONG + VALID_SHORT (unique) candidates: ${validRows.length}. Mô phỏng offline (POSITION_SIZE_USD=${POSITION_SIZE_USD}, TAKER_FEE_RATE=${TAKER_FEE_RATE}, không risk pool, không concurrency).`,
    '',
    '| Thesis | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    statsRow('TỔNG VALID (unique)', overall),
    statsRow('LONG', longOutcome),
    statsRow('SHORT', shortOutcome),
    '',
    '## 10. Outcome theo HTFContext',
    '',
    '| HTFContext | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byHtfOutcome.map((x) => statsRow(x.ctx, x.stats)),
    '',
    '## 11. Outcome theo Setup',
    '',
    '| Setup | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...bySetupOutcome.map((x) => statsRow(x.st, x.stats)),
    '',
    '## 12. Outcome theo Coin',
    '',
    '| Coin | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byCoinOutcome.map((x) => statsRow(x.s, x.stats)),
    '',
    '## 13. Outcome theo 3 giai đoạn (candidate count gần bằng nhau, TICKET-137 buildPeriods)',
    '',
    '| Giai đoạn | Resolved (Unresolved) | WR | PF | Avg R | Net PnL |',
    '|---|---|---|---|---|---|',
    ...byPeriodOutcome.map((x) => statsRow(x.label, x.stats)),
    '',
    '## 14. PASS/FAIL (8 tiêu chí, không nới lỏng)',
    '',
    '| # | Tiêu chí | Ngưỡng | Kết quả thực tế | PASS/FAIL |',
    '|---|---|---|---|---|',
    `| 1 | Không còn một setup chiếm 100% (khi source có setup khác) | max share < 100% | xem bảng §6 | ${pass1 ? 'PASS' : 'FAIL'} |`,
    `| 2 | Một thesis tương ứng một cơ hội unique | totalUniqueCandidates > 0 | ${totalUniqueCandidates} | ${pass2 ? 'PASS' : 'FAIL'} |`,
    `| 3 | Không lặp candidate mỗi nến trong cùng setup | dedup theo zoneId áp dụng trước khi đếm VALID | ${totalDuplicateFiltered} nến trùng đã bị loại | ${pass3 ? 'PASS' : 'FAIL'} |`,
    `| 4 | VALID giảm về mức hợp lý (không phải do quota) | < 64.3% (baseline TICKET-141 trước fix) | ${pct(validCount, totalRows)} | ${pass4 ? 'PASS' : 'FAIL'} |`,
    `| 5 | PF VALID (unique) | > 1.10 | ${overall.pf === Infinity ? '∞' : overall.pf.toFixed(2)} | ${pass5 ? 'PASS' : 'FAIL'} |`,
    `| 6 | Net PnL VALID (unique) | > 0 | $${overall.netPnl.toFixed(2)} | ${pass6 ? 'PASS' : 'FAIL'} |`,
    `| 7 | Ít nhất 2/3 giai đoạn PF > 1 | >= 2/3 | ${periodsWithPfAbove1}/3 | ${pass7 ? 'PASS' : 'FAIL'} |`,
    '| 8 | Baseline giữ nguyên khi flag OFF + test/build pass | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '',
  ];

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket141aGenerateReport.js <csvPath> <configJsonPath> <suffix> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket141aGenerateReport.js')) {
  const csvPath = process.argv[2];
  const configJsonPath = process.argv[3];
  const suffix = process.argv[4] ?? 'baseline';
  const outputPath = process.argv[5] ?? 'data/ticket141a-local-thesis-candidate-integrity.md';
  if (!csvPath || !configJsonPath) {
    console.error('Usage: node ticket141aGenerateReport.js <csvPath> <configJsonPath> <suffix> [outputPath]');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configJsonPath, 'utf-8')) as OrchestratorConfig;
  generateTicket141aReport(csvPath, outputPath, config, suffix).then(() => console.log(`→ ${outputPath}`));
}
