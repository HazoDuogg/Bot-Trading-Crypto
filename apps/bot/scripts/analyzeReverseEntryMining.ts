import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

// Exploratory analysis of TICKET-043's reverse-entry-mining output. Data mining only — not a
// source-backed edge until re-validated on held-out data (same caveat as the mining ticket).

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';

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

interface Bucket {
  n: number;
  groupCounts: Record<Group, number>;
  sumGrossR: number;
  sumNetR: number;
}

function newBucket(): Bucket {
  return { n: 0, groupCounts: { WIN_NET_PROFIT: 0, WIN_FEE_EATEN: 0, LOSS: 0 }, sumGrossR: 0, sumNetR: 0 };
}

function accumulate(bucket: Bucket, rec: Rec): void {
  bucket.n += 1;
  bucket.groupCounts[rec.group] += 1;
  bucket.sumGrossR += rec.totalGrossR;
  bucket.sumNetR += rec.totalNetR;
}

function fmtBucket(label: string, b: Bucket, baseline: Bucket): string {
  const pct = (x: number) => ((100 * x) / b.n).toFixed(2);
  const avgNet = (b.sumNetR / b.n).toFixed(4);
  const avgGross = (b.sumGrossR / b.n).toFixed(4);
  const baseWinPct = (100 * baseline.groupCounts.WIN_NET_PROFIT) / baseline.n;
  const thisWinPct = (100 * b.groupCounts.WIN_NET_PROFIT) / b.n;
  const delta = (thisWinPct - baseWinPct).toFixed(2);
  return (
    `${label.padEnd(28)} n=${String(b.n).padStart(7)} ` +
    `WIN_NET=${pct(b.groupCounts.WIN_NET_PROFIT).padStart(6)}% (Δ${delta.padStart(6)}pp) ` +
    `FEE_EATEN=${pct(b.groupCounts.WIN_FEE_EATEN).padStart(6)}% LOSS=${pct(b.groupCounts.LOSS).padStart(6)}% ` +
    `avgNetR=${avgNet.padStart(8)} avgGrossR=${avgGross.padStart(8)}`
  );
}

function bucketBy<K extends string>(records: readonly Rec[], keyFn: (r: Rec) => K): Map<K, Bucket> {
  const map = new Map<K, Bucket>();
  for (const rec of records) {
    const key = keyFn(rec);
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = newBucket();
      map.set(key, bucket);
    }
    accumulate(bucket, rec);
  }
  return map;
}

function printBreakdown(title: string, records: readonly Rec[], keyFn: (r: Rec) => string, minN = 1000): void {
  const overall = newBucket();
  for (const rec of records) accumulate(overall, rec);
  const map = bucketBy(records, keyFn);
  console.info(`\n--- ${title} (baseline WIN_NET=${((100 * overall.groupCounts.WIN_NET_PROFIT) / overall.n).toFixed(2)}%, n=${overall.n}) ---`);
  const entries = [...map.entries()].filter(([, b]) => b.n >= minN);
  entries.sort((a, b) => b[1].groupCounts.WIN_NET_PROFIT / b[1].n - a[1].groupCounts.WIN_NET_PROFIT / a[1].n);
  for (const [key, bucket] of entries) console.info(fmtBucket(key, bucket, overall));
}

function compressionBucket(ratio: number | null): string {
  if (ratio === null) return 'null';
  if (ratio < 1.0) return '00_[0,1.0)';
  if (ratio < 1.5) return '01_[1.0,1.5)';
  if (ratio < 2.0) return '02_[1.5,2.0)';
  if (ratio < 2.5) return '03_[2.0,2.5)';
  if (ratio < 3.0) return '04_[2.5,3.0)';
  if (ratio < 4.0) return '05_[3.0,4.0)';
  if (ratio < 6.0) return '06_[4.0,6.0)';
  if (ratio < 10.0) return '07_[6.0,10.0)';
  return '08_[10.0,inf)';
}

function breakoutBucket(ratio: number): string {
  const bin = Math.min(9, Math.floor(ratio * 10));
  return `${String(bin).padStart(2, '0')}_[${(bin / 10).toFixed(1)},${((bin + 1) / 10).toFixed(1)})`;
}

function atrRatioBucket(atr15: number, atrH1: number | null): string {
  if (atrH1 === null || !(atr15 > 0)) return 'null';
  const ratio = atrH1 / atr15;
  if (ratio < 2) return '00_[0,2)';
  if (ratio < 3) return '01_[2,3)';
  if (ratio < 4) return '02_[3,4)';
  if (ratio < 5) return '03_[4,5)';
  if (ratio < 6) return '04_[5,6)';
  if (ratio < 8) return '05_[6,8)';
  if (ratio < 12) return '06_[8,12)';
  return '07_[12,inf)';
}

function trendAligned(rec: Rec): string {
  if (rec.aboveEmaH1 === null) return 'null';
  const aligned = (rec.direction === 'BULL') === rec.aboveEmaH1;
  return aligned ? 'ALIGNED_with_H1_trend' : 'COUNTER_H1_trend';
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
  console.info(`Loaded ${all.length} records (WIN_NET_PROFIT=${winNetProfit.length}, WIN_FEE_EATEN=${feeEaten.length}, LOSS=${loss.length})`);

  printBreakdown('By coin', all, (r) => r.coin);
  printBreakdown('By direction', all, (r) => r.direction);
  printBreakdown('By H1-trend alignment', all, trendAligned);
  printBreakdown('By compression bandwidth/ATR ratio', all, (r) => compressionBucket(r.compressionBandwidthAtrRatio));
  printBreakdown('By breakout body ratio', all, (r) => breakoutBucket(r.breakoutBodyRatio));
  printBreakdown('By ATR-H1 / ATR-M15 ratio', all, (r) => atrRatioBucket(r.atr15, r.atrH1));

  // 2D combos on the dimensions above with the widest apparent single-factor spread.
  printBreakdown('Compression x Trend-alignment', all, (r) => `${compressionBucket(r.compressionBandwidthAtrRatio)} | ${trendAligned(r)}`, 2000);
  printBreakdown('Breakout x Trend-alignment', all, (r) => `${breakoutBucket(r.breakoutBodyRatio)} | ${trendAligned(r)}`, 2000);
  printBreakdown('Compression x Breakout (coarse)', all, (r) => {
    const c = r.compressionBandwidthAtrRatio;
    const cCoarse = c === null ? 'null' : c < 1.5 ? 'compressed<1.5' : c < 3.0 ? 'mid[1.5,3.0)' : 'wide>=3.0';
    const b = r.breakoutBodyRatio;
    const bCoarse = b < 0.3 ? 'weakBody<0.3' : b < 0.55 ? 'mid[0.3,0.55)' : b < 0.7 ? 'strongBody[0.55,0.7)_D7range' : 'veryStrong>=0.7';
    return `${cCoarse} | ${bCoarse}`;
  }, 2000);
  printBreakdown('Compression x ATR-H1/M15 ratio', all, (r) => `${compressionBucket(r.compressionBandwidthAtrRatio)} | ${atrRatioBucket(r.atr15, r.atrH1)}`, 2000);
  printBreakdown('Coin x Direction', all, (r) => `${r.coin} | ${r.direction}`, 2000);
}

await main();
