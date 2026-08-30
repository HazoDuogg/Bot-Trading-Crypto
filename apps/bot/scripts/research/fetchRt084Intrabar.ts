import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Candle } from '../../src/noTradeZone/types.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { requiredIntrabarBlocks } from '../../src/research/trendLiveLikeExecution.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const OUTPUT_PATH = path.join(DATA_DIR, 'rt084Intrabar1m.csv');
const BASE_URL = 'https://fapi.binance.com';

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface FetchRange {
  symbol: string;
  startTime: number;
  endTime: number;
  blocks: number[];
}

function rangesFor(symbol: string, blocks: Set<number>): FetchRange[] {
  const sorted = [...blocks].sort((a, b) => a - b);
  const ranges: FetchRange[] = [];
  let group: number[] = [];
  for (const block of sorted) {
    const span = group.length === 0 ? 0 : block - group[0] + M15_MS;
    if (group.length > 0 && span > 499 * M1_MS) {
      ranges.push({ symbol, startTime: group[0], endTime: group.at(-1)! + M15_MS - 1, blocks: group });
      group = [];
    }
    group.push(block);
  }
  if (group.length > 0) ranges.push({ symbol, startTime: group[0], endTime: group.at(-1)! + M15_MS - 1, blocks: group });
  return ranges;
}

async function fetchRange(range: FetchRange): Promise<Candle[]> {
  const url = new URL('/fapi/v1/klines', BASE_URL);
  url.searchParams.set('symbol', range.symbol);
  url.searchParams.set('interval', '1m');
  url.searchParams.set('startTime', String(range.startTime));
  url.searchParams.set('endTime', String(range.endTime));
  url.searchParams.set('limit', String(Math.ceil((range.endTime - range.startTime + 1) / M1_MS)));
  let response: Response | null = null;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch {
      response = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`${range.symbol} ${range.startTime}: ${response?.status ?? 'network'} ${response ? await response.text() : ''}`);
  const rows = await response.json() as unknown[][];
  return rows.map((row) => ({ openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
}

async function readExistingCache(filePath: string): Promise<Map<string, Candle & { symbol: string }>> {
  const cache = new Map<string, Candle & { symbol: string }>();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return cache; // no file yet — empty cache, everything required will be "missing"
  }
  for (const line of raw.trim().split(/\r?\n/).slice(1)) {
    const [symbol, openTime, open, high, low, close, volume] = line.split(',');
    cache.set(`${symbol}:${openTime}`, { symbol, openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) });
  }
  return cache;
}

// TICKET-RT-087: reusable, incremental — reads whatever is already cached in rt084Intrabar1m.csv,
// fetches ONLY the minutes still missing for the given required-block set, merges, and re-verifies
// every required minute is present before writing (same "throw if any minute missing" self-check
// RT-084 always had, now applied to the merged superset instead of a single fresh fetch).
export async function ensureIntrabarBlocks(required: Map<string, Set<number>>, dataDir: string = DATA_DIR): Promise<{ alreadyCached: number; fetched: number; totalBlocks: number }> {
  const outputPath = path.join(dataDir, 'rt084Intrabar1m.csv');
  const cache = await readExistingCache(outputPath);

  const missingBySymbol = new Map<string, Set<number>>();
  let totalBlocks = 0;
  let alreadyCachedBlocks = 0;
  for (const [symbol, blocks] of required) {
    for (const block of blocks) {
      totalBlocks++;
      const complete = Array.from({ length: 15 }, (_, i) => block + i * M1_MS).every((minute) => cache.has(`${symbol}:${minute}`));
      if (complete) {
        alreadyCachedBlocks++;
        continue;
      }
      const set = missingBySymbol.get(symbol) ?? new Set<number>();
      missingBySymbol.set(symbol, set);
      set.add(block);
    }
  }

  const missingBlockCount = [...missingBySymbol.values()].reduce((sum, s) => sum + s.size, 0);
  console.log(`  Intrabar cache: ${alreadyCachedBlocks}/${totalBlocks} blocks already cached; ${missingBlockCount} missing.`);
  if (missingBlockCount === 0) return { alreadyCached: alreadyCachedBlocks, fetched: 0, totalBlocks };

  const ranges = [...missingBySymbol].flatMap(([symbol, blocks]) => rangesFor(symbol, blocks));
  const fetchedRows: Array<Candle & { symbol: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < ranges.length) {
      const range = ranges[cursor++];
      const fetched = await fetchRange(range);
      const wanted = new Set(range.blocks);
      for (const candle of fetched) if (wanted.has(Math.floor(candle.openTime / M15_MS) * M15_MS)) fetchedRows.push({ ...candle, symbol: range.symbol });
      if (cursor % 250 === 0) console.log(`  Fetched ${cursor}/${ranges.length} missing ranges`);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  });
  await Promise.all(workers);

  for (const candle of fetchedRows) cache.set(`${candle.symbol}:${candle.openTime}`, candle);

  for (const [symbol, blocks] of required) {
    for (const block of blocks) {
      for (let minute = 0; minute < 15; minute++) {
        const key = `${symbol}:${block + minute * M1_MS}`;
        if (!cache.has(key)) throw new Error(`Missing minute after fetch: ${key}`);
      }
    }
  }

  const merged = [...cache.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.openTime - b.openTime);
  const rows = merged.map((candle) => `${candle.symbol},${candle.openTime},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}`);
  await writeFile(outputPath, ['symbol,openTime,open,high,low,close,volume', ...rows].join('\n') + '\n', 'utf8');
  console.log(`  Wrote ${merged.length} total candles (${fetchedRows.length} newly fetched) to ${outputPath}`);
  return { alreadyCached: alreadyCachedBlocks, fetched: missingBlockCount, totalBlocks };
}

async function main(): Promise<void> {
  const m15BySymbol = new Map<string, Candle[]>();
  const candidates = [];
  let detected = 0;
  let floorRejected = 0;
  for (const symbol of SYMBOLS) {
    const m15 = await readCandles(path.join(DATA_DIR, `${symbol}_15m_3y.csv`));
    const h1 = await readCandles(path.join(DATA_DIR, `${symbol}_1h_3y.csv`));
    m15BySymbol.set(symbol, m15);
    const generated = generateTrendCandidates(symbol, m15, h1);
    detected += generated.detectedSignals;
    floorRejected += generated.floorRejected;
    candidates.push(...generated.candidates);
  }
  const required = requiredIntrabarBlocks(candidates, m15BySymbol);
  const blockCount = [...required.values()].reduce((sum, blocks) => sum + blocks.size, 0);
  console.log(`Detected=${detected}; floorRejected=${floorRejected}; eligible=${candidates.length}; blocks=${blockCount}`);
  if (process.env.RT084_PLAN_ONLY === '1') return;
  await ensureIntrabarBlocks(required, DATA_DIR);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
