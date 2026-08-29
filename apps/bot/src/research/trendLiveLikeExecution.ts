import type { Candle } from '../noTradeZone/types.js';
import type { Direction } from '../entry/types.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../entry/fvgStrategyConfig.js';

const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;

export interface TrendCandidate {
  symbol: string;
  signalOpenTime: number;
  decisionTimestamp: number;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  gapLow: number;
  gapHigh: number;
}

export interface ExecutionScenario {
  id: string;
  label: string;
  fillBufferBps: number;
  latencyMs: 0 | 500 | 1000 | 2000;
  slippageBps: number;
  entryFeeRate: number;
  slFeeRate: number;
  tpFeeRate: number;
}

export type ExecutionStatus = 'WIN' | 'LOSS' | 'EXPIRED' | 'NOT_FILLED' | 'OPEN' | 'PRODUCTION_SKIPPED';

export interface ExecutionResult {
  candidate: TrendCandidate;
  scenarioId: string;
  status: ExecutionStatus;
  fillTime: number | null;
  exitTime: number | null;
  orderEndTime: number;
  grossR: number | null;
  netR: number | null;
  feeR: number;
  slippageR: number;
}

export interface ExecutionMetrics {
  candidates: number;
  filled: number;
  expired: number;
  notFilled: number;
  skipped: number;
  open: number;
  fillRatePct: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossProfitFactor: number;
  netProfitFactor: number;
  grossExpectancyR: number;
  netExpectancyR: number;
  grossNetR: number;
  netR: number;
  maxDrawdownR: number;
  maxConsecutiveLosses: number;
}

export interface SymbolReplayData {
  m15: Candle[];
  m15IndexByOpenTime: Map<number, number>;
  minuteByOpenTime: Map<number, Candle>;
}

export class MissingIntrabarDataError extends Error {
  constructor(public readonly symbol: string, public readonly blockOpenTime: number) {
    super(`Missing 1m block: ${symbol} ${blockOpenTime}`);
  }
}

function resolvedLatencyMs(latencyMs: ExecutionScenario['latencyMs']): number {
  return latencyMs === 0 ? 0 : M1_MS;
}

function minuteBlock(data: SymbolReplayData, symbol: string, openTime: number): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 15; index++) {
    const candle = data.minuteByOpenTime.get(openTime + index * M1_MS);
    if (!candle) throw new MissingIntrabarDataError(symbol, openTime);
    candles.push(candle);
  }
  return candles;
}

function fillThreshold(candidate: TrendCandidate, bufferBps: number): number {
  const fraction = bufferBps / 10_000;
  return candidate.direction === 'LONG' ? candidate.entryPrice * (1 - fraction) : candidate.entryPrice * (1 + fraction);
}

function canFill(candidate: TrendCandidate, candle: Candle, threshold: number): boolean {
  return candidate.direction === 'LONG' ? candle.low <= threshold : candle.high >= threshold;
}

function exitTouches(candidate: TrendCandidate, candle: Candle): { sl: boolean; tp: boolean } {
  if (candidate.direction === 'LONG') return { sl: candle.low <= candidate.slPrice, tp: candle.high >= candidate.tpPrice };
  return { sl: candle.high >= candidate.slPrice, tp: candle.low <= candidate.tpPrice };
}

function closedResult(candidate: TrendCandidate, scenario: ExecutionScenario, won: boolean, fillTime: number, exitTime: number): ExecutionResult {
  const risk = Math.abs(candidate.entryPrice - candidate.slPrice);
  const slip = scenario.slippageBps / 10_000;
  const exitPrice = won ? candidate.tpPrice : candidate.direction === 'LONG' ? candidate.slPrice * (1 - slip) : candidate.slPrice * (1 + slip);
  const priceR = candidate.direction === 'LONG' ? (exitPrice - candidate.entryPrice) / risk : (candidate.entryPrice - exitPrice) / risk;
  const exitFee = won ? scenario.tpFeeRate : scenario.slFeeRate;
  const feeR = (candidate.entryPrice * scenario.entryFeeRate + exitPrice * exitFee) / risk;
  return {
    candidate,
    scenarioId: scenario.id,
    status: won ? 'WIN' : 'LOSS',
    fillTime,
    exitTime,
    orderEndTime: exitTime,
    grossR: won ? DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple : -1,
    netR: priceR - feeR,
    feeR,
    slippageR: won ? 0 : Math.max(0, -1 - priceR),
  };
}

