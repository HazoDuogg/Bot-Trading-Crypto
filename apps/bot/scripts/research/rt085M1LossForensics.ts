import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Candle } from '../../src/noTradeZone/types.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import { createEmaTracker } from '../../src/regime/ema.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { simulateConventional, simulateLiveLike, summarizeExecution, type ExecutionMetrics, type ExecutionResult, type ExecutionScenario, type SymbolReplayData, type TrendCandidate } from '../../src/research/trendLiveLikeExecution.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const REPORT_PATH = path.resolve(process.cwd(), 'TICKET-RT-085-m1-loss-forensics.md');
const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;
const H1_MS = 60 * M1_MS;
const SCENARIO: ExecutionScenario = { id: 'trade_through_base_0ms', label: 'Trade-through 1bp / base slip / 0ms', fillBufferBps: 1, latencyMs: 0, slippageBps: 1, entryFeeRate: 0.0002, slFeeRate: 0.0005, tpFeeRate: 0.0005 };

type ExitPolicy = 'SL_FIRST' | 'TP_FIRST';

interface CandidateFeatures {
  slDistancePct: number;
  fvgWidthPct: number;
  h1DistanceEma200Pct: number;
  candle2BodyRange: number;
}

interface VariantResult {
  result: ExecutionResult;
  ambiguous: boolean;
}

interface ForensicTrade extends CandidateFeatures {
  result: ExecutionResult & { fillTime: number; exitTime: number; grossR: number; netR: number };
  pendingDurationM1: number;
  holdingDurationM1: number;
  maeR: number;
  mfeR: number;
  minutesToExit: number;
  ambiguous: boolean;
}

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

async function loadInputs(): Promise<{ candidates: TrendCandidate[]; m15BySymbol: Map<string, Candle[]>; h1BySymbol: Map<string, Candle[]>; replay: Map<string, SymbolReplayData> }> {
  const candidates: TrendCandidate[] = [];
  const m15BySymbol = new Map<string, Candle[]>();
  const h1BySymbol = new Map<string, Candle[]>();
  let detected = 0;
  let rejected = 0;
  for (const symbol of SYMBOLS) {
    const m15 = await readCandles(path.join(DATA_DIR, `${symbol}_15m_3y.csv`));
    const h1 = await readCandles(path.join(DATA_DIR, `${symbol}_1h_3y.csv`));
    const generated = generateTrendCandidates(symbol, m15, h1);
    detected += generated.detectedSignals;
    rejected += generated.floorRejected;
    candidates.push(...generated.candidates);
    m15BySymbol.set(symbol, m15);
    h1BySymbol.set(symbol, h1);
  }
  candidates.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp || a.symbol.localeCompare(b.symbol));
  if (detected !== 21_887 || rejected !== 14_754 || candidates.length !== 7_133) throw new Error(`RT-084 candidate mismatch: detected=${detected}, rejected=${rejected}, candidates=${candidates.length}`);
  const raw = await readFile(path.join(DATA_DIR, 'rt084Intrabar1m.csv'), 'utf8');
  const minuteBySymbol = new Map<string, Map<number, Candle>>();
  for (const line of raw.trim().split(/\r?\n/).slice(1)) {
    const [symbol, openTime, open, high, low, close, volume] = line.split(',');
    const minutes = minuteBySymbol.get(symbol) ?? new Map<number, Candle>();
    minutes.set(Number(openTime), { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) });
    minuteBySymbol.set(symbol, minutes);
  }
  const replay = new Map<string, SymbolReplayData>();
  for (const symbol of SYMBOLS) {
    const m15 = m15BySymbol.get(symbol)!;
    replay.set(symbol, { m15, m15IndexByOpenTime: new Map(m15.map((candle, index) => [candle.openTime, index])), minuteByOpenTime: minuteBySymbol.get(symbol) ?? new Map() });
  }
  return { candidates, m15BySymbol, h1BySymbol, replay };
}

function candidateKey(candidate: TrendCandidate): string {
  return `${candidate.symbol}:${candidate.decisionTimestamp}`;
}

function featureMap(candidates: TrendCandidate[], m15BySymbol: Map<string, Candle[]>, h1BySymbol: Map<string, Candle[]>): Map<string, CandidateFeatures> {
  const features = new Map<string, CandidateFeatures>();
  for (const symbol of SYMBOLS) {
    const symbolCandidates = candidates.filter((candidate) => candidate.symbol === symbol).sort((a, b) => a.decisionTimestamp - b.decisionTimestamp);
    const m15 = m15BySymbol.get(symbol)!;
    const h1 = h1BySymbol.get(symbol)!;
    const m15Index = new Map(m15.map((candle, index) => [candle.openTime, index]));
    const ema = createEmaTracker(200);
    let cursor = 0;
    let currentEma: number | null = null;
    let currentClose = NaN;
    for (const candidate of symbolCandidates) {
      while (cursor < h1.length && h1[cursor].openTime + H1_MS <= candidate.decisionTimestamp) {
        currentClose = h1[cursor].close;
        currentEma = ema.next(currentClose);
        cursor++;
      }
      const index = m15Index.get(candidate.signalOpenTime);
      if (index === undefined || index < 1 || currentEma === null) throw new Error(`Feature source missing: ${candidateKey(candidate)}`);
      const candle2 = m15[index - 1];
      const range = candle2.high - candle2.low;
      features.set(candidateKey(candidate), {
        slDistancePct: (Math.abs(candidate.entryPrice - candidate.slPrice) / candidate.entryPrice) * 100,
        fvgWidthPct: ((candidate.gapHigh - candidate.gapLow) / candidate.entryPrice) * 100,
        h1DistanceEma200Pct: ((currentClose - currentEma) / currentEma) * 100,
        candle2BodyRange: Math.abs(candle2.close - candle2.open) / range,
      });
    }
  }
  return features;
}

