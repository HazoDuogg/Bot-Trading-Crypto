import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// TICKET-RT-051: fetches 1 year of OHLCV (H1+M15) for the 5 coins, saved under a "_1y" suffix so the
// existing 90-day dataset (BTCUSDT_15m.csv etc., used by every RT-032..RT-050 script) is NOT
// overwritten — those tickets' confirmed numbers must stay reproducible against the exact data they
// were measured on. Same fetch/pagination logic as scripts/fetchOhlcv.ts, just a 365-day window and
// looped over all 5 symbols/2 intervals instead of one at a time from argv.
loadEnv();

interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

const BINANCE_URL = process.env.BINANCE_URL;
if (!BINANCE_URL) throw new Error('BINANCE_URL missing from .env');

async function fetchKlinesPage(symbol: string, interval: string, startTime: number, endTime: number): Promise<Kline[]> {
  const url = new URL('/fapi/v1/klines', BINANCE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
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
  }));
}

async function fetchAllKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<Kline[]> {
  const all: Kline[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const page = await fetchKlinesPage(symbol, interval, cursor, endTime);
    if (page.length === 0) break;
    all.push(...page);
    const lastOpenTime = page[page.length - 1].openTime;
    if (page.length < 1500) break;
    cursor = lastOpenTime + 1;
  }
  return all;
}

function toCsv(klines: Kline[]): string {
  const header = 'openTime,open,high,low,close,volume';
  const rows = klines.map((k) => `${k.openTime},${k.open},${k.high},${k.low},${k.close},${k.volume}`);
  return [header, ...rows].join('\n') + '\n';
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const intervals = ['1h', '15m'];
  const DAYS_BACK = 365;

  const endTime = Date.now();
  const startTime = endTime - DAYS_BACK * 24 * 60 * 60 * 1000;

  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  await mkdir(dataDir, { recursive: true });

  for (const symbol of symbols) {
    for (const interval of intervals) {
      console.log(`Fetching ${symbol} ${interval} from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
      const klines = await fetchAllKlines(symbol, interval, startTime, endTime);
      console.log(`  ${symbol} ${interval}: ${klines.length} candles`);
      const outPath = path.join(dataDir, `${symbol}_${interval}_1y.csv`);
      await writeFile(outPath, toCsv(klines), 'utf8');
      console.log(`  Wrote ${outPath}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
