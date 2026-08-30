import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candle } from '../../src/noTradeZone/types.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { requiredIntrabarBlocks, simulateLiveLike, summarizeExecution, type ExecutionMetrics, type ExecutionScenario, type SymbolReplayData, type TrendCandidate } from '../../src/research/trendLiveLikeExecution.js';
import { ensureIntrabarBlocks } from './fetchRt084Intrabar.js';

// TICKET-RT-087: sweeps minSlPctFloor in isolation (targetRMultiple held fixed at production's
// 2.10, per the ticket's "co lap 1 bien" rule) at M1 resolution. Each floor value regenerates its
// OWN candidate set (a higher floor rejects more/different signals — the set is NOT the frozen
// 7,133 from RT-084/086) and tops up the shared M1 intrabar cache incrementally (fetch-missing-only,
// via fetchRt084Intrabar.ts's ensureIntrabarBlocks, never re-fetching what's already cached).

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const REPORT_PATH = path.resolve(process.cwd(), 'apps/bot/reports/RT-087-minSlPctFloor-sweep.md');
const FLOOR_VALUES = [0.5, 0.75, 1.0, 1.5, 2.0];

const RT084_FEE: Pick<ExecutionScenario, 'entryFeeRate' | 'slFeeRate' | 'tpFeeRate'> = { entryFeeRate: 0.0002, slFeeRate: 0.0005, tpFeeRate: 0.0005 };
// Flat 0.2% round-trip fee (rtDogeThreeYearBacktest.ts's FEE_PCT_SUM), expressed as a single exit-side
// leg (entryFeeRate=0) — same R-equivalent approximation already used and disclosed in RT-086.
const RTDOGE_FEE: Pick<ExecutionScenario, 'entryFeeRate' | 'slFeeRate' | 'tpFeeRate'> = { entryFeeRate: 0, slFeeRate: 0.002, tpFeeRate: 0.002 };
const REALISTIC_BASE = { fillBufferBps: 1, latencyMs: 0 as const, slippageBps: 1 };

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

async function loadMinuteCache(): Promise<Map<string, Map<number, Candle>>> {
  const raw = await readFile(path.join(DATA_DIR, 'rt084Intrabar1m.csv'), 'utf8');
  const minutesBySymbol = new Map<string, Map<number, Candle>>();
  for (const line of raw.trim().split(/\r?\n/).slice(1)) {
    const [symbol, openTime, open, high, low, close, volume] = line.split(',');
    const map = minutesBySymbol.get(symbol) ?? new Map<number, Candle>();
    minutesBySymbol.set(symbol, map);
    map.set(Number(openTime), { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) });
  }
  return minutesBySymbol;
}

function f(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'inf';
}

interface FloorResult {
  floor: number;
  candidateCount: number;
  metricsRt084: ExecutionMetrics;
  metricsRtDoge: ExecutionMetrics;
}

