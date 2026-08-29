import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Candle } from '../../src/noTradeZone/types.js';
import { DEFAULT_FVG_CONFIG } from '../../src/entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import { DEFAULT_EXPOSURE_TRACKER_CONFIG } from '../../src/positionSizing/exposureTracker.js';
import { DEFAULT_LEVERAGE_CONFIG } from '../../src/positionSizing/leverageConfig.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { applyOneActivePerSymbol, requiredIntrabarBlocks, simulateConventional, simulateLiveLike, summarizeExecution, type ExecutionMetrics, type ExecutionResult, type ExecutionScenario, type SymbolReplayData, type TrendCandidate } from '../../src/research/trendLiveLikeExecution.js';

const BASELINE_COMMIT = '76160e72d8c66347c7cd7e6d5c3930a8e0e317bf';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const REPORT_PATH = path.resolve(process.cwd(), 'apps/bot/reports/RT-084-current-trend-live-like-baseline.md');
const ENTRY_FEE = 0.0002;
const EXIT_FEE = 0.0005;
const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;

const scenario = (id: string, label: string, fillBufferBps: number, latencyMs: ExecutionScenario['latencyMs'], slippageBps: number): ExecutionScenario => ({ id, label, fillBufferBps, latencyMs, slippageBps, entryFeeRate: ENTRY_FEE, slFeeRate: EXIT_FEE, tpFeeRate: EXIT_FEE });
const TOUCH = scenario('touch_base_0ms', 'Touch / base slip / 0ms', 0, 0, 1);
const REALISTIC = scenario('trade_through_base_0ms', 'Trade-through 1bp / base slip / 0ms', 1, 0, 1);
const CONSERVATIVE = scenario('conservative_base_0ms', 'Conservative 3bp / base slip / 0ms', 3, 0, 1);
const STRESS = scenario('stress', 'Conservative 3bp / stress slip / 2000ms', 3, 2000, 3);
const LATENCY = ([0, 500, 1000, 2000] as const).map((value) => scenario(`trade_through_base_${value}ms`, `Trade-through 1bp / base slip / ${value}ms`, 1, value, 1));
const ALL_SCENARIOS = [TOUCH, REALISTIC, CONSERVATIVE, ...LATENCY.slice(1), STRESS];

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

async function loadBaseline(): Promise<{ candidates: TrendCandidate[]; detected: number; floorRejected: number; m15BySymbol: Map<string, Candle[]>; ranges: string[] }> {
  const candidates: TrendCandidate[] = [];
  const m15BySymbol = new Map<string, Candle[]>();
  const ranges: string[] = [];
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
    const start = new Date(Math.max(m15[0].openTime, h1[0].openTime)).toISOString();
    const end = new Date(Math.min(m15.at(-1)!.openTime + M15_MS, h1.at(-1)!.openTime + 60 * M1_MS)).toISOString();
    ranges.push(`${symbol}: ${start} to ${end}; M15=${m15.length.toLocaleString('en-US')}, H1=${h1.length.toLocaleString('en-US')}`);
  }
  candidates.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp || a.symbol.localeCompare(b.symbol));
  if (detected !== 21_887 || floorRejected !== 14_754 || candidates.length !== 7_133) throw new Error(`Frozen baseline drift: detected=${detected}, floorRejected=${floorRejected}, eligible=${candidates.length}`);
  return { candidates, detected, floorRejected, m15BySymbol, ranges };
}

async function loadReplay(m15BySymbol: Map<string, Candle[]>, candidates: TrendCandidate[]): Promise<{ replay: Map<string, SymbolReplayData>; minutes: number; blocks: number; mismatches: number }> {
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
  let blocks = 0;
  let mismatches = 0;
  for (const symbol of SYMBOLS) {
    const m15 = m15BySymbol.get(symbol)!;
    const m15ByTime = new Map(m15.map((candle) => [candle.openTime, candle]));
    const minuteMap = minutesBySymbol.get(symbol) ?? new Map<number, Candle>();
    for (const block of required.get(symbol) ?? []) {
      const minutes = Array.from({ length: 15 }, (_, index) => minuteMap.get(block + index * M1_MS));
      if (minutes.some((candle) => candle === undefined)) throw new Error(`Incomplete required block: ${symbol} ${block}`);
      const complete = minutes as Candle[];
      const expected = m15ByTime.get(block);
      if (!expected) throw new Error(`M15 block missing: ${symbol} ${block}`);
      const actual = { open: complete[0].open, high: Math.max(...complete.map((candle) => candle.high)), low: Math.min(...complete.map((candle) => candle.low)), close: complete.at(-1)!.close };
      const matches = (['open', 'high', 'low', 'close'] as const).every((field) => Math.abs(actual[field] - expected[field]) <= Math.max(1, Math.abs(expected[field])) * 1e-9);
      if (!matches) mismatches++;
      blocks++;
    }
    replay.set(symbol, { m15, m15IndexByOpenTime: new Map(m15.map((candle, index) => [candle.openTime, index])), minuteByOpenTime: minuteMap });
  }
  return { replay, minutes: [...minutesBySymbol.values()].reduce((sum, map) => sum + map.size, 0), blocks, mismatches };
}

