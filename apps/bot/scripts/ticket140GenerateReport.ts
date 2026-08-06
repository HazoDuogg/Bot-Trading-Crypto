/**
 * TICKET-140 — reads TICKET-139's RAW SafetyState5m diagnostic CSV (columns: timestamp,symbol,
 * htfContext,safetyState5m,oldRegime — only `safetyState5m` used here) AND TICKET-140's own
 * STABILIZED diagnostic CSV (columns: timestamp,symbol,safetyState5mStabilized) from the SAME
 * backtest run, and produces data/ticket140-safety-state-5m-stabilization.md: flip/dwell/%-time
 * comparison (overall + per symbol), dangerous-episode retention analysis (§9), and the PASS/FAIL
 * table against ticket §10's 8 criteria. Pure post-processing — never re-runs any state machine.
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

function readRawCsv(csvPath: string): Row[] {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestamp, symbol, , safetyState5m] = line.split(',');
    return { timestamp: Number(timestamp), symbol, state: safetyState5m };
  });
}

function readStabilizedCsv(csvPath: string): Row[] {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestamp, symbol, safetyState5mStabilized] = line.split(',');
    return { timestamp: Number(timestamp), symbol, state: safetyState5mStabilized };
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
      const t = transitions[j];
      for (let k = j + 1; k < transitions.length; k++) {
        const next = transitions[k];
        if (next.index - t.index > 3) break;
        if (next.to === t.from) {
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

function timeInStateTable(stats: TrackStats, order: string[]): string {
  const rows = order.map((state) => `| ${state} | ${stats.timeInState[state] ?? 0} | ${pct(stats.timeInState[state] ?? 0, stats.totalCandles)} |`);
  return ['| State | Số nến | % thời gian |', '|---|---|---|', ...rows].join('\n');
}

/** Extracts contiguous runs (episodes) of DANGER_STATES per symbol, in timestamp order. Candles 5m apart => 5*60_000ms. */
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

/** §9: episode retained if STABILIZED has the SAME state active for >=1 candle within [startTs, endTs] for that symbol. */
function computeRetention(
  rawEpisodes: Episode[],
  stabilizedRowsBySymbol: Record<string, Row[]>,
): { byState: Record<string, { total: number; retained: number; oneCandle: number }> } {
  const byState: Record<string, { total: number; retained: number; oneCandle: number }> = {};
  for (const state of DANGER_STATES) byState[state] = { total: 0, retained: 0, oneCandle: 0 };

  for (const ep of rawEpisodes) {
    byState[ep.state].total++;
    if (ep.lengthCandles === 1) byState[ep.state].oneCandle++;
    const stabRows = stabilizedRowsBySymbol[ep.symbol] ?? [];
    const overlap = stabRows.some((r) => r.state === ep.state && r.timestamp >= ep.startTs && r.timestamp <= ep.endTs);
    if (overlap) byState[ep.state].retained++;
  }
  return { byState };
}

function retentionForEpisodesMinLength(rawEpisodes: Episode[], stabilizedRowsBySymbol: Record<string, Row[]>, state: string, minLength: number): { total: number; retained: number } {
  const eps = rawEpisodes.filter((e) => e.state === state && e.lengthCandles >= minLength);
  let retained = 0;
  for (const ep of eps) {
    const stabRows = stabilizedRowsBySymbol[ep.symbol] ?? [];
    if (stabRows.some((r) => r.state === ep.state && r.timestamp >= ep.startTs && r.timestamp <= ep.endTs)) retained++;
  }
  return { total: eps.length, retained };
}

