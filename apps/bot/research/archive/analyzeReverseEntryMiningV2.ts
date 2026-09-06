import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

// Comprehensive within-group breakdown + filter-candidate report for reverseEntryMiningV2.ts's
// output. Data mining only — not a source-backed edge until re-validated on held-out data.

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS: Group[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'];

interface Rec {
  coin: string;
  direction: 'BULL' | 'BEAR';
  totalGrossR: number;
  totalNetR: number;
  atr15: number;
  compressionBandwidthAtrRatio: number | null;
  breakoutBodyRatio: number;
  atrH1: number | null;
  aboveEmaH1: boolean | null;
  distFromEmaH1Atr: number | null;
  aboveEmaM15: boolean | null;
  distFromEmaM15Atr: number | null;
  momentum5Atr: number | null;
  momentum10Atr: number | null;
  momentum20Atr: number | null;
  consecutiveSameColor: number;
  relativeVolume20: number | null;
  atrExpansionRatio20: number | null;
  distToHigh20Atr: number;
  distToLow20Atr: number;
  hourUtc: number;
  dayOfWeekUtc: number;
  group: Group;
}

const num = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v));
const bool = (v: unknown): boolean | null => (v === undefined || v === null ? null : Boolean(v));

function rowToRec(v: unknown[], group: Group): Rec {
  // index: 1 coin,2 entryTimestamp,3 direction,4 totalGrossR,5 totalNetR,6 atr15,
  // 7 compressionBandwidthAtrRatio,8 breakoutBodyRatio,9 atrH1,10 emaValueH1,11 aboveEmaH1,
  // 12 distFromEmaH1Atr,13 emaValueM15,14 aboveEmaM15,15 distFromEmaM15Atr,16 momentum5Atr,
  // 17 momentum10Atr,18 momentum20Atr,19 consecutiveSameColor,20 relativeVolume20,
  // 21 atrExpansionRatio20,22 distToHigh20Atr,23 distToLow20Atr,24 hourUtc,25 dayOfWeekUtc
  return {
    coin: String(v[1]),
    direction: v[3] as 'BULL' | 'BEAR',
    totalGrossR: Number(v[4]),
    totalNetR: Number(v[5]),
    atr15: Number(v[6]),
    compressionBandwidthAtrRatio: num(v[7]),
    breakoutBodyRatio: Number(v[8]),
    atrH1: num(v[9]),
    aboveEmaH1: bool(v[11]),
    distFromEmaH1Atr: num(v[12]),
    aboveEmaM15: bool(v[14]),
    distFromEmaM15Atr: num(v[15]),
    momentum5Atr: num(v[16]),
    momentum10Atr: num(v[17]),
    momentum20Atr: num(v[18]),
    consecutiveSameColor: Number(v[19]),
    relativeVolume20: num(v[20]),
    atrExpansionRatio20: num(v[21]),
    distToHigh20Atr: Number(v[22]),
    distToLow20Atr: Number(v[23]),
    hourUtc: Number(v[24]),
    dayOfWeekUtc: Number(v[25]),
    group,
  };
}

// Streaming reader: the V2 workbook is ~260MB / 928k rows and OOM-crashed the in-memory reader
// (confirmed) — worksheets are visited in write order (1=WIN_NET_PROFIT, 2=WIN_FEE_EATEN, 3=LOSS,
// 4=SUMMARY, matching reverseEntryMiningV2.ts's addWorksheet calls) since the streaming reader's
// own worksheet.name is just a placeholder ("SheetN"), not the real sheet name.
async function readAllGroups(path: string): Promise<Rec[]> {
  const SHEET_ORDER: readonly (Group | 'SUMMARY')[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS', 'SUMMARY'];
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {});
  const out: Rec[] = [];
  let sheetIndex = 0;
  for await (const worksheetReader of reader) {
    const group = SHEET_ORDER[sheetIndex];
    sheetIndex += 1;
    if (group === undefined || group === 'SUMMARY') continue;
    for await (const rowOrRows of worksheetReader) {
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      for (const row of rows) {
        if (row.number <= 2) continue;
        out.push(rowToRec(row.values as unknown[], group));
      }
    }
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function percentile(sortedValues: readonly number[], p: number): number {
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * sortedValues.length)));
  return sortedValues[idx];
}

const lines: string[] = [];
function w(line = ''): void {
  lines.push(line);
}

