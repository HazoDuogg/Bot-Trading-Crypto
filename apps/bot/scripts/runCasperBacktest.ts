import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  runCasperHistoricalBacktest,
  type CasperBacktestTrace,
  type CasperHistoricalDataset,
} from '../src/strategy/casperFvg/historicalBacktest.js';
import type { CasperCostConfig } from '../src/strategy/casperFvg/costAccounting.js';
import type { CasperCandle } from '../src/strategy/casperFvg/types.js';

function argumentsByName(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  if (values.length > 0 && !values[0].startsWith('--')) {
    const keys = [
      'symbol',
      'entry-fee-rate',
      'exit-fee-rate',
      'entry-slippage-rate',
      'exit-slippage-rate',
      'output-dir',
      'input-dir',
    ];
    if (values.length < 5 || values.length > keys.length) throw new Error('Expected 5 to 7 positional arguments');
    values.forEach((value, index) => parsed.set(keys[index], value));
    return parsed;
  }
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? 'end'}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function rates(args: Map<string, string>): CasperCostConfig {
  return {
    entryFeeRate: Number(required(args, 'entry-fee-rate')),
    exitFeeRate: Number(required(args, 'exit-fee-rate')),
    entrySlippageRate: Number(required(args, 'entry-slippage-rate')),
    exitSlippageRate: Number(required(args, 'exit-slippage-rate')),
  };
}

async function readCandles(filePath: string, durationMs: number): Promise<CasperCandle[]> {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const candles: CasperCandle[] = [];
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      if (line.trim() !== 'openTime,open,high,low,close,volume') {
        throw new Error(`Unexpected CSV header in ${filePath}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const [openTime, open, high, low, close] = line.split(',');
    const startTimeMs = Number(openTime);
    candles.push({
      startTimeMs,
      endTimeMs: startTimeMs + durationMs,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
    });
  }
  return candles;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tradesCsv(traces: readonly CasperBacktestTrace[]): string {
  const headers = [
    'symbol', 'tradingDay', 'direction', 'orHigh', 'orLow', 'c1StartMs', 'c1EndMs', 'c2StartMs',
    'c2EndMs', 'c3StartMs', 'c3EndMs',
    'fvgLow', 'fvgHigh', 'entry', 'stopLoss', 'target1_5R', 'target2_0R', 'createdAtMs', 'filledAtMs',
    'outcome1_5R', 'grossR1_5R', 'netR1_5R', 'outcome2_0R', 'grossR2_0R', 'netR2_0R', 'reason',
  ];
  const rows = traces.map((trace) => {
    const one = trace.variants['1.5R'].configured;
    const two = trace.variants['2.0R'].configured;
    return [
      trace.symbol, trace.tradingDay, trace.direction, trace.openingRange.high, trace.openingRange.low,
      trace.sourceTimestamps.c1StartMs, trace.sourceTimestamps.c1EndMs, trace.sourceTimestamps.c2StartMs,
      trace.sourceTimestamps.c2EndMs, trace.sourceTimestamps.c3StartMs, trace.sourceTimestamps.c3EndMs,
      trace.fvgLow, trace.fvgHigh, trace.entry, trace.stopLoss, trace.targets['1.5R'], trace.targets['2.0R'],
      trace.createdAtMs, trace.filledAtMs, trace.outcomes['1.5R'], one.state === 'ACCOUNTED' ? one.grossR : '',
      one.state === 'ACCOUNTED' ? one.netR : '', trace.outcomes['2.0R'], two.state === 'ACCOUNTED' ? two.grossR : '',
      two.state === 'ACCOUNTED' ? two.netR : '', trace.reason,
    ].map(csvCell).join(',');
  });
  return [headers.join(','), ...rows].join('\n') + '\n';
}

async function main() {
  const args = argumentsByName(process.argv.slice(2));
  const symbol = required(args, 'symbol').toUpperCase();
  const costs = rates(args);
  if (!Object.values(costs).every((rate) => Number.isFinite(rate) && rate >= 0 && rate < 1)) {
    throw new Error('Every cost rate must be finite and satisfy 0 <= rate < 1');
  }
  const inputDir = path.resolve(args.get('input-dir') ?? 'apps/bot/data');
  const outputDir = path.resolve(args.get('output-dir') ?? 'data/casper-rt100');
  const dataset: CasperHistoricalDataset = {
    symbol,
    m15: await readCandles(path.join(inputDir, `${symbol}_15m_3y.csv`), 15 * 60_000),
    m5: await readCandles(path.join(inputDir, `${symbol}_5m_3y.csv`), 5 * 60_000),
    m1: await readCandles(path.join(inputDir, `${symbol}_rt094_1m.csv`), 60_000),
  };
  const result = runCasperHistoricalBacktest(dataset, { costs });
  await mkdir(outputDir, { recursive: true });
  const summary = {
    state: result.state,
    symbol: result.symbol,
    costsDecimal: result.costs,
    costsPercent: result.costPercent,
    issues: result.issues,
    selectedTraceIndexes: result.selectedTraceIndexes,
    summaries: result.summaries,
  };
  await writeFile(
    path.join(outputDir, 'casper-baseline-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(outputDir, 'casper-baseline-trades.csv'), tradesCsv(result.traces), 'utf8');
  if (result.state !== 'COMPLETED') throw new Error(`Backtest failed closed with state ${result.state}`);
  process.stdout.write(`Casper baseline complete: ${result.traces.length} setups, output ${outputDir}\n`);
}

await main();
