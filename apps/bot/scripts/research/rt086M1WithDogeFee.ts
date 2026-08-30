import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candle } from '../../src/noTradeZone/types.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { simulateLiveLike, summarizeExecution, requiredIntrabarBlocks, type SymbolReplayData, type TrendCandidate, type ExecutionScenario } from '../../src/research/trendLiveLikeExecution.js';

// TICKET-RT-086 Part C support: what does the M1 realistic result look like if it charges
// RT-DOGE-001's (higher) fee instead of RT-084's own (lower) fee constant? RT-084's headline M1
// Net PF=0.936 already uses the LOWER fee — this checks whether the gap to RT-DOGE-001's fee
// standard makes the live-like picture even worse. Read-only: no production file touched.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

async function main() {
  const candidates: TrendCandidate[] = [];
  const m15BySymbol = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    const m15 = await readCandles(path.join(DATA_DIR, `${symbol}_15m_3y.csv`));
    const h1 = await readCandles(path.join(DATA_DIR, `${symbol}_1h_3y.csv`));
    m15BySymbol.set(symbol, m15);
    candidates.push(...generateTrendCandidates(symbol, m15, h1).candidates);
  }
  candidates.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp || a.symbol.localeCompare(b.symbol));
  if (candidates.length !== 7_133) throw new Error(`Frozen baseline drift: eligible=${candidates.length}`);

  const raw = await readFile(path.join(DATA_DIR, 'rt084Intrabar1m.csv'), 'utf8');
  const minutesBySymbol = new Map<string, Map<number, Candle>>();
  for (const line of raw.trim().split(/\r?\n/).slice(1)) {
    const [symbol, openTime, open, high, low, close, volume] = line.split(',');
    const map = minutesBySymbol.get(symbol) ?? new Map<number, Candle>();
    minutesBySymbol.set(symbol, map);
    map.set(Number(openTime), { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) });
  }
  const required = requiredIntrabarBlocks(candidates, m15BySymbol);
  const replay = new Map<string, SymbolReplayData>();
  for (const symbol of SYMBOLS) {
    const m15 = m15BySymbol.get(symbol)!;
    replay.set(symbol, { m15, m15IndexByOpenTime: new Map(m15.map((c, i) => [c.openTime, i])), minuteByOpenTime: minutesBySymbol.get(symbol) ?? new Map() });
  }
  void required; void M15_MS;

  const dogeFeeScenario: ExecutionScenario = { id: 'rtdoge_fee', label: 'Trade-through 1bp / base slip / 0ms / RT-DOGE-001 fee', fillBufferBps: 1, latencyMs: 0, slippageBps: 1, entryFeeRate: 0, tpFeeRate: 0.002, slFeeRate: 0.002 };
  const rt084FeeScenario: ExecutionScenario = { ...dogeFeeScenario, id: 'rt084_fee', entryFeeRate: 0.0002, tpFeeRate: 0.0005, slFeeRate: 0.0005 };

  const withDogeFee = candidates.map((c) => simulateLiveLike(c, replay.get(c.symbol)!, dogeFeeScenario));
  const withRt084Fee = candidates.map((c) => simulateLiveLike(c, replay.get(c.symbol)!, rt084FeeScenario));

  const m1 = summarizeExecution(withRt084Fee);
  const m1DogeFee = summarizeExecution(withDogeFee);
  console.log(`M1 realistic, RT-084 fee (reproduces RT-084 headline): netPF=${m1.netProfitFactor.toFixed(3)}, netExpR=${m1.netExpectancyR.toFixed(3)}, netR=${m1.netR.toFixed(1)}`);
  console.log(`M1 realistic, RT-DOGE-001 fee (apples-to-apples with the 1.451 standard): netPF=${m1DogeFee.netProfitFactor.toFixed(3)}, netExpR=${m1DogeFee.netExpectancyR.toFixed(3)}, netR=${m1DogeFee.netR.toFixed(1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
