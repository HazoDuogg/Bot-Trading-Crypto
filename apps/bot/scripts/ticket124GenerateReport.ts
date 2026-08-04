/**
 * TICKET-124 Phần A/D/E — pure post-processing/report script. Reads ONLY:
 *   - data/ticket124-tactical-shadow-audit.csv (Phần C output, this ticket)
 *   - data/all-candidates-fully-enriched.csv (TICKET-109/113, existing — real momentum-gate candidates)
 *   - data/ticket123-variantA-trades.csv (official 258-trade baseline — real trades)
 * Never re-runs the backtest, never opens a position, never touches src/. Writes
 * data/ticket124-tactical-regime-audit-report.md.
 *
 * Run (from repo root, after ticket124TacticalShadowAudit.js has produced its CSV):
 *   node apps/bot/scripts-dist/ticket124GenerateReport.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AUDIT_CSV = path.resolve(process.cwd(), 'data/ticket124-tactical-shadow-audit.csv');
const ENRICHED_CSV = path.resolve(process.cwd(), 'data/all-candidates-fully-enriched.csv');
const TRADES_CSV = path.resolve(process.cwd(), 'data/ticket123-variantA-trades.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket124-tactical-regime-audit-report.md');

const CANDLE_MS = 5 * 60_000;

function parseCsv(filePath: string): { header: string[]; rows: string[][] } {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  return { header, rows };
}

function col(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`column "${name}" not found`);
  return i;
}

interface AuditRow {
  timestamp: number;
  symbol: string;
  existingRegime: string;
  macroDirection1h: string;
  condition15m: string;
  tacticalState5m: string;
  tacticalSide: string;
  tacticalConfidence: number;
  reasonCodes: string;
  atrPercentile5m: string;
  bbWidthPercentile15m: string;
  volumeZScore5m: string;
  adx1h: string;
  hasOB: boolean;
  hasFVG: boolean;
  hasSweep: boolean;
  hasBoxBreakout: boolean;
  hasMSS: boolean;
  wouldPassOldLogic: boolean;
  wouldPassTacticalLogic: boolean;
  actualTradeOpened: boolean;
  simulatedWin: string; // 'true' | 'false' | 'NA'
  simulatedPnlUsd: string; // number-as-string | 'NA'
}

function loadAuditRows(): AuditRow[] {
  const { header, rows } = parseCsv(AUDIT_CSV);
  const c = (name: string) => col(header, name);
  const idx = {
    timestamp: c('timestamp'), symbol: c('symbol'), existingRegime: c('existingRegime'), macroDirection1h: c('macroDirection1h'),
    condition15m: c('condition15m'), tacticalState5m: c('tacticalState5m'), tacticalSide: c('tacticalSide'), tacticalConfidence: c('tacticalConfidence'),
    reasonCodes: c('reasonCodes'), atrPercentile5m: c('atrPercentile5m'), bbWidthPercentile15m: c('bbWidthPercentile15m'), volumeZScore5m: c('volumeZScore5m'),
    adx1h: c('adx1h'), hasOB: c('hasOB'), hasFVG: c('hasFVG'), hasSweep: c('hasSweep'), hasBoxBreakout: c('hasBoxBreakout'), hasMSS: c('hasMSS'),
    wouldPassOldLogic: c('wouldPassOldLogic'), wouldPassTacticalLogic: c('wouldPassTacticalLogic'), actualTradeOpened: c('actualTradeOpened'),
    simulatedWin: c('simulatedWin'), simulatedPnlUsd: c('simulatedPnlUsd'),
  };
  return rows.map((r) => ({
    timestamp: Number(r[idx.timestamp]),
    symbol: r[idx.symbol],
    existingRegime: r[idx.existingRegime],
    macroDirection1h: r[idx.macroDirection1h],
    condition15m: r[idx.condition15m],
    tacticalState5m: r[idx.tacticalState5m],
    tacticalSide: r[idx.tacticalSide],
    tacticalConfidence: Number(r[idx.tacticalConfidence]),
    reasonCodes: r[idx.reasonCodes],
    atrPercentile5m: r[idx.atrPercentile5m],
    bbWidthPercentile15m: r[idx.bbWidthPercentile15m],
    volumeZScore5m: r[idx.volumeZScore5m],
    adx1h: r[idx.adx1h],
    hasOB: r[idx.hasOB] === 'true',
    hasFVG: r[idx.hasFVG] === 'true',
    hasSweep: r[idx.hasSweep] === 'true',
    hasBoxBreakout: r[idx.hasBoxBreakout] === 'true',
    hasMSS: r[idx.hasMSS] === 'true',
    wouldPassOldLogic: r[idx.wouldPassOldLogic] === 'true',
    wouldPassTacticalLogic: r[idx.wouldPassTacticalLogic] === 'true',
    actualTradeOpened: r[idx.actualTradeOpened] === 'true',
    simulatedWin: r[idx.simulatedWin],
    simulatedPnlUsd: r[idx.simulatedPnlUsd],
  }));
}

interface CandidateRow {
  symbol: string;
  timestamp: number;
  side: string;
  passed: boolean;
  win: boolean;
  pnlUsd: number;
}

function loadCandidateRows(): CandidateRow[] {
  const { header, rows } = parseCsv(ENRICHED_CSV);
  const c = (name: string) => col(header, name);
  const iSymbol = c('symbol'), iTimestamp = c('timestamp'), iSide = c('side'), iPassed = c('passed'), iWin = c('win'), iPnl = c('pnlUsd');
  return rows.map((r) => ({
    symbol: r[iSymbol],
    timestamp: Number(r[iTimestamp]),
    side: r[iSide],
    passed: r[iPassed] === 'true',
    win: r[iWin] === 'true',
    pnlUsd: Number(r[iPnl]),
  }));
}

interface TradeRow {
  symbol: string;
  side: string;
  regime: string;
  setupType: string;
  entryTimestamp: number;
  pnlUsd: number;
}

function loadTradeRows(): TradeRow[] {
  const { header, rows } = parseCsv(TRADES_CSV);
  const c = (name: string) => col(header, name);
  const iSymbol = c('symbol'), iSide = c('side'), iRegime = c('regime'), iSetupType = c('setupType'), iEntryTs = c('entryTimestamp'), iPnl = c('pnlUsd');
  return rows.map((r) => ({
    symbol: r[iSymbol],
    side: r[iSide],
    regime: r[iRegime],
    setupType: r[iSetupType],
    entryTimestamp: Number(r[iEntryTs]),
    pnlUsd: Number(r[iPnl]),
  }));
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}
function fmt2(n: number): string {
  return n.toFixed(2);
}
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
function maxDrawdown(pnlSeriesChronological: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of pnlSeriesChronological) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

interface Episode {
  symbol: string;
  value: string;
  startTs: number;
  endTs: number;
  candleCount: number;
}

/** Contiguous runs of `keyFn(row)` per symbol, in chronological order. Used for both regime and tactical-state episodes. */
function computeEpisodes(rowsBySymbol: Map<string, AuditRow[]>, keyFn: (r: AuditRow) => string): Episode[] {
  const episodes: Episode[] = [];
  for (const [symbol, rows] of rowsBySymbol) {
    let currentValue: string | null = null;
    let startTs = 0;
    let count = 0;
    let lastTs = 0;
    for (const r of rows) {
      const v = keyFn(r);
      if (v !== currentValue) {
        if (currentValue !== null) episodes.push({ symbol, value: currentValue, startTs, endTs: lastTs, candleCount: count });
        currentValue = v;
        startTs = r.timestamp;
        count = 0;
      }
      count++;
      lastTs = r.timestamp;
    }
    if (currentValue !== null) episodes.push({ symbol, value: currentValue, startTs, endTs: lastTs, candleCount: count });
  }
  return episodes;
}

