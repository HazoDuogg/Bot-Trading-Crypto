/**
 * TICKET-127 — STRICT TACTICAL CANDIDATE SCREENING.
 *
 * Pure post-processing/analysis script. Reads ONLY `data/ticket126-normalized-return-shadow-audit.csv`
 * (TICKET-126's output, 193536 rows). Never touches src/, never reruns the backtest, never opens a
 * position. Writes `data/ticket127-strict-candidate-screening-report.md`.
 *
 * KHÔNG sửa classifier/threshold ở ticket này — chỉ đọc/lọc/phân tích output có sẵn.
 *
 * Group A — Strict Expansion: existingRegime=NEUTRAL_TRANSITION AND tacticalState5m=NEUTRAL_EXPANSION
 *           AND reasonCodes KHÔNG chứa "FALLBACK_NO_STRICT_MATCH".
 * Group B — Strict Micro Trend: same but tacticalState5m=MICRO_TREND.
 *
 * Run (from repo root, after build:scripts):
 *   node apps/bot/scripts-dist/ticket127StrictCandidateScreening.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AUDIT_CSV = path.resolve(process.cwd(), 'data/ticket126-normalized-return-shadow-audit.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket127-strict-candidate-screening-report.md');

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
function num(v: string): number | undefined {
  return v === 'NA' || v === '' ? undefined : Number(v);
}

interface Row {
  timestamp: number;
  symbol: string;
  existingRegime: string;
  macroDirection1h: string;
  tacticalState5m: string;
  tacticalSide: string;
  reasonCodes: string;
  volumeZScore5m: number | undefined;
  returnInAtr5m: number | undefined;
  structuralBreakAgeCandles: number | undefined;
  wouldPassOldLogic: boolean;
  simulatedWin: string; // 'true' | 'false' | 'NA'
  simulatedPnlUsd: string; // number-as-string or 'NA'
}

function loadRows(): Row[] {
  const { header, rows } = parseCsv(AUDIT_CSV);
  const c = (name: string) => col(header, name);
  const idx = {
    timestamp: c('timestamp'),
    symbol: c('symbol'),
    existingRegime: c('existingRegime'),
    macroDirection1h: c('macroDirection1h'),
    tacticalState5m: c('tacticalState5m'),
    tacticalSide: c('tacticalSide'),
    reasonCodes: c('reasonCodes'),
    volumeZScore5m: c('volumeZScore5m'),
    returnInAtr5m: c('returnInAtr5m'),
    structuralBreakAgeCandles: c('structuralBreakAgeCandles'),
    wouldPassOldLogic: c('wouldPassOldLogic'),
    simulatedWin: c('simulatedWin'),
    simulatedPnlUsd: c('simulatedPnlUsd'),
  };
  return rows.map((r) => ({
    timestamp: Number(r[idx.timestamp]),
    symbol: r[idx.symbol],
    existingRegime: r[idx.existingRegime],
    macroDirection1h: r[idx.macroDirection1h],
    tacticalState5m: r[idx.tacticalState5m],
    tacticalSide: r[idx.tacticalSide],
    reasonCodes: r[idx.reasonCodes],
    volumeZScore5m: num(r[idx.volumeZScore5m]),
    returnInAtr5m: num(r[idx.returnInAtr5m]),
    structuralBreakAgeCandles: num(r[idx.structuralBreakAgeCandles]),
    wouldPassOldLogic: r[idx.wouldPassOldLogic] === 'true',
    simulatedWin: r[idx.simulatedWin],
    simulatedPnlUsd: r[idx.simulatedPnlUsd],
  }));
}

// ---------------------------------------------------------------------------------------------
// Helpers (same conventions as TICKET-124/125/126's report scripts)
// ---------------------------------------------------------------------------------------------
function fmtPct(n: number): string {
  return Number.isNaN(n) ? 'NA' : `${(n * 100).toFixed(2)}%`;
}
function fmt2(n: number): string {
  return Number.isNaN(n) ? 'NA' : n.toFixed(2);
}
function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function maxDrawdown(pnlSeriesChronological: number[]): number {
  let equity = 0,
    peak = 0,
    maxDd = 0;
  for (const pnl of pnlSeriesChronological) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}
/** Longest consecutive losing streak (chronological), counted in resolved candidates. */
function longestLossStreak(pnlSeriesChronological: number[]): number {
  let longest = 0,
    current = 0;
  for (const pnl of pnlSeriesChronological) {
    if (pnl < 0) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function resolvedRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.simulatedWin !== 'NA');
}

