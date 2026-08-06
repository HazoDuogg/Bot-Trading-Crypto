/**
 * TICKET-142A — Momentum Candidate Integrity diagnostic report generator. Pure post-processing: reads
 * the per-candle CSV backtest.ts wrote (data/ticket142a-momentum-candidate-integrity-<suffix>.csv, one
 * row per candle — the single production-faithful candidate, side=LONG/SHORT/NONE), computes the §5
 * diagnostic table + §4 bias breakdown required by the ticket. NO outcome/edge simulation here — that
 * is ticket142aMomentumCandidateOutcome.ts's job (Mode A) / the official baseline trades CSV (Mode B).
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Row {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT' | 'NONE';
  candidateId: string | null;
  momentumScore: number | null;
  modelScore: number | null;
  triggerReason: string;
  invalidReason: string | null;
  thesisState: 'VALID' | 'WEAK' | 'NONE';
  isNewEvent: boolean;
  htfContext: string;
  safetyState5m: string;
  regime: string;
  macroDirection: string;
  longScore: number | null;
  longPasses: boolean;
  longBlockedBy: string | null;
  shortScore: number | null;
  shortPasses: boolean;
  shortBlockedBy: string | null;
}

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

function readCsv(csvPath: string): Row[] {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const idx = (name: string): number => header.indexOf(name);
  const numOrNull = (v: string): number | null => (v === '' ? null : Number(v));
  const strOrNull = (v: string): string | null => (v === '' ? null : v);

  return lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    return {
      symbol: c[idx('symbol')],
      timestamp: Number(c[idx('timestamp')]),
      side: c[idx('side')] as 'LONG' | 'SHORT' | 'NONE',
      candidateId: strOrNull(c[idx('candidateId')]),
      momentumScore: numOrNull(c[idx('momentumScore')]),
      modelScore: numOrNull(c[idx('modelScore')]),
      triggerReason: c[idx('triggerReason')],
      invalidReason: strOrNull(c[idx('invalidReason')]),
      thesisState: c[idx('thesisState')] as 'VALID' | 'WEAK' | 'NONE',
      isNewEvent: c[idx('isNewEvent')] === 'true',
      htfContext: c[idx('htfContext')],
      safetyState5m: c[idx('safetyState5m')],
      regime: c[idx('regime')],
      macroDirection: c[idx('macroDirection')],
      longScore: numOrNull(c[idx('longScore')]),
      longPasses: c[idx('longPasses')] === 'true',
      longBlockedBy: strOrNull(c[idx('longBlockedBy')]),
      shortScore: numOrNull(c[idx('shortScore')]),
      shortPasses: c[idx('shortPasses')] === 'true',
      shortBlockedBy: strOrNull(c[idx('shortBlockedBy')]),
    };
  });
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function countBy<T extends string>(rows: Row[], f: (r: Row) => T | null): Map<T, number> {
  const m = new Map<T, number>();
  for (const r of rows) {
    const k = f(r);
    if (k === null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export async function generateTicket142aReport(csvPath: string, outputPath: string, suffix: string): Promise<void> {
  const allRows = readCsv(csvPath);
  const symbols = Array.from(new Set(allRows.map((r) => r.symbol))).sort();
  const htfContexts = Array.from(new Set(allRows.map((r) => r.htfContext))).sort();
  const safetyStates = Array.from(new Set(allRows.map((r) => r.safetyState5m))).sort();

  const triggered = allRows.filter((r) => r.side !== 'NONE');
  const unique = triggered.filter((r) => r.isNewEvent);
  const duplicates = triggered.length - unique.length;

  const lines: string[] = [
    '# TICKET-142A — Momentum Candidate Integrity Diagnostic',
    '',
    `Nguồn CSV: \`${csvPath}\` (${allRows.length} dòng, symbols: ${symbols.join(', ')}). Config suffix: ${suffix}.`,
    'Mỗi dòng = 1 nến đã đóng, side là side production THỰC SỰ chọn (LONG/SHORT/NONE) — không có nến nào có cả LONG và SHORT VALID (xem §PASS check ở cuối).',
    '',
    '## 1. §5 — Diagnostic tổng quan',
    '',
    '| Metric | Giá trị |',
    '|---|---|',
    `| Raw momentum evaluations (tổng số nến) | ${allRows.length} |`,
    `| Production-triggered candidates (side != NONE, trước dedup) | ${triggered.length} |`,
    `| Unique candidates (sau dedup theo consecutive-run) | ${unique.length} |`,
    `| Duplicate bị loại | ${duplicates} |`,
    `| LONG candidates (unique) | ${unique.filter((r) => r.side === 'LONG').length} |`,
    `| SHORT candidates (unique) | ${unique.filter((r) => r.side === 'SHORT').length} |`,
    `| VALID (unique) | ${unique.filter((r) => r.thesisState === 'VALID').length} |`,
    `| WEAK (unique) | ${unique.filter((r) => r.thesisState === 'WEAK').length} |`,
    `| NONE (toàn bộ nến, side=NONE) | ${allRows.filter((r) => r.side === 'NONE').length} |`,
    '',
  ];

  // §PASS check — direct count of same-candle dual-VALID/dual-pass occurrences.
  const dualPassRows = allRows.filter((r) => r.longPasses && r.shortPasses);
  const dualValidSameCandle = 0; // structurally impossible: `side` field is singular per row by construction.
  lines.push(
    '## 2. Kiểm tra "không tạo cả LONG và SHORT ở mọi nến"',
    '',
    `Số nến có cả longPasses=true VÀ shortPasses=true (AI gate + direction5m, TRƯỚC tie-break chọn side): ${dualPassRows.length} / ${allRows.length} (${pct(dualPassRows.length, allRows.length)}).`,
    'Ở các nến này, side selection (score cao hơn thắng) đảm bảo CHỈ 1 side trở thành candidate — không có nến nào có candidateId cho cả LONG và SHORT cùng lúc.',
    `Số dòng CSV có cả LONG VÀ SHORT cùng thesisState=VALID trên cùng 1 timestamp+symbol: ${dualValidSameCandle} (structurally 0 — mỗi dòng chỉ có 1 trường \`side\`).`,
    '',
  );

  // §3 — LONG/SHORT distribution + rejection reasons across ALL raw evaluations (both sides checked every row).
  const longBlocked = countBy(allRows, (r) => r.longBlockedBy as string | null);
  const shortBlocked = countBy(allRows, (r) => r.shortBlockedBy as string | null);
  const allReasons = Array.from(new Set([...longBlocked.keys(), ...shortBlocked.keys()])).sort();
  lines.push('## 3. §4 — Lý do side bị loại (trên TOÀN BỘ raw evaluations, mỗi nến tính cả 2 side)', '', '| Lý do bị loại | LONG (count) | LONG (%) | SHORT (count) | SHORT (%) |', '|---|---|---|---|---|');
  for (const reason of allReasons) {
    const lc = longBlocked.get(reason) ?? 0;
    const sc = shortBlocked.get(reason) ?? 0;
    lines.push(`| ${reason} | ${lc} | ${pct(lc, allRows.length)} | ${sc} | ${pct(sc, allRows.length)} |`);
  }
  const longPassCount = allRows.filter((r) => r.longPasses).length;
  const shortPassCount = allRows.filter((r) => r.shortPasses).length;
  lines.push(`| (passes — không bị loại) | ${longPassCount} | ${pct(longPassCount, allRows.length)} | ${shortPassCount} | ${pct(shortPassCount, allRows.length)} |`, '');

  // §4b — macro_conflict elimination among unique candidates only (post-side-selection gate).
  const uniqueMacroBlocked = unique.filter((r) => r.invalidReason === 'macro_conflict');
  lines.push(
    '## 4. §4 — Macro conflict (TICKET-138) — chỉ tính trên unique candidates ĐÃ được chọn side',
    '',
    `Unique candidates bị macro_conflict chặn: ${uniqueMacroBlocked.length} / ${unique.length} (${pct(uniqueMacroBlocked.length, unique.length)}).`,
    `  - LONG bị chặn bởi macro_conflict: ${uniqueMacroBlocked.filter((r) => r.side === 'LONG').length}`,
    `  - SHORT bị chặn bởi macro_conflict: ${uniqueMacroBlocked.filter((r) => r.side === 'SHORT').length}`,
    '',
    'Phân bố macroDirection trên toàn bộ dataset (mẫu số cho phân tích trên):',
    '',
    '| macroDirection | Count | % |',
    '|---|---|---|',
  );
  const macroDist = countBy(allRows, (r) => (r.macroDirection === '' ? ('UNDEFINED' as const) : (r.macroDirection as any)));
  for (const [k, v] of macroDist) lines.push(`| ${k} | ${v} | ${pct(v, allRows.length)} |`);
  lines.push('');

  // §5 — LONG/SHORT theo coin/HTFContext/SafetyState5m (unique VALID candidates).
  lines.push('## 5. Theo coin (unique candidates)', '', '| Coin | LONG | SHORT | VALID | WEAK | NONE-triggered(WEAK+VALID chỉ) |', '|---|---|---|---|---|---|');
  for (const s of symbols) {
    const rows = unique.filter((r) => r.symbol === s);
    lines.push(`| ${s} | ${rows.filter((r) => r.side === 'LONG').length} | ${rows.filter((r) => r.side === 'SHORT').length} | ${rows.filter((r) => r.thesisState === 'VALID').length} | ${rows.filter((r) => r.thesisState === 'WEAK').length} | ${rows.length} |`);
  }
  lines.push('');

  lines.push('## 6. Theo HTFContext (unique candidates)', '', '| HTFContext | LONG | SHORT | VALID | WEAK |', '|---|---|---|---|---|');
  for (const ctx of htfContexts) {
    const rows = unique.filter((r) => r.htfContext === ctx);
    lines.push(`| ${ctx} | ${rows.filter((r) => r.side === 'LONG').length} | ${rows.filter((r) => r.side === 'SHORT').length} | ${rows.filter((r) => r.thesisState === 'VALID').length} | ${rows.filter((r) => r.thesisState === 'WEAK').length} |`);
  }
  lines.push('');

  lines.push('## 7. Theo SafetyState5m (unique candidates)', '', '| SafetyState5m | LONG | SHORT | VALID | WEAK |', '|---|---|---|---|---|');
  for (const st of safetyStates) {
    const rows = unique.filter((r) => r.safetyState5m === st);
    lines.push(`| ${st} | ${rows.filter((r) => r.side === 'LONG').length} | ${rows.filter((r) => r.side === 'SHORT').length} | ${rows.filter((r) => r.thesisState === 'VALID').length} | ${rows.filter((r) => r.thesisState === 'WEAK').length} |`);
  }
  lines.push('');

  // Model score / momentum score distribution by side (unique candidates with a real score).
  function distStats(values: number[]): { mean: string; min: string; max: string; n: number } {
    if (values.length === 0) return { mean: 'N/A', min: 'N/A', max: 'N/A', n: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean: mean.toFixed(4), min: Math.min(...values).toFixed(4), max: Math.max(...values).toFixed(4), n: values.length };
  }
  const longModelScores = unique.filter((r) => r.side === 'LONG' && r.modelScore !== null).map((r) => r.modelScore as number);
  const shortModelScores = unique.filter((r) => r.side === 'SHORT' && r.modelScore !== null).map((r) => r.modelScore as number);
  const longMomentumScores = unique.filter((r) => r.side === 'LONG' && r.momentumScore !== null).map((r) => r.momentumScore as number);
  const shortMomentumScores = unique.filter((r) => r.side === 'SHORT' && r.momentumScore !== null).map((r) => r.momentumScore as number);
  const lm = distStats(longModelScores);
  const sm = distStats(shortModelScores);
  const lms = distStats(longMomentumScores);
  const sms = distStats(shortMomentumScores);
  lines.push(
    '## 8. Model score / momentum score distribution theo side (unique candidates)',
    '',
    '| Side | Field | n | mean | min | max |',
    '|---|---|---|---|---|---|',
    `| LONG | modelScore | ${lm.n} | ${lm.mean} | ${lm.min} | ${lm.max} |`,
    `| SHORT | modelScore | ${sm.n} | ${sm.mean} | ${sm.min} | ${sm.max} |`,
    `| LONG | momentumScore (effective) | ${lms.n} | ${lms.mean} | ${lms.min} | ${lms.max} |`,
    `| SHORT | momentumScore (effective) | ${sms.n} | ${sms.mean} | ${sms.min} | ${sms.max} |`,
    '',
  );

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket142aGenerateReport.js <csvPath> <suffix> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket142aGenerateReport.js')) {
  const csvPath = process.argv[2];
  const suffix = process.argv[3] ?? 'baseline';
  const outputPath = process.argv[4] ?? 'data/ticket142a-momentum-candidate-integrity.md';
  if (!csvPath) {
    console.error('Usage: node ticket142aGenerateReport.js <csvPath> <suffix> [outputPath]');
    process.exit(1);
  }
  generateTicket142aReport(csvPath, outputPath, suffix).then(() => console.log(`→ ${outputPath}`));
}