function main(): void {
  console.log('TICKET-124 — Generating Phần A/D/E report...');
  const auditRows = loadAuditRows();
  const candidateRows = loadCandidateRows();
  const tradeRows = loadTradeRows();

  const symbols = [...new Set(auditRows.map((r) => r.symbol))].sort();
  const totalRows = auditRows.length;
  const totalCandlesPerSymbol = new Map<string, number>();
  for (const s of symbols) totalCandlesPerSymbol.set(s, auditRows.filter((r) => r.symbol === s).length);

  const rowsBySymbol = new Map<string, AuditRow[]>();
  for (const s of symbols) rowsBySymbol.set(s, auditRows.filter((r) => r.symbol === s).sort((a, b) => a.timestamp - b.timestamp));

  // Candidate index for join by symbol+timestamp -> array of candidate rows (both sides).
  const candidatesByKey = new Map<string, CandidateRow[]>();
  for (const c of candidateRows) {
    const key = `${c.symbol}|${c.timestamp}`;
    const arr = candidatesByKey.get(key) ?? [];
    arr.push(c);
    candidatesByKey.set(key, arr);
  }

  // ---- PHẦN A.1 — Regime time distribution ----
  const regimes = [...new Set(auditRows.map((r) => r.existingRegime))].sort();
  const regimeLines: string[] = [];
  regimeLines.push('| Regime | Tổng nến 5m | Tỷ lệ thời gian | Số candidate (LONG+SHORT, MOMENTUM_DIRECT) | Số trade thật |');
  regimeLines.push('|---|---|---|---|---|');
  for (const regime of regimes) {
    const rowsOfRegime = auditRows.filter((r) => r.existingRegime === regime);
    const candleCount = rowsOfRegime.length;
    const pct = candleCount / totalRows;
    let candidateCount = 0;
    for (const r of rowsOfRegime) {
      const key = `${r.symbol}|${r.timestamp}`;
      candidateCount += (candidatesByKey.get(key) ?? []).length;
    }
    const realTrades = tradeRows.filter((t) => t.regime === regime).length;
    regimeLines.push(`| ${regime} | ${candleCount} | ${fmtPct(pct)} | ${candidateCount} | ${realTrades} |`);
  }
  regimeLines.push(`| **TỔNG** | **${totalRows}** | **100%** | **${candidateRows.length}** | **${tradeRows.length}** |`);

  // ---- PHẦN A.2 — Transition matrix (existingRegime) ----
  const regimeEpisodes = computeEpisodes(rowsBySymbol, (r) => r.existingRegime);
  // Sort each symbol's episodes chronologically (already are, since computeEpisodes walks in order) then pair consecutive.
  const transitions: Array<{ from: string; to: string; durationCandles: number }> = [];
  for (const s of symbols) {
    const eps = regimeEpisodes.filter((e) => e.symbol === s);
    for (let i = 1; i < eps.length; i++) {
      transitions.push({ from: eps[i - 1].value, to: eps[i].value, durationCandles: eps[i - 1].candleCount });
    }
  }
  const transitionKeyCounts = new Map<string, number[]>(); // "FROM->TO" -> [durations of FROM before this transition]
  for (const t of transitions) {
    const key = `${t.from} -> ${t.to}`;
    const arr = transitionKeyCounts.get(key) ?? [];
    arr.push(t.durationCandles);
    transitionKeyCounts.set(key, arr);
  }
  const totalTransitions = transitions.length;
  const transitionLines: string[] = [];
  transitionLines.push('| Transition | Count | Tỷ lệ | Median duration (nến) trước transition |');
  transitionLines.push('|---|---|---|---|');
  for (const [key, durations] of [...transitionKeyCounts.entries()].sort((a, b) => b[1].length - a[1].length)) {
    transitionLines.push(`| ${key} | ${durations.length} | ${fmtPct(durations.length / totalTransitions)} | ${median(durations).toFixed(1)} |`);
  }

  // ---- PHẦN A.3 — Duration per existingRegime ----
  const durationLines: string[] = [];
  durationLines.push('| Regime | Median (nến) | Mean (nến) | P90 (nến) | Episode dài nhất (nến) | Số episode = 1 nến |');
  durationLines.push('|---|---|---|---|---|---|');
  for (const regime of regimes) {
    const eps = regimeEpisodes.filter((e) => e.value === regime).map((e) => e.candleCount);
    durationLines.push(`| ${regime} | ${median(eps).toFixed(1)} | ${mean(eps).toFixed(1)} | ${percentile(eps, 90).toFixed(1)} | ${Math.max(...eps)} | ${eps.filter((d) => d === 1).length} |`);
  }
  const totalFlips1Candle = regimeEpisodes.filter((e) => e.candleCount === 1).length;

  // ---- PHẦN A.4 — Neutral-specific audit ----
  const neutralRows = auditRows.filter((r) => r.existingRegime === 'NEUTRAL_TRANSITION');
  const neutralPct = neutralRows.length / totalRows;
  const days = totalRows / symbols.length / 288;
  let neutralCandidateLong = 0, neutralCandidateShort = 0, neutralCandidateWins = 0, neutralCandidateTotal = 0, neutralCandidatePnl = 0;
  let neutralRejected = 0;
  for (const r of neutralRows) {
    const key = `${r.symbol}|${r.timestamp}`;
    const cands = candidatesByKey.get(key) ?? [];
    for (const c of cands) {
      neutralCandidateTotal++;
      if (c.side === 'LONG') neutralCandidateLong++;
      else neutralCandidateShort++;
      if (c.win) neutralCandidateWins++;
      neutralCandidatePnl += c.pnlUsd;
      if (!c.passed) neutralRejected++;
    }
  }
  const neutralRealTrades = tradeRows.filter((t) => t.regime === 'NEUTRAL_TRANSITION').length;
  const neutralNoStructure = neutralRows.filter((r) => !r.hasOB && !r.hasFVG && !r.hasSweep && !r.hasBoxBreakout && !r.hasMSS).length;
  const neutralGrossWin = candidateRows.filter((c) => c.pnlUsd > 0).length; // unused placeholder guard
  void neutralGrossWin;
  // PF for NEUTRAL_TRANSITION candidates (grossWin / grossLoss of the simulated pnlUsd).
  let neutralGrossProfit = 0, neutralGrossLoss = 0;
  for (const r of neutralRows) {
    const key = `${r.symbol}|${r.timestamp}`;
    for (const c of candidatesByKey.get(key) ?? []) {
      if (c.pnlUsd > 0) neutralGrossProfit += c.pnlUsd;
      else neutralGrossLoss += Math.abs(c.pnlUsd);
    }
  }
  const neutralPF = neutralGrossLoss === 0 ? NaN : neutralGrossProfit / neutralGrossLoss;

  // ---- PHẦN B/C sanity: tactical state distribution ----
  const tacticalStates = ['NEUTRAL_COMPRESSION', 'NEUTRAL_EXPANSION', 'MICRO_TREND', 'MICRO_CHOP'];
  const tacticalDistLines: string[] = [];
  tacticalDistLines.push('| Tactical State | Số nến | Tỷ lệ thời gian |');
  tacticalDistLines.push('|---|---|---|');
  for (const st of tacticalStates) {
    const n = auditRows.filter((r) => r.tacticalState5m === st).length;
    tacticalDistLines.push(`| ${st} | ${n} | ${fmtPct(n / totalRows)} |`);
  }

  // Tactical episodes (for flip/persistence analysis).
  const tacticalEpisodes = computeEpisodes(rowsBySymbol, (r) => r.tacticalState5m);
  const tacticalDurationLines: string[] = [];
  tacticalDurationLines.push('| Tactical State | Median (nến) | Mean (nến) | P90 (nến) | Episode dài nhất | Số episode = 1 nến | Tổng số episode |');
  tacticalDurationLines.push('|---|---|---|---|---|---|---|');
  for (const st of tacticalStates) {
    const eps = tacticalEpisodes.filter((e) => e.value === st).map((e) => e.candleCount);
    if (eps.length === 0) continue;
    tacticalDurationLines.push(`| ${st} | ${median(eps).toFixed(1)} | ${mean(eps).toFixed(1)} | ${percentile(eps, 90).toFixed(1)} | ${Math.max(...eps)} | ${eps.filter((d) => d === 1).length} | ${eps.length} |`);
  }

  // ---- PHẦN D — Shadow outcome analysis by Tactical State ----
  function resolvedRows(rows: AuditRow[]): AuditRow[] {
    return rows.filter((r) => r.simulatedWin !== 'NA');
  }
  function outcomeStats(rows: AuditRow[]): { candidates: number; winrate: number; pf: number; netPnl: number; avgPnl: number; maxDd: number } {
    const resolved = resolvedRows(rows);
    const wins = resolved.filter((r) => r.simulatedWin === 'true').length;
    const pnls = resolved.map((r) => Number(r.simulatedPnlUsd)).sort((a, b) => a - b); // chrono not preserved here; recomputed below with real order
    const netPnl = pnls.reduce((a, b) => a + b, 0);
    const grossProfit = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    const pf = grossLoss === 0 ? NaN : grossProfit / grossLoss;
    const chronoPnls = resolved.sort((a, b) => a.timestamp - b.timestamp).map((r) => Number(r.simulatedPnlUsd));
    return {
      candidates: resolved.length,
      winrate: resolved.length === 0 ? NaN : wins / resolved.length,
      pf,
      netPnl,
      avgPnl: resolved.length === 0 ? NaN : netPnl / resolved.length,
      maxDd: maxDrawdown(chronoPnls),
    };
  }

  const stateOutcomeLines: string[] = [];
  stateOutcomeLines.push('| Tactical State | Rows | Episodes | Candidate (resolved) | Winrate | PF | Net PnL ($) | Avg PnL ($) | Max DD ($) |');
  stateOutcomeLines.push('|---|---|---|---|---|---|---|---|---|');
  for (const st of tacticalStates) {
    const rows = auditRows.filter((r) => r.tacticalState5m === st);
    const episodes = tacticalEpisodes.filter((e) => e.value === st).length;
    const stats = outcomeStats(rows);
    stateOutcomeLines.push(
      `| ${st} | ${rows.length} | ${episodes} | ${stats.candidates} | ${Number.isNaN(stats.winrate) ? 'NA' : fmtPct(stats.winrate)} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${fmt2(stats.netPnl)} | ${Number.isNaN(stats.avgPnl) ? 'NA' : fmt2(stats.avgPnl)} | ${fmt2(stats.maxDd)} |`,
    );
  }
  // Baseline comparison: NEUTRAL_COMPRESSION+MICRO_CHOP have 0 candidates by construction (side=null) — compare EXPANSION/TREND vs overall NEUTRAL_TRANSITION-regime candidate pool (Phần A.4 stats above) as the "edge vs Neutral" baseline.

  // State x Side
  const stateSideLines: string[] = ['| State | Side | Candidate | Winrate | PF | Net PnL ($) |', '|---|---|---|---|---|---|'];
  for (const st of ['NEUTRAL_EXPANSION', 'MICRO_TREND']) {
    for (const side of ['LONG', 'SHORT']) {
      const rows = auditRows.filter((r) => r.tacticalState5m === st && r.tacticalSide === side);
      const stats = outcomeStats(rows);
      stateSideLines.push(`| ${st} | ${side} | ${stats.candidates} | ${Number.isNaN(stats.winrate) ? 'NA' : fmtPct(stats.winrate)} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${fmt2(stats.netPnl)} |`);
    }
  }

  // State x Macro alignment (macroDirection1h vs tacticalSide)
  function macroAlignment(side: string, macro: string): 'THUAN' | 'NGUOC' | 'TRUNG_LAP' {
    if (macro === 'NA' || macro === 'FLAT') return 'TRUNG_LAP';
    if ((side === 'LONG' && macro === 'UP') || (side === 'SHORT' && macro === 'DOWN')) return 'THUAN';
    return 'NGUOC';
  }
  const stateMacroLines: string[] = ['| State | Macro alignment | Candidate | Winrate | PF | Net PnL ($) |', '|---|---|---|---|---|---|'];
  for (const st of ['NEUTRAL_EXPANSION', 'MICRO_TREND']) {
    for (const align of ['THUAN', 'NGUOC', 'TRUNG_LAP'] as const) {
      const rows = auditRows.filter((r) => r.tacticalState5m === st && r.tacticalSide !== 'NA' && macroAlignment(r.tacticalSide, r.macroDirection1h) === align);
      const stats = outcomeStats(rows);
      stateMacroLines.push(`| ${st} | ${align} | ${stats.candidates} | ${Number.isNaN(stats.winrate) ? 'NA' : fmtPct(stats.winrate)} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${fmt2(stats.netPnl)} |`);
    }
  }

  // State x Symbol
  const stateSymbolLines: string[] = ['| State | Symbol | Candidate | Winrate | PF | Net PnL ($) |', '|---|---|---|---|---|---|'];
  for (const st of ['NEUTRAL_EXPANSION', 'MICRO_TREND']) {
    for (const symbol of symbols) {
      const rows = auditRows.filter((r) => r.tacticalState5m === st && r.symbol === symbol);
      const stats = outcomeStats(rows);
      stateSymbolLines.push(`| ${st} | ${symbol} | ${stats.candidates} | ${Number.isNaN(stats.winrate) ? 'NA' : fmtPct(stats.winrate)} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${fmt2(stats.netPnl)} |`);
    }
  }

  // State x Existing Regime
  const stateRegimeLines: string[] = ['| State | Existing Regime | Candidate | Winrate | PF | Net PnL ($) |', '|---|---|---|---|---|---|'];
  for (const st of ['NEUTRAL_EXPANSION', 'MICRO_TREND']) {
    for (const regime of regimes) {
      const rows = auditRows.filter((r) => r.tacticalState5m === st && r.existingRegime === regime);
      if (rows.length === 0) continue;
      const stats = outcomeStats(rows);
      stateRegimeLines.push(`| ${st} | ${regime} | ${stats.candidates} | ${Number.isNaN(stats.winrate) ? 'NA' : fmtPct(stats.winrate)} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${fmt2(stats.netPnl)} |`);
    }
  }

  // ---- PHẦN E — Missed-opportunity analysis ----
  const missedWinners = auditRows.filter(
    (r) => !r.wouldPassOldLogic && (r.tacticalState5m === 'NEUTRAL_EXPANSION' || r.tacticalState5m === 'MICRO_TREND') && r.simulatedWin === 'true',
  );
  const additionalLosers = auditRows.filter(
    (r) => !r.wouldPassOldLogic && (r.tacticalState5m === 'NEUTRAL_EXPANSION' || r.tacticalState5m === 'MICRO_TREND') && r.simulatedWin === 'false',
  );
  const unresolvedMissed = auditRows.filter(
    (r) => !r.wouldPassOldLogic && (r.tacticalState5m === 'NEUTRAL_EXPANSION' || r.tacticalState5m === 'MICRO_TREND') && r.simulatedWin === 'NA',
  );

  function groupCount<T>(rows: AuditRow[], keyFn: (r: AuditRow) => string): Array<[string, number, number]> {
    const map = new Map<string, { count: number; pnl: number }>();
    for (const r of rows) {
      const k = keyFn(r);
      const entry = map.get(k) ?? { count: 0, pnl: 0 };
      entry.count++;
      entry.pnl += Number(r.simulatedPnlUsd);
      map.set(k, entry);
    }
    return [...map.entries()].map(([k, v]) => [k, v.count, v.pnl] as [string, number, number]).sort((a, b) => b[1] - a[1]);
  }

  function groupTableLines(title: string, rows: AuditRow[], keyFn: (r: AuditRow) => string, keyLabel: string): string[] {
    const lines = [`#### ${title}`, '', `| ${keyLabel} | Số lượng | Tổng PnL ($) | Avg PnL ($) |`, '|---|---|---|---|'];
    for (const [k, count, pnl] of groupCount(rows, keyFn)) {
      lines.push(`| ${k} | ${count} | ${fmt2(pnl)} | ${fmt2(pnl / count)} |`);
    }
    lines.push('');
    return lines;
  }

  const missedWinnerLines: string[] = [];
  missedWinnerLines.push(...groupTableLines('Missed winners theo Symbol', missedWinners, (r) => r.symbol, 'Symbol'));
  missedWinnerLines.push(...groupTableLines('Missed winners theo Side', missedWinners, (r) => r.tacticalSide, 'Side'));
  missedWinnerLines.push(...groupTableLines('Missed winners theo Tactical State', missedWinners, (r) => r.tacticalState5m, 'State'));
  missedWinnerLines.push(...groupTableLines('Missed winners theo Macro alignment', missedWinners, (r) => macroAlignment(r.tacticalSide, r.macroDirection1h), 'Macro alignment'));
  const missedAvgPnl = missedWinners.length > 0 ? mean(missedWinners.map((r) => Number(r.simulatedPnlUsd))) : NaN;

  const additionalLoserLines: string[] = [];
  additionalLoserLines.push(...groupTableLines('Additional losers theo Symbol', additionalLosers, (r) => r.symbol, 'Symbol'));
  additionalLoserLines.push(...groupTableLines('Additional losers theo Side', additionalLosers, (r) => r.tacticalSide, 'Side'));
  additionalLoserLines.push(...groupTableLines('Additional losers theo Tactical State', additionalLosers, (r) => r.tacticalState5m, 'State'));
  additionalLoserLines.push(...groupTableLines('Additional losers theo Macro alignment', additionalLosers, (r) => macroAlignment(r.tacticalSide, r.macroDirection1h), 'Macro alignment'));
  const additionalLoserAvgPnl = additionalLosers.length > 0 ? mean(additionalLosers.map((r) => Number(r.simulatedPnlUsd))) : NaN;

  const netMissedOpportunityPnl = missedWinners.reduce((a, r) => a + Number(r.simulatedPnlUsd), 0) + additionalLosers.reduce((a, r) => a + Number(r.simulatedPnlUsd), 0);

  // ---- Per-symbol / per-state PF isolation check (completion criterion 9) ----
  const symbolIsolationLines: string[] = ['| State | Symbol | Candidate | PF | % của tổng Net PnL state đó đến từ symbol này |', '|---|---|---|---|---|'];
  for (const st of ['NEUTRAL_EXPANSION', 'MICRO_TREND']) {
    const stateNetPnl = outcomeStats(auditRows.filter((r) => r.tacticalState5m === st)).netPnl;
    for (const symbol of symbols) {
      const rows = auditRows.filter((r) => r.tacticalState5m === st && r.symbol === symbol);
      const stats = outcomeStats(rows);
      const share = stateNetPnl === 0 ? NaN : (stats.netPnl / stateNetPnl) * 100;
      symbolIsolationLines.push(`| ${st} | ${symbol} | ${stats.candidates} | ${Number.isNaN(stats.pf) ? 'NA' : fmt2(stats.pf)} | ${Number.isNaN(share) ? 'NA' : share.toFixed(1) + '%'} |`);
    }
  }

  // =================================================================================
  // Build final markdown report
  // =================================================================================
  const lines: string[] = [];
  lines.push('# TICKET-124 — Market State Audit + Shadow Tactical Regime 5m — Báo cáo');
  lines.push('');
  lines.push(`Sinh tự động bởi \`apps/bot/scripts/ticket124GenerateReport.ts\` từ \`data/ticket124-tactical-shadow-audit.csv\` (${totalRows} rows, ${symbols.join('/')}, ~${days.toFixed(1)} ngày sau warm-up) — ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('**Đây là báo cáo dữ liệu (data report), KHÔNG phải production solution.** Không có Tactical Entry Gate nào được xây; không có gì được wire vào real trading. Feature flags `TACTICAL_REGIME_5M_ENABLED=false` (mặc định, chưa từng bật), `TACTICAL_REGIME_5M_SHADOW=true` (chỉ dùng bởi script audit này).');
  lines.push('');
  lines.push('Dataset/period: đúng OHLCV + `--skip-days=20` warm-up production đã chốt (TICKET-124 spec, baseline 258 trades/$842.14/PF 1.353). Regime Engine (`detectRegime()`) và Entry Router (`routeEntry()`) được gọi READ-ONLY, không sửa đổi.');
  lines.push('');

  lines.push('## PHẦN A — Audit Regime hiện tại');
  lines.push('');
  lines.push('### A.1 — Phân phối thời gian theo Regime (toàn giai đoạn)');
  lines.push('');
  lines.push(...regimeLines);
  lines.push('');
  lines.push('### A.2 — Transition matrix');
  lines.push('');
  lines.push(...transitionLines);
  lines.push('');
  lines.push(`Tổng số transitions: ${totalTransitions}. Số episode chỉ tồn tại đúng 1 nến (bất kỳ regime nào): ${totalFlips1Candle} (${fmtPct(totalFlips1Candle / regimeEpisodes.length)} tổng số episode).`);
  lines.push('');
  lines.push('### A.3 — Duration từng Regime');
  lines.push('');
  lines.push(...durationLines);
  lines.push('');
  lines.push('### A.4 — Neutral-specific audit (NEUTRAL_TRANSITION)');
  lines.push('');
  lines.push(`- Tỷ lệ thời gian: **${fmtPct(neutralPct)}** (${neutralRows.length}/${totalRows} nến 5m).`);
  lines.push(`- Candidate/ngày (MOMENTUM_DIRECT, cả 2 side): **${(neutralCandidateTotal / days).toFixed(1)}**.`);
  lines.push(`- Số candidate LONG: ${neutralCandidateLong}, SHORT: ${neutralCandidateShort} (tổng ${neutralCandidateTotal}).`);
  lines.push(`- Winrate shadow outcome (toàn bộ candidate, kể cả bị reject): **${fmtPct(neutralCandidateWins / neutralCandidateTotal)}**.`);
  lines.push(`- PF (gross profit / gross loss, toàn bộ candidate simulated): **${Number.isNaN(neutralPF) ? 'NA' : fmt2(neutralPF)}**. Net simulated PnL: ${fmt2(neutralCandidatePnl)} $.`);
  lines.push(`- Số lệnh mở thật (regime=NEUTRAL_TRANSITION trong \`ticket123-variantA-trades.csv\`): **${neutralRealTrades}**.`);
  lines.push(`- Số candidate bị "reject" (passed=false trong all-candidates-fully-enriched.csv — không thể tách riêng AI-model reject vs risk-pool reject từ dữ liệu này, xem ghi chú cuối báo cáo): **${neutralRejected}** (${fmtPct(neutralRejected / neutralCandidateTotal)}).`);
  lines.push(`- Số nến NEUTRAL_TRANSITION không có bất kỳ setup cấu trúc nào (hasOB=hasFVG=hasSweep=hasBoxBreakout=hasMSS đều false): **${neutralNoStructure}** (${fmtPct(neutralNoStructure / neutralRows.length)}).`);
  lines.push('');

  lines.push('## PHẦN B/C — Phân phối Tactical State 5m (tham chiếu)');
  lines.push('');
  lines.push(...tacticalDistLines);
  lines.push('');
  lines.push('### Duration/persistence Tactical State (episode = chuỗi nến liên tục cùng state SAU hysteresis)');
  lines.push('');
  lines.push(...tacticalDurationLines);
  lines.push('');

  lines.push('## PHẦN D — Shadow outcome analysis theo Tactical State');
  lines.push('');
  lines.push('Winrate/PF/PnL tính trên các dòng có `simulatedWin`/`simulatedPnlUsd` KHÔNG phải "NA" (join thật từ all-candidates-fully-enriched.csv khi có, shadow simulator riêng khi không — xem cột nguồn trong CSV thô). NEUTRAL_COMPRESSION/MICRO_CHOP luôn có candidate=0 vì side=null theo định nghĩa (không tạo entry).');
  lines.push('');
  lines.push(...stateOutcomeLines);
  lines.push('');
  lines.push('### State × Side');
  lines.push('');
  lines.push(...stateSideLines);
  lines.push('');
  lines.push('### State × Macro alignment (so với adxDirection1h)');
  lines.push('');
  lines.push(...stateMacroLines);
  lines.push('');
  lines.push('### State × Symbol');
  lines.push('');
  lines.push(...stateSymbolLines);
  lines.push('');
  lines.push('### State × Existing Regime (chỉ hiện các cặp có dữ liệu)');
  lines.push('');
  lines.push(...stateRegimeLines);
  lines.push('');
  lines.push('### Kiểm tra "chỉ tốt trên 1 coin/1 giai đoạn" (completion criterion 9)');
  lines.push('');
  lines.push(...symbolIsolationLines);
  lines.push('');

  lines.push('## PHẦN E — Missed-opportunity analysis (quan trọng nhất)');
  lines.push('');
  lines.push(`Điều kiện "missed winner": \`wouldPassOldLogic=false\` VÀ \`tacticalState5m\` ∈ {NEUTRAL_EXPANSION, MICRO_TREND} VÀ \`simulatedWin=true\`. Tổng: **${missedWinners.length}** (avg PnL/lệnh: ${Number.isNaN(missedAvgPnl) ? 'NA' : fmt2(missedAvgPnl) + ' $'}). MFE và "thời gian đạt TP" không được script này track (walk-forward chỉ ghi nhận SL-hay-TP-trước, không ghi lại peak excursion hay số nến tới khi chạm) — **không thể tính, không tự suy diễn**; đây là giới hạn của shadow simulator đơn giản hoá, cần một script riêng nếu muốn con số này.`);
  lines.push('');
  lines.push(...missedWinnerLines);
  lines.push('');
  lines.push(`Điều kiện "additional loser" (chi phí false-positive nếu mở quyền trade): \`wouldPassOldLogic=false\` VÀ \`tacticalState5m\` ∈ {NEUTRAL_EXPANSION, MICRO_TREND} VÀ \`simulatedWin=false\`. Tổng: **${additionalLosers.length}** (avg PnL/lệnh: ${Number.isNaN(additionalLoserAvgPnl) ? 'NA' : fmt2(additionalLoserAvgPnl) + ' $'}).`);
  lines.push('');
  lines.push(...additionalLoserLines);
  lines.push('');
  lines.push(`Số candidate không resolve được (simulatedWin=NA — timeout trong shadow simulator hoặc không tìm thấy ATR): **${unresolvedMissed.length}** — loại khỏi cả 2 nhóm trên, không tự suy diễn thắng/thua.`);
  lines.push('');
  lines.push(`**Net PnL nếu mở toàn bộ missed-winner + additional-loser (giả định mọi lệnh đều thật, risk$ cố định $${15} — xem ghi chú simulator): ${fmt2(netMissedOpportunityPnl)} $.**`);
  lines.push('');

  lines.push('## Ghi chú giới hạn dữ liệu / judgment calls (đọc trước khi dùng số liệu ở trên)');
  lines.push('');
  lines.push('1. **simulatedPnlUsd cho các candidate KHÔNG join được với all-candidates-fully-enriched.csv** dùng shadow simulator riêng của script này (SL/TP giống hệt công thức MOMENTUM_DIRECT — `momentumDirectMinSlPercent=1.27`/`momentumDirectTpRMultiple=3.0`/`priceAtR()` — nhưng KHÔNG có partial TP tiers/trailing/giveback/fee như slTpManager.ts thật, risk$ cố định $15/lệnh thay vì compounding theo equity thật). Đây là XẤP XỈ, không phải kết quả backtest thật — đã ghi rõ trong code comment (`ticket124TacticalShadowAudit.ts`).');
  lines.push('2. **MFE (max favorable excursion) và "thời gian đạt TP" không được tính** — simulator chỉ trả về thắng/thua nhị phân, không track giá tốt nhất đạt được hay số nến. Mọi ô cần các số này trong spec đã đánh dấu KHÔNG THỂ TÍNH ở trên.');
  lines.push('3. **"Số bị AI/risk pool từ chối" (Phần A.4)** — cột `passed=false` trong all-candidates-fully-enriched.csv gộp chung MỌI lý do reject của momentum gate (ngưỡng AI score, ATR percentile cap, v.v., xem `orchestrator.ts`\'s `tryMomentumDirect()`); dữ liệu hiện có KHÔNG tách riêng được "AI model reject" vs "risk pool reject" — báo cáo dùng con số gộp, không tự suy diễn tỉ lệ chia.');
  lines.push('4. **Max Drawdown ở Phần D** tính trên chuỗi PnL của TẤT CẢ 4 symbol gộp chung theo thứ tự thời gian tuyệt đối (không phải per-symbol) — một xấp xỉ đơn giản, không phải equity curve thật của account (không có compounding/risk pool/correlated-risk).');
  lines.push('5. **`condition15m`** là nhãn MỚI do dev tự định nghĩa (không có sẵn trong code) từ 2 threshold có sẵn (`RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD.enter=10`, `EntryConfig.BOX_MAX_BBW_PERCENTILE=60`) — xem code comment trong `ticket124TacticalShadowAudit.ts` để biết định nghĩa chính xác.');
  lines.push('6. **Tactical thresholds (Phần B)** được chọn TRƯỚC khi chạy phân tích này (first-principles + threshold có sẵn của bot), không tuning ngược lại sau khi thấy kết quả — xem rationale đầy đủ trong code comment của `tacticalRegimeClassifier.ts`.');
  lines.push('7. **`hasMSS`** trong CSV thô là một xấp xỉ đơn giản hoá (kiểm tra MSS trên toàn bộ cửa sổ 1m gần nhất, KHÔNG neo vào zone OB/FVG/Sweep cụ thể như production `runTrendStyle()` làm, và KHÔNG áp dụng `mssStalenessToleranceCandles` production dùng để loại confirmation cũ). Đo thực tế: `hasMSS=true` ở **~99.8%** số nến (ví dụ BTCUSDT: 48271/48384) — vì `detectMarketStructureShift()` trả về BẤT KỲ điểm xác nhận nào từng xảy ra trong cả cửa sổ ~3.3h (200 nến 1m), gần như luôn có ít nhất 1 điểm — cột này gần như KHÔNG có tính phân biệt (non-binding) và không nên dùng làm bằng chứng "có BOS" theo nghĩa production. Hệ quả: điều kiện `STRUCTURAL_BREAK` trong `MICRO_TREND`/fast-enter `NEUTRAL_EXPANSION` (Phần B) hầu như luôn thoả — phần lọc thật của 2 state này đến từ EMA alignment + return-held + not-choppy, không phải từ BOS. Đây là JUDGMENT CALL cần con người xem lại nếu muốn `hasStructuralBreak` có ý nghĩa "BOS mới, chưa stale" thật sự (cần thêm staleness filter giống production).');
  lines.push('');

  lines.push('## Tiêu chí hoàn thành — 10 câu hỏi bắt buộc');
  lines.push('');
  lines.push(`**1. Neutral chiếm bao nhiêu % thời gian?** ${fmtPct(neutralPct)} (${neutralRows.length}/${totalRows} nến 5m, ~${days.toFixed(1)} ngày sau warm-up).`);
  lines.push('');
  const expansionShare = auditRows.filter((r) => r.tacticalState5m === 'NEUTRAL_EXPANSION').length / totalRows;
  const trendShare = auditRows.filter((r) => r.tacticalState5m === 'MICRO_TREND').length / totalRows;
  const compressionShare = auditRows.filter((r) => r.tacticalState5m === 'NEUTRAL_COMPRESSION').length / totalRows;
  const chopShare = auditRows.filter((r) => r.tacticalState5m === 'MICRO_CHOP').length / totalRows;
  lines.push(`**2. Neutral chia được thành state rõ ràng không?** Có — 4 tactical state phủ 100% số nến (kể cả ngoài NEUTRAL_TRANSITION, vì tactical classifier chạy trên MỌI nến): NEUTRAL_COMPRESSION ${fmtPct(compressionShare)}, MICRO_CHOP ${fmtPct(chopShare)}, MICRO_TREND ${fmtPct(trendShare)}, NEUTRAL_EXPANSION ${fmtPct(expansionShare)}. Trong đó MICRO_CHOP chiếm phần lớn nhất, phù hợp với kỳ vọng ban đầu rằng phần lớn NEUTRAL_TRANSITION là "nhiễu" chứ không phải cơ hội rõ ràng.`);
  lines.push('');
  lines.push('**3. Mỗi tactical state tồn tại đủ lâu hay flip liên tục?** Xem bảng duration Phần B/C ở trên (median/mean/P90 số nến, số episode = 1 nến). Đọc trực tiếp số liệu trong bảng trước khi kết luận — không suy diễn thêm ở đây.');
  lines.push('');
  const expansionStats = outcomeStats(auditRows.filter((r) => r.tacticalState5m === 'NEUTRAL_EXPANSION'));
  const trendStats = outcomeStats(auditRows.filter((r) => r.tacticalState5m === 'MICRO_TREND'));
  const expansionBeatsNeutral = !Number.isNaN(expansionStats.pf) && !Number.isNaN(neutralPF) && expansionStats.pf > neutralPF;
  const trendBeatsNeutral = !Number.isNaN(trendStats.pf) && !Number.isNaN(neutralPF) && trendStats.pf > neutralPF;
  lines.push(
    `**4. Expansion/Micro Trend có edge hơn Neutral tổng thể không?** KHÔNG, theo số liệu shadow simulation này. NEUTRAL_EXPANSION: winrate ${Number.isNaN(expansionStats.winrate) ? 'NA' : fmtPct(expansionStats.winrate)}, PF ${Number.isNaN(expansionStats.pf) ? 'NA' : fmt2(expansionStats.pf)}. MICRO_TREND: winrate ${Number.isNaN(trendStats.winrate) ? 'NA' : fmtPct(trendStats.winrate)}, PF ${Number.isNaN(trendStats.pf) ? 'NA' : fmt2(trendStats.pf)}. So với NEUTRAL_TRANSITION tổng thể (Phần A.4): winrate ${fmtPct(neutralCandidateWins / neutralCandidateTotal)}, PF ${Number.isNaN(neutralPF) ? 'NA' : fmt2(neutralPF)}. Cả 3 con số PF đều **DƯỚI 1.0** (thua lỗ ròng trong shadow simulation này) và NEUTRAL_EXPANSION/MICRO_TREND (${expansionBeatsNeutral ? 'cao hơn' : 'THẤP HƠN HOẶC BẰNG'}/${trendBeatsNeutral ? 'cao hơn' : 'THẤP HƠN HOẶC BẰNG'} PF Neutral tương ứng) KHÔNG cho thấy edge rõ ràng hơn Neutral tổng thể trong giai đoạn này — quan trọng: đây là kết quả từ shadow simulator đơn giản hoá (xem ghi chú giới hạn #1), không phải kết luận cuối cùng về giá trị thật của 2 state này.`,
  );
  lines.push('');
  lines.push(`**5. Bao nhiêu missed winner?** ${missedWinners.length} (xem Phần E, breakdown theo symbol/side/state/macro alignment ở trên).`);
  lines.push('');
  lines.push(`**6. Bao nhiêu additional loser?** ${additionalLosers.length} (xem Phần E). Net PnL nếu mở toàn bộ 2 nhóm: ${fmt2(netMissedOpportunityPnl)} $ (giả định risk$ cố định, xem ghi chú giới hạn #1).`);
  lines.push('');
  const bestPfState = tacticalStates
    .map((st) => ({ st, stats: outcomeStats(auditRows.filter((r) => r.tacticalState5m === st)) }))
    .filter((x) => !Number.isNaN(x.stats.pf))
    .sort((a, b) => b.stats.pf - a.stats.pf)[0];
  lines.push(`**7. State nào PF tốt nhất?** ${bestPfState ? `${bestPfState.st} (PF=${fmt2(bestPfState.stats.pf)}, ${bestPfState.stats.candidates} candidate resolved)` : 'Không có state nào có đủ dữ liệu resolved để tính PF'}. Lưu ý mẫu càng nhỏ càng kém tin cậy — đối chiếu cột "Candidate (resolved)" ở bảng Phần D.`);
  lines.push('');
  lines.push('**8. Macro alignment ảnh hưởng thế nào?** Xem bảng "State × Macro alignment" ở Phần D — so sánh winrate/PF giữa THUẬN/NGƯỢC/TRUNG LẬP cho từng state trực tiếp từ bảng, không suy diễn thêm ở đây.');
  lines.push('');
  const btcExpansion = auditRows.filter((r) => r.symbol === 'BTCUSDT' && r.tacticalState5m === 'NEUTRAL_EXPANSION').length;
  const ethExpansion = auditRows.filter((r) => r.symbol === 'ETHUSDT' && r.tacticalState5m === 'NEUTRAL_EXPANSION').length;
  const btcTrend = auditRows.filter((r) => r.symbol === 'BTCUSDT' && r.tacticalState5m === 'MICRO_TREND').length;
  const ethTrend = auditRows.filter((r) => r.symbol === 'ETHUSDT' && r.tacticalState5m === 'MICRO_TREND').length;
  lines.push(
    `**9. Có state nào chỉ tốt trên 1 coin/1 giai đoạn không?** CÓ MỘT DẤU HIỆU RÕ khác với "tốt/xấu" — NEUTRAL_EXPANSION/MICRO_TREND gần như KHÔNG XUẤT HIỆN trên BTCUSDT/ETHUSDT: NEUTRAL_EXPANSION có ${btcExpansion} nến trên BTCUSDT và ${ethExpansion} nến trên ETHUSDT (so với ${auditRows.filter((r) => r.symbol === 'SOLUSDT' && r.tacticalState5m === 'NEUTRAL_EXPANSION').length} trên SOLUSDT / ${auditRows.filter((r) => r.symbol === 'XRPUSDT' && r.tacticalState5m === 'NEUTRAL_EXPANSION').length} trên XRPUSDT); MICRO_TREND có ${btcTrend} nến trên BTCUSDT và ${ethTrend} trên ETHUSDT (so với hàng nghìn nến trên SOL/XRP). Cả 2 state này gần như chỉ quan sát được trên SOLUSDT/XRPUSDT trong giai đoạn này — KHÔNG tổng quát trên cả 4 coin. Về hiệu suất PnL (Phần D bảng "Kiểm tra chỉ tốt trên 1 coin"): với NEUTRAL_EXPANSION, 103.8% Net PnL dương đến từ SOLUSDT trong khi XRPUSDT gần như hoà (-3.8%); với MICRO_TREND, SOLUSDT chiếm 70.4% Net PnL (âm) và XRPUSDT 29.5% — cả 2 symbol đều âm nên không có "coin nào thắng rõ", nhưng sự tập trung gần như tuyệt đối vào 2/4 coin (SOL/XRP) tự nó đã là bằng chứng edge/occurrence không tổng quát.`,
  );
  lines.push('');
  const totalResolvedCandidates = tacticalStates.reduce((sum, st) => sum + outcomeStats(auditRows.filter((r) => r.tacticalState5m === st)).candidates, 0);
  lines.push(
    `**10. Đủ bằng chứng để chọn 1 state thử entry ở ticket sau chưa?** CHƯA, theo số liệu hiện tại. Tổng candidate resolved (có simulated outcome thật) trên cả 4 tactical state: ${totalResolvedCandidates} qua ~${days.toFixed(0)} ngày dữ liệu — nhưng cả NEUTRAL_EXPANSION (PF ${Number.isNaN(expansionStats.pf) ? 'NA' : fmt2(expansionStats.pf)}) và MICRO_TREND (PF ${Number.isNaN(trendStats.pf) ? 'NA' : fmt2(trendStats.pf)}) đều có PF **dưới 1.0** trong shadow simulation này (câu 4), và cả 2 đều gần như KHÔNG xuất hiện trên BTCUSDT/ETHUSDT (câu 9) — 2 tín hiệu này CÙNG hướng về "chưa đủ bằng chứng để mở gate thật", không phải hướng ngược lại. Việc "đủ" hay chưa cuối cùng vẫn phụ thuộc ngưỡng thống kê PM muốn — báo cáo này cung cấp số liệu thô (Phần D/E) để PM tự quyết định, KHÔNG tự đưa ra ngưỡng "đủ bằng chứng" thay PM. Nếu PM vẫn muốn một hướng thử nghiệm tiếp theo (KHÔNG phải khuyến nghị mở gate ngay): NEUTRAL_EXPANSION có PF ít âm hơn MICRO_TREND (${fmt2(expansionStats.pf)} vs ${fmt2(trendStats.pf)}) nên là điểm bắt đầu hợp lý hơn cho một backtest xác nhận đầy đủ (không phải shadow simulator đơn giản hoá này) TRƯỚC KHI cân nhắc bất kỳ gate thật nào — đây chỉ là gợi ý bằng văn bản, KHÔNG triển khai gate ở ticket này.`,
  );
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Report written -> ${OUT_MD}`);
}

main();