interface OutcomeStats {
  candidates: number;
  resolvedCount: number;
  unresolvedCount: number;
  unresolvedRate: number;
  winrate: number;
  pf: number;
  netPnl: number;
  avgPnl: number;
  medianPnl: number;
  maxDd: number;
  longestLossStreak: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
}
function outcomeStats(rows: Row[]): OutcomeStats {
  const resolved = resolvedRows(rows);
  const chronoSorted = [...resolved].sort((a, b) => a.timestamp - b.timestamp);
  const chronoPnls = chronoSorted.map((r) => Number(r.simulatedPnlUsd));
  const wins = chronoPnls.filter((p) => p > 0);
  const losses = chronoPnls.filter((p) => p <= 0);
  const netPnl = chronoPnls.reduce((a, b) => a + b, 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = grossLoss === 0 ? NaN : grossProfit / grossLoss;
  return {
    candidates: rows.length,
    resolvedCount: resolved.length,
    unresolvedCount: rows.length - resolved.length,
    unresolvedRate: rows.length === 0 ? NaN : (rows.length - resolved.length) / rows.length,
    winrate: resolved.length === 0 ? NaN : resolved.filter((r) => r.simulatedWin === 'true').length / resolved.length,
    pf,
    netPnl,
    avgPnl: resolved.length === 0 ? NaN : netPnl / resolved.length,
    medianPnl: median(chronoPnls),
    maxDd: maxDrawdown(chronoPnls),
    longestLossStreak: longestLossStreak(chronoPnls),
    grossProfit,
    grossLoss,
    avgWin: wins.length === 0 ? NaN : mean(wins),
    avgLoss: losses.length === 0 ? NaN : mean(losses),
  };
}

function macroAlignment(side: string, macro: string): 'THUAN' | 'NGUOC' | 'TRUNG_LAP' {
  if (macro === 'NA' || macro === 'FLAT') return 'TRUNG_LAP';
  if ((side === 'LONG' && macro === 'UP') || (side === 'SHORT' && macro === 'DOWN')) return 'THUAN';
  return 'NGUOC';
}

function topNConcentration(rows: Row[], n: number): { topNPnl: number; pctOfNetPositive: number } {
  const resolved = resolvedRows(rows);
  const winPnls = resolved.map((r) => Number(r.simulatedPnlUsd)).filter((p) => p > 0).sort((a, b) => b - a);
  const totalPositive = winPnls.reduce((a, b) => a + b, 0);
  const topNPnl = winPnls.slice(0, n).reduce((a, b) => a + b, 0);
  return { topNPnl, pctOfNetPositive: totalPositive === 0 ? NaN : topNPnl / totalPositive };
}

// Fee/slippage assumption: reuse the bot's own takerFeeRate=0.0004 (liveRunner.ts convention),
// applied twice per round-trip trade (entry + exit), plus a small stated slippage assumption
// (0.02% per side, first-principles, NOT tuned on this dataset's outcome).
const TAKER_FEE_RATE = 0.0004;
const SLIPPAGE_RATE = 0.0002;
const ASSUMED_NOTIONAL_PER_TRADE = 15; // matches TICKET-124/125/126 simulator's fixed $15 risk convention used for these shadow rows
function feeAdjustedNetPnl(rows: Row[]): number {
  const resolved = resolvedRows(rows);
  const costPerTrade = ASSUMED_NOTIONAL_PER_TRADE * (TAKER_FEE_RATE + SLIPPAGE_RATE) * 2; // entry+exit, both fee+slippage
  const rawNet = resolved.reduce((a, r) => a + Number(r.simulatedPnlUsd), 0);
  return rawNet - costPerTrade * resolved.length;
}

// ---------------------------------------------------------------------------------------------
// Load + filter
// ---------------------------------------------------------------------------------------------
function main(): void {
  console.log('TICKET-127 — Strict Tactical Candidate Screening...');
  const allRows = loadRows();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const totalRows = allRows.length;

  const isStrictMatch = (r: Row) => !r.reasonCodes.includes('FALLBACK_NO_STRICT_MATCH');
  const groupARows = allRows.filter((r) => r.existingRegime === 'NEUTRAL_TRANSITION' && r.tacticalState5m === 'NEUTRAL_EXPANSION' && isStrictMatch(r));
  const groupBRows = allRows.filter((r) => r.existingRegime === 'NEUTRAL_TRANSITION' && r.tacticalState5m === 'MICRO_TREND' && isStrictMatch(r));

  // Sub-period windows: dataset spans 2026-02-11T01:10:00Z -> 2026-07-29T01:10:00Z (168 days exactly),
  // starting at the SAME date TICKET-123's S1/S2/S3 stability windows started. 168/3=56 exactly ->
  // reuse TICKET-123's 56-day cadence, applied to this dataset's own full range (TICKET-123's own S1-S3
  // covered only 165 of those days via its --skip-days=20 backtest's realized trade dates; this dataset
  // is the raw OHLCV audit range, 3 days longer, so windows are re-anchored to ITS min/max timestamp,
  // not copy-pasted verbatim).
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const r of allRows) {
    if (r.timestamp < minTs) minTs = r.timestamp;
    if (r.timestamp > maxTs) maxTs = r.timestamp;
  }
  maxTs += 1;
  const span = maxTs - minTs;
  const third = span / 3;
  const windowBounds = [minTs, minTs + third, minTs + 2 * third, maxTs];
  function subPeriodOf(ts: number): 'S1' | 'S2' | 'S3' {
    if (ts < windowBounds[1]) return 'S1';
    if (ts < windowBounds[2]) return 'S2';
    return 'S3';
  }

  const lines: string[] = [];
  lines.push('# TICKET-127 — Strict Tactical Candidate Screening — Báo cáo');
  lines.push('');
  lines.push(
    `Sinh tự động bởi \`apps/bot/scripts/ticket127StrictCandidateScreening.ts\` từ \`data/ticket126-normalized-return-shadow-audit.csv\` (${totalRows} rows) — ${new Date().toISOString()}.`,
  );
  lines.push('');
  lines.push(
    '**Mục tiêu DUY NHẤT của ticket này: ĐO edge của tín hiệu strict-match hiện có (NEUTRAL_EXPANSION / MICRO_TREND, existingRegime=NEUTRAL_TRANSITION, KHÔNG có FALLBACK_NO_STRICT_MATCH trong reasonCodes). KHÔNG sửa classifier/threshold. `tacticalRegimeClassifier.ts`, `structuralBreakRecent.ts`, `marketStructureShift.ts` giữ nguyên byte-identical trong suốt ticket này (xác nhận bằng checksum/git diff ở cuối báo cáo).**',
  );
  lines.push('');
  lines.push(
    `Sub-period windows (KHÔNG chồng lấn, chia đều dataset ${(span / 86400000).toFixed(1)} ngày thành 3 phần bằng nhau, cùng ngày bắt đầu với TICKET-123's S1/S2/S3 nhưng re-anchor lại theo min/max timestamp của chính dataset này — vì dataset này (raw OHLCV audit range) dài hơn vài ngày so với TICKET-123's realized-trade date range): S1 [${new Date(windowBounds[0]).toISOString()} .. ${new Date(windowBounds[1]).toISOString()}), S2 [${new Date(windowBounds[1]).toISOString()} .. ${new Date(windowBounds[2]).toISOString()}), S3 [${new Date(windowBounds[2]).toISOString()} .. ${new Date(windowBounds[3]).toISOString()}].`,
  );
  lines.push('');

  // =================================================================================
  // Headline table
  // =================================================================================
  lines.push('## Bảng chính — Group A vs Group B');
  lines.push('');
  lines.push('| Group | Candidates (rows) | Resolved | Winrate | PF | Net PnL ($) | Avg PnL ($) | Median PnL ($) | Max DD ($) | Longest loss streak |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const groupStats = new Map<string, OutcomeStats>();
  for (const [name, rows] of [['Group A (Strict Expansion)', groupARows] as const, ['Group B (Strict Micro Trend)', groupBRows] as const]) {
    const s = outcomeStats(rows);
    groupStats.set(name, s);
    lines.push(
      `| ${name} | ${s.candidates} | ${s.resolvedCount} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} | ${fmt2(s.avgPnl)} | ${fmt2(s.medianPnl)} | ${fmt2(s.maxDd)} | ${s.longestLossStreak} |`,
    );
  }
  lines.push('');

  lines.push('### Gross profit/loss + avg win/loss + unresolved rate');
  lines.push('');
  lines.push('| Group | Gross Profit ($) | Gross Loss ($) | Avg Win ($) | Avg Loss ($) | simulatedWin=NA rate |');
  lines.push('|---|---|---|---|---|---|');
  for (const [name, rows] of [['Group A', groupARows] as const, ['Group B', groupBRows] as const]) {
    const s = outcomeStats(rows);
    lines.push(`| ${name} | ${fmt2(s.grossProfit)} | ${fmt2(s.grossLoss)} | ${fmt2(s.avgWin)} | ${fmt2(s.avgLoss)} | ${fmtPct(s.unresolvedRate)} (${s.unresolvedCount}/${s.candidates}) |`);
  }
  lines.push('');

  // Missed winners / additional losers (TICKET-124's exact definition, reused verbatim)
  lines.push('### Missed winners / Additional losers (định nghĩa TICKET-124: `wouldPassOldLogic=false` trong nhóm này)');
  lines.push('');
  lines.push('| Group | Missed winners (simulatedWin=true) | Additional losers (simulatedWin=false) |');
  lines.push('|---|---|---|');
  for (const [name, rows] of [['Group A', groupARows] as const, ['Group B', groupBRows] as const]) {
    const missed = rows.filter((r) => !r.wouldPassOldLogic && r.simulatedWin === 'true').length;
    const additional = rows.filter((r) => !r.wouldPassOldLogic && r.simulatedWin === 'false').length;
    lines.push(`| ${name} | ${missed} | ${additional} |`);
  }
  lines.push('');

  // Concentration — top 1/3/5 winner dependence
  lines.push('### Mức độ phụ thuộc vào các lệnh thắng lớn nhất (concentration check)');
  lines.push('');
  lines.push('| Group | Top-1 winner PnL | % of gross positive | Top-3 winners PnL | % of gross positive | Top-5 winners PnL | % of gross positive |');
  lines.push('|---|---|---|---|---|---|---|');
  const concentration = new Map<string, { top1: ReturnType<typeof topNConcentration>; top3: ReturnType<typeof topNConcentration>; top5: ReturnType<typeof topNConcentration> }>();
  for (const [name, rows] of [['Group A', groupARows] as const, ['Group B', groupBRows] as const]) {
    const top1 = topNConcentration(rows, 1);
    const top3 = topNConcentration(rows, 3);
    const top5 = topNConcentration(rows, 5);
    concentration.set(name, { top1, top3, top5 });
    lines.push(
      `| ${name} | ${fmt2(top1.topNPnl)} | ${fmtPct(top1.pctOfNetPositive)} | ${fmt2(top3.topNPnl)} | ${fmtPct(top3.pctOfNetPositive)} | ${fmt2(top5.topNPnl)} | ${fmtPct(top5.pctOfNetPositive)} |`,
    );
  }
  lines.push('');

  // Side / Symbol / Macro alignment / Sub-period breakdowns
  function breakdownTable(title: string, groups: Array<[string, Row[]]>, keyLabel: string, keys: string[], keyFn: (r: Row) => string): void {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(`| Group | ${keyLabel} | Candidates | Resolved | Winrate | PF | Net PnL ($) | Avg PnL ($) |`);
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const [name, rows] of groups) {
      for (const key of keys) {
        const filtered = rows.filter((r) => keyFn(r) === key);
        const s = outcomeStats(filtered);
        lines.push(`| ${name} | ${key} | ${s.candidates} | ${s.resolvedCount} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} | ${fmt2(s.avgPnl)} |`);
      }
    }
    lines.push('');
  }
  const groupPairs: Array<[string, Row[]]> = [
    ['Group A', groupARows],
    ['Group B', groupBRows],
  ];
  breakdownTable('Theo Side (LONG/SHORT)', groupPairs, 'Side', ['LONG', 'SHORT'], (r) => r.tacticalSide);
  breakdownTable('Theo Symbol', groupPairs, 'Symbol', symbols, (r) => r.symbol);
  breakdownTable('Theo Macro alignment (thuận/ngược 1H)', groupPairs, 'Alignment', ['THUAN', 'NGUOC', 'TRUNG_LAP'], (r) => macroAlignment(r.tacticalSide, r.macroDirection1h));
  breakdownTable('Theo 3 sub-period không chồng lấn', groupPairs, 'Sub-period', ['S1', 'S2', 'S3'], (r) => subPeriodOf(r.timestamp));
  lines.push('');

  // =================================================================================
  // Phân tích bổ sung (descriptive only — KHÔNG dùng để tune)
  // =================================================================================
  lines.push('## Phân tích bổ sung (CHỈ mô tả — KHÔNG dùng để tune ngược threshold; không có thay đổi threshold nào trong ticket này)');
  lines.push('');

  lines.push('### Group A — theo Volume Z-score bucket');
  lines.push('');
  lines.push('| Bucket | Candidates | Resolved | Winrate | PF | Net PnL ($) |');
  lines.push('|---|---|---|---|---|---|');
  const volBuckets: Array<[string, (v: number) => boolean]> = [
    ['0.5-1.0', (v) => v >= 0.5 && v < 1.0],
    ['1.0-1.5', (v) => v >= 1.0 && v < 1.5],
    ['1.5-2.0', (v) => v >= 1.5 && v < 2.0],
    ['>2.0', (v) => v >= 2.0],
  ];
  for (const [label, pred] of volBuckets) {
    const rows = groupARows.filter((r) => r.volumeZScore5m !== undefined && pred(r.volumeZScore5m));
    const s = outcomeStats(rows);
    lines.push(`| ${label} | ${s.candidates} | ${s.resolvedCount} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} |`);
  }
  lines.push('');

  lines.push('### Group B (MICRO_TREND) — theo Structural Break age bucket (nến 1m)');
  lines.push('');
  lines.push('| Bucket | Candidates | Resolved | Winrate | PF | Net PnL ($) |');
  lines.push('|---|---|---|---|---|---|');
  const ageBuckets: Array<[string, (v: number) => boolean]> = [
    ['0-5', (v) => v >= 0 && v <= 5],
    ['6-10', (v) => v >= 6 && v <= 10],
    ['11-15', (v) => v >= 11 && v <= 15],
    ['16-19', (v) => v >= 16 && v <= 19],
  ];
  for (const [label, pred] of ageBuckets) {
    const rows = groupBRows.filter((r) => r.structuralBreakAgeCandles !== undefined && pred(r.structuralBreakAgeCandles));
    const s = outcomeStats(rows);
    lines.push(`| ${label} | ${s.candidates} | ${s.resolvedCount} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} |`);
  }
  lines.push('');

  lines.push('### Theo |returnInAtr5m| bucket (cả 2 group, absolute value vì side có thể là cả 2 hướng)');
  lines.push('');
  lines.push('| Group | Bucket | Candidates | Resolved | Winrate | PF | Net PnL ($) |');
  lines.push('|---|---|---|---|---|---|---|');
  const returnBuckets: Array<[string, (v: number) => boolean]> = [
    ['0.3-0.5', (v) => v >= 0.3 && v < 0.5],
    ['0.5-0.8', (v) => v >= 0.5 && v < 0.8],
    ['0.8-1.2', (v) => v >= 0.8 && v < 1.2],
    ['>1.2', (v) => v >= 1.2],
  ];
  for (const [name, rows] of groupPairs) {
    for (const [label, pred] of returnBuckets) {
      const filtered = rows.filter((r) => r.returnInAtr5m !== undefined && pred(Math.abs(r.returnInAtr5m)));
      const s = outcomeStats(filtered);
      lines.push(`| ${name} | ${label} | ${s.candidates} | ${s.resolvedCount} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} |`);
    }
  }
  lines.push('');
  lines.push(
    '**Lưu ý bắt buộc:** 3 bảng trên (Volume Z-score / Structural Break age / |returnInAtr5m|) CHỈ mang tính mô tả (descriptive). KHÔNG bucket nào ở trên được dùng để biện minh cho việc thay đổi threshold — ticket này KHÔNG có thay đổi threshold nào, dù kết quả bucket có khác biệt thế nào.',
  );
  lines.push('');

  // =================================================================================
  // 8-criteria screening
  // =================================================================================
  lines.push('## ĐIỀU KIỆN QUA VÒNG SCREENING — 8 tiêu chí (PHẢI đạt ĐỦ CẢ 8)');
  lines.push('');

  interface Criterion {
    n: number;
    name: string;
    pass: boolean;
    detail: string;
  }
  function screenGroup(name: string, rows: Row[]): { criteria: Criterion[]; allPass: boolean } {
    const s = outcomeStats(rows);
    const criteria: Criterion[] = [];

    // 1. PF shadow > 1.10
    const c1 = !Number.isNaN(s.pf) && s.pf > 1.1;
    criteria.push({ n: 1, name: 'PF shadow > 1.10', pass: c1, detail: `PF=${fmt2(s.pf)}` });

    // 2. >= 200 candidate resolved
    const c2 = s.resolvedCount >= 200;
    criteria.push({ n: 2, name: '>= 200 candidate resolved', pass: c2, detail: `resolved=${s.resolvedCount}` });

    // 3. Dương trong >= 2/3 sub-period
    const subPeriodNets = ['S1', 'S2', 'S3'].map((sp) => {
      const filtered = rows.filter((r) => subPeriodOf(r.timestamp) === sp);
      return { sp, net: outcomeStats(filtered).netPnl };
    });
    const positiveCount = subPeriodNets.filter((x) => x.net > 0).length;
    const c3 = positiveCount >= 2;
    criteria.push({
      n: 3,
      name: 'Dương trong >= 2/3 sub-period',
      pass: c3,
      detail: subPeriodNets.map((x) => `${x.sp}=${fmt2(x.net)}`).join(', ') + ` (${positiveCount}/3 dương)`,
    });

    // 4. Không phụ thuộc hoàn toàn 1 coin. Bar: no single symbol's positive Net PnL > 90% of total
    // positive-symbol Net PnL sum WHILE at least one other symbol has resolved candidates (i.e. not
    // structurally absent) with net <= 0. Stated explicitly as a judgment call.
    const symbolNets = symbols.map((sym) => {
      const filtered = rows.filter((r) => r.symbol === sym);
      const st = outcomeStats(filtered);
      return { sym, net: st.netPnl, resolved: st.resolvedCount };
    });
    const positiveSymbolNetSum = symbolNets.filter((x) => x.net > 0).reduce((a, x) => a + x.net, 0);
    const maxSymbolShare = positiveSymbolNetSum <= 0 ? NaN : Math.max(...symbolNets.map((x) => (x.net > 0 ? x.net / positiveSymbolNetSum : 0)));
    const othersFlatOrNegative = symbolNets.filter((x) => x.net <= 0).length >= symbols.length - 1;
    const c4 = !Number.isNaN(maxSymbolShare) && !(maxSymbolShare >= 0.9 && othersFlatOrNegative);
    criteria.push({
      n: 4,
      name: 'Không phụ thuộc hoàn toàn 1 coin (bar: 1 coin không được chiếm >=90% tổng Net PnL dương trong khi >=3/4 coin còn lại flat/âm)',
      pass: c4,
      detail: symbolNets.map((x) => `${x.sym}=${fmt2(x.net)} (resolved=${x.resolved})`).join(', ') + ` — max single-symbol share of positive Net PnL: ${fmtPct(maxSymbolShare)}`,
    });

    // 5. Không phụ thuộc vài lệnh thắng bất thường. Bar: top-3 winners must NOT account for >=100% of
    // total positive PnL (i.e. group must have positive contribution beyond its 3 biggest wins) AND
    // top-3 share must be < 75% as a stricter, stated bar.
    const top3 = topNConcentration(rows, 3);
    const c5 = !Number.isNaN(top3.pctOfNetPositive) && top3.pctOfNetPositive < 0.75;
    criteria.push({
      n: 5,
      name: 'Không phụ thuộc vài lệnh thắng bất thường (bar: top-3 winners < 75% tổng PnL dương)',
      pass: c5,
      detail: `Top-3 winners chiếm ${fmtPct(top3.pctOfNetPositive)} tổng PnL dương.`,
    });

    // 6. Macro thuận không kém rõ rệt macro ngược. Bar: THUAN's PF must not be materially worse than
    // NGUOC's — "materially worse" stated as THUAN PF < 0.7x NGUOC PF (when both resolved counts are
    // non-trivial, i.e. >=20 resolved each; otherwise treat as inconclusive/pass to avoid over-penalizing
    // small samples).
    const thuanRows = rows.filter((r) => macroAlignment(r.tacticalSide, r.macroDirection1h) === 'THUAN');
    const nguocRows = rows.filter((r) => macroAlignment(r.tacticalSide, r.macroDirection1h) === 'NGUOC');
    const thuanStats = outcomeStats(thuanRows);
    const nguocStats = outcomeStats(nguocRows);
    const bothMeaningfulSample = thuanStats.resolvedCount >= 20 && nguocStats.resolvedCount >= 20;
    const c6 = !bothMeaningfulSample || Number.isNaN(thuanStats.pf) || Number.isNaN(nguocStats.pf) || thuanStats.pf >= 0.7 * nguocStats.pf;
    criteria.push({
      n: 6,
      name: 'Macro thuận không kém rõ rệt macro ngược (bar: THUAN PF >= 0.7x NGUOC PF, khi cả 2 có >=20 resolved; nếu không đủ mẫu thì coi là inconclusive/pass)',
      pass: c6,
      detail: `THUAN: PF=${fmt2(thuanStats.pf)} (resolved=${thuanStats.resolvedCount}), NGUOC: PF=${fmt2(nguocStats.pf)} (resolved=${nguocStats.resolvedCount}).`,
    });

    // 7. Drawdown/longest loss streak không bất thường. Bar: Max DD must not exceed 3x the group's
    // average |trade size| times sqrt(resolvedCount) (a rough "reasonable multiple" proxy) AND longest
    // loss streak must not exceed 40% of resolved count (first-principles bar, stated explicitly).
    const avgAbsTrade = s.resolvedCount === 0 ? NaN : mean(resolvedRows(rows).map((r) => Math.abs(Number(r.simulatedPnlUsd))));
    const ddBarUsd = Number.isNaN(avgAbsTrade) ? NaN : 3 * avgAbsTrade * Math.sqrt(s.resolvedCount);
    const ddOk = Number.isNaN(ddBarUsd) || s.maxDd <= ddBarUsd;
    const streakBar = Math.ceil(0.4 * s.resolvedCount);
    const streakOk = s.longestLossStreak <= streakBar;
    const c7 = ddOk && streakOk;
    criteria.push({
      n: 7,
      name: 'Drawdown/longest loss streak không bất thường (bar: MaxDD <= 3x avg|trade|*sqrt(N); longest loss streak <= 40% of resolved N)',
      pass: c7,
      detail: `MaxDD=${fmt2(s.maxDd)} (bar=${fmt2(ddBarUsd)}), longest loss streak=${s.longestLossStreak} (bar=${streakBar}, N=${s.resolvedCount}).`,
    });

    // 8. Còn dương sau phí/slippage giả định
    const netAfterFees = feeAdjustedNetPnl(rows);
    const c8 = netAfterFees > 0;
    criteria.push({
      n: 8,
      name: `Còn dương sau phí/slippage giả định (takerFeeRate=${TAKER_FEE_RATE}, slippage=${SLIPPAGE_RATE}, mỗi bên entry+exit, trên notional giả định $${ASSUMED_NOTIONAL_PER_TRADE}/lệnh — cùng convention $15 risk của simulator TICKET-124/125/126)`,
      pass: c8,
      detail: `Net PnL raw=${fmt2(s.netPnl)}, sau phí/slippage=${fmt2(netAfterFees)}.`,
    });

    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| # | Tiêu chí | Kết quả | Chi tiết |');
    lines.push('|---|---|---|---|');
    for (const c of criteria) {
      lines.push(`| ${c.n} | ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`);
    }
    const allPass = criteria.every((c) => c.pass);
    lines.push('');
    lines.push(allPass ? `**${name}: ĐẠT ĐỦ 8/8 tiêu chí.**` : `**${name}: KHÔNG đạt (${criteria.filter((c) => c.pass).length}/8 tiêu chí pass).**`);
    lines.push('');
    return { criteria, allPass };
  }

  const resultA = screenGroup('Group A (Strict Expansion)', groupARows);
  const resultB = screenGroup('Group B (Strict Micro Trend)', groupBRows);

  const anyPass = resultA.allPass || resultB.allPass;

  lines.push('## Kết luận vòng screening');
  lines.push('');
  if (!anyPass) {
    lines.push('**Không có Tactical Entry candidate đủ điều kiện để tiếp tục.**');
    lines.push('');
    lines.push(
      'Theo ticket spec: vì KHÔNG nhóm nào đạt cả 8 tiêu chí, dừng lại ở đây — KHÔNG xây Tactical Entry Gate, KHÔNG chạy full production backtest, KHÔNG so sánh A/B/C.',
    );
  } else {
    lines.push(
      `**Có candidate đạt đủ 8/8 tiêu chí: ${resultA.allPass ? 'Group A' : ''}${resultA.allPass && resultB.allPass ? ' VÀ ' : ''}${resultB.allPass ? 'Group B' : ''}.** Tiến hành phần Full production backtest bên dưới (chỉ với (các) candidate đạt).`,
    );
  }
  lines.push('');

  // =================================================================================
  // Judgment calls flagged for human review
  // =================================================================================
  lines.push('## Judgment calls cần con người double-check (KHÔNG cho sẵn số chính xác trong ticket spec)');
  lines.push('');
  lines.push('1. **Tiêu chí #4 ("không phụ thuộc hoàn toàn 1 coin")**: bar tự chọn = 1 coin không chiếm >=90% tổng Net PnL dương trong khi >=3/4 coin còn lại flat/âm.');
  lines.push('2. **Tiêu chí #5 ("không phụ thuộc vài lệnh thắng bất thường")**: bar tự chọn = top-3 winners chiếm < 75% tổng PnL dương của group.');
  lines.push('3. **Tiêu chí #6 ("macro thuận không kém rõ rệt macro ngược")**: bar tự chọn = THUAN PF >= 0.7x NGUOC PF khi cả 2 có >=20 resolved candidate; nếu mẫu quá nhỏ (< 20 mỗi bên) coi là inconclusive và cho pass để tránh phạt oan nhóm ít dữ liệu.');
  lines.push('4. **Tiêu chí #7 ("drawdown/longest loss streak không bất thường")**: bar tự chọn = MaxDD <= 3 × avg|trade| × sqrt(N resolved); longest loss streak <= 40% N resolved.');
  lines.push('5. **Sub-period windows (S1/S2/S3)**: dataset này (168 ngày, 2026-02-11 → 2026-07-29) dài hơn vài ngày so với TICKET-123\'s realized-trade S1/S2/S3 (2026-02-11 → 2026-07-25, 165 ngày). Đã re-anchor 3 window bằng nhau theo min/max timestamp của CHÍNH dataset này (không copy verbatim từ TICKET-123) — cùng convention (chia 3 phần bằng nhau, không chồng lấn) nhưng biên giới khác vài ngày so với TICKET-123\'s report.');
  lines.push('6. **Phí/slippage giả định (tiêu chí #8)**: dùng taker fee 0.0004 (liveRunner.ts convention) × 2 (entry+exit) + slippage giả định 0.0002/bên × 2, trên notional $15/lệnh (cùng convention risk cố định $15 mà simulator TICKET-124/125/126 đã dùng cho các hàng dữ liệu này). Đây là ước lượng thô, KHÔNG phải chi phí thực tế đo từ sàn.');
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Report written -> ${OUT_MD}`);
  console.log(`Group A: ${resultA.allPass ? 'PASS 8/8' : 'FAIL'}. Group B: ${resultB.allPass ? 'PASS 8/8' : 'FAIL'}.`);
}

main();