export function simulateLiveLike(candidate: TrendCandidate, data: SymbolReplayData, scenario: ExecutionScenario): ExecutionResult {
  const startIndex = data.m15IndexByOpenTime.get(candidate.decisionTimestamp);
  if (startIndex === undefined) return { candidate, scenarioId: scenario.id, status: 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: candidate.decisionTimestamp, grossR: null, netR: null, feeR: 0, slippageR: 0 };
  const activeTime = candidate.decisionTimestamp + resolvedLatencyMs(scenario.latencyMs);
  const expiryTime = candidate.decisionTimestamp + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles * M15_MS;
  const threshold = fillThreshold(candidate, scenario.fillBufferBps);
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
    const minutes = minuteBlock(data, candidate.symbol, m15.openTime);
    for (let minuteIndex = 0; minuteIndex < minutes.length; minuteIndex++) {
      const minute = minutes[minuteIndex];
      if (minute.openTime < activeTime) continue;
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
    const completeWindow = startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles <= data.m15.length;
    const endTime = Math.min(expiryTime, data.m15.at(-1)!.openTime + M15_MS);
    return { candidate, scenarioId: scenario.id, status: completeWindow ? 'EXPIRED' : 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: endTime, grossR: null, netR: null, feeR: 0, slippageR: 0 };
  }

  for (let index = fillM15Index; index < data.m15.length; index++) {
    const m15 = data.m15[index];
    const m15Touched = exitTouches(candidate, m15);
    if (!m15Touched.sl && !m15Touched.tp) continue;
    const minutes = minuteBlock(data, candidate.symbol, m15.openTime);
    const firstMinute = index === fillM15Index ? fillMinuteIndex : 0;
    for (let minuteIndex = firstMinute; minuteIndex < minutes.length; minuteIndex++) {
      const minute = minutes[minuteIndex];
      const touched = exitTouches(candidate, minute);
      if (touched.sl) return closedResult(candidate, scenario, false, fillTime, minute.openTime + M1_MS);
      if (touched.tp) return closedResult(candidate, scenario, true, fillTime, minute.openTime + M1_MS);
    }
  }
  const dataEnd = data.m15.at(-1)!.openTime + M15_MS;
  return { candidate, scenarioId: scenario.id, status: 'OPEN', fillTime, exitTime: null, orderEndTime: dataEnd, grossR: null, netR: null, feeR: 0, slippageR: 0 };
}

export function simulateConventional(candidate: TrendCandidate, data: SymbolReplayData, scenario: ExecutionScenario): ExecutionResult {
  const startIndex = data.m15IndexByOpenTime.get(candidate.decisionTimestamp);
  if (startIndex === undefined) return { candidate, scenarioId: 'conventional', status: 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: candidate.decisionTimestamp, grossR: null, netR: null, feeR: 0, slippageR: 0 };
  const endIndex = Math.min(data.m15.length, startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles);
  let fillIndex = -1;
  for (let index = startIndex; index < endIndex; index++) {
    const candle = data.m15[index];
    if (candle.low <= candidate.gapHigh && candle.high >= candidate.gapLow) {
      fillIndex = index;
      break;
    }
  }
  if (fillIndex < 0) {
    const complete = startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles <= data.m15.length;
    const endTime = data.m15[Math.max(startIndex, endIndex - 1)]?.openTime + M15_MS || candidate.decisionTimestamp;
    return { candidate, scenarioId: 'conventional', status: complete ? 'EXPIRED' : 'NOT_FILLED', fillTime: null, exitTime: null, orderEndTime: endTime, grossR: null, netR: null, feeR: 0, slippageR: 0 };
  }
  const fillTime = data.m15[fillIndex].openTime;
  for (let index = fillIndex + 1; index < data.m15.length; index++) {
    const touched = exitTouches(candidate, data.m15[index]);
    if (touched.sl) return closedResult(candidate, { ...scenario, slippageBps: 0 }, false, fillTime, data.m15[index].openTime + M15_MS);
    if (touched.tp) return closedResult(candidate, { ...scenario, slippageBps: 0 }, true, fillTime, data.m15[index].openTime + M15_MS);
  }
  const dataEnd = data.m15.at(-1)!.openTime + M15_MS;
  return { candidate, scenarioId: 'conventional', status: 'OPEN', fillTime, exitTime: null, orderEndTime: dataEnd, grossR: null, netR: null, feeR: 0, slippageR: 0 };
}

