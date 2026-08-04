/**
 * TICKET-005 — fetch real OHLCV from Binance Futures public klines endpoint (no API key needed).
 * Run from repo root: `npm run fetch-ohlcv -- --days=180` (loads .env via dotenv, cwd = repo root).
 * TICKET-022: `--out-dir=data/ohlcv-365d` to fetch into a separate directory (defaults to
 * `data/ohlcv`) — lets a training-only pull run without ever touching the dataset backtest.ts reads.
 * TICKET-135: `--start-date=YYYY-MM-DD --end-date=YYYY-MM-DD` to fetch a FIXED historical window
 * instead of "last N days ending now" — additive, `--days=`/default behavior unchanged when these
 * flags are absent. End date is treated as inclusive (end-of-day UTC, 23:59:59.999).
 *
 * Output: {outDir}/{SYMBOL}_{interval}.csv, columns: timestampUtc,datetimeUtcIso,open,high,low,close,volume
 */
import 'dotenv/config';
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.BINANCE_URL;
if (!BASE_URL) {
  throw new Error('fetchOhlcv: BINANCE_URL not set in .env');
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
// TICKET-010 Phần A: '1m' added — MSS_TIMEFRAME defaults to 1m, needed for the backtest runner.
// TICKET-017 Phần A.1: '1d' added — macro trend filter needs daily-candle direction.
const INTERVALS: Record<string, number> = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000, '1m': 60_000, '1d': 24 * 60 * 60_000 };
const LIMIT_PER_REQUEST = 1500;
const MAX_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on 429

interface ParsedArgs {
  outDir: string;
  // Either a rolling "last N days ending now" window, or a fixed [rangeStart, rangeEnd] window.
  rangeStart: number;
  rangeEnd: number;
}

/** Parses --start-date=/--end-date= as YYYY-MM-DD (UTC) or raw epoch-ms; end-date is inclusive (end-of-day UTC). */
function parseDateFlag(raw: string, endOfDay: boolean): number {
  if (/^\d+$/.test(raw)) return Number(raw); // raw epoch ms
  const ms = Date.parse(endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`fetchOhlcv: không parse được date "${raw}" — dùng YYYY-MM-DD hoặc epoch ms.`);
  return ms;
}

function parseArgs(): ParsedArgs {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const outDirArg = process.argv.find((a) => a.startsWith('--out-dir='));
  const startDateArg = process.argv.find((a) => a.startsWith('--start-date='));
  const endDateArg = process.argv.find((a) => a.startsWith('--end-date='));

  // TICKET-022: separate output dir so a 365-day training-only pull never touches data/ohlcv/
  // (the 180-day dataset the chosen backtest baseline reads).
  const outDir = path.resolve(process.cwd(), outDirArg ? outDirArg.split('=')[1] : 'data/ohlcv');

  // TICKET-135: explicit fixed historical window, additive — only activates when BOTH flags given.
  if (startDateArg || endDateArg) {
    if (!startDateArg || !endDateArg) {
      throw new Error('fetchOhlcv: --start-date= và --end-date= phải đi cùng nhau.');
    }
    const rangeStart = parseDateFlag(startDateArg.split('=')[1], false);
    const rangeEnd = parseDateFlag(endDateArg.split('=')[1], true);
    if (rangeStart >= rangeEnd) throw new Error('fetchOhlcv: --start-date phải trước --end-date.');
    return { outDir, rangeStart, rangeEnd };
  }

  const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
  const rangeEnd = Date.now();
  const rangeStart = rangeEnd - days * 24 * 60 * 60 * 1000;
  return { outDir, rangeStart, rangeEnd };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawKline extends Array<string | number> {
  0: number; // open time
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
}

async function fetchPage(url: string): Promise<RawKline[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        if (attempt === MAX_RETRIES - 1) {
          throw new Error(`429 rate-limited after ${MAX_RETRIES} attempts: ${url}`);
        }
        const waitMs = 1000 * 2 ** attempt;
        console.log(`    429 — chờ ${waitMs}ms rồi thử lại (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      }
      return (await res.json()) as RawKline[];
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES - 1) throw err;
      const waitMs = 1000 * 2 ** attempt;
      console.log(`    Lỗi mạng (${(err as Error).message}) — chờ ${waitMs}ms rồi thử lại (${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function csvRow(k: RawKline): string {
  const ts = k[0];
  const iso = new Date(ts).toISOString();
  return [ts, iso, k[1], k[2], k[3], k[4], k[5]].join(',');
}

/** Last saved candle's timestampUtc, or null if the file doesn't exist / has no data rows yet. */
function lastSavedTimestamp(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  if (lines.length < 2) return null; // header only
  const lastLine = lines[lines.length - 1];
  const ts = Number(lastLine.split(',')[0]);
  return Number.isFinite(ts) ? ts : null;
}

async function fetchSymbolInterval(symbol: string, interval: string, intervalMs: number, rangeStart: number, rangeEnd: number, outDir: string): Promise<void> {
  const filePath = path.join(outDir, `${symbol}_${interval}.csv`);
  const endTime = rangeEnd;

  const resumeFrom = lastSavedTimestamp(filePath);
  let startTime = resumeFrom !== null ? resumeFrom + intervalMs : rangeStart;

  if (!existsSync(filePath)) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(filePath, 'timestampUtc,datetimeUtcIso,open,high,low,close,volume\n');
  }

  if (startTime >= endTime) {
    console.log(`  ${symbol} ${interval}: đã cập nhật tới hiện tại, bỏ qua.`);
    return;
  }

  const expectedTotal = Math.ceil((endTime - startTime) / intervalMs);
  let fetchedCount = 0;
  if (interval === '1m' && expectedTotal > 10_000) {
    console.log(
      `  ⚠ ${symbol} 1m: khối lượng lớn (~${expectedTotal} nến, ~${Math.ceil(expectedTotal / LIMIT_PER_REQUEST)} request phân trang) — sẽ chạy lâu hơn hẳn 5m/15m/1h.`,
    );
  }
  console.log(`  ${symbol} ${interval}: ${resumeFrom !== null ? 'tiếp tục từ nến cuối đã lưu' : 'bắt đầu mới'} (~${expectedTotal} nến)...`);

  while (startTime < endTime) {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT_PER_REQUEST}`;
    const page = await fetchPage(url);
    if (page.length === 0) break;

    const rows = page.map(csvRow).join('\n') + '\n';
    appendFileSync(filePath, rows);
    fetchedCount += page.length;

    const lastCandleOpenTime = page[page.length - 1][0];
    startTime = lastCandleOpenTime + intervalMs;

    console.log(`    ${symbol} ${interval}: ${fetchedCount}/${expectedTotal} nến...`);

    if (page.length < LIMIT_PER_REQUEST) break; // caught up to present
    await sleep(400); // polite pacing between successful pages, same as reference script
  }

  console.log(`  → ${filePath} (+${fetchedCount} nến mới)`);
}

async function main(): Promise<void> {
  const { rangeStart, rangeEnd, outDir } = parseArgs();
  console.log(
    `Fetch OHLCV ${new Date(rangeStart).toISOString()} → ${new Date(rangeEnd).toISOString()} cho ${SYMBOLS.join(', ')} → ${outDir}...`,
  );

  for (const symbol of SYMBOLS) {
    console.log(`=== ${symbol} ===`);
    for (const [interval, intervalMs] of Object.entries(INTERVALS)) {
      await fetchSymbolInterval(symbol, interval, intervalMs, rangeStart, rangeEnd, outDir);
    }
  }
}

main().catch((err) => {
  console.error('fetchOhlcv failed:', err);
  process.exit(1);
});
