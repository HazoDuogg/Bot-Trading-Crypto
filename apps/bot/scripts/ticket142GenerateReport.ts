/**
 * TICKET-142 — Setup-Specific Thesis diagnostic report generator. Pure post-processing: reads the
 * per-candle CSV backtest.ts wrote (data/ticket142-setup-specific-thesis-<suffix>.csv, one row per
 * SetupThesisResult), applies dedup (OB/FVG/SWEEP by candidateId — first VALID/WEAK occurrence of a
 * given candidateId counts, later rows with the same id are duplicates; BOX_BREAKOUT/MOMENTUM_DIRECT
 * need no dedup — see report body), then produces the §Diagnostic tables required by the ticket. NO
 * outcome/edge simulation here — explicitly forbidden by TICKET-142's own text.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Row {
  symbol: string;
  timestamp: number;
  setupType: string;
  side: string;
  candidateId: string;
  thesisState: 'VALID' | 'WEAK' | 'NONE';
  qualityScore: number | null;
  reasons: string[];
  entryPrice: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  htfContext: string;
  safetyState5m: string;
  isUnique: boolean;
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

  const rows: Row[] = lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    return {
      symbol: c[idx('symbol')],
      timestamp: Number(c[idx('timestamp')]),
      setupType: c[idx('setupType')],
      side: c[idx('side')],
      candidateId: c[idx('candidateId')],
      thesisState: c[idx('thesisState')] as 'VALID' | 'WEAK' | 'NONE',
      qualityScore: numOrNull(c[idx('qualityScore')]),
      reasons: c[idx('reasons')].split(' | '),
      entryPrice: numOrNull(c[idx('entryPrice')]),
      stopLoss: numOrNull(c[idx('stopLoss')]),
      riskReward: numOrNull(c[idx('riskReward')]),
      htfContext: c[idx('htfContext')],
      safetyState5m: c[idx('safetyState5m')],
      isUnique: false,
    };
  });

  // Dedup by candidateId — OB/FVG/SWEEP candidateId bakes in zone/sweep-event identity, so the FIRST
  // chronological occurrence of a given id is the unique candidate; later rows with the same id are
  // duplicates. BOX_BREAKOUT/MOMENTUM_DIRECT candidateId is timestamp-qualified per-candle, so this
  // naturally never dedups them (each row already has a unique id) — matches the ticket's own note
  // that BOX_BREAKOUT needs no extra dedup machinery and MOMENTUM_DIRECT has no zone concept.
  rows.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.candidateId)) continue;
    seen.add(r.candidateId);
    r.isUnique = true;
  }
  return rows;
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

// Numeric values (score=0.0622, age=3, distanceFromEmaInAtr=4.09...) make each reason string unique —
// bucket by category first (strip variable numbers) so "most common" reflects the real failure mode.
function reasonCategory(reason: string): string {
  return reason.replace(/[-+]?\d+(\.\d+)?/g, '#');
}

function mostCommonFailReason(rows: Row[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.thesisState === 'VALID') continue;
    for (const reason of r.reasons) {
      const isFail = /không|chưa|thiếu|N\/A|block/i.test(reason) && !/^Có |^SL\/R hợp lệ|hợp lệ:/i.test(reason);
      if (!isFail) continue;
      const category = reasonCategory(reason);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  let best = 'N/A';
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return bestCount > 0 ? `${best} (${bestCount}x)` : 'N/A';
}

const THESIS_NAMES = ['MomentumThesis', 'PullbackThesis', 'BreakoutThesis', 'ReversalThesis'] as const;
const SETUP_TO_THESIS: Record<string, (typeof THESIS_NAMES)[number]> = {
  MOMENTUM_DIRECT: 'MomentumThesis',
  OB: 'PullbackThesis',
  FVG: 'PullbackThesis',
  BOX_BREAKOUT: 'BreakoutThesis',
  SWEEP: 'ReversalThesis',
};

export async function generateTicket142Report(csvPath: string, outputPath: string, suffix: string): Promise<void> {
  const allRows = readCsv(csvPath);
  const symbols = Array.from(new Set(allRows.map((r) => r.symbol))).sort();
  const htfContexts = Array.from(new Set(allRows.map((r) => r.htfContext))).sort();
  const safetyStates = Array.from(new Set(allRows.map((r) => r.safetyState5m))).sort();

  const dedupApplicable = (setupType: string): boolean => setupType === 'OB' || setupType === 'FVG' || setupType === 'SWEEP';

  const lines: string[] = [
    '# TICKET-142 — Setup-Specific Thesis Diagnostic',
    '',
    `Nguồn CSV: \`${csvPath}\` (${allRows.length} dòng, symbols: ${symbols.join(', ')}). Config suffix: ${suffix}.`,
    'KHÔNG có outcome/edge simulation trong report này (ticket cấm rõ).',
    '',
    '## 1. Theo Thesis (Candidates | VALID | WEAK | NONE)',
    '',
    '| Thesis | Setup(s) | Raw rows | Unique candidates | VALID | WEAK | NONE | Duplicate bị loại |',
    '|---|---|---|---|---|---|---|---|',
  ];

  let grandTotalDup = 0;
  for (const thesisName of THESIS_NAMES) {
    const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([s]) => s);
    const rawRows = allRows.filter((r) => setupTypes.includes(r.setupType));
    const usesDedup = setupTypes.some(dedupApplicable);
    const uniqueRows = usesDedup ? rawRows.filter((r) => r.isUnique) : rawRows;
    const dup = rawRows.length - uniqueRows.length;
    grandTotalDup += dup;
    const valid = uniqueRows.filter((r) => r.thesisState === 'VALID').length;
    const weak = uniqueRows.filter((r) => r.thesisState === 'WEAK').length;
    const none = uniqueRows.filter((r) => r.thesisState === 'NONE').length;
    lines.push(`| ${thesisName} | ${setupTypes.join('/')} | ${rawRows.length} | ${uniqueRows.length} | ${valid} | ${weak} | ${none} | ${dup} |`);
  }
  lines.push('', `Tổng duplicate bị loại (toàn bộ 4 thesis): ${grandTotalDup}.`, '');

  lines.push('## 2. LONG/SHORT theo Thesis (unique candidates)', '', '| Thesis | LONG | SHORT |', '|---|---|---|');
  for (const thesisName of THESIS_NAMES) {
    const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([s]) => s);
    const usesDedup = setupTypes.some(dedupApplicable);
    const rows = allRows.filter((r) => setupTypes.includes(r.setupType) && (!usesDedup || r.isUnique));
    lines.push(`| ${thesisName} | ${rows.filter((r) => r.side === 'LONG').length} | ${rows.filter((r) => r.side === 'SHORT').length} |`);
  }
  lines.push('');

  lines.push('## 3. Theo coin (unique candidates, VALID count)', '', `| Coin | ${THESIS_NAMES.join(' | ')} |`, `|---|${THESIS_NAMES.map(() => '---').join('|')}|`);
  for (const s of symbols) {
    const cells = THESIS_NAMES.map((thesisName) => {
      const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([st]) => st);
      const usesDedup = setupTypes.some(dedupApplicable);
      const rows = allRows.filter((r) => r.symbol === s && setupTypes.includes(r.setupType) && (!usesDedup || r.isUnique));
      return rows.filter((r) => r.thesisState === 'VALID').length;
    });
    lines.push(`| ${s} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 4. Theo HTFContext (unique candidates, VALID count)', '', `| HTFContext | ${THESIS_NAMES.join(' | ')} |`, `|---|${THESIS_NAMES.map(() => '---').join('|')}|`);
  for (const ctx of htfContexts) {
    const cells = THESIS_NAMES.map((thesisName) => {
      const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([st]) => st);
      const usesDedup = setupTypes.some(dedupApplicable);
      const rows = allRows.filter((r) => r.htfContext === ctx && setupTypes.includes(r.setupType) && (!usesDedup || r.isUnique));
      return rows.filter((r) => r.thesisState === 'VALID').length;
    });
    lines.push(`| ${ctx} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 5. Theo SafetyState5m (unique candidates, VALID count)', '', `| SafetyState5m | ${THESIS_NAMES.join(' | ')} |`, `|---|${THESIS_NAMES.map(() => '---').join('|')}|`);
  for (const st of safetyStates) {
    const cells = THESIS_NAMES.map((thesisName) => {
      const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([s]) => s);
      const usesDedup = setupTypes.some(dedupApplicable);
      const rows = allRows.filter((r) => r.safetyState5m === st && setupTypes.includes(r.setupType) && (!usesDedup || r.isUnique));
      return rows.filter((r) => r.thesisState === 'VALID').length;
    });
    lines.push(`| ${st} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 6. Lý do fail phổ biến nhất (theo Thesis, trên unique candidates không VALID)', '', '| Thesis | Lý do fail phổ biến nhất |', '|---|---|');
  for (const thesisName of THESIS_NAMES) {
    const setupTypes = Object.entries(SETUP_TO_THESIS).filter(([, t]) => t === thesisName).map(([s]) => s);
    const usesDedup = setupTypes.some(dedupApplicable);
    const rows = allRows.filter((r) => setupTypes.includes(r.setupType) && (!usesDedup || r.isUnique));
    lines.push(`| ${thesisName} | ${mostCommonFailReason(rows)} |`);
  }
  lines.push('');

  lines.push(
    '## 7. MOMENTUM_DIRECT — mẫu qualityScore thực (không N/A)',
    '',
    'Mẫu 10 dòng đầu tiên có qualityScore != null:',
    '',
    '| symbol | timestamp | side | qualityScore | thesisState |',
    '|---|---|---|---|---|',
  );
  const momentumWithScore = allRows.filter((r) => r.setupType === 'MOMENTUM_DIRECT' && r.qualityScore !== null).slice(0, 10);
  for (const r of momentumWithScore) {
    lines.push(`| ${r.symbol} | ${r.timestamp} | ${r.side} | ${r.qualityScore} | ${r.thesisState} |`);
  }
  lines.push('', `Tổng số dòng MOMENTUM_DIRECT có qualityScore != null: ${allRows.filter((r) => r.setupType === 'MOMENTUM_DIRECT' && r.qualityScore !== null).length} / ${allRows.filter((r) => r.setupType === 'MOMENTUM_DIRECT').length}.`, '');

  writeFileSync(outputPath, lines.join('\n') + '\n');
}

// Allows standalone re-run: `node scripts-dist/ticket142GenerateReport.js <csvPath> <suffix> [outputPath]`
if (process.argv[1] && process.argv[1].endsWith('ticket142GenerateReport.js')) {
  const csvPath = process.argv[2];
  const suffix = process.argv[3] ?? 'baseline';
  const outputPath = process.argv[4] ?? 'data/ticket142-setup-specific-thesis.md';
  if (!csvPath) {
    console.error('Usage: node ticket142GenerateReport.js <csvPath> <suffix> [outputPath]');
    process.exit(1);
  }
  generateTicket142Report(csvPath, outputPath, suffix).then(() => console.log(`→ ${outputPath}`));
}