function run(candidates: TrendCandidate[], replay: Map<string, SymbolReplayData>, config: ExecutionScenario): ExecutionResult[] {
  return candidates.map((candidate) => simulateLiveLike(candidate, replay.get(candidate.symbol)!, config));
}

function f(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'inf';
}

function metricsRow(label: string, metrics: ExecutionMetrics): string {
  return `| ${label} | ${metrics.candidates} | ${metrics.filled} | ${metrics.expired} | ${metrics.notFilled} | ${metrics.skipped} | ${metrics.open} | ${f(metrics.fillRatePct, 1)}% | ${metrics.wins} | ${metrics.losses} | ${f(metrics.winRatePct, 1)}% | ${f(metrics.grossProfitFactor, 3)} | ${f(metrics.netProfitFactor, 3)} | ${f(metrics.grossExpectancyR, 3)} | ${f(metrics.netExpectancyR, 3)} | ${f(metrics.grossNetR, 1)} | ${f(metrics.netR, 1)} | ${f(metrics.maxDrawdownR, 1)} | ${metrics.maxConsecutiveLosses} |\n`;
}

function metricsTable(rows: Array<{ label: string; metrics: ExecutionMetrics }>): string {
  let markdown = '| Scenario | Candidates | Filled | Expired | Not filled | Skipped | Open | Fill rate | Wins | Losses | WR | Gross PF | Net PF | Gross Exp R | Net Exp R | Gross Net R | Net R | MaxDD R | Loss streak |\n';
  markdown += '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const row of rows) markdown += metricsRow(row.label, row.metrics);
  return markdown + '\n';
}

function splitChronologically(candidates: TrendCandidate[]): Array<{ label: string; start: number; end: number }> {
  const start = Math.min(...candidates.map((candidate) => candidate.decisionTimestamp));
  const end = Math.max(...candidates.map((candidate) => candidate.decisionTimestamp)) + 1;
  const width = (end - start) / 3;
  return [
    { label: 'Early', start, end: start + width },
    { label: 'Middle', start: start + width, end: start + 2 * width },
    { label: 'Late', start: start + 2 * width, end },
  ];
}

function degradationTable(conventional: ExecutionMetrics, realistic: ExecutionMetrics): string {
  return `| Comparator | WR Δ pp | Gross PF Δ | Net PF Δ | Gross Exp ΔR | Net Exp ΔR | Gross Net ΔR | Net R Δ | MaxDD ΔR | Fill-rate Δ pp |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| Live-like minus M15 conventional | ${f(realistic.winRatePct - conventional.winRatePct, 1)} | ${f(realistic.grossProfitFactor - conventional.grossProfitFactor, 3)} | ${f(realistic.netProfitFactor - conventional.netProfitFactor, 3)} | ${f(realistic.grossExpectancyR - conventional.grossExpectancyR, 3)} | ${f(realistic.netExpectancyR - conventional.netExpectancyR, 3)} | ${f(realistic.grossNetR - conventional.grossNetR, 1)} | ${f(realistic.netR - conventional.netR, 1)} | ${f(realistic.maxDrawdownR - conventional.maxDrawdownR, 1)} | ${f(realistic.fillRatePct - conventional.fillRatePct, 1)} |\n\n`;
}