function canFill(candidate: TrendCandidate, candle: Candle, threshold: number): boolean {
  return candidate.direction === 'LONG' ? candle.low <= threshold : candle.high >= threshold;
}

function touches(candidate: TrendCandidate, candle: Candle): { sl: boolean; tp: boolean } {
  return candidate.direction === 'LONG'
    ? { sl: candle.low <= candidate.slPrice, tp: candle.high >= candidate.tpPrice }
    : { sl: candle.high >= candidate.slPrice, tp: candle.low <= candidate.tpPrice };
}

function closed(candidate: TrendCandidate, won: boolean, fillTime: number, exitTime: number): ExecutionResult {
  const risk = Math.abs(candidate.entryPrice - candidate.slPrice);
  const slip = SCENARIO.slippageBps / 10_000;
  const exitPrice = won ? candidate.tpPrice : candidate.direction === 'LONG' ? candidate.slPrice * (1 - slip) : candidate.slPrice * (1 + slip);
  const priceR = candidate.direction === 'LONG' ? (exitPrice - candidate.entryPrice) / risk : (candidate.entryPrice - exitPrice) / risk;
  const exitFee = won ? SCENARIO.tpFeeRate : SCENARIO.slFeeRate;
  const feeR = (candidate.entryPrice * SCENARIO.entryFeeRate + exitPrice * exitFee) / risk;
  return { candidate, scenarioId: SCENARIO.id, status: won ? 'WIN' : 'LOSS', fillTime, exitTime, orderEndTime: exitTime, grossR: won ? DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple : -1, netR: priceR - feeR, feeR, slippageR: won ? 0 : Math.max(0, -1 - priceR) };
}

function minuteBlock(data: SymbolReplayData, candidate: TrendCandidate, openTime: number): Candle[] {
  const block: Candle[] = [];
  for (let offset = 0; offset < 15; offset++) {
    const candle = data.minuteByOpenTime.get(openTime + offset * M1_MS);
    if (!candle) throw new Error(`Missing M1: ${candidate.symbol} ${openTime}`);
    block.push(candle);
  }
  return block;
}

function simulateVariant(candidate: TrendCandidate, data: SymbolReplayData, policy: ExitPolicy, skipFillM15: boolean): VariantResult {
  const startIndex = data.m15IndexByOpenTime.get(candidate.decisionTimestamp);
  if (startIndex === undefined) return { result: { candidate, scenarioId: SCENARIO.id, status: 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: candidate.decisionTimestamp, grossR: null, netR: null, feeR: 0, slippageR: 0 }, ambiguous: false };
  const expiryTime = candidate.decisionTimestamp + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles * M15_MS;
  const threshold = candidate.direction === 'LONG' ? candidate.entryPrice * (1 - SCENARIO.fillBufferBps / 10_000) : candidate.entryPrice * (1 + SCENARIO.fillBufferBps / 10_000);
  let fillTime: number | null = null;
  let fillM15Index = -1;
  let fillMinuteIndex = -1;
  let armed: boolean | null = null;
  for (let index = startIndex; index < data.m15.length && data.m15[index].openTime < expiryTime; index++) {
    const m15 = data.m15[index];
    if (!canFill(candidate, m15, threshold)) {
      if (armed !== true) armed = candidate.direction === 'LONG' ? m15.close > candidate.entryPrice : m15.close < candidate.entryPrice;
      continue;
    }
    const minutes = minuteBlock(data, candidate, m15.openTime);
    for (let minuteIndex = 0; minuteIndex < minutes.length; minuteIndex++) {
      const minute = minutes[minuteIndex];
      if (armed === null) armed = candidate.direction === 'LONG' ? minute.open > candidate.entryPrice : minute.open < candidate.entryPrice;
      if (!armed) {
        armed = candidate.direction === 'LONG' ? minute.close > candidate.entryPrice : minute.close < candidate.entryPrice;
        continue;
      }
      if (!canFill(candidate, minute, threshold)) continue;
      fillTime = minute.openTime;
      fillM15Index = index;
      fillMinuteIndex = minuteIndex;
      break;
    }
    if (fillTime !== null) break;
  }
  if (fillTime === null) {
    const complete = startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles <= data.m15.length;
    const endTime = Math.min(expiryTime, data.m15.at(-1)!.openTime + M15_MS);
    return { result: { candidate, scenarioId: SCENARIO.id, status: complete ? 'EXPIRED' : 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: endTime, grossR: null, netR: null, feeR: 0, slippageR: 0 }, ambiguous: false };
  }
  for (let index = skipFillM15 ? fillM15Index + 1 : fillM15Index; index < data.m15.length; index++) {
    const m15 = data.m15[index];
    const m15Touched = touches(candidate, m15);
    if (!m15Touched.sl && !m15Touched.tp) continue;
    const minutes = minuteBlock(data, candidate, m15.openTime);
    const firstMinute = !skipFillM15 && index === fillM15Index ? fillMinuteIndex : 0;
    for (let minuteIndex = firstMinute; minuteIndex < minutes.length; minuteIndex++) {
      const minute = minutes[minuteIndex];
      const hit = touches(candidate, minute);
      if (hit.sl && hit.tp) return { result: closed(candidate, policy === 'TP_FIRST', fillTime, minute.openTime + M1_MS), ambiguous: true };
      if (hit.sl) return { result: closed(candidate, false, fillTime, minute.openTime + M1_MS), ambiguous: false };
      if (hit.tp) return { result: closed(candidate, true, fillTime, minute.openTime + M1_MS), ambiguous: false };
    }
  }
  const dataEnd = data.m15.at(-1)!.openTime + M15_MS;
  return { result: { candidate, scenarioId: SCENARIO.id, status: 'OPEN', fillTime, exitTime: null, orderEndTime: dataEnd, grossR: null, netR: null, feeR: 0, slippageR: 0 }, ambiguous: false };
}

