import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeAtr } from '../../backtest/engine/noTradeZone/atr.js';
import { computeMeanReversionSignals } from '../../core/entry/meanReversionSignal.js';
import { TOO_TIGHT_TICK_COUNT } from '../../core/risk/meanReversionTradePlan.js';

// TICKET-04X-O: pure descriptive comparison of two SL-distance formulas at TICKET-04X-N's own
// signal points. No entry/exit simulation, no fill simulation, no PnL anywhere in this file.
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const ATR_MULTIPLE = 1.5;
const ZSCORE_SL_MULTIPLE = 3;
const BTC_TICK_SIZE = 0.1; // matches DEFAULT_COIN_BACKTEST_CONFIG.BTCUSDT.tickSize
// TOO_TIGHT_TICK_COUNT (locked BEFORE running, per the ticket) now lives in
// meanReversionTradePlan.ts (TICKET-04X-P reuses it as an actual SL floor) — imported here so the
// two files can never independently drift to two different "3"s.

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

interface SignalRow {
  direction: 'LONG' | 'SHORT';
  year: string;
  zDistancePct: number;
  atrDistancePct: number;
  ratio: number;
  tooTight: boolean;
}

function yearBucket(openTimeMs: number): string {
  const year = new Date(openTimeMs).getUTCFullYear();
  return year >= 2025 ? '2025-2026' : String(year);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function populationStd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function describe(values: readonly number[]) {
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    std: populationStd(values),
  };
}

function printDescribe(label: string, values: readonly number[]): void {
  if (values.length === 0) {
    console.info(`${label}: n=0`);
    return;
  }
  const d = describe(values);
  console.info(
    `${label}: n=${d.n} mean=${d.mean.toFixed(6)} median=${d.median.toFixed(6)} min=${d.min.toFixed(6)} max=${d.max.toFixed(6)} std=${d.std.toFixed(6)}`,
  );
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  const m5Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_5m_3y.csv'));
  console.info(`Loaded ${m15Candles.length} M15 candles, ${m5Candles.length} M5 candles`);

  const signals = computeMeanReversionSignals(m15Candles, m5Candles, M15_MS, M5_MS);
  const atrSeries = computeAtr(m5Candles, ATR_PERIOD); // atrSeries[k] -> m5Candles[k + ATR_PERIOD]

  const rows: SignalRow[] = [];
  for (let i = 0; i < m5Candles.length; i += 1) {
    const s = signals[i];
    if (s.signal === 'NONE') continue;
    if (s.windowMean === null || s.windowStd === null || s.windowStd === 0) continue;
    const atr = i >= ATR_PERIOD ? atrSeries[i - ATR_PERIOD] : undefined;
    if (atr === undefined) continue; // should not happen: zScore already requires i>=20>14

    const entryClose = m5Candles[i].close;
    const sign = s.signal === 'LONG' ? -1 : 1;
    const zSLPrice = s.windowMean + sign * ZSCORE_SL_MULTIPLE * s.windowStd;
    const zDistancePct = Math.abs(entryClose - zSLPrice) / entryClose;
    const atrDistancePct = (ATR_MULTIPLE * atr) / entryClose;
    if (zDistancePct === 0) continue; // ratio undefined; not expected in practice
    const tooTightThresholdPct = (TOO_TIGHT_TICK_COUNT * BTC_TICK_SIZE) / entryClose;

    rows.push({
      direction: s.signal,
      year: yearBucket(m5Candles[i].openTime),
      zDistancePct,
      atrDistancePct,
      ratio: atrDistancePct / zDistancePct,
      tooTight: zDistancePct < tooTightThresholdPct,
    });
  }

  console.info(`\n########## 1. TONG SO TIN HIEU ##########`);
  console.info(`LONG: ${rows.filter((r) => r.direction === 'LONG').length}`);
  console.info(`SHORT: ${rows.filter((r) => r.direction === 'SHORT').length}`);
  console.info(`TONG: ${rows.length}`);

  console.info(`\n########## 2. PHAN PHOI zDistancePct / atrDistancePct (toan bo 3 nam) ##########`);
  printDescribe('zDistancePct', rows.map((r) => r.zDistancePct));
  printDescribe('atrDistancePct', rows.map((r) => r.atrDistancePct));

  console.info(`\n########## 3. PHAN PHOI TY LE atrDistancePct / zDistancePct ##########`);
  printDescribe('ratio (atr/z)', rows.map((r) => r.ratio));

  console.info(`\n########## 4. CHIA THEO NAM ##########`);
  const years = ['2023', '2024', '2025-2026'];
  for (const year of years) {
    const yearRows = rows.filter((r) => r.year === year);
    console.info(`\n-- ${year} (n=${yearRows.length}) --`);
    printDescribe('  zDistancePct', yearRows.map((r) => r.zDistancePct));
    printDescribe('  atrDistancePct', yearRows.map((r) => r.atrDistancePct));
    printDescribe('  ratio (atr/z)', yearRows.map((r) => r.ratio));
  }

  console.info(`\n########## 5. CO CANH BAO z-score QUA SAT (< ${TOO_TIGHT_TICK_COUNT} tick, khoa cung truoc khi chay) ##########`);
  const tooTightCount = rows.filter((r) => r.tooTight).length;
  console.info(`${tooTightCount}/${rows.length} (${((100 * tooTightCount) / rows.length).toFixed(2)}%) tin hieu co zDistancePct < nguong ${TOO_TIGHT_TICK_COUNT}xtickSize/gia`);
  for (const year of years) {
    const yearRows = rows.filter((r) => r.year === year);
    const yearTooTight = yearRows.filter((r) => r.tooTight).length;
    console.info(`  ${year}: ${yearTooTight}/${yearRows.length} (${yearRows.length === 0 ? 'N/A' : ((100 * yearTooTight) / yearRows.length).toFixed(2) + '%'})`);
  }
}

await main();
