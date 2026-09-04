import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

// Follow-up to analyzeReverseEntryMining.ts: within-group distributions + filter-candidate
// precision/recall. Data mining only — not a source-backed edge until re-validated on held-out data.

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
  group: Group;
}

async function readGroup(path: string, sheetName: string, group: Group): Promise<Rec[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${path}`);
  const out: Rec[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = row.values as unknown[];
    const [, coin, , direction, totalGrossR, totalNetR, atr15, compressionBandwidthAtrRatio, breakoutBodyRatio, atrH1, , aboveEmaH1] = v;
    out.push({
      coin: String(coin),
      direction: direction as 'BULL' | 'BEAR',
      totalGrossR: Number(totalGrossR),
      totalNetR: Number(totalNetR),
      atr15: Number(atr15),
      compressionBandwidthAtrRatio: compressionBandwidthAtrRatio === undefined || compressionBandwidthAtrRatio === null ? null : Number(compressionBandwidthAtrRatio),
      breakoutBodyRatio: Number(breakoutBodyRatio),
      atrH1: atrH1 === undefined || atrH1 === null ? null : Number(atrH1),
      aboveEmaH1: aboveEmaH1 === undefined || aboveEmaH1 === null ? null : Boolean(aboveEmaH1),
      group,
    });
  });
  return out;
}

function atrRatio(r: Rec): number | null {
  if (r.atrH1 === null || !(r.atr15 > 0)) return null;
  return r.atrH1 / r.atr15;
}

function trendAligned(r: Rec): boolean | null {
  if (r.aboveEmaH1 === null) return null;
  return (r.direction === 'BULL') === r.aboveEmaH1;
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

// Within-group scalar summary for a continuous, mostly-defined feature.
function summarizeContinuous(records: readonly Rec[], label: string, extract: (r: Rec) => number | null): void {
  console.info(`\n=== ${label}: within-group summary ===`);
  for (const group of GROUPS) {
    const values = records.filter((r) => r.group === group).map(extract).filter((v): v is number => v !== null);
    const sorted = [...values].sort((a, b) => a - b);
    console.info(
      `${group.padEnd(16)} n=${String(values.length).padStart(7)} mean=${mean(values).toFixed(4).padStart(9)} ` +
        `median=${median(values).toFixed(4).padStart(9)} p10=${percentile(sorted, 0.1).toFixed(4).padStart(9)} ` +
        `p90=${percentile(sorted, 0.9).toFixed(4).padStart(9)} p99=${percentile(sorted, 0.99).toFixed(4).padStart(9)}`,
    );
  }
}

// Within-group % distribution across buckets, plus the gap between WIN_NET_PROFIT and the "bad"
// (LOSS + WIN_FEE_EATEN) population — this is the signature-matching view the filter design needs.
function withinGroupDistribution<K extends string>(records: readonly Rec[], label: string, keyFn: (r: Rec) => K): void {
  console.info(`\n=== ${label}: within-group distribution (% of that group's own rows) ===`);
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
    return { key, pWin, pFee, pLoss, pBad, gap: pBad - pWin };
  });
  rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  for (const row of rows) {
    console.info(
      `${String(row.key).padEnd(20)} WIN_NET=${(100 * row.pWin).toFixed(2).padStart(6)}% ` +
        `FEE_EATEN=${(100 * row.pFee).toFixed(2).padStart(6)}% LOSS=${(100 * row.pLoss).toFixed(2).padStart(6)}% ` +
        `(bad-win gap=${(100 * row.gap).toFixed(2).padStart(6)}pp)`,
    );
  }
}

