import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Candle } from '../noTradeZone/types.js';
import type { TradePlan } from '../risk/tradePlan.js';
import { calculateExecutionCosts, type ExecutionCostResult } from './costModel.js';
import {
  M15_CANDLE_DURATION_MS,
  simulateIntrabarExecution,
  type IntrabarExecutionResult,
} from './intrabarExecution.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuyAndHoldControlResult {
  passed: boolean;
  periodStartTimestamp: number;
  periodEndTimestamp: number;
  startPrice: number;
  endPrice: number;
  rawChangePct: number;
  netR: number;
  costDragR: number;
  execution: IntrabarExecutionResult;
  costs: ExecutionCostResult;
}

function parseM1Row(row: string, lineNumber: number): Candle {
  const values = row.split(',').map(Number);
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid M1 CSV row at line ${lineNumber}`);
  }
  const [openTime, open, high, low, close, volume] = values;
  if (!Number.isSafeInteger(openTime) || high < low) {
    throw new Error(`Invalid M1 candle at line ${lineNumber}`);
  }
  return { openTime, open, high, low, close, volume };
}

export async function readLastCandleOpenTime(csvPath: string): Promise<number> {
  const reader = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  let lastTimestamp: number | null = null;
  for await (const row of reader) {
    lineNumber += 1;
    if (lineNumber === 1 || row.trim().length === 0) continue;
    lastTimestamp = parseM1Row(row, lineNumber).openTime;
  }
  if (lastTimestamp === null) throw new Error('Candle CSV contains no data rows');
  return lastTimestamp;
}

export async function loadRecentM1Candles(
  csvPath: string,
  periodDays = 180,
  m15EndOpenTime?: number,
): Promise<Candle[]> {
  if (!Number.isSafeInteger(periodDays) || periodDays <= 0) {
    throw new Error('periodDays must be a positive integer');
  }
  const reader = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const retained: Candle[] = [];
  if (
    m15EndOpenTime !== undefined &&
    (!Number.isSafeInteger(m15EndOpenTime) || m15EndOpenTime < 0)
  ) {
    throw new Error('m15EndOpenTime must be a non-negative UTC epoch millisecond timestamp');
  }
  const anchoredStart =
    m15EndOpenTime === undefined ? null : m15EndOpenTime - periodDays * DAY_MS;
  const anchoredEnd =
    m15EndOpenTime === undefined ? null : m15EndOpenTime + M15_CANDLE_DURATION_MS - 1;
  let head = 0;
  let lineNumber = 0;
  let previousTimestamp = -1;
  for await (const row of reader) {
    lineNumber += 1;
    if (lineNumber === 1 || row.trim().length === 0) continue;
    const current = parseM1Row(row, lineNumber);
    if (current.openTime <= previousTimestamp) {
      throw new Error(`M1 candles must be strictly chronological at line ${lineNumber}`);
    }
    previousTimestamp = current.openTime;
    if (anchoredStart !== null && current.openTime < anchoredStart) continue;
    if (anchoredEnd !== null && current.openTime > anchoredEnd) break;
    retained.push(current);
    if (anchoredStart === null) {
      const cutoff = current.openTime - periodDays * DAY_MS;
      while (head < retained.length && retained[head].openTime < cutoff) head += 1;
      if (head >= 100_000) {
        retained.splice(0, head);
        head = 0;
      }
    }
  }
  const result = retained.slice(head);
  if (result.length < 2) throw new Error('M1 control period requires at least two candles');
  return result;
}

export async function loadM1CandlesBetween(
  csvPath: string,
  startInclusive: number,
  endExclusive: number,
): Promise<Candle[]> {
  if (!Number.isSafeInteger(startInclusive) || !Number.isSafeInteger(endExclusive)) {
    throw new Error('M1 window bounds must be UTC epoch millisecond integers');
  }
  if (endExclusive <= startInclusive) throw new Error('M1 window end must be after start');
  const reader = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const result: Candle[] = [];
  let lineNumber = 0;
  let previousTimestamp = -1;
  for await (const row of reader) {
    lineNumber += 1;
    if (lineNumber === 1 || row.trim().length === 0) continue;
    const current = parseM1Row(row, lineNumber);
    if (current.openTime <= previousTimestamp) {
      throw new Error(`M1 candles must be strictly chronological at line ${lineNumber}`);
    }
    previousTimestamp = current.openTime;
    if (current.openTime < startInclusive) continue;
    if (current.openTime >= endExclusive) break;
    result.push(current);
  }
  if (result.length < 2) throw new Error('M1 CSV has fewer than two candles in the requested window');
  return result;
}

export function runBuyAndHoldControl(candles: readonly Candle[]): BuyAndHoldControlResult {
  if (candles.length < 2) throw new Error('Buy-and-hold control requires at least two M1 candles');
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (last.openTime <= first.openTime || first.open <= 0 || last.close <= 0) {
    throw new Error('Buy-and-hold control candles must be chronological with positive prices');
  }

  // One risk unit equals the entry price, so gross R equals the buy-and-hold fractional return.
  const plan: TradePlan = {
    direction: 'BULL',
    entryPrice: first.open,
    stopLoss: Number.MIN_VALUE,
    takeProfit: Number.MAX_VALUE,
    riskPerUnit: first.open,
    positionSize: 1,
    requiredMargin: first.open,
  };
  const execution = simulateIntrabarExecution({
    tradePlan: plan,
    entryFillTimestamp: first.openTime,
    m1Candles: candles,
  });
  const costs = calculateExecutionCosts({
    tradePlan: plan,
    exitPrice: last.close,
    entryM1Candle: first,
    exitM1Candle: last,
  });
  const rawChange = (last.close - first.open) / first.open;
  const costDragR = costs.feeR + costs.spreadR + costs.slippageR;
  const reconciled = Math.abs(costs.netR - (rawChange - costDragR)) <= 1e-12;
  const passed =
    execution.outcome === 'OPEN' &&
    rawChange > 0 &&
    costs.netR > 0 &&
    costs.netR < rawChange &&
    reconciled;

  return {
    passed,
    periodStartTimestamp: first.openTime,
    periodEndTimestamp: last.openTime,
    startPrice: first.open,
    endPrice: last.close,
    rawChangePct: rawChange * 100,
    netR: costs.netR,
    costDragR,
    execution,
    costs,
  };
}

async function main(): Promise<void> {
  const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_rt094_1m.csv', import.meta.url));
  const m15Path = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
  const m15Anchor = await readLastCandleOpenTime(m15Path);
  const result = runBuyAndHoldControl(await loadRecentM1Candles(csvPath, 180, m15Anchor));
  console.info(
    `BTCUSDT buy-and-hold control\n` +
      `period=${new Date(result.periodStartTimestamp).toISOString()} -> ` +
      `${new Date(result.periodEndTimestamp).toISOString()}\n` +
      `start=${result.startPrice.toFixed(2)}, end=${result.endPrice.toFixed(2)}\n` +
      `raw=${result.rawChangePct.toFixed(2)}%, grossR=${result.costs.grossR.toFixed(4)}\n` +
      `feeR=${result.costs.feeR.toFixed(4)}, spreadR=${result.costs.spreadR.toFixed(4)}, ` +
      `slippageR=${result.costs.slippageR.toFixed(4)}\n` +
      `netR=${result.netR.toFixed(4)} (${(result.netR * 100).toFixed(2)}%), ` +
      `execution=${result.execution.outcome}, PASS=${result.passed}`,
  );
  if (!result.passed) process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