async function main() {
  const m15BySymbol = new Map<string, Candle[]>();
  const h1BySymbol = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    m15BySymbol.set(symbol, await readCandles(path.join(DATA_DIR, `${symbol}_15m_3y.csv`)));
    h1BySymbol.set(symbol, await readCandles(path.join(DATA_DIR, `${symbol}_1h_3y.csv`)));
  }

  const results: FloorResult[] = [];

  for (const floor of FLOOR_VALUES) {
    console.log(`\n=== minSlPctFloor = ${floor}% ===`);
    const candidates: TrendCandidate[] = [];
    let detected = 0;
    let floorRejected = 0;
    for (const symbol of SYMBOLS) {
      const generated = generateTrendCandidates(symbol, m15BySymbol.get(symbol)!, h1BySymbol.get(symbol)!, floor);
      detected += generated.detectedSignals;
      floorRejected += generated.floorRejected;
      candidates.push(...generated.candidates);
    }
    candidates.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp || a.symbol.localeCompare(b.symbol));
    console.log(`  detected=${detected}, floorRejected=${floorRejected}, eligible=${candidates.length}`);

    const required = requiredIntrabarBlocks(candidates, m15BySymbol);
    await ensureIntrabarBlocks(required, DATA_DIR);

    const minuteCache = await loadMinuteCache();
    const replay = new Map<string, SymbolReplayData>();
    for (const symbol of SYMBOLS) {
      const m15 = m15BySymbol.get(symbol)!;
      replay.set(symbol, { m15, m15IndexByOpenTime: new Map(m15.map((c, i) => [c.openTime, i])), minuteByOpenTime: minuteCache.get(symbol) ?? new Map() });
    }

    const scenarioRt084: ExecutionScenario = { id: `floor_${floor}_rt084fee`, label: `floor=${floor}% RT-084 fee`, ...REALISTIC_BASE, ...RT084_FEE };
    const scenarioRtDoge: ExecutionScenario = { id: `floor_${floor}_rtdogefee`, label: `floor=${floor}% RT-DOGE-001 fee`, ...REALISTIC_BASE, ...RTDOGE_FEE };

    const resultsRt084 = candidates.map((c) => simulateLiveLike(c, replay.get(c.symbol)!, scenarioRt084));
    const resultsRtDoge = candidates.map((c) => simulateLiveLike(c, replay.get(c.symbol)!, scenarioRtDoge));
    const metricsRt084 = summarizeExecution(resultsRt084);
    const metricsRtDoge = summarizeExecution(resultsRtDoge);

    console.log(`  RT-084 fee : filled=${metricsRt084.filled}, WR=${f(metricsRt084.winRatePct, 1)}%, netPF=${f(metricsRt084.netProfitFactor)}, netExpR=${f(metricsRt084.netExpectancyR)}, netR=${f(metricsRt084.netR, 1)}, maxDD=${f(metricsRt084.maxDrawdownR, 1)}R, lossStreak=${metricsRt084.maxConsecutiveLosses}`);
    console.log(`  RTDOGE fee : filled=${metricsRtDoge.filled}, WR=${f(metricsRtDoge.winRatePct, 1)}%, netPF=${f(metricsRtDoge.netProfitFactor)}, netExpR=${f(metricsRtDoge.netExpectancyR)}, netR=${f(metricsRtDoge.netR, 1)}, maxDD=${f(metricsRtDoge.maxDrawdownR, 1)}R, lossStreak=${metricsRtDoge.maxConsecutiveLosses}`);

    if (floor === 0.5) {
      const okRt084 = Math.abs(metricsRt084.netProfitFactor - 0.936) < 0.001;
      const okRtDoge = Math.abs(metricsRtDoge.netProfitFactor - 0.734) < 0.001;
      if (!okRt084 || !okRtDoge) {
        throw new Error(`CORRECTION_REQUIRED: baseline self-check FAILED — floor=0.5% must reproduce netPF=0.936 (RT-084 fee, got ${metricsRt084.netProfitFactor.toFixed(3)}) and netPF=0.734 (RT-DOGE-001 fee, got ${metricsRtDoge.netProfitFactor.toFixed(3)}) from RT-086. STOPPING, not continuing the sweep.`);
      }
      console.log('  -> Self-check PASSED: baseline reproduces RT-086 exactly (0.936 / 0.734).');
    }

    results.push({ floor, candidateCount: candidates.length, metricsRt084, metricsRtDoge });
  }

  let md = '# TICKET-RT-087 — minSlPctFloor Sweep (M1 resolution, targetRMultiple fixed at 2.10)\n\n';
  md += 'Audit-only. Each row regenerates its OWN candidate set for that floor value (not the frozen RT-084/086 7,133 set) and replays it at M1 resolution, "Main realistic" scenario (trade-through 1bp, base slippage 1bp, 0ms latency), under BOTH fee standards side by side.\n\n';
  md += 'Baseline (floor=0.5%) self-checked against RT-086: must reproduce netPF=0.936 (RT-084 fee) and netPF=0.734 (RT-DOGE-001 fee) exactly, or the script stops before sweeping further.\n\n';
  md += '| minSlPctFloor | Candidates | Filled | Fill rate | WR | Net PF (RT-084 fee) | Net PF (RT-DOGE-001 fee) | Net Exp R (RT-084) | Net Exp R (RTDOGE) | Net R (RT-084) | Net R (RTDOGE) | MaxDD R (RT-084) | MaxDD R (RTDOGE) | Loss streak (RT-084) | Loss streak (RTDOGE) |\n';
  md += '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const r of results) {
    md += `| ${r.floor}% | ${r.candidateCount} | ${r.metricsRt084.filled} | ${f(r.metricsRt084.fillRatePct, 1)}% | ${f(r.metricsRt084.winRatePct, 1)}% | ${f(r.metricsRt084.netProfitFactor)} | ${f(r.metricsRtDoge.netProfitFactor)} | ${f(r.metricsRt084.netExpectancyR)} | ${f(r.metricsRtDoge.netExpectancyR)} | ${f(r.metricsRt084.netR, 1)} | ${f(r.metricsRtDoge.netR, 1)} | ${f(r.metricsRt084.maxDrawdownR, 1)} | ${f(r.metricsRtDoge.maxDrawdownR, 1)} | ${r.metricsRt084.maxConsecutiveLosses} | ${r.metricsRtDoge.maxConsecutiveLosses} |\n`;
  }
  md += '\nNote: WR and fill rate are computed identically under both fee standards (fees do not affect fill/exit determination), shown once.\n\n';
  md += 'No floor value is recommended here — this is measurement only, per the ticket.\n';
  await writeFile(REPORT_PATH, md, 'utf8');
  console.log(`\nReport: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