export function applyOneActivePerSymbol(results: ExecutionResult[]): ExecutionResult[] {
  const busyUntil = new Map<string, number>();
  return [...results].sort((a, b) => a.candidate.decisionTimestamp - b.candidate.decisionTimestamp || a.candidate.symbol.localeCompare(b.candidate.symbol)).map((result) => {
    const availableAt = busyUntil.get(result.candidate.symbol) ?? -Infinity;
    if (result.candidate.decisionTimestamp < availableAt) return { ...result, status: 'PRODUCTION_SKIPPED', fillTime: null, exitTime: null, grossR: null, netR: null, feeR: 0, slippageR: 0 };
    busyUntil.set(result.candidate.symbol, result.orderEndTime);
    return result;
  });
}

function profitFactor(values: number[]): number {
  const profit = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  const loss = -values.reduce((sum, value) => sum + Math.min(0, value), 0);
  return loss === 0 ? (profit > 0 ? Infinity : 0) : profit / loss;
}

export function summarizeExecution(results: ExecutionResult[]): ExecutionMetrics {
  const closed = results.filter((result): result is ExecutionResult & { grossR: number; netR: number } => result.grossR !== null && result.netR !== null)
    .sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0) || a.candidate.symbol.localeCompare(b.candidate.symbol));
  const gross = closed.map((result) => result.grossR);
  const net = closed.map((result) => result.netR);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  let streak = 0;
  let maxConsecutiveLosses = 0;
  for (const value of net) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    streak = value < 0 ? streak + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
  }
  const wins = closed.filter((result) => result.status === 'WIN').length;
  const losses = closed.filter((result) => result.status === 'LOSS').length;
  const filled = results.filter((result) => result.fillTime !== null && result.status !== 'PRODUCTION_SKIPPED').length;
  return {
    candidates: results.length,
    filled,
    expired: results.filter((result) => result.status === 'EXPIRED').length,
    notFilled: results.filter((result) => result.status === 'NOT_FILLED').length,
    skipped: results.filter((result) => result.status === 'PRODUCTION_SKIPPED').length,
    open: results.filter((result) => result.status === 'OPEN').length,
    fillRatePct: results.length === 0 ? 0 : (filled / results.length) * 100,
    wins,
    losses,
    winRatePct: closed.length === 0 ? 0 : (wins / closed.length) * 100,
    grossProfitFactor: profitFactor(gross),
    netProfitFactor: profitFactor(net),
    grossExpectancyR: closed.length === 0 ? 0 : gross.reduce((sum, value) => sum + value, 0) / closed.length,
    netExpectancyR: closed.length === 0 ? 0 : net.reduce((sum, value) => sum + value, 0) / closed.length,
    grossNetR: gross.reduce((sum, value) => sum + value, 0),
    netR: equity,
    maxDrawdownR,
    maxConsecutiveLosses,
  };
}

export function requiredIntrabarBlocks(candidates: TrendCandidate[], m15BySymbol: Map<string, Candle[]>): Map<string, Set<number>> {
  const blocks = new Map<string, Set<number>>();
  const indices = new Map([...m15BySymbol].map(([symbol, candles]) => [symbol, new Map(candles.map((candle, index) => [candle.openTime, index]))]));
  for (const candidate of candidates) {
    const candles = m15BySymbol.get(candidate.symbol);
    const startIndex = indices.get(candidate.symbol)?.get(candidate.decisionTimestamp);
    if (!candles || startIndex === undefined) continue;
    const symbolBlocks = blocks.get(candidate.symbol) ?? new Set<number>();
    blocks.set(candidate.symbol, symbolBlocks);
    const fillIndices: number[] = [];
    for (let index = startIndex; index < Math.min(candles.length, startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles); index++) {
      if (canFill(candidate, candles[index], candidate.entryPrice)) {
        fillIndices.push(index);
        symbolBlocks.add(candles[index].openTime);
      }
    }
    for (const fillIndex of fillIndices) {
      let added = 0;
      for (let index = fillIndex; index < candles.length && added < 3; index++) {
        const touched = exitTouches(candidate, candles[index]);
        if (touched.sl || touched.tp) {
          symbolBlocks.add(candles[index].openTime);
          added++;
        }
      }
    }
  }
  return blocks;
}