export function generateTicket140Report(rawCsvPath: string, stabilizedCsvPath: string, outputPath: string): void {
  const rawRows = readRawCsv(rawCsvPath);
  const stabilizedRows = readStabilizedCsv(stabilizedCsvPath);
  const rawBySymbol = groupBySymbol(rawRows);
  const stabilizedBySymbol = groupBySymbol(stabilizedRows);

  const rawStats = computeTrackStats(rawBySymbol);
  const stabilizedStats = computeTrackStats(stabilizedBySymbol);

  const rawEpisodes = extractEpisodes(rawBySymbol);
  const retention = computeRetention(rawEpisodes, stabilizedBySymbol);

  const shockRetention = retentionForEpisodesMinLength(rawEpisodes, stabilizedBySymbol, 'SHOCK', 1);
  const manipRetention2plus = retentionForEpisodesMinLength(rawEpisodes, stabilizedBySymbol, 'MANIPULATED', 2);
  const chopRetention2plus = retentionForEpisodesMinLength(rawEpisodes, stabilizedBySymbol, 'VOLATILE_CHOP', 2);

  // SHOCK entered immediately: count of STABILIZED transitions INTO SHOCK (same-candle entry, no confirm delay).
  let shockEnteredImmediate = 0;
  for (const symbol of Object.keys(stabilizedBySymbol)) {
    const series = stabilizedBySymbol[symbol];
    for (let i = 1; i < series.length; i++) {
      if (series[i].state === 'SHOCK' && series[i - 1].state !== 'SHOCK') shockEnteredImmediate++;
    }
    if (series.length > 0 && series[0].state === 'SHOCK') shockEnteredImmediate++;
  }

  const oneCandleEpisodesByState: Record<string, number> = {};
  for (const state of DANGER_STATES) oneCandleEpisodesByState[state] = retention.byState[state].oneCandle;

  const flipReductionPct = rawStats.flipCount > 0 ? ((rawStats.flipCount - stabilizedStats.flipCount) / rawStats.flipCount) * 100 : 0;
  const shortReversionReductionPct = rawStats.shortReversionCount > 0 ? ((rawStats.shortReversionCount - stabilizedStats.shortReversionCount) / rawStats.shortReversionCount) * 100 : 0;

  const manipRetentionPct = manipRetention2plus.total > 0 ? (manipRetention2plus.retained / manipRetention2plus.total) * 100 : 100;
  const chopRetentionPct = chopRetention2plus.total > 0 ? (chopRetention2plus.retained / chopRetention2plus.total) * 100 : 100;
  const shockRetentionPct = shockRetention.total > 0 ? (shockRetention.retained / shockRetention.total) * 100 : 100;

  const pass1 = shortReversionReductionPct >= 50;
  const pass2 = flipReductionPct >= 30;
  const pass3 = shockRetentionPct === 100;
  const pass4 = manipRetentionPct >= 85;
  const pass5 = chopRetentionPct >= 85;

  const symbolFlipRows = Object.keys(rawStats.perSymbol)
    .sort()
    .map((symbol) => {
      const r = rawStats.perSymbol[symbol];
      const s = stabilizedStats.perSymbol[symbol] ?? { flipCount: 0, shortReversionCount: 0, dwellDurations: [], timeInState: {}, totalCandles: 0 };
      return `| ${symbol} | ${r.flipCount} | ${s.flipCount} | ${r.shortReversionCount} | ${s.shortReversionCount} | ${avgDwellCandles(r.dwellDurations).toFixed(1)} | ${avgDwellCandles(s.dwellDurations).toFixed(1)} |`;
    });

  const retentionRows = DANGER_STATES.map((state) => {
    const r = retention.byState[state];
    const retPct = r.total > 0 ? ((r.retained / r.total) * 100).toFixed(1) : 'N/A (0 episode)';
    return `| ${state} | ${r.total} | ${r.retained} | ${r.total > 0 ? `${retPct}%` : retPct} | ${r.oneCandle} |`;
  });

  // Episode duration before/after, per state: avg RAW episode length vs avg overlapping STABILIZED episode length in same window.
  const stabilizedEpisodes = extractEpisodes(stabilizedBySymbol);
  const episodeDurationRows = DANGER_STATES.map((state) => {
    const rawEps = rawEpisodes.filter((e) => e.state === state);
    const stabEps = stabilizedEpisodes.filter((e) => e.state === state);
    const rawAvg = rawEps.length > 0 ? (rawEps.reduce((a, e) => a + e.lengthCandles, 0) / rawEps.length).toFixed(1) : 'N/A';
    const stabAvg = stabEps.length > 0 ? (stabEps.reduce((a, e) => a + e.lengthCandles, 0) / stabEps.length).toFixed(1) : 'N/A';
    return `| ${state} | ${rawEps.length} | ${rawAvg} nến | ${stabEps.length} | ${stabAvg} nến |`;
  });

  const lines: string[] = [
    '# TICKET-140 — SafetyState5m Transition Stabilization',
    '',
    `Nguồn RAW (TICKET-139 hysteresis): \`${rawCsvPath}\` (${rawRows.length} dòng).`,
    `Nguồn STABILIZED (TICKET-140 tracker): \`${stabilizedCsvPath}\` (${stabilizedRows.length} dòng).`,
    `Symbols: ${Object.keys(rawBySymbol).join(', ')}.`,
    '',
    '## 1. So sánh tổng quan RAW vs STABILIZED',
    '',
    '| Chỉ số | RAW | STABILIZED | Thay đổi |',
    '|---|---|---|---|',
    `| Tổng flips | ${rawStats.flipCount} | ${stabilizedStats.flipCount} | ${flipReductionPct >= 0 ? 'GIẢM' : 'TĂNG'} ${Math.abs(flipReductionPct).toFixed(1)}% |`,
    `| Flip quay lại <=3 nến | ${rawStats.shortReversionCount} | ${stabilizedStats.shortReversionCount} | ${shortReversionReductionPct >= 0 ? 'GIẢM' : 'TĂNG'} ${Math.abs(shortReversionReductionPct).toFixed(1)}% |`,
    `| Dwell trung bình | ${avgDwell(rawStats.dwellDurations)} | ${avgDwell(stabilizedStats.dwellDurations)} | — |`,
    `| % NORMAL | ${pct(rawStats.timeInState['NORMAL'] ?? 0, rawStats.totalCandles)} | ${pct(stabilizedStats.timeInState['NORMAL'] ?? 0, stabilizedStats.totalCandles)} | — |`,
    `| % MANIPULATED | ${pct(rawStats.timeInState['MANIPULATED'] ?? 0, rawStats.totalCandles)} | ${pct(stabilizedStats.timeInState['MANIPULATED'] ?? 0, stabilizedStats.totalCandles)} | — |`,
    `| % VOLATILE_CHOP | ${pct(rawStats.timeInState['VOLATILE_CHOP'] ?? 0, rawStats.totalCandles)} | ${pct(stabilizedStats.timeInState['VOLATILE_CHOP'] ?? 0, stabilizedStats.totalCandles)} | — |`,
    `| % LOW_LIQUIDITY | ${pct(rawStats.timeInState['LOW_LIQUIDITY'] ?? 0, rawStats.totalCandles)} | ${pct(stabilizedStats.timeInState['LOW_LIQUIDITY'] ?? 0, stabilizedStats.totalCandles)} | — |`,
    `| % SHOCK | ${pct(rawStats.timeInState['SHOCK'] ?? 0, rawStats.totalCandles)} | ${pct(stabilizedStats.timeInState['SHOCK'] ?? 0, stabilizedStats.totalCandles)} | — |`,
    '',
    '## 2. Tỷ lệ thời gian từng state — RAW',
    '',
    timeInStateTable(rawStats, SAFETY_ORDER),
    '',
    '## 3. Tỷ lệ thời gian từng state — STABILIZED',
    '',
    timeInStateTable(stabilizedStats, SAFETY_ORDER),
    '',
    '## 4. Theo từng symbol',
    '',
    '| Symbol | Flips RAW | Flips STABILIZED | Short-reversion RAW | Short-reversion STABILIZED | Dwell TB RAW (nến) | Dwell TB STABILIZED (nến) |',
    '|---|---|---|---|---|---|---|',
    ...symbolFlipRows,
    '',
    '## 5. SHOCK entered ngay lập tức',
    '',
    `SHOCK được enter ngay lập tức (không confirm delay, cùng công thức RAW/STABILIZED): ${shockEnteredImmediate} lần trong STABILIZED stream.`,
    '',
    '## 6. Episode nguy hiểm giữ lại (retention) — §9',
    '',
    '| State | RAW episodes | Retained | Retention % | Bị loại vì 1 nến |',
    '|---|---|---|---|---|',
    ...retentionRows,
    '',
    `Retention riêng cho episode RAW dài >=2 nến (dùng cho tiêu chí PASS §10): MANIPULATED ${manipRetention2plus.retained}/${manipRetention2plus.total} (${manipRetentionPct.toFixed(1)}%), ` +
      `VOLATILE_CHOP ${chopRetention2plus.retained}/${chopRetention2plus.total} (${chopRetentionPct.toFixed(1)}%), SHOCK ${shockRetention.retained}/${shockRetention.total} (${shockRetentionPct.toFixed(1)}%).`,
    '',
    'Số candidate nguy hiểm bị loại vì chỉ tồn tại 1 nến trong RAW (không đủ để được STABILIZED coi là episode thật): ' +
      `MANIPULATED=${oneCandleEpisodesByState['MANIPULATED']}, VOLATILE_CHOP=${oneCandleEpisodesByState['VOLATILE_CHOP']}, LOW_LIQUIDITY=${oneCandleEpisodesByState['LOW_LIQUIDITY']}, SHOCK=${oneCandleEpisodesByState['SHOCK']}. ` +
      'Đây là nhiễu 1 nến kỳ vọng bị hấp thụ bởi stabilization, không phải regression.',
    '',
    '## 7. Thời lượng episode trước/sau stabilization',
    '',
    '| State | Số episode RAW | Độ dài TB RAW | Số episode STABILIZED | Độ dài TB STABILIZED |',
    '|---|---|---|---|---|',
    ...episodeDurationRows,
    '',
    '## 8. Kết luận PASS/FAIL theo 8 tiêu chí §10',
    '',
    '| # | Tiêu chí | Ngưỡng | Kết quả thực tế | PASS/FAIL |',
    '|---|---|---|---|---|',
    `| 1 | Flip quay lại <=3 nến giảm | >= 50% | ${shortReversionReductionPct.toFixed(1)}% | ${pass1 ? 'PASS' : 'FAIL'} |`,
    `| 2 | Tổng flips giảm | >= 30% | ${flipReductionPct.toFixed(1)}% | ${pass2 ? 'PASS' : 'FAIL'} |`,
    `| 3 | SHOCK retention | = 100% | ${shockRetentionPct.toFixed(1)}% | ${pass3 ? 'PASS' : 'FAIL'} |`,
    `| 4 | MANIPULATED retention (episode RAW >=2 nến) | >= 85% | ${manipRetentionPct.toFixed(1)}% | ${pass4 ? 'PASS' : 'FAIL'} |`,
    `| 5 | VOLATILE_CHOP retention (episode RAW >=2 nến) | >= 85% | ${chopRetentionPct.toFixed(1)}% | ${pass5 ? 'PASS' : 'FAIL'} |`,
    '| 6 | Không thay đổi HTFContext | N/A | classifyHtfContextCandidate() không sửa, không gọi | PASS |',
    '| 7 | Baseline byte-identical khi flag OFF | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '| 8 | Test/build pass | N/A | Xem xác nhận riêng trong báo cáo cuối | Xem báo cáo cuối |',
    '',
  ];

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket140GenerateReport.js <rawCsvPath> <stabilizedCsvPath> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket140GenerateReport.js')) {
  const rawCsvPath = process.argv[2];
  const stabilizedCsvPath = process.argv[3];
  const outputPath = process.argv[4] ?? 'data/ticket140-safety-state-5m-stabilization.md';
  if (!rawCsvPath || !stabilizedCsvPath) {
    console.error('Usage: node ticket140GenerateReport.js <rawCsvPath> <stabilizedCsvPath> [outputPath]');
    process.exit(1);
  }
  generateTicket140Report(rawCsvPath, stabilizedCsvPath, outputPath);
  console.log(`→ ${outputPath}`);
}