// Filter-candidate precision/recall: "block entries where feature >= threshold" — how much of the
// bad population does it remove, how much win population does it cost, what's the resulting win
// rate among what's left.
function filterCandidates(records: readonly Rec[], label: string, extract: (r: Rec) => number | null, thresholds: readonly number[]): void {
  console.info(`\n=== Filter candidate: block "${label} >= T" ===`);
  const totalWin = records.filter((r) => r.group === 'WIN_NET_PROFIT').length;
  const totalFee = records.filter((r) => r.group === 'WIN_FEE_EATEN').length;
  const totalLoss = records.filter((r) => r.group === 'LOSS').length;
  const totalBad = totalFee + totalLoss;
  for (const t of thresholds) {
    const blocked = records.filter((r) => {
      const v = extract(r);
      return v !== null && v >= t;
    });
    const blockedWin = blocked.filter((r) => r.group === 'WIN_NET_PROFIT').length;
    const blockedFee = blocked.filter((r) => r.group === 'WIN_FEE_EATEN').length;
    const blockedLoss = blocked.filter((r) => r.group === 'LOSS').length;
    const blockedBad = blockedFee + blockedLoss;
    const remaining = records.length - blocked.length;
    const remainingWin = totalWin - blockedWin;
    const remainingWinRate = remaining === 0 ? 0 : (100 * remainingWin) / remaining;
    console.info(
      `T=${String(t).padStart(5)}  blocked=${String(blocked.length).padStart(7)} ` +
        `(costs ${((100 * blockedWin) / totalWin).toFixed(2).padStart(5)}% of WIN_NET_PROFIT, ` +
        `removes ${((100 * blockedBad) / totalBad).toFixed(2).padStart(5)}% of bad [FEE_EATEN+LOSS]) ` +
        `-> remaining WIN_NET rate=${remainingWinRate.toFixed(2)}%`,
    );
  }
}

async function main(): Promise<void> {
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  console.info('Loading sheets...');
  const [winNetProfit, feeEaten, loss] = await Promise.all([
    readGroup(resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining.xlsx'), 'WIN_NET_PROFIT', 'WIN_NET_PROFIT'),
    readGroup(resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx'), 'WIN_FEE_EATEN', 'WIN_FEE_EATEN'),
    readGroup(resolve(reportsDirectory, 'nukida-ticket043-reverse-entry-mining -loss.xlsx'), 'LOSS', 'LOSS'),
  ]);
  const all = [...winNetProfit, ...feeEaten, ...loss];
  console.info(`Loaded ${all.length} records`);

  summarizeContinuous(all, 'ATR-H1 / ATR-M15 ratio', atrRatio);
  summarizeContinuous(all, 'compressionBandwidthAtrRatio', (r) => r.compressionBandwidthAtrRatio);
  summarizeContinuous(all, 'breakoutBodyRatio', (r) => r.breakoutBodyRatio);

  withinGroupDistribution(all, 'Trend alignment', (r) => {
    const a = trendAligned(r);
    return a === null ? 'null' : a ? 'ALIGNED' : 'COUNTER';
  });
  withinGroupDistribution(all, 'Direction', (r) => r.direction);
  withinGroupDistribution(all, 'Coin', (r) => r.coin);
  withinGroupDistribution(all, 'ATR-H1/M15 ratio (fine)', (r) => {
    const v = atrRatio(r);
    if (v === null) return 'null';
    if (v < 1.5) return '00_[0,1.5)';
    if (v < 2.0) return '01_[1.5,2.0)';
    if (v < 2.5) return '02_[2.0,2.5)';
    if (v < 3.0) return '03_[2.5,3.0)';
    if (v < 3.5) return '04_[3.0,3.5)';
    if (v < 4.0) return '05_[3.5,4.0)';
    if (v < 5.0) return '06_[4.0,5.0)';
    return '07_[5.0,inf)';
  });

  filterCandidates(all, 'atrH1/atr15', atrRatio, [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0]);
  filterCandidates(all, 'compressionBandwidthAtrRatio', (r) => r.compressionBandwidthAtrRatio, [3.0, 4.0, 5.0, 6.0, 8.0]);
  filterCandidates(all, 'breakoutBodyRatio', (r) => r.breakoutBodyRatio, [0.7, 0.8, 0.85, 0.9, 0.95]);

  // Compound candidate: does stacking the two weaker single-factor signals (counter-trend +
  // elevated atrH1/atr15) sharpen the filter beyond either alone?
  console.info('\n=== Compound filter candidate: atrH1/atr15 >= 3 AND counter-trend ===');
  const compoundBlocked = all.filter((r) => {
    const ratio = atrRatio(r);
    return ratio !== null && ratio >= 3 && trendAligned(r) === false;
  });
  const totalWin = all.filter((r) => r.group === 'WIN_NET_PROFIT').length;
  const totalBad = all.filter((r) => r.group !== 'WIN_NET_PROFIT').length;
  const blockedWin = compoundBlocked.filter((r) => r.group === 'WIN_NET_PROFIT').length;
  const blockedBad = compoundBlocked.filter((r) => r.group !== 'WIN_NET_PROFIT').length;
  console.info(
    `blocked=${compoundBlocked.length} costs ${((100 * blockedWin) / totalWin).toFixed(2)}% of WIN_NET_PROFIT, ` +
      `removes ${((100 * blockedBad) / totalBad).toFixed(2)}% of bad`,
  );
}

await main();