function buildReport(baseline: Awaited<ReturnType<typeof loadBaseline>>, replayStats: { minutes: number; blocks: number; mismatches: number }, results: Map<string, ExecutionResult[]>, conventionalResults: ExecutionResult[]): string {
  const independentRows = [TOUCH, REALISTIC, CONSERVATIVE].map((config) => ({ label: config.label, metrics: summarizeExecution(results.get(`${config.id}:independent`)!) }));
  const constrainedRows = [TOUCH, REALISTIC, CONSERVATIVE].map((config) => ({ label: config.label, metrics: summarizeExecution(results.get(`${config.id}:constrained`)!) }));
  const realisticResults = results.get(`${REALISTIC.id}:independent`)!;
  const realisticMetrics = summarizeExecution(realisticResults);
  const conventionalMetrics = summarizeExecution(conventionalResults);
  let markdown = '# TICKET-RT-084 — Current Trend-Following Live-Like Baseline\n\n';
  markdown += `## Frozen commit and production configuration\n\n- Branch: \`real-time\`; commit: \`${BASELINE_COMMIT}\`. Tracked files were clean at freeze; the pre-existing untracked \`apps/bot/scripts/research/rtCheckCurrentSlPct.ts\` was excluded from this ticket.\n- Symbols: ${SYMBOLS.join(', ')}.\n- H1 trend: latest available closed H1 close versus EMA200 computed by the current detector from its capped 300-candle H1 buffer; equal/above is UPTREND, below is DOWNTREND.\n- Signal: three-candle M15 FVG in the H1 direction; candle-2 body/range minimum ${DEFAULT_FVG_CONFIG.minCandle2BodyRatio}. Current No-Trade-Zone gates remain active.\n- Entry: LIMIT at gapLow for LONG and gapHigh for SHORT. SL: candle-1 invalidation wick. Minimum SL distance: ${DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor}%. TP: fixed ${DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple}R. Pending expiry: ${DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles} M15 candles.\n- Production concurrency: one ENTRY_PENDING/position lifecycle per symbol. \`liveRunner\` does not call the portfolio exposure tracker; its configured ${f(DEFAULT_EXPOSURE_TRACKER_CONFIG.maxTotalUsedMargin * 100, 0)}% cap is therefore not applied here. Circuit-breaker and reconciliation failures cannot be reconstructed from OHLC.\n- Sizing config is unchanged: per-trade margin cap ${f(DEFAULT_MAX_MARGIN_PCT * 100, 0)}%; leverage ${Object.entries(DEFAULT_LEVERAGE_CONFIG.fourCoinLeverage).map(([symbol, leverage]) => `${symbol}=${leverage}x`).join(', ')}. Sizing does not change R-path outcomes.\n- No production fee tier exists in source, so the audit assumes maker LIMIT entry 0.02%, taker SL 0.05%, taker TP 0.05%.\n\n`;
  markdown += `## Dataset and frozen candidate generation\n\n${baseline.ranges.map((range) => `- ${range}`).join('\n')}\n\nThe current production signal engine detected ${baseline.detected.toLocaleString('en-US')} direction-matched signals. The production SL floor rejected ${baseline.floorRejected.toLocaleString('en-US')} before order placement, leaving ${baseline.candidates.length.toLocaleString('en-US')} order-eligible candidates. M1 never creates or filters a signal.\n\n`;
  markdown += `The replay dataset contains ${replayStats.minutes.toLocaleString('en-US')} M1 candles in ${replayStats.blocks.toLocaleString('en-US')} complete required M15 blocks. ${replayStats.blocks - replayStats.mismatches}/${replayStats.blocks} re-aggregate exactly to the frozen M15 OHLC; ${replayStats.mismatches} mismatches are retained and disclosed as data-version differences.\n\n`;
  markdown += '## Decision timestamp validation\n\nEach candidate becomes eligible only at the close of its third M15 FVG candle. H1 ingestion requires `h1.openTime + 1h <= decisionTimestamp`; equality is allowed because the live poll processes newly closed H1 before M15. The runner rejects any fill earlier than the resolution-adjusted active time. M1 is read only after the frozen decision timestamp.\n\n';
  markdown += '## Fill, fee, slippage, and latency methodology\n\nTouch requires an entry touch; realistic requires 1bp trade-through; conservative requires 3bp. LIMIT fill price remains the configured entry with no beneficial improvement. The fill minute is evaluated and ambiguous SL+TP is SL-first. Base adverse SL slippage is 1bp and stress is 3bp; TP slippage is 0bp. Latency 0ms uses the decision-time minute, while 500/1000/2000ms all map conservatively to the next complete M1 candle because millisecond history is unavailable. A price already passed before activation is not backfilled; reset and later recross are required.\n\n';
  markdown += '## Independent execution modes\n\n' + metricsTable(independentRows);
  markdown += '## Production-constrained execution modes\n\n' + metricsTable(constrainedRows);
  markdown += '## Main realistic result\n\n' + metricsTable([{ label: REALISTIC.label, metrics: realisticMetrics }]);
  markdown += '## Latency sensitivity\n\n' + metricsTable(LATENCY.map((config) => ({ label: config.label, metrics: summarizeExecution(results.get(`${config.id}:independent`)!) })));
  markdown += '## LONG / SHORT breakdown\n\n' + metricsTable((['LONG', 'SHORT'] as const).map((direction) => ({ label: `${direction} trend-following`, metrics: summarizeExecution(realisticResults.filter((result) => result.candidate.direction === direction)) })));
  markdown += '## Chronological stability\n\n';
  markdown += metricsTable(splitChronologically(baseline.candidates).map((segment) => ({
    label: `${segment.label} (${new Date(segment.start).toISOString().slice(0, 10)} to ${new Date(segment.end - 1).toISOString().slice(0, 10)})`,
    metrics: summarizeExecution(realisticResults.filter((result) => result.candidate.decisionTimestamp >= segment.start && result.candidate.decisionTimestamp < segment.end)),
  })));
  markdown += '## Combined stress scenario\n\n' + metricsTable([
    { label: 'Independent', metrics: summarizeExecution(results.get(`${STRESS.id}:independent`)!) },
    { label: 'Production-constrained', metrics: summarizeExecution(results.get(`${STRESS.id}:constrained`)!) },
  ]);
  markdown += '## Conventional backtest comparison\n\nThe existing RT-DOGE-001 report is preserved unchanged: 3,804 portfolio-constrained trades, 50.6% WR, PF 1.451, PnL $7,642.57 and MaxDD 2.28%. It is not a clean degradation denominator: it uses candidate suppression, sizing/global exposure, a different fee constant and M15 gap-intersection fills, and reports dollar/PCT rather than R expectancy.\n\nFor an apples-to-apples degradation calculation, the table below replays the same 7,133 frozen current candidates with the conventional M15 geometry: any gap intersection is treated as a LIMIT fill, the fill candle is skipped for outcome, and subsequent ambiguous M15 exits are SL-first. Fees are held equal to RT-084; no thresholds are changed.\n\n';
  markdown += metricsTable([{ label: 'M15 conventional comparator', metrics: conventionalMetrics }, { label: 'M1 live-like realistic', metrics: realisticMetrics }]);
  markdown += degradationTable(conventionalMetrics, realisticMetrics);
  markdown += '## Limitations\n\n- M1 OHLC cannot recover tick order, queue priority, partial fills, or exact millisecond latency. Full fill occurs only after the selected deterministic condition.\n- Historical funding and historical exchange filter/tick-size versions are unavailable, so funding is excluded and analytical entry/SL/TP levels are not rounded using today\'s filters.\n- Historical balance, Soft-Veto Python scores, exchange rejects, circuit-breaker trips, reconciliation state and API failures are unavailable. They affect sizing/admission in live operation but are not invented here.\n- The constrained view faithfully applies the active per-symbol lifecycle visible in `liveRunner`; it does not invent a cross-symbol cap.\n- Audit observation: `SymbolSignalEngine` invalidates its KeyZone cache by H1 buffer length, but that length stays at the 300-candle cap. KeyZone/Soft-Veto features can therefore become stale after the cap. This does not gate direction-matched signal eligibility or R outcomes, and RT-084 leaves the production risk path unchanged.\n\n';
  const verdict = realisticMetrics.netProfitFactor > 1 && realisticMetrics.netExpectancyR > 0 ? 'positive' : 'not positive';
  markdown += `## Final verdict\n\nThe current trend-following strategy is ${verdict} under the main live-like assumptions: Net PF ${f(realisticMetrics.netProfitFactor, 3)}, Net Expectancy ${f(realisticMetrics.netExpectancyR, 3)}R/trade, Net R ${f(realisticMetrics.netR, 1)} and MaxDD ${f(realisticMetrics.maxDrawdownR, 1)}R. This is a benchmark result only and does not authorize a strategy/configuration change.\n\n`;
  markdown += '`NO STRATEGY LOGIC MODIFIED`\n\n`NO PRODUCTION RISK LOGIC MODIFIED`\n\n`NO LIVE ORDER LOGIC MODIFIED`\n';
  return markdown;
}

