/**
 * TICKET-140B — reads TICKET-139's RAW SafetyState5m diagnostic CSV (columns: timestamp,symbol,
 * htfContext,safetyState5m,oldRegime — only `safetyState5m` used here), TICKET-140's STABILIZED CSV
 * (columns: timestamp,symbol,safetyState5mStabilized), AND TICKET-140B's own FINAL-STABILIZED CSV
 * (columns: timestamp,symbol,safetyState5mFinalStabilized) from the SAME backtest run, and produces
 * data/ticket140b-safety-state-5m-final-chattering-reduction.md: a 3-way RAW/T140/T140B
 * flip/dwell/%-time comparison + dangerous-episode retention analysis (extends TICKET-140's own
 * ticket140GenerateReport.ts methodology to a 3rd column) + the PASS/FAIL table against the ticket's
 * 8 criteria. Pure post-processing — never re-runs any state machine.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Row {
  timestamp: number;
  symbol: string;
  state: string;
}

interface TrackStats {
  totalCandles: number;
  timeInState: Record<string, number>;
  flipCount: number;
  shortReversionCount: number;
  dwellDurations: number[];
  perSymbol: Record<string, { flipCount: number; shortReversionCount: number; dwellDurations: number[]; timeInState: Record<string, number>; totalCandles: number }>;
}

interface Episode {
  symbol: string;
  state: string;
  startTs: number;
  endTs: number;
  lengthCandles: number;
}

const DANGER_STATES = ['MANIPULATED', 'VOLATILE_CHOP', 'LOW_LIQUIDITY', 'SHOCK'];
const SAFETY_ORDER = ['NORMAL', 'MANIPULATED', 'VOLATILE_CHOP', 'LOW_LIQUIDITY', 'SHOCK'];

function readCsvGeneric(csvPath: string, stateColumnIndex: number): Row[] {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return { timestamp: Number(cols[0]), symbol: cols[1], state: cols[stateColumnIndex] };
  });
}

function groupBySymbol(rows: Row[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const r of rows) {
    if (!out[r.symbol]) out[r.symbol] = [];
    out[r.symbol].push(r);
  }
  for (const symbol of Object.keys(out)) out[symbol].sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

function computeTrackStats(rowsBySymbol: Record<string, Row[]>): TrackStats {
  const stats: TrackStats = { totalCandles: 0, timeInState: {}, flipCount: 0, shortReversionCount: 0, dwellDurations: [], perSymbol: {} };

  for (const symbol of Object.keys(rowsBySymbol)) {
    const series = rowsBySymbol[symbol].map((r) => r.state);
    const symStats = { flipCount: 0, shortReversionCount: 0, dwellDurations: [] as number[], timeInState: {} as Record<string, number>, totalCandles: series.length };
    stats.totalCandles += series.length;
    for (const v of series) {
      stats.timeInState[v] = (stats.timeInState[v] ?? 0) + 1;
      symStats.timeInState[v] = (symStats.timeInState[v] ?? 0) + 1;
    }

    const transitions: { index: number; from: string; to: string }[] = [];
    let runStart = 0;
    for (let i = 1; i < series.length; i++) {
      if (series[i] !== series[i - 1]) {
        transitions.push({ index: i, from: series[i - 1], to: series[i] });
        const dwell = i - runStart;
        stats.dwellDurations.push(dwell);
        symStats.dwellDurations.push(dwell);
        runStart = i;
      }
    }
    if (series.length > 0) {
      const dwell = series.length - runStart;
      stats.dwellDurations.push(dwell);
      symStats.dwellDurations.push(dwell);
    }

    stats.flipCount += transitions.length;
    symStats.flipCount = transitions.length;
    for (let j = 0; j < transitions.length; j++) {
      const tr = transitions[j];
      for (let k = j + 1; k < transitions.length; k++) {
        const next = transitions[k];
        if (next.index - tr.index > 3) break;
        if (next.to === tr.from) {
          stats.shortReversionCount++;
          symStats.shortReversionCount++;
          break;
        }
      }
    }
    stats.perSymbol[symbol] = symStats;
  }
  return stats;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function avgDwell(durations: number[]): string {
  if (durations.length === 0) return 'N/A';
  const avgCandles = durations.reduce((a, b) => a + b, 0) / durations.length;
  return `${avgCandles.toFixed(1)} nến (${(avgCandles * 5).toFixed(0)} phút)`;
}

function avgDwellCandles(durations: number[]): number {
  if (durations.length === 0) return 0;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

function maxDwellCandles(durations: number[]): number {
  if (durations.length === 0) return 0;
  return Math.max(...durations);
}

function timeInStateTable(stats: TrackStats, order: string[]): string {
  const rows = order.map((state) => `| ${state} | ${stats.timeInState[state] ?? 0} | ${pct(stats.timeInState[state] ?? 0, stats.totalCandles)} |`);
  return ['| State | Số nến | % thời gian |', '|---|---|---|', ...rows].join('\n');
}

/** Extracts contiguous runs (episodes) of DANGER_STATES per symbol, in timestamp order. */
function extractEpisodes(rowsBySymbol: Record<string, Row[]>): Episode[] {
  const episodes: Episode[] = [];
  for (const symbol of Object.keys(rowsBySymbol)) {
    const rows = rowsBySymbol[symbol];
    let i = 0;
    while (i < rows.length) {
      if (!DANGER_STATES.includes(rows[i].state)) {
        i++;
        continue;
      }
      const state = rows[i].state;
      const startTs = rows[i].timestamp;
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].state === state) j++;
      const endTs = rows[j].timestamp;
      episodes.push({ symbol, state, startTs, endTs, lengthCandles: j - i + 1 });
      i = j + 1;
    }
  }
  return episodes;
}