function continuousSection(records: readonly Rec[], label: string, extract: (r: Rec) => number | null, thresholds: readonly number[]): void {
  w(`\n## ${label}\n`);
  w('| Group | n | mean | median | p10 | p90 | p99 |');
  w('|---|---|---|---|---|---|---|');
  const byGroup: Record<Group, number[]> = { WIN_NET_PROFIT: [], WIN_FEE_EATEN: [], LOSS: [] };
  for (const r of records) {
    const v = extract(r);
    if (v !== null) byGroup[r.group].push(v);
  }
  for (const group of GROUPS) {
    const values = byGroup[group];
    const sorted = [...values].sort((a, b) => a - b);
    w(
      `| ${group} | ${values.length} | ${mean(values).toFixed(4)} | ${median(values).toFixed(4)} | ` +
        `${percentile(sorted, 0.1).toFixed(4)} | ${percentile(sorted, 0.9).toFixed(4)} | ${percentile(sorted, 0.99).toFixed(4)} |`,
    );
  }

  if (thresholds.length === 0) return;
  w(`\n**Filter candidate: block "${label} >= T"**\n`);
  w('| T | blocked | % of WIN_NET_PROFIT lost | % of bad (FEE_EATEN+LOSS) removed | remaining WIN_NET rate |');
  w('|---|---|---|---|---|');
  const totalWin = records.filter((r) => r.group === 'WIN_NET_PROFIT').length;
  const totalBad = records.filter((r) => r.group !== 'WIN_NET_PROFIT').length;
  for (const t of thresholds) {
    const blocked = records.filter((r) => {
      const v = extract(r);
      return v !== null && v >= t;
    });
    const blockedWin = blocked.filter((r) => r.group === 'WIN_NET_PROFIT').length;
    const blockedBad = blocked.length - blockedWin;
    const remaining = records.length - blocked.length;
    const remainingWinRate = remaining === 0 ? 0 : (100 * (totalWin - blockedWin)) / remaining;
    w(
      `| ${t} | ${blocked.length} | ${((100 * blockedWin) / totalWin).toFixed(2)}% | ` +
        `${((100 * blockedBad) / totalBad).toFixed(2)}% | ${remainingWinRate.toFixed(2)}% |`,
    );
  }
}

function categoricalSection<K extends string>(records: readonly Rec[], label: string, keyFn: (r: Rec) => K): void {
  w(`\n## ${label}\n`);
  w('| Value | WIN_NET_PROFIT % | WIN_FEE_EATEN % | LOSS % | bad-win gap (pp) |');
  w('|---|---|---|---|---|');
  const byGroup: Record<Group, Map<K, number>> = { WIN_NET_PROFIT: new Map(), WIN_FEE_EATEN: new Map(), LOSS: new Map() };
  const totals: Record<Group, number> = { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 };
  for (const r of records) {
    const key = keyFn(r);
    byGroup[r.group].set(key, (byGroup[r.group].get(key) ?? 0) + 1);
    totals[r.group] += 1;
  }
  const allKeys = new Set<K>([...byGroup.WIN_NET_PROFIT.keys(), ...byGroup.WIN_FEE_EATEN.keys(), ...byGroup.LOSS.keys()]);
  const rows = [...allKeys].map((key) => {
    const pWin = (byGroup.WIN_NET_PROFIT.get(key) ?? 0) / totals.WIN_NET_PROFIT;
    const pFee = (byGroup.WIN_FEE_EATEN.get(key) ?? 0) / totals.WIN_FEE_EATEN;
    const pLoss = (byGroup.LOSS.get(key) ?? 0) / totals.LOSS;
    const pBad = (pFee * totals.WIN_FEE_EATEN + pLoss * totals.LOSS) / (totals.WIN_FEE_EATEN + totals.LOSS);
    return { key, pWin, pFee, pLoss, gap: pBad - pWin };
  });
  rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  for (const row of rows) {
    w(`| ${row.key} | ${(100 * row.pWin).toFixed(2)}% | ${(100 * row.pFee).toFixed(2)}% | ${(100 * row.pLoss).toFixed(2)}% | ${(100 * row.gap).toFixed(2)} |`);
  }
}