async function main(): Promise<void> {
  const baseline = await loadBaseline();
  const replayStats = await loadReplay(baseline.m15BySymbol, baseline.candidates);
  const results = new Map<string, ExecutionResult[]>();
  for (const config of ALL_SCENARIOS) {
    const independent = run(baseline.candidates, replayStats.replay, config);
    const minimumActiveDelay = config.latencyMs === 0 ? 0 : M1_MS;
    if (independent.some((result) => result.fillTime !== null && result.fillTime < result.candidate.decisionTimestamp + minimumActiveDelay)) throw new Error(`Pre-active fill: ${config.id}`);
    results.set(`${config.id}:independent`, independent);
    results.set(`${config.id}:constrained`, applyOneActivePerSymbol(independent));
  }
  const conventional = baseline.candidates.map((candidate) => simulateConventional(candidate, replayStats.replay.get(candidate.symbol)!, REALISTIC));
  await writeFile(REPORT_PATH, buildReport(baseline, replayStats, results, conventional), 'utf8');
  const mainMetrics = summarizeExecution(results.get(`${REALISTIC.id}:independent`)!);
  console.log(`Eligible=${baseline.candidates.length}; M1 blocks=${replayStats.blocks}; mismatches=${replayStats.mismatches}`);
  console.log(`Realistic: filled=${mainMetrics.filled}; netPF=${f(mainMetrics.netProfitFactor, 3)}; netExp=${f(mainMetrics.netExpectancyR, 3)}R; netR=${f(mainMetrics.netR, 1)}; maxDD=${f(mainMetrics.maxDrawdownR, 1)}R`);
  console.log(`Report: ${REPORT_PATH}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