/** Episode retained if the OTHER track has the SAME state active for >=1 candle within [startTs, endTs] for that symbol. */
function computeRetention(rawEpisodes: Episode[], otherRowsBySymbol: Record<string, Row[]>): { byState: Record<string, { total: number; retained: number; oneCandle: number }> } {
  const byState: Record<string, { total: number; retained: number; oneCandle: number }> = {};
  for (const state of DANGER_STATES) byState[state] = { total: 0, retained: 0, oneCandle: 0 };

  for (const ep of rawEpisodes) {
    byState[ep.state].total++;
    if (ep.lengthCandles === 1) byState[ep.state].oneCandle++;
    const otherRows = otherRowsBySymbol[ep.symbol] ?? [];
    const overlap = otherRows.some((r) => r.state === ep.state && r.timestamp >= ep.startTs && r.timestamp <= ep.endTs);
    if (overlap) byState[ep.state].retained++;
  }
  return { byState };
}

function retentionForEpisodesMinLength(rawEpisodes: Episode[], otherRowsBySymbol: Record<string, Row[]>, state: string, minLength: number): { total: number; retained: number } {
  const eps = rawEpisodes.filter((e) => e.state === state && e.lengthCandles >= minLength);
  let retained = 0;
  for (const ep of eps) {
    const otherRows = otherRowsBySymbol[ep.symbol] ?? [];
    if (otherRows.some((r) => r.state === ep.state && r.timestamp >= ep.startTs && r.timestamp <= ep.endTs)) retained++;
  }
  return { total: eps.length, retained };
}

