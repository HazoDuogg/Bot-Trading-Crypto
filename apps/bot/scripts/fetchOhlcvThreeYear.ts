import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// TICKET-RT-065 Part A: fetches up to 3 years of OHLCV (H1+M15) for the 5 coins, saved under a
// "_3y" suffix so the existing "_1y" dataset (RT-051..064's confirmed baseline) is NOT overwritten.
// Does NOT assume any coin's listing date — queries Binance directly for the actual earliest
// available candle per symbol/interval (startTime=0, limit=1 returns the first candle Binance has),
// then fetches from max(that date, now - 3 years) to now. HYPE (listed 2025) will naturally get less
// than 3 years; the other 4 coins are expected to hit the 3-year cap.
//
// Same pagination/closed-candle-only logic as fetchOhlcvOneYear.ts (RT-051/054) — public futures
// klines endpoint, no API key needed, read-only market data.
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

const INTERVAL_MS: Record<string, number> = { '1h': 60 * 60 * 1000, '15m': 15 * 60 * 1000 };
const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    closeTime: row[6] as number,
  }));
}

// Binance-documented technique: startTime=0 (or any time before listing) + limit=1 returns the
// FIRST candle the exchange actually has for this symbol/interval — no assumption, direct query.
async function fetchEarliestOpenTime(symbol: string, interval: string): Promise<number> {
  const page = await fetchKlinesPage(symbol, interval, 0, Date.now());
  if (page.length === 0) throw new Error(`CORRECTION_REQUIRED: Binance tra ve 0 nen cho ${symbol} ${interval} khi truy van tu startTime=0 — khong the xac dinh ngay som nhat.`);
  return page[0].openTime;
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
    await sleep(150); // considerate pacing on a public endpoint, no API key
  }
  return all;
}

function toCsv(klines: Kline[]): string {
  const header = 'openTime,open,high,low,close,volume';
  const rows = klines.map((k) => `${k.openTime},${k.open},${k.high},${k.low},${k.close},${k.volume}`);
  return [header, ...rows].join('\n') + '\n';
}

// Checks openTime[i+1] - openTime[i] === intervalMs for every consecutive pair — any deviation is a
// gap (missing candle) or a duplicate/out-of-order entry, both reported explicitly.
function checkNoGaps(klines: Kline[], intervalMs: number): { gaps: { afterIndex: number; expectedNext: number; actualNext: number }[] } {
  const gaps: { afterIndex: number; expectedNext: number; actualNext: number }[] = [];
  for (let i = 0; i < klines.length - 1; i++) {
    const expectedNext = klines[i].openTime + intervalMs;
    const actualNext = klines[i + 1].openTime;
    if (actualNext !== expectedNext) {
      gaps.push({ afterIndex: i, expectedNext, actualNext });
    }
  }
  return { gaps };
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const intervals: ('1h' | '15m')[] = ['1h', '15m'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  await mkdir(dataDir, { recursive: true });

  const now = Date.now();
  const threeYearsAgo = now - THREE_YEARS_MS;

  const summary: { symbol: string; interval: string; earliestAvailable: string; fetchStart: string; cappedAt3y: boolean; candleCount: number; days: number; gapCount: number }[] = [];

  for (const symbol of symbols) {
    for (const interval of intervals) {
      console.log(`\n${symbol} ${interval}: dang truy van ngay som nhat thuc te tren Binance...`);
      const earliestAvailable = await fetchEarliestOpenTime(symbol, interval);
      const fetchStart = Math.max(earliestAvailable, threeYearsAgo);
      const cappedAt3y = fetchStart > earliestAvailable;
      console.log(
        `  Ngay som nhat thuc co: ${new Date(earliestAvailable).toISOString()}. ` +
          `${cappedAt3y ? `Vuot 3 nam -> gioi han lay tu ${new Date(fetchStart).toISOString()} (dung 3 nam gan nhat).` : `Duoi 3 nam -> lay het tu ngay nay.`}`,
      );

      console.log(`  Dang fetch tu ${new Date(fetchStart).toISOString()} den ${new Date(now).toISOString()}...`);
      const klines = await fetchAllKlines(symbol, interval, fetchStart, now);
      const closedOnly = klines.filter((k) => k.closeTime < Date.now());
      const droppedCount = klines.length - closedOnly.length;
      console.log(`  Fetch xong: ${closedOnly.length} nen da dong${droppedCount > 0 ? ` (loai ${droppedCount} nen chua dong)` : ''}.`);

      const { gaps } = checkNoGaps(closedOnly, INTERVAL_MS[interval]);
      if (gaps.length > 0) {
        console.error(`  CANH BAO: ${gaps.length} gap/bat-thuong ve timestamp phat hien trong ${symbol} ${interval}:`);
        for (const g of gaps.slice(0, 10)) {
          console.error(`    Sau index ${g.afterIndex}: ky vong openTime tiep theo=${new Date(g.expectedNext).toISOString()}, thuc te=${new Date(g.actualNext).toISOString()}`);
        }
        if (gaps.length > 10) console.error(`    ... va ${gaps.length - 10} gap khac.`);
      } else {
        console.log(`  Khong co gap: timestamp lien tuc tu dau den cuoi.`);
      }

      const days = closedOnly.length > 0 ? (closedOnly[closedOnly.length - 1].openTime - closedOnly[0].openTime) / (24 * 60 * 60 * 1000) : 0;
      const outPath = path.join(dataDir, `${symbol}_${interval}_3y.csv`);
      await writeFile(outPath, toCsv(closedOnly), 'utf8');
      console.log(`  Da ghi ${outPath} (${closedOnly.length} nen, ~${days.toFixed(1)} ngay).`);

      summary.push({
        symbol,
        interval,
        earliestAvailable: new Date(earliestAvailable).toISOString(),
        fetchStart: new Date(fetchStart).toISOString(),
        cappedAt3y,
        candleCount: closedOnly.length,
        days: Number(days.toFixed(1)),
        gapCount: gaps.length,
      });
    }
  }

  console.log('\n=== TOM TAT ===');
  console.log('symbol'.padEnd(10) + 'interval'.padEnd(9) + 'ngay som nhat co'.padEnd(24) + 'ngay bat dau fetch'.padEnd(24) + 'gioi han 3y?'.padEnd(13) + 'so nen'.padEnd(9) + 'so ngay'.padEnd(10) + 'gap');
  for (const s of summary) {
    console.log(
      s.symbol.padEnd(10) +
        s.interval.padEnd(9) +
        s.earliestAvailable.padEnd(24) +
        s.fetchStart.padEnd(24) +
        (s.cappedAt3y ? 'co' : 'khong').padEnd(13) +
        String(s.candleCount).padEnd(9) +
        String(s.days).padEnd(10) +
        s.gapCount,
    );
  }

  const anyGaps = summary.some((s) => s.gapCount > 0);
  if (anyGaps) {
    console.error('\nCORRECTION_REQUIRED: co gap du lieu o it nhat 1 file — xem chi tiet o tren truoc khi dung du lieu nay cho Phan C/D.');
    process.exitCode = 1;
  } else {
    console.log('\n-> Khong file nao co gap. Du lieu san sang cho Phan C/D.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
