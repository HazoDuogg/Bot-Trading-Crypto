import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Candle } from '../src/noTradeZone/types.js';

// TICKET-04X-F: cross-coin relative/correlation features for TICKET-043's reverse-entry mining
// population. Every feature uses only candles with openTime < entryTimestamp, across ALL 5 coins
// (not just the coin being evaluated) — including looking up BTCUSDT/basket-coin candles at the
// exact same historical timestamp as the entry's own coin.
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'] as const;
const BTC = 'BTCUSDT';
// Same N=20 as TICKET-04X-C — no new tunable introduced.
const N = 20;

type Group = 'WIN_NET_PROFIT' | 'WIN_FEE_EATEN' | 'LOSS';
const GROUPS: readonly Group[] = ['WIN_NET_PROFIT', 'WIN_FEE_EATEN', 'LOSS'];
const REPORTS_FILES: Array<{ file: string; sheet: Group }> = [
  { file: 'nukida-ticket043-reverse-entry-mining.xlsx', sheet: 'WIN_NET_PROFIT' },
  { file: 'nukida-ticket043-reverse-entry-mining -win-fee-eaten .xlsx', sheet: 'WIN_FEE_EATEN' },
  { file: 'nukida-ticket043-reverse-entry-mining -loss.xlsx', sheet: 'LOSS' },
];
const OLD_HEADER = [
  'coin',
  'entryTimestamp',
  'direction',
  'totalGrossR',
  'totalNetR',
  'atr15',
  'compressionBandwidthAtrRatio',
  'breakoutBodyRatio',
  'atrH1',
  'emaValueH1',
  'aboveEmaH1',
];
const NEW_COLUMNS = ['relReturnVsBtc_N', 'relReturnVsBasket_N', 'zscoreReturnVsBasket_N', 'rollingCorrWithBtc_N'] as const;
type NewColumn = (typeof NEW_COLUMNS)[number];

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// Population std (divides by n, not n-1) — the ticket's "độ lệch chuẩn của rổ" is a descriptive
// statistic over the small, fully-known set of basket members at this instant, not a sample
// estimate of a larger population.
function populationStd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  const meanA = mean(a);
  const meanB = mean(b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let k = 0; k < n; k += 1) {
    const da = a[k] - meanA;
    const db = b[k] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

interface CoinSeries {
  candles: Candle[];
  closes: number[];
  logReturns: (number | null)[]; // logReturns[k] uses closes[k],closes[k-1]; null at k=0
  ownReturnN: (number | null)[]; // ownReturnN[i] uses closes[i-1] and closes[i-1-N]
  openTimeToIndex: Map<number, number>;
}

function buildCoinSeries(candles: Candle[]): CoinSeries {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const logReturns: (number | null)[] = new Array(n).fill(null);
  for (let k = 1; k < n; k += 1) logReturns[k] = Math.log(closes[k] / closes[k - 1]);
  const ownReturnN: (number | null)[] = new Array(n).fill(null);
  for (let i = N + 1; i < n; i += 1) {
    ownReturnN[i] = (closes[i - 1] - closes[i - 1 - N]) / closes[i - 1 - N];
  }
  const openTimeToIndex = new Map(candles.map((c, idx) => [c.openTime, idx]));
  return { candles, closes, logReturns, ownReturnN, openTimeToIndex };
}

interface FeatureResult {
  relReturnVsBtc_N: number | null;
  relReturnVsBasket_N: number | null;
  zscoreReturnVsBasket_N: number | null;
  rollingCorrWithBtc_N: number | null;
}

function computeFeatures(coin: string, entryTimestamp: number, seriesByCoin: Map<string, CoinSeries>): FeatureResult | 'MISSING_SELF_INDEX' {
  const self = seriesByCoin.get(coin)!;
  const idxSelf = self.openTimeToIndex.get(entryTimestamp);
  if (idxSelf === undefined) return 'MISSING_SELF_INDEX';

  const ownReturn = self.ownReturnN[idxSelf];

  const btc = seriesByCoin.get(BTC)!;
  const idxBtc = btc.openTimeToIndex.get(entryTimestamp);
  const btcReturn = idxBtc === undefined ? null : btc.ownReturnN[idxBtc];
  const relReturnVsBtc_N = ownReturn !== null && btcReturn !== null ? ownReturn - btcReturn : null;

  // Basket = every coin other than `coin`, restricted to those with a candle at this exact
  // timestamp AND a computable own N-candle return there (no inferred/defaulted members).
  const basketReturns: number[] = [];
  for (const other of COINS) {
    if (other === coin) continue;
    const s = seriesByCoin.get(other)!;
    const idx = s.openTimeToIndex.get(entryTimestamp);
    if (idx === undefined) continue;
    const r = s.ownReturnN[idx];
    if (r !== null) basketReturns.push(r);
  }
  const basketMean = basketReturns.length > 0 ? mean(basketReturns) : null;
  const relReturnVsBasket_N = ownReturn !== null && basketMean !== null ? ownReturn - basketMean : null;
  const basketStd = basketReturns.length > 0 ? populationStd(basketReturns) : null;
  const zscoreReturnVsBasket_N =
    relReturnVsBasket_N !== null && basketStd !== null && basketStd > 0 ? relReturnVsBasket_N / basketStd : null;

  let rollingCorrWithBtc_N: number | null = null;
  if (idxBtc !== undefined && idxSelf >= N + 1 && idxBtc >= N + 1) {
    const selfSeries = self.logReturns.slice(idxSelf - N, idxSelf) as number[];
    const btcSeries = btc.logReturns.slice(idxBtc - N, idxBtc) as number[];
    rollingCorrWithBtc_N = pearsonCorrelation(selfSeries, btcSeries);
  }

  return { relReturnVsBtc_N, relReturnVsBasket_N, zscoreReturnVsBasket_N, rollingCorrWithBtc_N };
}

function printVerification(coin: string, entryTimestamp: number, seriesByCoin: Map<string, CoinSeries>, result: FeatureResult | 'MISSING_SELF_INDEX'): void {
  const fmt = (c: Candle) => `openTime=${c.openTime} (${new Date(c.openTime).toISOString()}) C=${c.close}`;
  console.log(`\n=== VERIFY coin=${coin} entryTimestamp=${entryTimestamp} (${new Date(entryTimestamp).toISOString()}) ===`);
  console.log(`result = ${JSON.stringify(result)}`);
  if (result === 'MISSING_SELF_INDEX') return;

  const self = seriesByCoin.get(coin)!;
  const idxSelf = self.openTimeToIndex.get(entryTimestamp)!;
  console.log(`-- ${coin} own N=${N} return: candles[${idxSelf - 1 - N}] and [${idxSelf - 1}] (both < entry openTime=${entryTimestamp})`);
  if (idxSelf - 1 - N >= 0) {
    console.log(`   [${idxSelf - 1 - N}] ${fmt(self.candles[idxSelf - 1 - N])}`);
    console.log(`   [${idxSelf - 1}] ${fmt(self.candles[idxSelf - 1])}`);
    console.log(`   ownReturn=${self.ownReturnN[idxSelf]}`);
  } else {
    console.log('   insufficient history -> null');
  }

  const btc = seriesByCoin.get(BTC)!;
  const idxBtc = btc.openTimeToIndex.get(entryTimestamp);
  console.log(`-- BTCUSDT at the same timestamp: idx=${idxBtc}`);
  if (idxBtc !== undefined && idxBtc - 1 - N >= 0) {
    console.log(`   [${idxBtc - 1 - N}] ${fmt(btc.candles[idxBtc - 1 - N])}`);
    console.log(`   [${idxBtc - 1}] ${fmt(btc.candles[idxBtc - 1])}`);
    console.log(`   btcReturn=${btc.ownReturnN[idxBtc]}`);
  }

  console.log(`-- basket (all coins except ${coin}) own returns at this timestamp:`);
  for (const other of COINS) {
    if (other === coin) continue;
    const s = seriesByCoin.get(other)!;
    const idx = s.openTimeToIndex.get(entryTimestamp);
    if (idx === undefined) {
      console.log(`   ${other}: no candle at this timestamp (not listed yet) -> excluded`);
      continue;
    }
    console.log(`   ${other}: idx=${idx} openTime=${s.candles[idx].openTime} ownReturn=${s.ownReturnN[idx]}`);
  }

  if (idxSelf >= N + 1 && idxBtc !== undefined && idxBtc >= N + 1) {
    console.log(`-- rollingCorrWithBtc_N: ${coin} logReturns[${idxSelf - N}..${idxSelf - 1}] vs BTC logReturns[${idxBtc - N}..${idxBtc - 1}]`);
    console.log(`   ${coin} window: ${self.logReturns.slice(idxSelf - N, idxSelf).join(', ')}`);
    console.log(`   BTC window:     ${btc.logReturns.slice(idxBtc - N, idxBtc).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../reports/', import.meta.url));
  const startedAt = Date.now();

  console.info('Loading all 5 coins and building return/correlation series...');
  const seriesByCoin = new Map<string, CoinSeries>();
  for (const coin of COINS) {
    const candles = await loadCsv(resolve(dataDirectory, `${coin}_15m_3y.csv`));
    seriesByCoin.set(coin, buildCoinSeries(candles));
    console.info(`  ${coin}: ${candles.length} candles`);
  }

  console.info('\n########## MANUAL NO-LOOKAHEAD VERIFICATION (5 random rows) ##########');
  for (let k = 0; k < 5; k += 1) {
    const coin = COINS[Math.floor(Math.random() * COINS.length)];
    const s = seriesByCoin.get(coin)!;
    const idx = N + 5 + Math.floor(Math.random() * (s.candles.length - N - 10));
    const entryTimestamp = s.candles[idx].openTime;
    printVerification(coin, entryTimestamp, seriesByCoin, computeFeatures(coin, entryTimestamp, seriesByCoin));
  }

  const outputPath = resolve(reportsDirectory, 'nukida-ticket04x-f-cross-coin-relative-features.xlsx');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: false });

  const nullCountsByCoin = new Map<string, Record<NewColumn, number>>(
    COINS.map((c) => [c, Object.fromEntries(NEW_COLUMNS.map((f) => [f, 0])) as Record<NewColumn, number>]),
  );
  const totalRowsByCoin = new Map<string, number>(COINS.map((c) => [c, 0]));
  const btcRelReturnNonZero: number[] = [];
  const btcCorrNotOne: (number | null)[] = [];

  for (const { file, sheet: sheetName } of REPORTS_FILES) {
    console.info(`\nReading ${file} [${sheetName}]...`);
    const source = new ExcelJS.Workbook();
    await source.xlsx.readFile(resolve(reportsDirectory, file));
    const sourceSheet = source.getWorksheet(sheetName);
    if (sourceSheet === undefined) throw new Error(`Missing sheet ${sheetName} in ${file}`);

    const outSheet = workbook.addWorksheet(sheetName);
    outSheet.addRow([...OLD_HEADER, ...NEW_COLUMNS]).commit();

    let written = 0;
    sourceSheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;
      const v = row.values as unknown[];
      const coin = String(v[1]);
      const entryTimestamp = Number(v[2]);
      const result = computeFeatures(coin, entryTimestamp, seriesByCoin);
      if (result === 'MISSING_SELF_INDEX') {
        throw new Error(`entryTimestamp ${entryTimestamp} not found in ${coin}'s own CSV — key join failed`);
      }

      totalRowsByCoin.set(coin, totalRowsByCoin.get(coin)! + 1);
      const counts = nullCountsByCoin.get(coin)!;
      for (const f of NEW_COLUMNS) if (result[f] === null) counts[f] += 1;

      if (coin === BTC) {
        if (result.relReturnVsBtc_N !== null && result.relReturnVsBtc_N !== 0) btcRelReturnNonZero.push(result.relReturnVsBtc_N);
        if (result.rollingCorrWithBtc_N !== null && result.rollingCorrWithBtc_N !== 1) btcCorrNotOne.push(result.rollingCorrWithBtc_N);
      }

      const excelRow = outSheet.addRow([
        ...OLD_HEADER.map((_, i) => v[i + 1]),
        result.relReturnVsBtc_N,
        result.relReturnVsBasket_N,
        result.zscoreReturnVsBasket_N,
        result.rollingCorrWithBtc_N,
      ]);
      written += 1;
      if (written % 500 === 0) excelRow.commit();
    });
    outSheet.commit();
    console.info(`  wrote ${written} rows, elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)}min`);
  }

  await workbook.commit();

  console.info('\n########## NULL RATE PER FEATURE, BY COIN ##########');
  for (const coin of COINS) {
    const total = totalRowsByCoin.get(coin)!;
    console.info(`${coin} (n=${total}):`);
    const counts = nullCountsByCoin.get(coin)!;
    for (const f of NEW_COLUMNS) {
      console.info(`   ${f}: ${counts[f]}/${total} null (${((100 * counts[f]) / total).toFixed(4)}%)`);
    }
  }

  console.info('\n########## BTCUSDT SELF-CONSISTENCY CHECK ##########');
  console.info(`relReturnVsBtc_N !== 0 count (excluding nulls): ${btcRelReturnNonZero.length} (expected 0)`);
  if (btcRelReturnNonZero.length > 0) console.info(`  sample non-zero values: ${btcRelReturnNonZero.slice(0, 10).join(', ')}`);
  console.info(`rollingCorrWithBtc_N !== 1 count (excluding nulls): ${btcCorrNotOne.length} (expected 0)`);
  if (btcCorrNotOne.length > 0) console.info(`  sample non-1 values: ${btcCorrNotOne.slice(0, 10).join(', ')}`);

  console.info(`\nOutput: ${outputPath}`);
  console.info(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

await main();