export function generateTicket140bReport(rawCsvPath: string, t140CsvPath: string, t140bCsvPath: string, outputPath: string): void {
  const rawRows = readCsvGeneric(rawCsvPath, 3); // ticket139 CSV: timestamp,symbol,htfContext,safetyState5m,oldRegime
  const t140Rows = readCsvGeneric(t140CsvPath, 2); // ticket140 CSV: timestamp,symbol,safetyState5mStabilized
  const t140bRows = readCsvGeneric(t140bCsvPath, 2); // ticket140b CSV: timestamp,symbol,safetyState5mFinalStabilized

  const rawBySymbol = groupBySymbol(rawRows);
  const t140BySymbol = groupBySymbol(t140Rows);
  const t140bBySymbol = groupBySymbol(t140bRows);

  const rawStats = computeTrackStats(rawBySymbol);
  const t140Stats = computeTrackStats(t140BySymbol);
  const t140bStats = computeTrackStats(t140bBySymbol);

  const rawEpisodes = extractEpisodes(rawBySymbol);
  const retentionVsRaw = computeRetention(rawEpisodes, t140bBySymbol);

  const shockRetention = retentionForEpisodesMinLength(rawEpisodes, t140bBySymbol, 'SHOCK', 1);
  const manipRetention2plus = retentionForEpisodesMinLength(rawEpisodes, t140bBySymbol, 'MANIPULATED', 2);
  const chopRetention2plus = retentionForEpisodesMinLength(rawEpisodes, t140bBySymbol, 'VOLATILE_CHOP', 2);

  let shockEnteredImmediate = 0;
  for (const symbol of Object.keys(t140bBySymbol)) {
    const series = t140bBySymbol[symbol];
    for (let i = 1; i < series.length; i++) {
      if (series[i].state === 'SHOCK' && series[i - 1].state !== 'SHOCK') shockEnteredImmediate++;
    }
    if (series.length > 0 && series[0].state === 'SHOCK') shockEnteredImmediate++;
  }

  const oneCandleEpisodesByState: Record<string, number> = {};
  for (const state of DANGER_STATES) oneCandleEpisodesByState[state] = retentionVsRaw.byState[state].oneCandle;

  const flipReductionPct = rawStats.flipCount > 0 ? ((rawStats.flipCount - t140bStats.flipCount) / rawStats.flipCount) * 100 : 0;
  const shortReversionReductionPct = rawStats.shortReversionCount > 0 ? ((rawStats.shortReversionCount - t140bStats.shortReversionCount) / rawStats.shortReversionCount) * 100 : 0;
  const flipReductionPctVsT140 = t140Stats.flipCount > 0 ? ((t140Stats.flipCount - t140bStats.flipCount) / t140Stats.flipCount) * 100 : 0;

  const manipRetentionPct = manipRetention2plus.total > 0 ? (manipRetention2plus.retained / manipRetention2plus.total) * 100 : 100;
  const chopRetentionPct = chopRetention2plus.total > 0 ? (chopRetention2plus.retained / chopRetention2plus.total) * 100 : 100;
  const shockRetentionPct = shockRetention.total > 0 ? (shockRetention.retained / shockRetention.total) * 100 : 100;

  const pass1 = flipReductionPct >= 30;
  const pass2 = shortReversionReductionPct >= 50;
  const pass3 = shockRetentionPct === 100;
  const pass4 = manipRetentionPct >= 85;
  const pass5 = chopRetentionPct >= 85;

  // §10 "không giữ hard-block bất thường quá lâu" has no ticket-given numeric threshold — inventing
  // one here would violate house rules (never invent thresholds beyond what the ticket gives). Instead
  // this is a DATA comparison: T140B's own episode-length distribution for each governed state
  // (min/max/avg) side by side with T140's SAME distribution on the SAME market data. Since T140B only
  // ever holds LONGER when the market genuinely keeps re-confirming the same danger candidate
  // (dwell-holding branch) or during the single extra 1-candle wait §2 adds — never an unbounded stall
  // — a long max episode by itself is not evidence of a bug UNLESS T140B's max is dramatically larger
  // than T140's max for the SAME state on the SAME data (which would indicate a state genuinely got
  // stuck instead of just holding one extra confirm candle). Left as a manual read, like criteria 7/8.
  const t140Episodes = extractEpisodes(t140BySymbol);
  const t140bEpisodes = extractEpisodes(t140bBySymbol);
  const holdComparisonRows = DANGER_STATES.map((state) => {
    const t140Eps = t140Episodes.filter((e) => e.state === state);
    const t140bEps = t140bEpisodes.filter((e) => e.state === state);
    const t140Max = t140Eps.length > 0 ? Math.max(...t140Eps.map((e) => e.lengthCandles)) : 0;
    const t140bMax = t140bEps.length > 0 ? Math.max(...t140bEps.map((e) => e.lengthCandles)) : 0;
    const t140Avg = t140Eps.length > 0 ? (t140Eps.reduce((a, e) => a + e.lengthCandles, 0) / t140Eps.length).toFixed(1) : 'N/A';
    const t140bAvg = t140bEps.length > 0 ? (t140bEps.reduce((a, e) => a + e.lengthCandles, 0) / t140bEps.length).toFixed(1) : 'N/A';
    return { state, t140Max, t140bMax, t140Avg, t140bAvg };
  });

  const symbolFlipRows = Object.keys(rawStats.perSymbol)
    .sort()
    .map((symbol) => {
      const r = rawStats.perSymbol[symbol];
      const s1 = t140Stats.perSymbol[symbol] ?? { flipCount: 0, shortReversionCount: 0, dwellDurations: [], timeInState: {}, totalCandles: 0 };
      const s2 = t140bStats.perSymbol[symbol] ?? { flipCount: 0, shortReversionCount: 0, dwellDurations: [], timeInState: {}, totalCandles: 0 };
      return `| ${symbol} | ${r.flipCount} | ${s1.flipCount} | ${s2.flipCount} | ${r.shortReversionCount} | ${s1.shortReversionCount} | ${s2.shortReversionCount} | ${avgDwellCandles(r.dwellDurations).toFixed(1)} | ${avgDwellCandles(s1.dwellDurations).toFixed(1)} | ${avgDwellCandles(s2.dwellDurations).toFixed(1)} |`;
    });

  const retentionRows = DANGER_STATES.map((state) => {
    const r = retentionVsRaw.byState[state];
    const retPct = r.total > 0 ? `${((r.retained / r.total) * 100).toFixed(1)}%` : 'N/A (0 episode)';
    return `| ${state} | ${r.total} | ${r.retained} | ${retPct} | ${r.oneCandle} |`;
  });

  const lines: string[] = [
    '# TICKET-140B — SafetyState5m Final Chattering Reduction',
    '',
    `Nguồn RAW (TICKET-139 candidate, chưa qua state machine): \`${rawCsvPath}\` (${rawRows.length} dòng).`,
    `Nguồn T140 (TICKET-140 stabilized tracker): \`${t140CsvPath}\` (${t140Rows.length} dòng).`,
    `Nguồn T140B (TICKET-140B final-stabilized tracker): \`${t140bCsvPath}\` (${t140bRows.length} dòng).`,
    `Symbols: ${Object.keys(rawBySymbol).join(', ')}.`,
    '',
    '## 1. So sánh tổng quan RAW / T140 / T140B',
    '',
    '| Chỉ số | RAW | T140 | T140B | Thay đổi T140B vs RAW | Thay đổi T140B vs T140 |',
    '|---|---|---|---|---|---|',
    `| Tổng flips | ${rawStats.flipCount} | ${t140Stats.flipCount} | ${t140bStats.flipCount} | ${flipReductionPct >= 0 ? 'GIẢM' : 'TĂNG'} ${Math.abs(flipReductionPct).toFixed(1)}% | ${flipReductionPctVsT140 >= 0 ? 'GIẢM' : 'TĂNG'} ${Math.abs(flipReductionPctVsT140).toFixed(1)}% |`,
    `| Flip quay lại <=3 nến | ${rawStats.shortReversionCount} | ${t140Stats.shortReversionCount} | ${t140bStats.shortReversionCount} | ${shortReversionReductionPct >= 0 ? 'GIẢM' : 'TĂNG'} ${Math.abs(shortReversionReductionPct).toFixed(1)}% | — |`,
    `| Dwell trung bình | ${avgDwell(rawStats.dwellDurations)} | ${avgDwell(t140Stats.dwellDurations)} | ${avgDwell(t140bStats.dwellDurations)} | — | — |`,
    `| % NORMAL | ${pct(rawStats.timeInState['NORMAL'] ?? 0, rawStats.totalCandles)} | ${pct(t140Stats.timeInState['NORMAL'] ?? 0, t140Stats.totalCandles)} | ${pct(t140bStats.timeInState['NORMAL'] ?? 0, t140bStats.totalCandles)} | — | — |`,
    `| % MANIPULATED | ${pct(rawStats.timeInState['MANIPULATED'] ?? 0, rawStats.totalCandles)} | ${pct(t140Stats.timeInState['MANIPULATED'] ?? 0, t140Stats.totalCandles)} | ${pct(t140bStats.timeInState['MANIPULATED'] ?? 0, t140bStats.totalCandles)} | — | — |`,
    `| % VOLATILE_CHOP | ${pct(rawStats.timeInState['VOLATILE_CHOP'] ?? 0, rawStats.totalCandles)} | ${pct(t140Stats.timeInState['VOLATILE_CHOP'] ?? 0, t140Stats.totalCandles)} | ${pct(t140bStats.timeInState['VOLATILE_CHOP'] ?? 0, t140bStats.totalCandles)} | — | — |`,
    `| % LOW_LIQUIDITY | ${pct(rawStats.timeInState['LOW_LIQUIDITY'] ?? 0, rawStats.totalCandles)} | ${pct(t140Stats.timeInState['LOW_LIQUIDITY'] ?? 0, t140Stats.totalCandles)} | ${pct(t140bStats.timeInState['LOW_LIQUIDITY'] ?? 0, t140bStats.totalCandles)} | — | — |`,
    `| % SHOCK | ${pct(rawStats.timeInState['SHOCK'] ?? 0, rawStats.totalCandles)} | ${pct(t140Stats.timeInState['SHOCK'] ?? 0, t140Stats.totalCandles)} | ${pct(t140bStats.timeInState['SHOCK'] ?? 0, t140bStats.totalCandles)} | — | — |`,
    '',
    '## 2. Tỷ lệ thời gian từng state — RAW',
    '',
    timeInStateTable(rawStats, SAFETY_ORDER),
    '',
    '## 3. Tỷ lệ thời gian từng state — T140',
    '',
    timeInStateTable(t140Stats, SAFETY_ORDER),
    '',
    '## 4. Tỷ lệ thời gian từng state — T140B',
    '',
    timeInStateTable(t140bStats, SAFETY_ORDER),
    '',
    '## 5. Theo từng symbol',
    '',
    '| Symbol | Flips RAW | Flips T140 | Flips T140B | Short-rev RAW | Short-rev T140 | Short-rev T140B | Dwell TB RAW | Dwell TB T140 | Dwell TB T140B |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...symbolFlipRows,
    '',
    '## 6. SHOCK entered ngay lập tức (T140B)',
    '',
    `SHOCK được enter ngay lập tức (không confirm delay, không đổi so với T140): ${shockEnteredImmediate} lần trong T140B stream.`,
    '',
    '## 7. Episode nguy hiểm giữ lại (retention) — RAW vs T140B',
    '',
    '| State | RAW episodes | Retained trong T140B | Retention % | Bị loại vì 1 nến |',
    '|---|---|---|---|---|',
    ...retentionRows,
    '',
    `Retention riêng cho episode RAW dài >=2 nến (dùng cho tiêu chí PASS): MANIPULATED ${manipRetention2plus.retained}/${manipRetention2plus.total} (${manipRetentionPct.toFixed(1)}%), ` +
      `VOLATILE_CHOP ${chopRetention2plus.retained}/${chopRetention2plus.total} (${chopRetentionPct.toFixed(1)}%), SHOCK ${shockRetention.retained}/${shockRetention.total} (${shockRetentionPct.toFixed(1)}%).`,
    '',
    'Số candidate nguy hiểm bị loại vì chỉ tồn tại 1 nến trong RAW (nhiễu 1 nến kỳ vọng bị hấp thụ, không phải regression): ' +
      `MANIPULATED=${oneCandleEpisodesByState['MANIPULATED']}, VOLATILE_CHOP=${oneCandleEpisodesByState['VOLATILE_CHOP']}, LOW_LIQUIDITY=${oneCandleEpisodesByState['LOW_LIQUIDITY']}, SHOCK=${oneCandleEpisodesByState['SHOCK']}.`,
    '',
    '## 8. Hard-block quá lâu bất thường? (episode T140 vs T140B, cùng dữ liệu — không có ngưỡng số cụ thể trong ticket, đọc thủ công)',
    '',
    '| State | Max T140 (nến) | Max T140B (nến) | TB T140 (nến) | TB T140B (nến) |',
    '|---|---|---|---|---|',
    ...holdComparisonRows.map((r) => `| ${r.state} | ${r.t140Max} | ${r.t140bMax} | ${r.t140Avg} | ${r.t140bAvg} |`),
    '',
    `Dwell trung bình dài nhất từng ghi nhận trong T140B (mọi state, mọi symbol): ${maxDwellCandles(t140bStats.dwellDurations)} nến. Ticket không cho ngưỡng số cụ thể cho tiêu chí này — không tự bịa ngưỡng, chỉ trình bày số liệu so sánh T140 vs T140B để review thủ công (§10 pass6 dưới).`,
    '',
    '## 9. Kết luận PASS/FAIL',
    '',
    '| # | Tiêu chí | Ngưỡng | Kết quả thực tế | PASS/FAIL |',
    '|---|---|---|---|---|',
    `| 1 | Tổng flips giảm (T140B vs RAW) | >= 30% | ${flipReductionPct.toFixed(1)}% | ${pass1 ? 'PASS' : 'FAIL'} |`,
    `| 2 | Flip quay lại <=3 nến giảm (T140B vs RAW) | >= 50% | ${shortReversionReductionPct.toFixed(1)}% | ${pass2 ? 'PASS' : 'FAIL'} |`,
    `| 3 | SHOCK retention | = 100% | ${shockRetentionPct.toFixed(1)}% | ${pass3 ? 'PASS' : 'FAIL'} |`,
    `| 4 | MANIPULATED retention (episode RAW >=2 nến) | >= 85% | ${manipRetentionPct.toFixed(1)}% | ${pass4 ? 'PASS' : 'FAIL'} |`,
    `| 5 | VOLATILE_CHOP retention (episode RAW >=2 nến) | >= 85% | ${chopRetentionPct.toFixed(1)}% | ${pass5 ? 'PASS' : 'FAIL'} |`,
    `| 6 | Không giữ hard-block bất thường quá lâu | không có ngưỡng số trong ticket | xem §8 (T140 vs T140B, max/TB dwell mỗi state) | Cần review thủ công — xem §8 |`,
    '| 7 | Baseline byte-identical khi flag OFF | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '| 8 | Test/build pass | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '',
  ];

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket140bGenerateReport.js <rawCsvPath> <t140CsvPath> <t140bCsvPath> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket140bGenerateReport.js')) {
  const rawCsvPath = process.argv[2];
  const t140CsvPath = process.argv[3];
  const t140bCsvPath = process.argv[4];
  const outputPath = process.argv[5] ?? 'data/ticket140b-safety-state-5m-final-chattering-reduction.md';
  if (!rawCsvPath || !t140CsvPath || !t140bCsvPath) {
    console.error('Usage: node ticket140bGenerateReport.js <rawCsvPath> <t140CsvPath> <t140bCsvPath> [outputPath]');
    process.exit(1);
  }
  generateTicket140bReport(rawCsvPath, t140CsvPath, t140bCsvPath, outputPath);
  console.log(`→ ${outputPath}`);
}
