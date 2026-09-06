import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Data-recovery script (M1 has no existing fetcher — only 1h/15m in fetchOhlcvThreeYear.ts):
// same pagination/closed-candle/gap-check pattern as that script, applied to the 1m interval,
// writing `${symbol}_rt094_1m.csv` (the filename every mining script in this series expects).
loadEnv();

interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

const BINANCE_URL = process.env.BINANCE_URL;
if (!BINANCE_URL) throw new Error('BINANCE_URL missing from .env');

const INTERVAL_MS = 60 * 1000;
const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKlinesPage(symbol: string, startTime: number, endTime: number): Promise<Kline[]> {
  const url = new URL('/fapi/v1/klines', BINANCE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1m');
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('endTime', String(endTime));
  url.searchParams.set('limit', '1500');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines request failed: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as unknown[][];
  return raw.map((row) => ({
    openTime: row[0] as number,
    open: row[1] as string,
    high: row[2] as string,
    low: row[3] as string,
    close: row[4] as string,
    volume: row[5] as string,
    closeTime: row[6] as number,
  }));
}

async function fetchEarliestOpenTime(symbol: string): Promise<number> {
  const page = await fetchKlinesPage(symbol, 0, Date.now());
  if (page.length === 0) throw new Error(`CORRECTION_REQUIRED: no candles for ${symbol} 1m at startTime=0.`);
  return page[0].openTime;
}

async function fetchAllKlines(symbol: string, startTime: number, endTime: number): Promise<Kline[]> {
  const all: Kline[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const page = await fetchKlinesPage(symbol, cursor, endTime);
    if (page.length === 0) break;
    all.push(...page);
    const lastOpenTime = page[page.length - 1].openTime;
    if (page.length < 1500) break;
    cursor = lastOpenTime + 1;
    await sleep(150);
  }
  return all;
}

function toCsv(klines: Kline[]): string {
  const header = 'openTime,open,high,low,close,volume';
  const rows = klines.map((k) => `${k.openTime},${k.open},${k.high},${k.low},${k.close},${k.volume}`);
  return [header, ...rows].join('\n') + '\n';
}

function checkNoGaps(klines: Kline[], intervalMs: number): number {
  let gaps = 0;
  for (let i = 0; i < klines.length - 1; i += 1) {
    if (klines[i + 1].openTime !== klines[i].openTime + intervalMs) gaps += 1;
  }
  return gaps;
}

async function fetchSymbol(symbol: string, dataDir: string): Promise<void> {
  const now = Date.now();
  const threeYearsAgo = now - THREE_YEARS_MS;
  console.info(`${symbol}: querying earliest available 1m candle...`);
  const earliestAvailable = await fetchEarliestOpenTime(symbol);
  const fetchStart = Math.max(earliestAvailable, threeYearsAgo);
  console.info(`${symbol}: fetching from ${new Date(fetchStart).toISOString()}...`);
  const klines = await fetchAllKlines(symbol, fetchStart, now);
  const closedOnly = klines.filter((k) => k.closeTime < Date.now());
  const gapCount = checkNoGaps(closedOnly, INTERVAL_MS);
  const outPath = path.join(dataDir, `${symbol}_rt094_1m.csv`);
  await writeFile(outPath, toCsv(closedOnly), 'utf8');
  console.info(`${symbol}: wrote ${closedOnly.length} candles, gaps=${gapCount} -> ${outPath}`);
}

async function main(): Promise<void> {
  const symbols = ['BTCUSDT']; // TICKET-04X-K: scope reduced to BTC-only
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  await mkdir(dataDir, { recursive: true });
  // Sequential, not Promise.all: 5 concurrent streams tripped Binance's 2400 req/min IP limit.
  for (const s of symbols) await fetchSymbol(s, dataDir);
  console.info('\nDone.');
}

await main();