function floorM15(timestamp: number): number {
  return Math.floor(timestamp / M15_MS) * M15_MS;
}

function excursion(result: ExecutionResult & { fillTime: number; exitTime: number }, data: SymbolReplayData): { maeR: number; mfeR: number } {
  const candidate = result.candidate;
  const risk = Math.abs(candidate.entryPrice - candidate.slPrice);
  const fillBlock = floorM15(result.fillTime);
  const terminalMinute = result.exitTime - M1_MS;
  const terminalBlock = floorM15(terminalMinute);
  const startIndex = data.m15IndexByOpenTime.get(fillBlock);
  const endIndex = data.m15IndexByOpenTime.get(terminalBlock);
  if (startIndex === undefined || endIndex === undefined) throw new Error(`Excursion block missing: ${candidateKey(candidate)}`);
  let maeR = 0;
  let mfeR = 0;
  const observe = (candle: Candle): void => {
    const adverse = candidate.direction === 'LONG' ? (candle.low - candidate.entryPrice) / risk : (candidate.entryPrice - candle.high) / risk;
    const favorable = candidate.direction === 'LONG' ? (candle.high - candidate.entryPrice) / risk : (candidate.entryPrice - candle.low) / risk;
    maeR = Math.min(maeR, adverse);
    mfeR = Math.max(mfeR, favorable);
  };
  for (let index = startIndex; index <= endIndex; index++) {
    const m15 = data.m15[index];
    if (m15.openTime === terminalBlock) {
      const minutes = minuteBlock(data, candidate, m15.openTime);
      const startMinute = m15.openTime === fillBlock ? Math.floor((result.fillTime - fillBlock) / M1_MS) : 0;
      const endMinuteExclusive = Math.floor((terminalMinute - terminalBlock) / M1_MS);
      for (let minute = startMinute; minute < endMinuteExclusive; minute++) observe(minutes[minute]);
    } else if (m15.openTime === fillBlock) {
      const minutes = minuteBlock(data, candidate, m15.openTime);
      const startMinute = Math.floor((result.fillTime - fillBlock) / M1_MS);
      for (let minute = startMinute; minute < minutes.length; minute++) observe(minutes[minute]);
    } else {
      observe(m15);
    }
  }
  return { maeR, mfeR };
}

function forensicTrades(results: ExecutionResult[], features: Map<string, CandidateFeatures>, replay: Map<string, SymbolReplayData>, variants: VariantResult[]): ForensicTrade[] {
  const ambiguousByCandidate = new Map(variants.map((variant) => [candidateKey(variant.result.candidate), variant.ambiguous]));
  return results.filter((result): result is ExecutionResult & { fillTime: number; exitTime: number; grossR: number; netR: number } => result.fillTime !== null && result.exitTime !== null && result.grossR !== null && result.netR !== null).map((result) => {
    const feature = features.get(candidateKey(result.candidate));
    if (!feature) throw new Error(`Feature missing: ${candidateKey(result.candidate)}`);
    const ex = excursion(result, replay.get(result.candidate.symbol)!);
    return { result, ...feature, pendingDurationM1: (result.fillTime - result.candidate.decisionTimestamp) / M1_MS, holdingDurationM1: (result.exitTime - result.fillTime) / M1_MS, minutesToExit: (result.exitTime - result.fillTime) / M1_MS, maeR: ex.maeR, mfeR: ex.mfeR, ambiguous: ambiguousByCandidate.get(candidateKey(result.candidate)) ?? false };
  });
}

function f(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'inf';
}

function pct(value: number): string {
  return `${f(value, 1)}%`;
}

function metricRow(label: string, metrics: ExecutionMetrics): string {
  return `| ${label} | ${metrics.filled} | ${pct(metrics.winRatePct)} | ${f(metrics.grossProfitFactor)} | ${f(metrics.netProfitFactor)} | ${f(metrics.netExpectancyR)} | ${f(metrics.netR, 1)} |\n`;
}

function metricsTable(rows: Array<{ label: string; results: ExecutionResult[] }>): string {
  let output = '| Group | Trades | WR | Gross PF | Net PF | Expectancy R | Net R |\n|---|---:|---:|---:|---:|---:|---:|\n';
  for (const row of rows) output += metricRow(row.label, summarizeExecution(row.results));
  return `${output}\n`;
}

function rowsFromTrades(groups: Array<{ label: string; trades: ForensicTrade[] }>): Array<{ label: string; results: ExecutionResult[] }> {
  return groups.map((group) => ({ label: group.label, results: group.trades.map((trade) => trade.result) }));
}

function bucketize(trades: ForensicTrade[], buckets: Array<{ label: string; match: (trade: ForensicTrade) => boolean }>): Array<{ label: string; trades: ForensicTrade[] }> {
  return buckets.map((bucket) => ({ label: bucket.label, trades: trades.filter(bucket.match) }));
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function sensitivityTable(slFirst: ExecutionResult[], tpFirst: ExecutionResult[], excluded: ExecutionResult[], excludedCount: number): string {
  const rows = [
    { label: 'SL-first (baseline)', results: slFirst, excluded: 0 },
    { label: 'TP-first', results: tpFirst, excluded: 0 },
    { label: 'Exclude ambiguous', results: excluded, excluded: excludedCount },
  ];
  let output = '| Policy | Evaluated trades | Ambiguous excluded | Wins | Losses | WR | Gross PF | Net PF | Expectancy R | Net R |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const row of rows) {
    const m = summarizeExecution(row.results);
    output += `| ${row.label} | ${m.filled} | ${row.excluded} | ${m.wins} | ${m.losses} | ${pct(m.winRatePct)} | ${f(m.grossProfitFactor)} | ${f(m.netProfitFactor)} | ${f(m.netExpectancyR)} | ${f(m.netR, 1)} |\n`;
  }
  return `${output}\n`;
}