async function main(): Promise<void> {
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const xlsxPath = resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining-v2.xlsx');
  console.info('Loading V2 sheets (streaming)...');
  const all = await readAllGroups(xlsxPath);
  console.info(`Loaded ${all.length} records`);

  w('# TICKET-043 v2 — Reverse Entry Mining: Extended Indicator Analysis');
  w();
  w('**CANH BAO / WARNING:** Du lieu khai thac tham do (data mining) — khong phai ket luan co edge');
  w('that. Entry duoc mo phong o MOI nen M15 (khong qua bat ky bo loc D1-D8 nao), voi stop co dinh');
  w('1xATR15 va chot 50%@1R + 50%@2R (trailing 1.5xATR14) qua positionManagementV2. Ket qua duoi day');
  w('can duoc kiem dinh lai tren du lieu khac (held-out) truoc khi tin va dua vao san xuat.');
  w();
  w(`Generated: ${new Date().toISOString()}`);
  w();
  w('## Population');
  w();
  w(`- Total classified entries: ${all.length}`);
  for (const group of GROUPS) {
    const n = all.filter((r) => r.group === group).length;
    w(`- ${group}: ${n} (${((100 * n) / all.length).toFixed(2)}%)`);
  }

  w('\n## How to read this report');
  w();
  w('Each section compares the three outcome groups on one indicator. "bad-win gap" is the');
  w('percentage-point difference between the combined WIN_FEE_EATEN+LOSS population and the');
  w('WIN_NET_PROFIT population on that value/bucket — the bigger the gap, the more that value');
  w('discriminates outcomes. The filter-candidate tables show what happens if you refuse to enter');
  w('whenever the indicator is at or above a threshold: how much of the good population you lose');
  w('vs. how much of the bad population you remove. A useful filter removes much more bad than good.');

  continuousSection(all, 'compressionBandwidthAtrRatio (D5 bandwidth/ATR14, lower = tighter range)', (r) => r.compressionBandwidthAtrRatio, [3, 4, 5, 6, 8]);
  continuousSection(all, 'breakoutBodyRatio (D7 |close-open|/range)', (r) => r.breakoutBodyRatio, [0.7, 0.8, 0.85, 0.9, 0.95]);
  continuousSection(all, 'atrH1 / atr15 (hourly vs 15m volatility ratio)', (r) => (r.atrH1 === null ? null : r.atrH1 / r.atr15), [2, 2.5, 3, 3.5, 4, 5]);
  continuousSection(all, 'distFromEmaH1Atr ((close-EMA200/H1)/atr15)', (r) => r.distFromEmaH1Atr, [1, 2, 3, 4, -1, -2, -3, -4]);
  continuousSection(all, 'distFromEmaM15Atr ((close-EMA50/M15)/atr15)', (r) => r.distFromEmaM15Atr, [1, 2, 3, -1, -2, -3]);
  continuousSection(all, 'momentum5Atr ((close-close[-5])/atr15)', (r) => r.momentum5Atr, [1, 2, -1, -2]);
  continuousSection(all, 'momentum10Atr ((close-close[-10])/atr15)', (r) => r.momentum10Atr, [1, 2, -1, -2]);
  continuousSection(all, 'momentum20Atr ((close-close[-20])/atr15)', (r) => r.momentum20Atr, [1, 2, 3, -1, -2, -3]);
  continuousSection(all, 'relativeVolume20 (this candle vs 20-bar avg volume)', (r) => r.relativeVolume20, [1.5, 2, 3, 4]);
  continuousSection(all, 'atrExpansionRatio20 (atr15 now vs 20 bars ago; >1 expanding)', (r) => r.atrExpansionRatio20, [1.2, 1.5, 2, 0.5, 0.7]);
  continuousSection(all, 'distToHigh20Atr ((20bar-high - close)/atr15; low = near top of range)', (r) => r.distToHigh20Atr, [0.2, 0.5, 3, 4]);
  continuousSection(all, 'distToLow20Atr ((close - 20bar-low)/atr15; low = near bottom of range)', (r) => r.distToLow20Atr, [0.2, 0.5, 3, 4]);

  categoricalSection(all, 'Direction', (r) => r.direction);
  categoricalSection(all, 'Coin', (r) => r.coin);
  categoricalSection(all, 'H1-EMA200 alignment (BULL above / BEAR below)', (r) => {
    if (r.aboveEmaH1 === null) return 'null';
    return (r.direction === 'BULL') === r.aboveEmaH1 ? 'ALIGNED' : 'COUNTER';
  });
  categoricalSection(all, 'M15-EMA50 alignment (BULL above / BEAR below)', (r) => {
    if (r.aboveEmaM15 === null) return 'null';
    return (r.direction === 'BULL') === r.aboveEmaM15 ? 'ALIGNED' : 'COUNTER';
  });
  categoricalSection(all, 'Consecutive same-color candle streak (bucketed)', (r) => {
    const s = r.consecutiveSameColor;
    if (s <= -5) return '<=-5 (long down streak)';
    if (s <= -1) return '[-4,-1] down streak';
    if (s === 0) return '0 (doji)';
    if (s <= 4) return '[1,4] up streak';
    return '>=5 (long up streak)';
  });
  categoricalSection(all, 'Hour of day (UTC)', (r) => String(r.hourUtc).padStart(2, '0'));
  categoricalSection(all, 'Day of week (UTC, 0=Sun)', (r) => String(r.dayOfWeekUtc));

  const reportPath = resolve(reportsDirectory, 'nukida-ticket043-v2-analysis.md');
  await writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
  console.info(`Report: ${reportPath}`);
}

await main();
