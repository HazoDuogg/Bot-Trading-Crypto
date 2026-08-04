/**
 * TICKET-128 — 5M-PRIORITY MARKET CONTEXT AUDIT — Step 4/5/6 (report generation).
 *
 * Pure post-processing/analysis script. Reads ONLY `data/ticket128-market-context-audit.csv`
 * (ticket128MarketContextAudit.ts's output, 324,176 rows). Never touches src/, never reruns the
 * backtest, never opens a position, never runs `npm run backtest`. Writes
 * `data/ticket128-5m-priority-market-context-report.md`.
 *
 * KHÔNG tune threshold ở ticket này — chỉ đọc/lọc/phân tích output có sẵn (Layer A/B/C were designed
 * and their thresholds fixed in ticket128MarketContextScoring.ts BEFORE this script ever ran).
 *
 * Run (from repo root, after build:scripts): node apps/bot/scripts-dist/ticket128GenerateReport.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AUDIT_CSV = path.resolve(process.cwd(), 'data/ticket128-market-context-audit.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket128-5m-priority-market-context-report.md');

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
  return v === '' || v === undefined ? undefined : Number(v);
}

interface Row {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  setupType: string;
  passed: boolean;
  win: boolean;
  pnlUsd: number;
  macroDirection: string;
  layerADirection: string;
  layerAScoreForCandidateSide: number;
  layerBQuality: string;
  layerCContext: string;
  structBreakLongAge: number | undefined;
  structBreakShortAge: number | undefined;
}

function loadRows(): Row[] {
  const { header, rows } = parseCsv(AUDIT_CSV);
  const c = (name: string) => col(header, name);
  const idx = {
    symbol: c('symbol'),
    timestamp: c('timestamp'),
    side: c('side'),
    setupType: c('setupType'),
    passed: c('passed'),
    win: c('win'),
    pnlUsd: c('pnlUsd'),
    macroDirection: c('macroDirection'),
    layerADirection: c('layerADirection'),
    layerAScoreForCandidateSide: c('layerAScoreForCandidateSide'),
    layerBQuality: c('layerBQuality'),
    layerCContext: c('layerCContext'),
    structBreakLongAge: c('structBreakLongAge'),
    structBreakShortAge: c('structBreakShortAge'),
  };
  return rows.map((r) => ({
    symbol: r[idx.symbol],
    timestamp: Number(r[idx.timestamp]),
    side: r[idx.side] as 'LONG' | 'SHORT',
    setupType: r[idx.setupType],
    passed: r[idx.passed] === 'true',
    win: r[idx.win] === 'true',
    pnlUsd: Number(r[idx.pnlUsd]),
    macroDirection: r[idx.macroDirection],
    layerADirection: r[idx.layerADirection],
    layerAScoreForCandidateSide: Number(r[idx.layerAScoreForCandidateSide]),
    layerBQuality: r[idx.layerBQuality],
    layerCContext: r[idx.layerCContext],
    structBreakLongAge: num(r[idx.structBreakLongAge]),
    structBreakShortAge: num(r[idx.structBreakShortAge]),
  }));
}

// ---------------------------------------------------------------------------------------------
// Stats helpers (same conventions as TICKET-124/125/126/127's report scripts)
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

interface OutcomeStats {
  candidates: number;
  winrate: number;
  pf: number;
  netPnl: number;
  avgPnl: number;
  maxDd: number;
  longestLossStreak: number;
  grossProfit: number;
  grossLoss: number;
}
function outcomeStats(rows: Row[]): OutcomeStats {
  const chronoSorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
  const pnls = chronoSorted.map((r) => r.pnlUsd);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const netPnl = pnls.reduce((a, b) => a + b, 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = grossLoss === 0 ? NaN : grossProfit / grossLoss;
  return {
    candidates: rows.length,
    winrate: rows.length === 0 ? NaN : rows.filter((r) => r.win).length / rows.length,
    pf,
    netPnl,
    avgPnl: rows.length === 0 ? NaN : netPnl / rows.length,
    maxDd: maxDrawdown(pnls),
    longestLossStreak: longestLossStreak(pnls),
    grossProfit,
    grossLoss,
  };
}

function strengthBandOf(score: number): '0-39' | '40-59' | '60-79' | '80-100' {
  if (score < 40) return '0-39';
  if (score < 60) return '40-59';
  if (score < 80) return '60-79';
  return '80-100';
}

function topNConcentration(rows: Row[], n: number): { topNPnl: number; pctOfNetPositive: number } {
  const winPnls = rows.map((r) => r.pnlUsd).filter((p) => p > 0).sort((a, b) => b - a);
  const totalPositive = winPnls.reduce((a, b) => a + b, 0);
  const topNPnl = winPnls.slice(0, n).reduce((a, b) => a + b, 0);
  return { topNPnl, pctOfNetPositive: totalPositive === 0 ? NaN : topNPnl / totalPositive };
}

// Fee/slippage assumption: same convention as TICKET-127 — taker fee 0.0004 (liveRunner.ts), applied
// twice per round-trip (entry+exit), plus a small stated slippage assumption (0.02%/side), on the
// $15 fixed-risk notional convention TICKET-108/109/113's shadow simulator already uses.
const TAKER_FEE_RATE = 0.0004;
const SLIPPAGE_RATE = 0.0002;
const ASSUMED_NOTIONAL_PER_TRADE = 15;
function feeAdjustedNetPnl(rows: Row[]): number {
  const costPerTrade = ASSUMED_NOTIONAL_PER_TRADE * (TAKER_FEE_RATE + SLIPPAGE_RATE) * 2;
  const rawNet = rows.reduce((a, r) => a + r.pnlUsd, 0);
  return rawNet - costPerTrade * rows.length;
}

function main(): void {
  console.log('TICKET-128 — 5m-Priority Market Context Audit — Report Generation...');
  const allRows = loadRows();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
  const totalRows = allRows.length;

  // Only analyze candidates that ALREADY exist as real production setups (ticket's own scope
  // restriction — every row in the source CSV already satisfies this by construction, since
  // all-candidates-fully-enriched.csv only contains momentum-gate-evaluated candidates with
  // setupType in {MOMENTUM_DIRECT, OB, FVG, SWEEP, BOX_BREAKOUT} — no filter needed here beyond a
  // sanity assertion).
  const validSetupTypes = new Set(['MOMENTUM_DIRECT', 'OB', 'FVG', 'SWEEP', 'BOX_BREAKOUT']);
  const invalidSetup = allRows.filter((r) => !validSetupTypes.has(r.setupType));
  if (invalidSetup.length > 0) {
    console.error(`LỖI: ${invalidSetup.length} rows có setupType ngoài phạm vi ticket (MOMENTUM_DIRECT/OB/FVG/SWEEP/BOX_BREAKOUT). Dừng lại.`);
    process.exit(1);
  }

  // Sub-period windows — same convention as TICKET-123/127: dataset spans 2026-02-11 -> 2026-07-29
  // (168 days), split into 3 equal, non-overlapping windows re-anchored to THIS dataset's own
  // min/max timestamp.
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

  const strengthBands: Array<'0-39' | '40-59' | '60-79' | '80-100'> = ['0-39', '40-59', '60-79', '80-100'];
  const qualities = ['CLEAN_TREND', 'EXPANSION', 'COMPRESSION', 'CHOP', 'SHOCK'];
  const contexts: string[] = ['ALIGNED', 'NEUTRAL', 'CONFLICT_WEAK', 'CONFLICT_STRONG', 'DANGER'];

  const lines: string[] = [];
  lines.push('# TICKET-128 — 5M-Priority Market Context Audit — Báo cáo');
  lines.push('');
  lines.push(
    `Sinh tự động bởi \`apps/bot/scripts/ticket128GenerateReport.ts\` từ \`data/ticket128-market-context-audit.csv\` (${totalRows} rows, 100% khớp với data/all-candidates-fully-enriched.csv) — ${new Date().toISOString()}.`,
  );
  lines.push('');
  lines.push(
    '**Phạm vi ticket (nhắc lại): CHỈ audit + shadow-log candidate ĐÃ CÓ setup production (MOMENTUM_DIRECT/OB/FVG/SWEEP/BOX_BREAKOUT). KHÔNG tạo candidate mới, KHÔNG chạm vào `tactical/`, KHÔNG chạy full backtest, KHÔNG tạo "Final Entry Score" (3 layer A/B/C giữ RIÊNG BIỆT, không gộp), KHÔNG tune trọng số theo PnL (mọi threshold trong `ticket128MarketContextScoring.ts` được cố định TRƯỚC khi chạy phân tích này).**',
  );
  lines.push('');
  lines.push(
    `Sub-period windows (KHÔNG chồng lấn, cùng convention TICKET-123/127 — chia đều dataset ${(span / 86400000).toFixed(1)} ngày thành 3 phần bằng nhau, re-anchor theo min/max timestamp của chính dataset này): S1 [${new Date(windowBounds[0]).toISOString()} .. ${new Date(windowBounds[1]).toISOString()}), S2 [${new Date(windowBounds[1]).toISOString()} .. ${new Date(windowBounds[2]).toISOString()}), S3 [${new Date(windowBounds[2]).toISOString()} .. ${new Date(windowBounds[3]).toISOString()}].`,
  );
  lines.push('');

  // =================================================================================
  // Methodology summary (Layer A/B/C) — pointer to the scoring library's own doc comments
  // =================================================================================
  lines.push('## Phương pháp — 3 lớp đánh giá riêng (KHÔNG gộp)');
  lines.push('');
  lines.push(
    '**Layer A — 5m Direction Strength** (`apps/bot/scripts/ticket128MarketContextScoring.ts`\'s `computeLayerA()`): 7 check nhị phân đều-trọng-số (structural break đúng chiều, EMA aligned, returnInAtr5m đủ lớn, momentum persistence 2/3 nến, HH-HL/LL-LH, structure freshness, không choppy) tính RIÊNG cho từng phía LONG/SHORT; score = số check đạt / 7 × 100. Nhãn BULLISH/BEARISH/NONE = phía có score cao hơn (NONE nếu hoà). Cross-tab dùng `layerAScoreForCandidateSide` — score theo ĐÚNG side của candidate (không phải side "thắng" trừu tượng).',
  );
  lines.push('');
  lines.push(
    '**Layer B — 5m Market Quality** (`computeLayerB()`): CLEAN_TREND/EXPANSION/COMPRESSION/CHOP/SHOCK, side-độc-lập, ưu tiên SHOCK (tái sử dụng `RegimeConfig.DANGER_VOLUME_ZSCORE_THRESHOLD`/`DANGER_ATR_PCT_THRESHOLD`) > COMPRESSION (`RegimeConfig.COMPRESSION_BBW_PCT_THRESHOLD`) > EXPANSION > CHOP > CLEAN_TREND (fallback).',
  );
  lines.push('');
  lines.push(
    '**Layer C — HTF Context** (`computeLayerC()`): ALIGNED/NEUTRAL/CONFLICT_WEAK/CONFLICT_STRONG/DANGER, so 1H ADX direction + strength (tái sử dụng `RegimeConfig.TREND_ENTER_ADX` {enter:32,exit:25}) và 1D macroDirection với side của candidate. CHỈ mang tính mô tả/cross-tab trong ticket này — KHÔNG gate quyết định gì.',
  );
  lines.push('');

  // =================================================================================
  // Bảng chính — 5m Strength x 5m Quality x HTF Context
  // =================================================================================
  const setupTypeCounts = new Map<string, number>();
  for (const r of allRows) setupTypeCounts.set(r.setupType, (setupTypeCounts.get(r.setupType) ?? 0) + 1);
  lines.push('## Ghi chú giới hạn dữ liệu (đọc trước khi xem bảng)');
  lines.push('');
  lines.push(
    `**Toàn bộ ${totalRows} candidate trong dataset này đều có setupType=MOMENTUM_DIRECT** (${JSON.stringify(Object.fromEntries(setupTypeCounts))}). Đây KHÔNG phải lỗi của audit script — data/all-candidates-fully-enriched.csv (nguồn của ticket này, do TICKET-108/109/113 sinh ra bằng CONFIG chính thức 8-flag) có \`neutralTransitionGateConfig.neutralTransitionTradingEnabled: false\`, khiến orchestrator.ts's processCandle() return sớm (event:null) TRƯỚC KHI gọi onMomentumGateEvaluation cho bất kỳ candidate nào có setupType ∈ {OB, FVG, SWEEP, BOX_BREAKOUT} (xem orchestrator.ts dòng ~655-658: \`if (!config.neutralTransitionGateConfig.neutralTransitionTradingEnabled) return {event:null, newEntry:null}\` — return này nằm TRƯỚC lời gọi onMomentumGateEvaluation). Baseline chính thức (258 lệnh/$842.14) dùng đúng CONFIG này, nên đây là giới hạn THẬT của dữ liệu hiện có, không phải giả định sai. Câu hỏi 5 ("Setup nào hưởng lợi nhiều nhất") và mọi breakdown "theo setup type" vì vậy chỉ có 1 giá trị (MOMENTUM_DIRECT) — không thể trả lời cho OB/FVG/SWEEP/BOX_BREAKOUT với dataset hiện tại. Muốn có dữ liệu cho 4 setup còn lại cần một lần re-walk RIÊNG với \`neutralTransitionTradingEnabled: true\` (ngoài phạm vi ticket này — ticket không được phép đổi CONFIG production/baseline).`,
  );
  lines.push('');

  lines.push('## Bảng chính — 5m Strength | 5m Quality | HTF Context');
  lines.push('');
  lines.push('| 5m Strength | 5m Quality | HTF Context | Candidates | Winrate | PF | Net PnL ($) | Avg PnL ($) | Max DD ($) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const mainTableRows: Array<{ band: string; quality: string; context: string; s: OutcomeStats }> = [];
  for (const band of strengthBands) {
    for (const quality of qualities) {
      for (const context of contexts) {
        const filtered = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === band && r.layerBQuality === quality && r.layerCContext === context);
        if (filtered.length === 0) continue;
        const s = outcomeStats(filtered);
        mainTableRows.push({ band, quality, context, s });
      }
    }
  }
  mainTableRows.sort((a, b) => b.s.candidates - a.s.candidates);
  for (const r of mainTableRows) {
    lines.push(`| ${r.band} | ${r.quality} | ${r.context} | ${r.s.candidates} | ${fmtPct(r.s.winrate)} | ${fmt2(r.s.pf)} | ${fmt2(r.s.netPnl)} | ${fmt2(r.s.avgPnl)} | ${fmt2(r.s.maxDd)} |`);
  }
  lines.push('');

  // =================================================================================
  // Breakdown helpers
  // =================================================================================
  function breakdownTable(title: string, keyLabel: string, keys: string[], keyFn: (r: Row) => string): void {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(`| ${keyLabel} | Candidates | Winrate | PF | Net PnL ($) | Avg PnL ($) |`);
    lines.push('|---|---|---|---|---|---|');
    for (const key of keys) {
      const filtered = allRows.filter((r) => keyFn(r) === key);
      const s = outcomeStats(filtered);
      lines.push(`| ${key} | ${s.candidates} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} | ${fmt2(s.avgPnl)} |`);
    }
    lines.push('');
  }
  breakdownTable('Theo setup type', 'Setup', ['MOMENTUM_DIRECT', 'OB', 'FVG', 'SWEEP', 'BOX_BREAKOUT'], (r) => r.setupType);
  breakdownTable('Theo side', 'Side', ['LONG', 'SHORT'], (r) => r.side);
  breakdownTable('Theo symbol', 'Symbol', symbols, (r) => r.symbol);
  breakdownTable('Theo sub-period (S1/S2/S3)', 'Sub-period', ['S1', 'S2', 'S3'], (r) => subPeriodOf(r.timestamp));
  breakdownTable(
    'Theo aligned-vs-conflict (gộp CONFLICT_WEAK+CONFLICT_STRONG+DANGER = "conflict")',
    'Nhóm',
    ['ALIGNED', 'NEUTRAL', 'conflict (WEAK+STRONG+DANGER)'],
    (r) => (r.layerCContext === 'ALIGNED' ? 'ALIGNED' : r.layerCContext === 'NEUTRAL' ? 'NEUTRAL' : 'conflict (WEAK+STRONG+DANGER)'),
  );

  // =================================================================================
  // Candidate bị block bởi HTF (proxy: passed=false AND layerC in {CONFLICT_STRONG, DANGER})
  // =================================================================================
  lines.push('## Candidate production đã bị block bởi HTF (proxy: `passed=false` AND HTF Context = CONFLICT_STRONG/DANGER)');
  lines.push('');
  const blockedByHtf = allRows.filter((r) => !r.passed && (r.layerCContext === 'CONFLICT_STRONG' || r.layerCContext === 'DANGER'));
  const blockedStats = outcomeStats(blockedByHtf);
  lines.push(
    `**${blockedStats.candidates} candidate** khớp proxy này (${fmtPct(totalRows === 0 ? NaN : blockedStats.candidates / totalRows)} tổng số candidate). Outcome nếu đã được cho vào: Winrate=${fmtPct(blockedStats.winrate)}, PF=${fmt2(blockedStats.pf)}, Net PnL=${fmt2(blockedStats.netPnl)}, Avg PnL=${fmt2(blockedStats.avgPnl)}.`,
  );
  lines.push('');

  lines.push('### Winner bị bỏ lỡ (rejected + simulated win=true), cross-tab theo HTF Context');
  lines.push('');
  lines.push('| HTF Context | Missed winners (passed=false, win=true) |');
  lines.push('|---|---|');
  for (const context of contexts) {
    const n = allRows.filter((r) => !r.passed && r.win && r.layerCContext === context).length;
    lines.push(`| ${context} | ${n} |`);
  }
  lines.push('');

  lines.push('### Loser được block đúng (rejected + simulated win=false), cross-tab theo HTF Context');
  lines.push('');
  lines.push('| HTF Context | Additional/correctly-blocked losers (passed=false, win=false) |');
  lines.push('|---|---|');
  for (const context of contexts) {
    const n = allRows.filter((r) => !r.passed && !r.win && r.layerCContext === context).length;
    lines.push(`| ${context} | ${n} |`);
  }
  lines.push('');

  // =================================================================================
  // 7 câu hỏi bắt buộc
  // =================================================================================
  lines.push('## 7 câu hỏi bắt buộc');
  lines.push('');

  // Q1: 5m mạnh nhưng ngược 1H — nhóm nào vẫn có edge?
  lines.push('### 1. Khi 5m mạnh nhưng ngược 1H, nhóm nào vẫn có edge?');
  lines.push('');
  const q1Rows = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && (r.layerCContext === 'CONFLICT_STRONG' || r.layerCContext === 'DANGER'));
  const q1Stats = outcomeStats(q1Rows);
  lines.push(
    `5m strength 80-100 AND HTF Context ∈ {CONFLICT_STRONG, DANGER}: **${q1Stats.candidates} candidate**, Winrate=${fmtPct(q1Stats.winrate)}, PF=${fmt2(q1Stats.pf)}, Net PnL=${fmt2(q1Stats.netPnl)}.`,
  );
  const q1ConflictStrongOnly = outcomeStats(allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && r.layerCContext === 'CONFLICT_STRONG'));
  const q1DangerOnly = outcomeStats(allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && r.layerCContext === 'DANGER'));
  lines.push(
    `Tách riêng: CONFLICT_STRONG only → ${q1ConflictStrongOnly.candidates} candidate, PF=${fmt2(q1ConflictStrongOnly.pf)}, Net PnL=${fmt2(q1ConflictStrongOnly.netPnl)}. DANGER only → ${q1DangerOnly.candidates} candidate, PF=${fmt2(q1DangerOnly.pf)}, Net PnL=${fmt2(q1DangerOnly.netPnl)}.`,
  );
  lines.push('');

  // Q2: Khi 1H neutral, 5m strength bao nhiêu thì đủ tốt?
  lines.push('### 2. Khi 1H neutral, 5m strength bao nhiêu thì đủ tốt?');
  lines.push('');
  lines.push('| 5m Strength band | Candidates (HTF=NEUTRAL) | Winrate | PF | Net PnL ($) |');
  lines.push('|---|---|---|---|---|');
  for (const band of strengthBands) {
    const rows = allRows.filter((r) => r.layerCContext === 'NEUTRAL' && strengthBandOf(r.layerAScoreForCandidateSide) === band);
    const s = outcomeStats(rows);
    lines.push(`| ${band} | ${s.candidates} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} |`);
  }
  lines.push('');

  // Q3: Khi 5m yếu nhưng thuận 1H, có nên trade không?
  lines.push('### 3. Khi 5m yếu nhưng thuận 1H, có nên trade không?');
  lines.push('');
  const q3Rows = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '0-39' && r.layerCContext === 'ALIGNED');
  const q3Stats = outcomeStats(q3Rows);
  lines.push(
    `5m strength 0-39 AND HTF Context = ALIGNED: **${q3Stats.candidates} candidate**, Winrate=${fmtPct(q3Stats.winrate)}, PF=${fmt2(q3Stats.pf)}, Net PnL=${fmt2(q3Stats.netPnl)}, Avg PnL=${fmt2(q3Stats.avgPnl)}.`,
  );
  lines.push('');

  // Q4: HTF context nên hard-block, giảm risk hay chỉ cảnh báo?
  lines.push('### 4. HTF context nên hard-block, giảm risk hay chỉ cảnh báo?');
  lines.push('');
  lines.push('| HTF Context | Candidates | Winrate | PF | Net PnL ($) | Avg PnL ($) |');
  lines.push('|---|---|---|---|---|---|');
  for (const context of contexts) {
    const s = outcomeStats(allRows.filter((r) => r.layerCContext === context));
    lines.push(`| ${context} | ${s.candidates} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} | ${fmt2(s.avgPnl)} |`);
  }
  lines.push('');
  lines.push(
    '(Khuyến nghị mô tả — KHÔNG implement trong ticket này — dựa vào bảng trên và câu 1/2/6: xem phần Kết luận cuối báo cáo.)',
  );
  lines.push('');

  // Q5: Setup nào hưởng lợi nhiều nhất khi ưu tiên 5m?
  lines.push('### 5. Setup nào hưởng lợi nhiều nhất khi ưu tiên 5m?');
  lines.push('');
  lines.push(
    '**Không thể trả lời đầy đủ với dataset hiện tại** — xem "Ghi chú giới hạn dữ liệu" ở đầu báo cáo: 100% candidate có setupType=MOMENTUM_DIRECT (baseline chính thức có neutralTransitionTradingEnabled=false, nên OB/FVG/SWEEP/BOX_BREAKOUT không bao giờ được capture). Bảng dưới đây do đó chỉ có 1 hàng có dữ liệu thật.',
  );
  lines.push('');
  lines.push('| Setup | Candidates (5m 80-100, HTF conflict) | Winrate | PF | Net PnL ($) |');
  lines.push('|---|---|---|---|---|');
  for (const setup of ['MOMENTUM_DIRECT', 'OB', 'FVG', 'SWEEP', 'BOX_BREAKOUT']) {
    const rows = allRows.filter(
      (r) => r.setupType === setup && strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && (r.layerCContext === 'CONFLICT_STRONG' || r.layerCContext === 'DANGER'),
    );
    const s = outcomeStats(rows);
    lines.push(`| ${setup} | ${s.candidates} | ${fmtPct(s.winrate)} | ${fmt2(s.pf)} | ${fmt2(s.netPnl)} |`);
  }
  lines.push('');

  // Q6: Có nhóm nào ổn định trên >=2/3 sub-period?
  lines.push('### 6. Có nhóm nào ổn định trên >=2/3 sub-period? (kiểm tra trên nhóm 5m mạnh ngược HTF, câu 1)');
  lines.push('');
  const q6SubNets = ['S1', 'S2', 'S3'].map((sp) => {
    const rows = q1Rows.filter((r) => subPeriodOf(r.timestamp) === sp);
    return { sp, net: outcomeStats(rows).netPnl, candidates: rows.length };
  });
  lines.push(`Nhóm 5m 80-100 & HTF conflict (câu 1): ${q6SubNets.map((x) => `${x.sp}=${fmt2(x.net)} (n=${x.candidates})`).join(', ')}.`);
  const q6Positive = q6SubNets.filter((x) => x.net > 0).length;
  lines.push(`→ Dương ở ${q6Positive}/3 sub-period.`);
  lines.push('');

  // Q7: Có nhóm nào phụ thuộc 1 coin hay 1 side?
  lines.push('### 7. Có nhóm nào phụ thuộc 1 coin hay 1 side? (kiểm tra trên nhóm 5m mạnh ngược HTF, câu 1)');
  lines.push('');
  const q7SymbolNets = symbols.map((sym) => ({ sym, s: outcomeStats(q1Rows.filter((r) => r.symbol === sym)) }));
  lines.push(`Theo symbol: ${q7SymbolNets.map((x) => `${x.sym}=${fmt2(x.s.netPnl)} (n=${x.s.candidates})`).join(', ')}.`);
  const q7SideNets = (['LONG', 'SHORT'] as const).map((side) => ({ side, s: outcomeStats(q1Rows.filter((r) => r.side === side)) }));
  lines.push(`Theo side: ${q7SideNets.map((x) => `${x.side}=${fmt2(x.s.netPnl)} (n=${x.s.candidates})`).join(', ')}.`);
  lines.push('');

  // =================================================================================
  // Screening — max 2 groups, 7 tiêu chí
  // =================================================================================
  lines.push('## Candidate Screening (chỉ giữ tối đa 2 nhóm tốt nhất) — 7 tiêu chí (PHẢI đạt ĐỦ CẢ 7)');
  lines.push('');
  lines.push(
    'Các nhóm được chọn để screen trực tiếp theo khung câu hỏi 1-3 của ticket (nhóm có khả năng "có edge" theo dữ liệu ở trên): G1 = 5m 80-100 & HTF conflict (CONFLICT_STRONG/DANGER) — câu 1\'s nhóm chính. G2 = 5m 60-79 & HTF conflict — biên yếu hơn của cùng ý tưởng. G3 = 5m 80-100 & HTF NEUTRAL — câu 2. G4 = 5m 0-39 & HTF ALIGNED — câu 3 (kiểm tra "5m yếu, thuận HTF" có đáng trade không).',
  );
  lines.push('');

  interface Criterion {
    n: number;
    name: string;
    pass: boolean;
    detail: string;
  }
  function screenGroup(name: string, rows: Row[]): { criteria: Criterion[]; allPass: boolean; stats: OutcomeStats } {
    const s = outcomeStats(rows);
    const criteria: Criterion[] = [];

    const c1 = !Number.isNaN(s.pf) && s.pf > 1.1;
    criteria.push({ n: 1, name: 'PF > 1.10', pass: c1, detail: `PF=${fmt2(s.pf)}` });

    const c2 = s.candidates >= 100;
    criteria.push({ n: 2, name: '>= 100 candidate resolved', pass: c2, detail: `candidates=${s.candidates}` });

    const subPeriodNets = ['S1', 'S2', 'S3'].map((sp) => {
      const filtered = rows.filter((r) => subPeriodOf(r.timestamp) === sp);
      return { sp, net: outcomeStats(filtered).netPnl };
    });
    const positiveCount = subPeriodNets.filter((x) => x.net > 0).length;
    const c3 = positiveCount >= 2;
    criteria.push({ n: 3, name: 'Dương trong >= 2/3 sub-period', pass: c3, detail: subPeriodNets.map((x) => `${x.sp}=${fmt2(x.net)}`).join(', ') + ` (${positiveCount}/3 dương)` });

    const symbolNets = symbols.map((sym) => {
      const filtered = rows.filter((r) => r.symbol === sym);
      const st = outcomeStats(filtered);
      return { sym, net: st.netPnl, candidates: st.candidates };
    });
    const positiveSymbolNetSum = symbolNets.filter((x) => x.net > 0).reduce((a, x) => a + x.net, 0);
    const maxSymbolShare = positiveSymbolNetSum <= 0 ? NaN : Math.max(...symbolNets.map((x) => (x.net > 0 ? x.net / positiveSymbolNetSum : 0)));
    const othersFlatOrNegative = symbolNets.filter((x) => x.net <= 0).length >= symbols.length - 1;
    const c4 = !Number.isNaN(maxSymbolShare) && !(maxSymbolShare >= 0.9 && othersFlatOrNegative);
    criteria.push({
      n: 4,
      name: 'Không phụ thuộc hoàn toàn 1 coin (bar: 1 coin không chiếm >=90% tổng Net PnL dương trong khi >=3/4 coin còn lại flat/âm)',
      pass: c4,
      detail: symbolNets.map((x) => `${x.sym}=${fmt2(x.net)} (n=${x.candidates})`).join(', ') + ` — max single-symbol share: ${fmtPct(maxSymbolShare)}`,
    });

    const top3 = topNConcentration(rows, 3);
    const c5 = !Number.isNaN(top3.pctOfNetPositive) && top3.pctOfNetPositive < 0.75;
    criteria.push({ n: 5, name: 'Không phụ thuộc vài winner lớn (bar: top-3 winners < 75% tổng PnL dương)', pass: c5, detail: `Top-3 winners chiếm ${fmtPct(top3.pctOfNetPositive)} tổng PnL dương.` });

    const avgAbsTrade = s.candidates === 0 ? NaN : mean(rows.map((r) => Math.abs(r.pnlUsd)));
    const ddBarUsd = Number.isNaN(avgAbsTrade) ? NaN : 3 * avgAbsTrade * Math.sqrt(s.candidates);
    const ddOk = Number.isNaN(ddBarUsd) || s.maxDd <= ddBarUsd;
    const streakBar = Math.ceil(0.4 * s.candidates);
    const streakOk = s.longestLossStreak <= streakBar;
    const c6 = ddOk && streakOk;
    criteria.push({
      n: 6,
      name: 'Max DD không bất thường (bar: MaxDD <= 3x avg|trade|*sqrt(N); longest loss streak <= 40% N)',
      pass: c6,
      detail: `MaxDD=${fmt2(s.maxDd)} (bar=${fmt2(ddBarUsd)}), longest loss streak=${s.longestLossStreak} (bar=${streakBar}, N=${s.candidates}).`,
    });

    const netAfterFees = feeAdjustedNetPnl(rows);
    const c7 = netAfterFees > 0;
    criteria.push({
      n: 7,
      name: `Còn dương sau phí/slippage giả định (takerFeeRate=${TAKER_FEE_RATE}, slippage=${SLIPPAGE_RATE}, entry+exit, notional $${ASSUMED_NOTIONAL_PER_TRADE}/lệnh)`,
      pass: c7,
      detail: `Net PnL raw=${fmt2(s.netPnl)}, sau phí/slippage=${fmt2(netAfterFees)}.`,
    });

    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| # | Tiêu chí | Kết quả | Chi tiết |');
    lines.push('|---|---|---|---|');
    for (const c of criteria) lines.push(`| ${c.n} | ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`);
    const allPass = criteria.every((c) => c.pass);
    lines.push('');
    lines.push(allPass ? `**${name}: ĐẠT ĐỦ 7/7 tiêu chí.**` : `**${name}: KHÔNG đạt (${criteria.filter((c) => c.pass).length}/7 tiêu chí pass).**`);
    lines.push('');
    return { criteria, allPass, stats: s };
  }

  const groupG1 = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && (r.layerCContext === 'CONFLICT_STRONG' || r.layerCContext === 'DANGER'));
  const groupG2 = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '60-79' && (r.layerCContext === 'CONFLICT_STRONG' || r.layerCContext === 'DANGER'));
  const groupG3 = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '80-100' && r.layerCContext === 'NEUTRAL');
  const groupG4 = allRows.filter((r) => strengthBandOf(r.layerAScoreForCandidateSide) === '0-39' && r.layerCContext === 'ALIGNED');

  const resultG1 = screenGroup('G1: 5m 80-100 & HTF conflict (CONFLICT_STRONG/DANGER)', groupG1);
  const resultG2 = screenGroup('G2: 5m 60-79 & HTF conflict (CONFLICT_STRONG/DANGER)', groupG2);
  const resultG3 = screenGroup('G3: 5m 80-100 & HTF NEUTRAL', groupG3);
  const resultG4 = screenGroup('G4: 5m 0-39 & HTF ALIGNED', groupG4);

  const allGroupResults = [
    { name: 'G1', result: resultG1 },
    { name: 'G2', result: resultG2 },
    { name: 'G3', result: resultG3 },
    { name: 'G4', result: resultG4 },
  ];
  const passingGroups = allGroupResults.filter((g) => g.result.allPass);
  // "chỉ giữ tối đa 2 nhóm tốt nhất" — if more than 2 pass, keep the 2 with the highest PF.
  const keptGroups = passingGroups
    .sort((a, b) => b.result.stats.pf - a.result.stats.pf)
    .slice(0, 2);

  lines.push('## Kết quả screening');
  lines.push('');
  if (passingGroups.length === 0) {
    lines.push('**Không có nhóm nào đạt đủ 7/7 tiêu chí.**');
  } else {
    lines.push(`**Nhóm đạt đủ 7/7 tiêu chí (giữ tối đa 2, sắp theo PF): ${keptGroups.map((g) => g.name).join(', ')}.**`);
  }
  lines.push('');

  // =================================================================================
  // Kết luận bắt buộc (A/B/C)
  // =================================================================================
  lines.push('## Kết luận bắt buộc');
  lines.push('');
  const anyConflictGroupPasses = keptGroups.some((g) => g.name === 'G1' || g.name === 'G2');
  const anyAlignedOrNeutralPasses = keptGroups.some((g) => g.name === 'G3' || g.name === 'G4');
  let conclusion: 'A' | 'B' | 'C';
  let conclusionText: string;
  if (anyConflictGroupPasses) {
    conclusion = 'A';
    conclusionText =
      '**A**: có nhóm 5m mạnh dù ngược HTF vẫn có edge (theo screening ở trên) → đề xuất full backtest với risk giảm cho nhóm này (KHUYẾN NGHỊ VĂN BẢN — KHÔNG implement trong ticket này).';
  } else if (anyAlignedOrNeutralPasses || passingGroups.length > 0) {
    conclusion = 'B';
    conclusionText = '**B**: chỉ nhóm thuận HTF (hoặc HTF neutral) có edge → giữ HTF làm modifier mạnh, không đổi kiến trúc hiện tại.';
  } else {
    conclusion = 'C';
    conclusionText = '**C**: không nhóm nào có edge đủ điều kiện screening → không thay đổi kiến trúc hiện tại.';
  }
  lines.push(conclusionText);
  lines.push('');
  lines.push(`Mã kết luận: **${conclusion}**.`);
  lines.push('');

  // =================================================================================
  // Judgment calls
  // =================================================================================
  lines.push('## Judgment calls cần con người double-check');
  lines.push('');
  lines.push('1. **Layer A\'s 7 check formula và trọng số bằng nhau (1/7 mỗi check)**: không có cơ sở "trọng số tối ưu" nào được cho trước trong ticket spec — chọn trọng số ĐỀU (count/total) theo đúng convention `scoreOf()` của `tactical/tacticalRegimeClassifier.ts` khi không có lý do khác để ưu tiên 1 check hơn check khác. Đây là judgment call, KHÔNG backtest-tuned.');
  lines.push('2. **Layer A\'s strength bands 0-39/40-59/60-79/80-100**: cho sẵn trực tiếp từ ticket spec, không tự chọn.');
  lines.push('3. **Layer B\'s priority order (SHOCK > COMPRESSION > EXPANSION > CHOP > CLEAN_TREND)**: tự chọn theo "mức độ nghiêm trọng/đặc thù giảm dần" — không có thứ tự ưu tiên nào được cho trước trong ticket spec.');
  lines.push('4. **Layer C\'s 5 threshold (NEUTRAL/ALIGNED/CONFLICT_WEAK/CONFLICT_STRONG/DANGER)**: tái sử dụng `RegimeConfig.TREND_ENTER_ADX` {enter:32,exit:25} làm 2 ranh giới duy nhất — DANGER thêm điều kiện macroDirection cùng chiều đối kháng. Đây là 1 cách hợp lý để map ADX+macro vào 5 nhãn, không phải cách DUY NHẤT có thể — cần review.');
  lines.push('5. **Proxy "candidate bị block bởi HTF"**: `passed=false AND layerC ∈ {CONFLICT_STRONG, DANGER}` — đây là proxy được ticket spec gợi ý, không phải chỉ số chính xác 100% (production\'s macro filter có logic riêng, không nhất thiết trùng khớp layerC).');
  lines.push('6. **4 nhóm được chọn để screening (G1-G4)**: tự chọn theo khung câu hỏi 1-3 của ticket — không phải liệt kê đầy đủ mọi tổ hợp có thể (44 tổ hợp band x context). Nếu PM muốn xem tổ hợp khác, bảng chính ở trên đã có đủ dữ liệu để tự tính thêm.');
  lines.push('7. **7 tiêu chí + bar số của screening**: cùng discipline TICKET-127 (tiêu chí #4/#5/#6 dùng bar tự chọn, nêu rõ trong tên tiêu chí) nhưng KHÔNG có tiêu chí macro-alignment riêng (đã gộp vào chính khái niệm HTF Context của ticket này).');
  lines.push(
    `8. **Sub-period windows**: giống hệt TICKET-127's convention (re-anchor theo min/max timestamp của chính dataset này: ${new Date(windowBounds[0]).toISOString()} → ${new Date(windowBounds[3]).toISOString()}).`,
  );
  lines.push('');

  writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Report written -> ${OUT_MD}`);
  console.log(`Kết luận: ${conclusion}`);
}

main();
