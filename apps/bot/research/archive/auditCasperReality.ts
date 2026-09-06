import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { runCasperHistoricalBacktest, type CasperHistoricalDataset } from '../src/strategy/casperFvg/historicalBacktest.js';
import {
  auditCasperBacktestReality,
  type CasperManualReplayRecord,
  type CasperRealityScenarios,
} from '../src/strategy/casperFvg/realityAudit.js';
import type { CasperCostConfig } from '../src/strategy/casperFvg/costAccounting.js';
import type { CasperCandle } from '../src/strategy/casperFvg/types.js';

function positional(values: readonly string[]) {
  if (values.length < 5 || values.length > 7) {
    throw new Error('Expected symbol, four rates, optional output directory, and optional input directory');
  }
  return {
    symbol: values[0].toUpperCase(),
    costs: {
      entryFeeRate: Number(values[1]),
      exitFeeRate: Number(values[2]),
      entrySlippageRate: Number(values[3]),
      exitSlippageRate: Number(values[4]),
    } satisfies CasperCostConfig,
    outputDir: path.resolve(values[5] ?? 'data/casper-rt102'),
    inputDir: path.resolve(values[6] ?? 'apps/bot/data'),
  };
}

function validCosts(costs: CasperCostConfig): boolean {
  return Object.values(costs).every((rate) => Number.isFinite(rate) && rate >= 0 && rate < 1);
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

function scenarios(costs: CasperCostConfig): CasperRealityScenarios {
  return {
    CURRENT_RT101: {
      entryFeeRate: costs.entryFeeRate,
      tpExitFeeRate: costs.exitFeeRate,
      slExitFeeRate: costs.exitFeeRate,
      entrySlippageRate: costs.entrySlippageRate,
      tpExitSlippageRate: costs.exitSlippageRate,
      slExitSlippageRate: costs.exitSlippageRate,
    },
    MAKER_TP_TAKER_SL: {
      entryFeeRate: costs.entryFeeRate,
      tpExitFeeRate: costs.entryFeeRate,
      slExitFeeRate: costs.exitFeeRate,
      entrySlippageRate: 0,
      tpExitSlippageRate: 0,
      slExitSlippageRate: costs.exitSlippageRate,
    },
    ZERO_COST_CONTROL: {
      entryFeeRate: 0,
      tpExitFeeRate: 0,
      slExitFeeRate: 0,
      entrySlippageRate: 0,
      tpExitSlippageRate: 0,
      slExitSlippageRate: 0,
    },
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function candleCells(prefix: string, candle: CasperCandle): Record<string, number> {
  return {
    [`${prefix}StartMs`]: candle.startTimeMs,
    [`${prefix}EndMs`]: candle.endTimeMs,
    [`${prefix}Open`]: candle.open,
    [`${prefix}High`]: candle.high,
    [`${prefix}Low`]: candle.low,
    [`${prefix}Close`]: candle.close,
  };
}

function manualSampleCsv(records: readonly CasperManualReplayRecord[]): string {
  const rows = records.map((record) => ({
    tradingDay: record.tradingDay,
    direction: record.direction,
    orHigh: record.openingRange.high,
    orLow: record.openingRange.low,
    ...candleCells('c1', record.sourceCandles.c1),
    ...candleCells('c2', record.sourceCandles.c2),
    ...candleCells('c3', record.sourceCandles.c3),
    fvgLow: record.fvg.low,
    fvgHigh: record.fvg.high,
    entry: record.entry,
    stopLoss: record.stopLoss,
    target1_5R: record.targets['1.5R'],
    target2_0R: record.targets['2.0R'],
    createdAtMs: record.createdAtMs,
    filledAtMs: record.filledAtMs,
    engineState: record.engineState,
    outcome1_5R: record.outcomes['1.5R'],
    outcome2_0R: record.outcomes['2.0R'],
    costImpact1_5R: record.costImpactR['1.5R'],
    costImpact2_0R: record.costImpactR['2.0R'],
    riskPctOfEntry: record.riskPctOfEntry,
    fillCategory: record.fillCategory,
    auditCategories: record.auditCategories.join('|'),
  }));
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(',')),
  ].join('\n') + '\n';
}

async function main() {
  const args = positional(process.argv.slice(2));
  if (!validCosts(args.costs)) throw new Error('Every rate must be finite and satisfy 0 <= rate < 1');
  const dataset: CasperHistoricalDataset = {
    symbol: args.symbol,
    m15: await readCandles(path.join(args.inputDir, `${args.symbol}_15m_3y.csv`), 15 * 60_000),
    m5: await readCandles(path.join(args.inputDir, `${args.symbol}_5m_3y.csv`), 5 * 60_000),
    m1: await readCandles(path.join(args.inputDir, `${args.symbol}_rt094_1m.csv`), 60_000),
  };
  const baseline = runCasperHistoricalBacktest(dataset, { costs: args.costs });
  if (baseline.state !== 'COMPLETED') throw new Error(`Baseline failed closed with ${baseline.state}`);
  const audit = auditCasperBacktestReality({
    baseline,
    dataset,
    scenarios: scenarios(args.costs),
    sampleSize: 40,
  });
  await mkdir(args.outputDir, { recursive: true });
  await writeFile(
    path.join(args.outputDir, 'reality-audit-summary.json'),
    `${JSON.stringify({
      symbol: args.symbol,
      baselineCosts: args.costs,
      baselineIssues: baseline.issues,
      baselineSummaries: baseline.summaries,
      scenarios: scenarios(args.costs),
      audit,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(args.outputDir, 'manual-replay-sample.csv'),
    manualSampleCsv(audit.manualReplaySample),
    'utf8',
  );
  process.stdout.write(`Casper reality audit complete: ${audit.manualReplaySample.length} manual samples\n`);
}

await main();
