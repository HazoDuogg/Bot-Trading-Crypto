/**
 * TICKET-005 — fetch real OHLCV from Binance Futures public klines endpoint (no API key needed).
 * Run from repo root: `npm run fetch-ohlcv` (loads .env via dotenv, cwd = repo root).
 *
 * Output: data/ohlcv/{SYMBOL}_{interval}.csv, columns: timestampUtc,datetimeUtcIso,open,high,low,close,volume
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
const OUT_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const LIMIT_PER_REQUEST = 1500;
const MAX_RETRIES = 5; // 1s,2s,4s,8s,16s backoff on 429

function parseArgs(): { days: number } {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  return { days: daysArg ? Number(daysArg.split('=')[1]) : 30 };
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

async function fetchSymbolInterval(symbol: string, interval: string, intervalMs: number, days: number): Promise<void> {
  const filePath = path.join(OUT_DIR, `${symbol}_${interval}.csv`);
  const endTime = Date.now();
  const rangeStart = endTime - days * 24 * 60 * 60 * 1000;

  const resumeFrom = lastSavedTimestamp(filePath);
  let startTime = resumeFrom !== null ? resumeFrom + intervalMs : rangeStart;

  if (!existsSync(filePath)) {
    mkdirSync(OUT_DIR, { recursive: true });
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
  const { days } = parseArgs();
  console.log(`Fetch OHLCV ${days} ngày gần nhất cho ${SYMBOLS.join(', ')}...`);

  for (const symbol of SYMBOLS) {
    console.log(`=== ${symbol} ===`);
    for (const [interval, intervalMs] of Object.entries(INTERVALS)) {
      await fetchSymbolInterval(symbol, interval, intervalMs, days);
    }
  }
}

main().catch((err) => {
  console.error('fetchOhlcv failed:', err);
  process.exit(1);
});
