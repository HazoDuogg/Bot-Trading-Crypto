import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAdxSeries } from '../../core/structure/regimeFilter.js';
import { computeMeanReversionSignals } from '../../core/entry/meanReversionSignal.js';

// Follow-up to TICKET-04X-S: adds zScore/adx to each TAKE_PROFIT/STOP_LOSS trade record in the
// existing backtest output, keyed by the trade's own m5Index. Reuses computeAdxSeries/
// computeMeanReversionSignals exactly as the backtest run itself did -- no new math, this script
// only re-derives the same intermediate values those functions already computed internally and
// captures them (computeMeanReversionSignals returns zScore directly; adx itself is only an
// internal intermediate there, so the closed-M15-ADX-as-of-each-M5-close walk is replicated here
// verbatim from meanReversionSignal.ts's own loop -- same algorithm, not a different one).
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

// Verbatim copy of the closed-M15-ADX-as-of-each-M5-close mapping loop from
// core/entry/meanReversionSignal.ts's computeMeanReversionSignals -- that function computes this
// same value internally but only returns the derived `regime`, never the raw adx number.
function adxAtEachM5Close(m15Candles: readonly Candle[], m5Candles: readonly Candle[]): Array<number | null> {
  const adxSeries = computeAdxSeries(m15Candles);
  const result: Array<number | null> = new Array(m5Candles.length);
  let m15Cursor = 0;
  let latestClosedAdx: number | null = null;
  for (let i = 0; i < m5Candles.length; i += 1) {
    const m5CloseTime = m5Candles[i].openTime + M5_MS;
    while (m15Cursor < m15Candles.length && m15Candles[m15Cursor].openTime + M15_MS <= m5CloseTime) {
      latestClosedAdx = adxSeries[m15Cursor];
      m15Cursor += 1;
    }
    result[i] = latestClosedAdx;
  }
  return result;
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const reportsDirectory = fileURLToPath(new URL('../../reports/', import.meta.url));

  console.info('Loading CSVs and recomputing signals/ADX (same functions the backtest itself used)...');
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const m5Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_5m_3y.csv'));
  const signals = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);
  const adxByM5Index = adxAtEachM5Close(m15Candles, m5Candles);

  const backtestPath = resolve(reportsDirectory, 'nukida-04x-s-mean-reversion-backtest.json');
  console.info(`Loading ${backtestPath}...`);
  const backtest = JSON.parse(await readFile(backtestPath, 'utf8')) as {
    trades: Array<{ m5Index: number; outcome: string; zScoreAtSignal?: number | null; adxAtSignal?: number | null }>;
  };

  let updated = 0;
  for (const trade of backtest.trades) {
    if (trade.outcome !== 'TAKE_PROFIT' && trade.outcome !== 'STOP_LOSS') continue;
    trade.zScoreAtSignal = signals[trade.m5Index].zScore;
    trade.adxAtSignal = adxByM5Index[trade.m5Index];
    updated += 1;
  }
  console.info(`Added zScoreAtSignal/adxAtSignal to ${updated} TAKE_PROFIT/STOP_LOSS trade records.`);

  await writeFile(backtestPath, JSON.stringify(backtest, null, 2), 'utf8');
  console.info(`Updated in place: ${backtestPath}`);
}

await main();
