import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// TICKET-04X-E item 1: fetches historical funding rate for the same 5 coins/3y window as
// fetchOhlcvThreeYear.ts, via Binance's public futures funding-rate endpoint (no API key, read-only
// market data — same category of call already established by fetchOhlcvThreeYear.ts). Same
// pagination/pacing convention as that script.
loadEnv();

interface FundingRateEntry {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

const BINANCE_URL = process.env.BINANCE_URL;
if (!BINANCE_URL) throw new Error('BINANCE_URL missing from .env');

// Matches the 3y CSV window already used across this ticket series (2023-08-28 .. now); coins
// listed later (HYPE) will simply get fewer/no rows before their own listing, same as the OHLCV
// fetch's per-symbol earliest-available handling.
const RANGE_START_MS = 1_693_233_000_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFundingRatePage(symbol: string, startTime: number, endTime: number): Promise<FundingRateEntry[]> {
  const url = new URL('/fapi/v1/fundingRate', BINANCE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('endTime', String(endTime));
  url.searchParams.set('limit', '1000');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fundingRate request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as FundingRateEntry[];
}

async function fetchAllFundingRates(symbol: string, startTime: number, endTime: number): Promise<FundingRateEntry[]> {
  const all: FundingRateEntry[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const page = await fetchFundingRatePage(symbol, cursor, endTime);
    if (page.length === 0) break;
    all.push(...page);
    const lastFundingTime = page[page.length - 1].fundingTime;
    if (page.length < 1000) break;
    cursor = lastFundingTime + 1;
    await sleep(150);
  }
  return all;
}

function toCsv(entries: FundingRateEntry[]): string {
  const header = 'fundingTime,fundingRate,markPrice';
  const rows = entries.map((e) => `${e.fundingTime},${e.fundingRate},${e.markPrice}`);
  return [header, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  await mkdir(dataDir, { recursive: true });
  const now = Date.now();

  const summary: Array<{ symbol: string; count: number; first: string; last: string; gapCount: number }> = [];

  for (const symbol of symbols) {
    console.info(`\n${symbol}: fetching funding rate history from ${new Date(RANGE_START_MS).toISOString()}...`);
    const entries = await fetchAllFundingRates(symbol, RANGE_START_MS, now);
    console.info(`  fetched ${entries.length} funding events`);

    // Funding is normally every 8h but Binance can widen the interval during extreme conditions —
    // report deviations, don't treat them as an error (nothing in this ticket depends on a fixed
    // 8h cadence; fundingRateChange8h below just diffs consecutive events whatever their spacing).
    let gapCount = 0;
    for (let i = 1; i < entries.length; i += 1) {
      const deltaHours = (entries[i].fundingTime - entries[i - 1].fundingTime) / 3_600_000;
      if (Math.abs(deltaHours - 8) > 0.01) gapCount += 1;
    }

    const outPath = path.join(dataDir, `${symbol}_funding_3y.csv`);
    await writeFile(outPath, toCsv(entries), 'utf8');
    console.info(`  wrote ${outPath}`);

    summary.push({
      symbol,
      count: entries.length,
      first: entries.length > 0 ? new Date(entries[0].fundingTime).toISOString() : 'n/a',
      last: entries.length > 0 ? new Date(entries[entries.length - 1].fundingTime).toISOString() : 'n/a',
      gapCount,
    });
  }

  console.info('\n=== SUMMARY ===');
  for (const s of summary) {
    console.info(`${s.symbol}: ${s.count} events, ${s.first} .. ${s.last}, non-8h-interval count=${s.gapCount}`);
  }
}

await main();