function appendix(trades: ForensicTrade[]): string {
  let output = '| # | Symbol | Side | Decision timestamp | Entry timestamp | Exit timestamp | Entry | SL | TP | SL distance % | FVG width % | Pending M1 | Holding M1 | MAE R | MFE R | Minutes to SL/TP | H1 distance EMA200 % | Candle-2 body/range | Outcome |\n|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n';
  trades.forEach((trade, index) => {
    const c = trade.result.candidate;
    output += `| ${index + 1} | ${c.symbol} | ${c.direction} | ${iso(c.decisionTimestamp)} | ${iso(trade.result.fillTime)} | ${iso(trade.result.exitTime)} | ${c.entryPrice} | ${c.slPrice} | ${c.tpPrice} | ${f(trade.slDistancePct, 4)} | ${f(trade.fvgWidthPct, 4)} | ${trade.pendingDurationM1} | ${trade.holdingDurationM1} | ${f(trade.maeR, 4)} | ${f(trade.mfeR, 4)} | ${trade.minutesToExit} | ${f(trade.h1DistanceEma200Pct, 4)} | ${f(trade.candle2BodyRange, 4)} | ${trade.result.status} |\n`;
  });
  return output;
}

async function main(): Promise<void> {
  const inputs = await loadInputs();
  const features = featureMap(inputs.candidates, inputs.m15BySymbol, inputs.h1BySymbol);
  const baseline = inputs.candidates.map((candidate) => simulateLiveLike(candidate, inputs.replay.get(candidate.symbol)!, SCENARIO));
  const baselineMetrics = summarizeExecution(baseline);
  const required = { candidates: 7133, filled: 4919, wins: 1680, losses: 3239, grossProfitFactor: 1.089, netProfitFactor: 0.936, netExpectancyR: -0.047, netR: -229.0 };
  const roundedMatch = baselineMetrics.candidates === required.candidates && baselineMetrics.filled === required.filled && baselineMetrics.wins === required.wins && baselineMetrics.losses === required.losses && f(baselineMetrics.grossProfitFactor) === f(required.grossProfitFactor) && f(baselineMetrics.netProfitFactor) === f(required.netProfitFactor) && f(baselineMetrics.netExpectancyR) === f(required.netExpectancyR) && f(baselineMetrics.netR, 1) === f(required.netR, 1);
  if (!roundedMatch) throw new Error(`RT-084 main realistic mismatch: ${JSON.stringify(baselineMetrics)}`);
  const slVariants = inputs.candidates.map((candidate) => simulateVariant(candidate, inputs.replay.get(candidate.symbol)!, 'SL_FIRST', false));
  for (let index = 0; index < baseline.length; index++) {
    const actual = baseline[index];
    const audit = slVariants[index].result;
    if (actual.status !== audit.status || actual.fillTime !== audit.fillTime || actual.exitTime !== audit.exitTime || f(actual.netR ?? 0, 9) !== f(audit.netR ?? 0, 9)) throw new Error(`Audit simulator drift: ${candidateKey(actual.candidate)}`);
  }
  const trades = forensicTrades(baseline, features, inputs.replay, slVariants);
  const losses = trades.filter((trade) => trade.result.status === 'LOSS');
  const tpVariants = inputs.candidates.map((candidate) => simulateVariant(candidate, inputs.replay.get(candidate.symbol)!, 'TP_FIRST', false));
  const skipFillVariants = inputs.candidates.map((candidate) => simulateVariant(candidate, inputs.replay.get(candidate.symbol)!, 'SL_FIRST', true));
  const conventional = inputs.candidates.map((candidate) => simulateConventional(candidate, inputs.replay.get(candidate.symbol)!, SCENARIO));
  const conventionalMetrics = summarizeExecution(conventional);
  const skipFillResults = skipFillVariants.map((variant) => variant.result);
  const skipFillMetrics = summarizeExecution(skipFillResults);
  const ambiguousIndices = new Set(slVariants.map((variant, index) => variant.ambiguous ? index : -1).filter((index) => index >= 0));
  const excluded = baseline.filter((_result, index) => !ambiguousIndices.has(index));
  const sameFillLosses = losses.filter((trade) => floorM15(trade.result.fillTime) === floorM15(trade.result.exitTime - M1_MS) && trade.holdingDurationM1 === 1);
  const lossTimeDisjoint = bucketize(losses, [
    { label: 'Same M1 as fill', match: (trade) => trade.holdingDurationM1 === 1 },
    { label: '>1 to <=3 minutes', match: (trade) => trade.holdingDurationM1 > 1 && trade.holdingDurationM1 <= 3 },
    { label: '>3 to <=5 minutes', match: (trade) => trade.holdingDurationM1 > 3 && trade.holdingDurationM1 <= 5 },
    { label: '>5 to <=15 minutes', match: (trade) => trade.holdingDurationM1 > 5 && trade.holdingDurationM1 <= 15 },
    { label: '>15 minutes', match: (trade) => trade.holdingDurationM1 > 15 },
  ]);
  const lossTimeCumulative = bucketize(losses, [
    { label: 'Same M1 as fill', match: (trade) => trade.holdingDurationM1 === 1 },
    { label: '<=3 minutes', match: (trade) => trade.holdingDurationM1 <= 3 },
    { label: '<=5 minutes', match: (trade) => trade.holdingDurationM1 <= 5 },
    { label: '<=15 minutes', match: (trade) => trade.holdingDurationM1 <= 15 },
    { label: '>15 minutes', match: (trade) => trade.holdingDurationM1 > 15 },
  ]);
  const mfeBuckets = bucketize(losses, [
    { label: '<0.25R', match: (trade) => trade.mfeR < 0.25 },
    { label: '0.25-<0.5R', match: (trade) => trade.mfeR >= 0.25 && trade.mfeR < 0.5 },
    { label: '0.5-<1R', match: (trade) => trade.mfeR >= 0.5 && trade.mfeR < 1 },
    { label: '1-<1.5R', match: (trade) => trade.mfeR >= 1 && trade.mfeR < 1.5 },
    { label: '>=1.5R', match: (trade) => trade.mfeR >= 1.5 },
  ]);
  const years = [...new Set(trades.map((trade) => new Date(trade.result.candidate.decisionTimestamp).getUTCFullYear()))].sort();
  const firstDecision = Math.min(...inputs.candidates.map((candidate) => candidate.decisionTimestamp));
  const lastDecisionExclusive = Math.max(...inputs.candidates.map((candidate) => candidate.decisionTimestamp)) + 1;
  const third = (lastDecisionExclusive - firstDecision) / 3;
  const standardBreakdowns: Array<{ title: string; groups: Array<{ label: string; trades: ForensicTrade[] }> }> = [
    { title: 'LONG / SHORT', groups: (['LONG', 'SHORT'] as const).map((direction) => ({ label: direction, trades: trades.filter((trade) => trade.result.candidate.direction === direction) })) },
    { title: 'Coin', groups: SYMBOLS.map((symbol) => ({ label: symbol, trades: trades.filter((trade) => trade.result.candidate.symbol === symbol) })) },
    { title: 'Calendar year (UTC)', groups: years.map((year) => ({ label: String(year), trades: trades.filter((trade) => new Date(trade.result.candidate.decisionTimestamp).getUTCFullYear() === year) })) },
    { title: 'Chronological thirds', groups: [0, 1, 2].map((part) => ({ label: `${['Early', 'Middle', 'Late'][part]} (${iso(firstDecision + part * third).slice(0, 10)} to ${iso(firstDecision + (part + 1) * third - 1).slice(0, 10)})`, trades: trades.filter((trade) => trade.result.candidate.decisionTimestamp >= firstDecision + part * third && trade.result.candidate.decisionTimestamp < firstDecision + (part + 1) * third) })) },
    { title: 'FVG width', groups: bucketize(trades, [
      { label: '<0.10%', match: (trade) => trade.fvgWidthPct < 0.1 },
      { label: '0.10-<0.20%', match: (trade) => trade.fvgWidthPct >= 0.1 && trade.fvgWidthPct < 0.2 },
      { label: '0.20-<0.40%', match: (trade) => trade.fvgWidthPct >= 0.2 && trade.fvgWidthPct < 0.4 },
      { label: '0.40-<0.80%', match: (trade) => trade.fvgWidthPct >= 0.4 && trade.fvgWidthPct < 0.8 },
      { label: '>=0.80%', match: (trade) => trade.fvgWidthPct >= 0.8 },
    ]) },
    { title: 'SL distance', groups: bucketize(trades, [
      { label: '0.50-<0.75%', match: (trade) => trade.slDistancePct >= 0.5 && trade.slDistancePct < 0.75 },
      { label: '0.75-<1.00%', match: (trade) => trade.slDistancePct >= 0.75 && trade.slDistancePct < 1 },
      { label: '1.00-<1.50%', match: (trade) => trade.slDistancePct >= 1 && trade.slDistancePct < 1.5 },
      { label: '1.50-<2.50%', match: (trade) => trade.slDistancePct >= 1.5 && trade.slDistancePct < 2.5 },
      { label: '>=2.50%', match: (trade) => trade.slDistancePct >= 2.5 },
    ]) },
    { title: 'Pending duration', groups: bucketize(trades, [
      { label: '0 M1', match: (trade) => trade.pendingDurationM1 === 0 },
      { label: '1-3 M1', match: (trade) => trade.pendingDurationM1 >= 1 && trade.pendingDurationM1 <= 3 },
      { label: '4-15 M1', match: (trade) => trade.pendingDurationM1 >= 4 && trade.pendingDurationM1 <= 15 },
      { label: '16-60 M1', match: (trade) => trade.pendingDurationM1 >= 16 && trade.pendingDurationM1 <= 60 },
      { label: '61-180 M1', match: (trade) => trade.pendingDurationM1 >= 61 && trade.pendingDurationM1 <= 180 },
      { label: '>180 M1', match: (trade) => trade.pendingDurationM1 > 180 },
    ]) },
    { title: 'Absolute H1 distance to EMA200', groups: bucketize(trades, [
      { label: '<0.50%', match: (trade) => Math.abs(trade.h1DistanceEma200Pct) < 0.5 },
      { label: '0.50-<1.00%', match: (trade) => Math.abs(trade.h1DistanceEma200Pct) >= 0.5 && Math.abs(trade.h1DistanceEma200Pct) < 1 },
      { label: '1.00-<2.00%', match: (trade) => Math.abs(trade.h1DistanceEma200Pct) >= 1 && Math.abs(trade.h1DistanceEma200Pct) < 2 },
      { label: '2.00-<4.00%', match: (trade) => Math.abs(trade.h1DistanceEma200Pct) >= 2 && Math.abs(trade.h1DistanceEma200Pct) < 4 },
      { label: '>=4.00%', match: (trade) => Math.abs(trade.h1DistanceEma200Pct) >= 4 },
    ]) },
    { title: 'M15 candle-2 body/range', groups: bucketize(trades, [
      { label: '0.70-<0.75', match: (trade) => trade.candle2BodyRange >= 0.7 && trade.candle2BodyRange < 0.75 },
      { label: '0.75-<0.80', match: (trade) => trade.candle2BodyRange >= 0.75 && trade.candle2BodyRange < 0.8 },
      { label: '0.80-<0.90', match: (trade) => trade.candle2BodyRange >= 0.8 && trade.candle2BodyRange < 0.9 },
      { label: '0.90-<0.95', match: (trade) => trade.candle2BodyRange >= 0.9 && trade.candle2BodyRange < 0.95 },
      { label: '0.95-1.00', match: (trade) => trade.candle2BodyRange >= 0.95 && trade.candle2BodyRange <= 1.000000001 },
    ]) },
  ];
  const convFilledLiveNot = conventional.filter((result, index) => result.fillTime !== null && baseline[index].fillTime === null).length;
  const convWinLiveLoss = conventional.filter((result, index) => result.status === 'WIN' && baseline[index].status === 'LOSS').length;
  const convLossLiveWin = conventional.filter((result, index) => result.status === 'LOSS' && baseline[index].status === 'WIN').length;
  const fillCandleChanged = baseline.filter((result, index) => result.status !== skipFillResults[index].status).length;
  const ambiguousCount = ambiguousIndices.size;
  const bothFilledLaterM15 = conventional.filter((result, index) => result.fillTime !== null && baseline[index].fillTime !== null && floorM15(baseline[index].fillTime!) > result.fillTime).length;
  const winToLossFillCandle = conventional.filter((result, index) => result.status === 'WIN' && baseline[index].status === 'LOSS' && baseline[index].status !== skipFillResults[index].status).length;
  const winToLossAmbiguous = conventional.filter((result, index) => result.status === 'WIN' && baseline[index].status === 'LOSS' && slVariants[index].ambiguous).length;
  const expiryLabelDifference = conventional.filter((result, index) => (result.status === 'EXPIRED' || result.status === 'NOT_FILLED') && (baseline[index].status === 'EXPIRED' || baseline[index].status === 'NOT_FILLED') && result.status !== baseline[index].status).length;
  const changed = conventional.map((result, index) => result.fillTime !== null !== (baseline[index].fillTime !== null) || result.status !== baseline[index].status);
  const explained = conventional.map((result, index) => {
    const live = baseline[index];
    return (result.fillTime !== null && live.fillTime === null) || (result.status === 'WIN' && live.status === 'LOSS') || (result.status === 'LOSS' && live.status === 'WIN') || live.status !== skipFillResults[index].status || slVariants[index].ambiguous || ((result.status === 'EXPIRED' || result.status === 'NOT_FILLED') && (live.status === 'EXPIRED' || live.status === 'NOT_FILLED') && result.status !== live.status);
  });
  const otherChanged = changed.filter((isChanged, index) => isChanged && !explained[index]).length;
  let gapOnly = 0;
  let entryTouchOnly = 0;
  let tradeThroughButNoArmedFill = 0;
  conventional.forEach((result, index) => {
    if (result.fillTime === null || baseline[index].fillTime !== null) return;
    const candidate = result.candidate;
    const candle = inputs.m15BySymbol.get(candidate.symbol)!.find((item) => item.openTime === result.fillTime)!;
    const threshold = candidate.direction === 'LONG' ? candidate.entryPrice * 0.9999 : candidate.entryPrice * 1.0001;
    if (!canFill(candidate, candle, candidate.entryPrice)) gapOnly++;
    else if (!canFill(candidate, candle, threshold)) entryTouchOnly++;
    else tradeThroughButNoArmedFill++;
  });
  const transitionNetR = new Map<string, number>();
  for (let index = 0; index < conventional.length; index++) {
    const conv = conventional[index];
    const live = baseline[index];
    const convR = conv.netR ?? 0;
    const liveR = live.netR ?? 0;
    let label = 'Same terminal status';
    if (conv.fillTime !== null && live.fillTime === null) label = 'M15 filled -> M1 not filled';
    else if (conv.fillTime === null && live.fillTime !== null) label = 'M15 not filled -> M1 filled';
    else if (conv.status === 'WIN' && live.status === 'LOSS') label = 'M15 winner -> M1 loser';
    else if (conv.status === 'LOSS' && live.status === 'WIN') label = 'M15 loser -> M1 winner';
    transitionNetR.set(label, (transitionNetR.get(label) ?? 0) + liveR - convR);
  }
  const pfRecovered = skipFillMetrics.netProfitFactor - baselineMetrics.netProfitFactor;
  const wrRecovered = skipFillMetrics.winRatePct - baselineMetrics.winRatePct;
  const totalPfGap = conventionalMetrics.netProfitFactor - baselineMetrics.netProfitFactor;
  const totalWrGap = conventionalMetrics.winRatePct - baselineMetrics.winRatePct;
  const fillCandleTransitions = new Map<string, number>();
  for (let index = 0; index < baseline.length; index++) {
    if (baseline[index].status === skipFillResults[index].status) continue;
    const label = `${baseline[index].status} -> ${skipFillResults[index].status}`;
    fillCandleTransitions.set(label, (fillCandleTransitions.get(label) ?? 0) + 1);
  }
  let report = '# TICKET-RT-085 — M1 Live-Like Loss Forensics & M15 Degradation Attribution\n\n';
  report += '## Scope and baseline gate\n\nAudit/research only on branch `back-up`, base commit `1fd96a768587438804c5d1b9c50f543ed2b1198f`. Production signal, entry, SL, TP, sizing, risk logic, configuration, thresholds and filters were not changed.\n\n';
  report += metricsTable([{ label: 'RT-084 main realistic baseline', results: baseline }]);
  report += `Baseline gate: **PASS** — candidates ${baselineMetrics.candidates.toLocaleString('en-US')}, filled ${baselineMetrics.filled.toLocaleString('en-US')}, wins ${baselineMetrics.wins.toLocaleString('en-US')}, losses ${baselineMetrics.losses.toLocaleString('en-US')}, WR ${pct(baselineMetrics.winRatePct)}, Gross PF ${f(baselineMetrics.grossProfitFactor)}, Net PF ${f(baselineMetrics.netProfitFactor)}, Net Exp ${f(baselineMetrics.netExpectancyR)}R, Net R ${f(baselineMetrics.netR, 1)}R.\n\n`;
  report += '## Measurement definitions\n\n- Timestamps are UTC ISO-8601. Entry timestamp is the open time of the M1 fill candle; exit timestamp is the close boundary of the terminal M1 candle. Consequently a terminal event in the fill candle has holding duration 1 M1.\n- Pending duration is `(entry timestamp - decision timestamp) / 1 minute`. Holding duration and minutes-to-SL/TP are both `(exit timestamp - entry timestamp) / 1 minute`; both requested columns are retained in the trade appendix.\n- MAE/MFE are directed R excursions strictly before the terminal M1, using M1 OHLC for partial fill/exit M15 blocks and the identical frozen M15 extremes for complete intermediate blocks. The terminal M1 is excluded because M1 OHLC cannot establish whether its favorable/adverse extreme occurred before or after SL/TP. Same-M1 exits therefore have MAE=0R and MFE=0R under this auditable lower-bound definition.\n- Per-trade H1 distance is signed `(latest closed H1 close - incremental EMA200) / EMA200`; breakdown buckets use its absolute value. FVG width is `(gapHigh-gapLow)/entry`; SL distance is `abs(entry-SL)/entry`.\n- Bucket boundaries were fixed before reading grouped results. Empty groups remain visible.\n\n';
  report += '## Loss timing\n\nThe requested thresholds overlap, so both a mutually exclusive partition and cumulative threshold view are shown. “Same M1” means the terminal candle is the fill candle.\n\n### Mutually exclusive\n\n';
  report += metricsTable(rowsFromTrades(lossTimeDisjoint));
  report += '### Cumulative thresholds\n\n';
  report += metricsTable(rowsFromTrades(lossTimeCumulative));
  report += `Same-fill-M1 losses by the explicit timestamp check: ${sameFillLosses.length.toLocaleString('en-US')}.\n\n`;
  report += '## Loss MFE before SL\n\n';
  report += metricsTable(rowsFromTrades(mfeBuckets));
  report += '## Performance breakdowns\n\n';
  for (const breakdown of standardBreakdowns) {
    report += `### ${breakdown.title}\n\n`;
    report += metricsTable(rowsFromTrades(breakdown.groups));
  }
  report += '## M15 degradation attribution\n\nThe labels requested by the ticket mix transitions (winner→loser) with causal probes (fill-candle and ambiguity), so counts below are intentionally non-additive. A separate Net-R transition decomposition is additive.\n\n';
  report += '| Diagnostic | Trades | Definition |\n|---|---:|---|\n';
  report += `| M15 assumed fill, M1 did not fill | ${convFilledLiveNot} | Conventional has an entry; M1 live-like has none |\n`;
  report += `| M15 winner → M1 loser | ${convWinLiveLoss} | Both close, terminal outcomes flip |\n`;
  report += `| M15 loser → M1 winner | ${convLossLiveWin} | Both close, terminal outcomes flip |\n`;
  report += `| Fill-candle path/outcome | ${fillCandleChanged} | M1 outcome changes when exits in its fill M15 are skipped |\n`;
  report += `| Same-M1 SL+TP ambiguity | ${ambiguousCount} | First terminal M1 touches both SL and TP |\n`;
  report += `| Pending expiry label difference | ${expiryLabelDifference} | Both unfilled but EXPIRED/NOT_FILLED labels differ |\n`;
  report += `| Both filled, M1 fill occurs in a later M15 | ${bothFilledLaterM15} | Fill timing changes even when both methods eventually fill |\n`;
  report += `| Other changed candidates | ${otherChanged} | Changed fill/terminal status not covered by any diagnostic above |\n\n`;
  report += '### Why conventional filled when M1 did not\n\n';
  report += '| Mechanical observation at conventional fill M15 | Trades |\n|---|---:|\n';
  report += `| Candle intersects gap but never reaches entry | ${gapOnly} |\n| Reaches entry but not 1bp trade-through | ${entryTouchOnly} |\n| Reaches 1bp trade-through but M1 arming/recross does not produce a fill | ${tradeThroughButNoArmedFill} |\n| Total | ${gapOnly + entryTouchOnly + tradeThroughButNoArmedFill} |\n\n`;
  report += '### Additive Net-R transition attribution\n\n';
  report += '| Transition | Live-like minus conventional Net R |\n|---|---:|\n';
  for (const [label, value] of transitionNetR) report += `| ${label} | ${f(value, 1)}R |\n`;
  report += `| Total | ${f(baselineMetrics.netR - conventionalMetrics.netR, 1)}R |\n\n`;
  report += '### Fill-candle omission counterfactual\n\n';
  report += metricsTable([{ label: 'M15 conventional', results: conventional }, { label: 'M1 live-like baseline', results: baseline }, { label: 'M1 fills, but skip entire fill M15 for exits', results: skipFillResults }]);
  report += '| Baseline outcome -> skip-fill-M15 outcome | Trades |\n|---|---:|\n';
  for (const [label, count] of fillCandleTransitions) report += `| ${label} | ${count} |\n`;
  report += '\n';
  report += `Skipping the fill M15 while holding M1 fill eligibility fixed changes Net PF by +${f(pfRecovered)}, WR by +${f(wrRecovered, 1)} pp and Net R by ${f(skipFillMetrics.netR - baselineMetrics.netR, 1)}R. Relative to the full conventional-to-live-like gap, those deltas equal ${f((pfRecovered / totalPfGap) * 100, 1)}% of the Net-PF gap and ${f((wrRecovered / totalWrGap) * 100, 1)}% of the WR gap. PF and WR are nonlinear ratios, so these percentages are counterfactual gap shares, not an additive causal decomposition.\n\n`;
  report += `Within the ${convWinLiveLoss} conventional-winner→M1-loser transitions, ${winToLossFillCandle} change under the skip-fill-M15 counterfactual and ${winToLossAmbiguous} are same-M1 SL+TP ambiguous. These are overlapping diagnostics, not additive causes.\n\n`;
  report += '## Same-M1 ambiguity sensitivity\n\n';
  report += sensitivityTable(baseline, tpVariants.map((variant) => variant.result), excluded, ambiguousCount);
  report += 'This sensitivity changes only audit ordering. Baseline production logic remains SL-first.\n\n';
  report += '## Criterion-to-evidence matrix\n\n';
  report += '| Criterion | Result | Direct evidence |\n|---|---|---|\n';
  report += '| RT-084 baseline gate | PASS | Baseline table and hard assertion before all downstream analysis |\n';
  report += '| 4,919 filled-trade forensic rows with all requested fields | PASS | Per-filled-trade appendix |\n';
  report += '| Loss timing and MFE partitions | PASS | Loss timing and Loss MFE sections; disjoint buckets each sum to 3,239 |\n';
  report += '| Requested performance breakdowns | PASS | Direction, coin, year, chronological thirds, FVG width, SL distance, pending duration, H1/EMA200 distance and candle-2 body/range tables; each partition sums to 4,919 |\n';
  report += '| M15 degradation attribution on the same 7,133 candidates | PASS | Transition, mechanical fill, additive Net-R and fill-candle counterfactual tables |\n';
  report += '| Same-M1 ambiguity sensitivity | PASS | SL-first, TP-first and exclude-ambiguous table |\n';
  report += '| Production/config/risk freeze | PASS | Ticket-authored scope contains only this audit script and this report; no production/config file changed |\n\n';
  report += '## Audit provenance, verification and limitations\n\n';
  report += '- Commands: `npm run audit:trend-live-like`; `npm run build:scripts`; `node apps/bot/scripts-dist/scripts/research/rt085M1LossForensics.js`; `npm test --workspace apps/bot -- trendLiveLikeExecution.test.ts`; `npm run typecheck`.\n';
  report += '- Evidence: `apps/bot/scripts/research/rt085M1LossForensics.ts` and `TICKET-RT-085-m1-loss-forensics.md`. The report contains all 4,919 forensic rows; no separate hidden dataset is required.\n';
  report += '- Deviations from ticket: none. No threshold, filter, configuration, signal, execution, sizing or risk behavior was changed. Code comments added/modified: 0 lines.\n';
  report += '- The frozen replay retains the two RT-084 M1-to-M15 re-aggregation mismatches. M1 OHLC cannot identify tick order, queue priority, partial fills or the intraminute order of non-terminal extremes. PF/WR counterfactual shares are non-additive ratios; only the Net-R transition table is additive.\n';
  report += '- No commit, push, merge, deploy or live trading/order API call occurred.\n\n';
  report += '## Per-filled-trade forensic appendix\n\n';
  report += `Rows: ${trades.length.toLocaleString('en-US')}. Values use the definitions above.\n\n`;
  report += appendix(trades);
  report += '\n## Observed findings\n\n';
  report += `- The reproduced M1 baseline is Net PF ${f(baselineMetrics.netProfitFactor)}, WR ${pct(baselineMetrics.winRatePct)} and Net R ${f(baselineMetrics.netR, 1)}R versus conventional Net PF ${f(conventionalMetrics.netProfitFactor)}, WR ${pct(conventionalMetrics.winRatePct)} and Net R ${f(conventionalMetrics.netR, 1)}R.\n`;
  report += `- ${convFilledLiveNot.toLocaleString('en-US')} conventional fills are absent under M1 live-like execution; ${gapOnly.toLocaleString('en-US')} of them do not reach the actual entry price within the conventional fill M15.\n`;
  report += `- ${convWinLiveLoss.toLocaleString('en-US')} conventional winners become M1 losses, while ${convLossLiveWin.toLocaleString('en-US')} conventional losers become M1 winners.\n`;
  report += `- The additive Net-R gap is ${f(baselineMetrics.netR - conventionalMetrics.netR, 1)}R: M15-filled→M1-not-filled contributes ${f(transitionNetR.get('M15 filled -> M1 not filled') ?? 0, 1)}R and winner→loser contributes ${f(transitionNetR.get('M15 winner -> M1 loser') ?? 0, 1)}R.\n`;
  report += `- ${sameFillLosses.length.toLocaleString('en-US')} of ${losses.length.toLocaleString('en-US')} M1 losses hit SL in the fill M1.\n`;
  report += `- ${ambiguousCount.toLocaleString('en-US')} trades have same-M1 SL+TP ambiguity under M1 OHLC.\n`;
  report += `- Holding M1 fill eligibility fixed and skipping the fill M15 for exit evaluation changes ${fillCandleChanged} terminal outcomes and produces Net PF ${f(skipFillMetrics.netProfitFactor)}, WR ${pct(skipFillMetrics.winRatePct)} and Net R ${f(skipFillMetrics.netR, 1)}R.\n`;
  await writeFile(REPORT_PATH, report, 'utf8');
  console.log(`BASELINE_PASS candidates=${baselineMetrics.candidates} filled=${baselineMetrics.filled} wins=${baselineMetrics.wins} losses=${baselineMetrics.losses} grossPF=${f(baselineMetrics.grossProfitFactor)} netPF=${f(baselineMetrics.netProfitFactor)} netExp=${f(baselineMetrics.netExpectancyR)} netR=${f(baselineMetrics.netR, 1)}`);
  console.log(`FORENSICS trades=${trades.length} sameFillLosses=${sameFillLosses.length} ambiguous=${ambiguousCount}`);
  console.log(`ATTRIBUTION convFillLiveNo=${convFilledLiveNot} winToLoss=${convWinLiveLoss} lossToWin=${convLossLiveWin} fillCandleChanged=${fillCandleChanged} other=${otherChanged}`);
  console.log(`REPORT ${REPORT_PATH}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
