import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { findSwingPoints } from '../src/regime/swingPoints.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Direction } from '../src/regime/types.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateRr } from '../src/risk/rrCalculator.js';

// TICKET-RT-007: compares two RANGE_TRADING SL formulas against the current one (0.25x ATR buffer,
// unchanged in src/risk/slCalculator.ts — NOT modified here). Detection pipeline (NTZ, regime routing,
// candlestick trigger, range-proximity gate) is identical to TICKET-RT-006's measureSlDistribution.ts;
// only the RANGE_TRADING SL formula and the downstream R:R check are varied, per this ticket's ask.
//
// R:R>=1.2 filter uses the opposite range boundary as cappedTpPrice (calculateRr's documented use case:
// "nearest resistance/support zone that may limit TP short of ideal level") — for a range trade, TP
// realistically can't extend past the far side of the range, so that's the natural cap. This is this
// script's interpretation, not an existing spec formula.

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;
const RANGE_PROXIMITY_ATR_MULTIPLIER = 1;
const TARGET_R_MULTIPLE = 1.2;

async function readCsv(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n').slice(1);
  return lines.map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return {
      openTime: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

interface RangeSignal {
  direction: Direction;
  nearLevel: number; // the boundary being traded from (SL side)
  farLevel: number; // the opposite boundary (TP cap side)
  entryPrice: number;
  atrM5: number;
}

function findRangeSignal(m5Window: Candle[], m15Window: Candle[], atrM5: number): RangeSignal | null {
  const swings = findSwingPoints(m15Window, SWING_WIDTH);
  const highs = swings.filter((p) => p.type === 'high');
  const lows = swings.filter((p) => p.type === 'low');
  if (highs.length === 0 || lows.length === 0) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const price = m5Window[m5Window.length - 1].close;
  const proximity = atrM5 * RANGE_PROXIMITY_ATR_MULTIPLIER;

  const distToLow = Math.abs(price - lastLow.price);
  const distToHigh = Math.abs(price - lastHigh.price);

  let direction: Direction;
  let nearLevel: number;
  let farLevel: number;
  if (distToLow <= proximity && distToLow <= distToHigh) {
    direction = 'LONG';
    nearLevel = lastLow.price;
    farLevel = lastHigh.price;
  } else if (distToHigh <= proximity) {
    direction = 'SHORT';
    nearLevel = lastHigh.price;
    farLevel = lastLow.price;
  } else {
    return null;
  }

  const current = m5Window[m5Window.length - 1];
  const pinBar = detectPinBar(current);
  let signalDir: Direction | null = pinBar.isPinBar && pinBar.direction ? pinBar.direction : null;
  if (!signalDir && m5Window.length >= 2) {
    const engulfing = detectEngulfing(m5Window[m5Window.length - 2], current);
    signalDir = engulfing.isEngulfing && engulfing.direction ? engulfing.direction : null;
  }
  if (signalDir !== direction) return null;

  return { direction, nearLevel, farLevel, entryPrice: current.close, atrM5 };
}

async function findRangeSignals(symbol: string, dataDir: string): Promise<{ signals: RangeSignal[]; spanDays: number }> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));

  const signals: RangeSignal[] = [];
  let h1Cursor = 0;
  let m15Cursor = 0;

  for (let i = 0; i < m5All.length; i++) {
    const m5CloseTime = m5All[i].openTime + 5 * 60 * 1000;

    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m5CloseTime) h1Cursor++;
    while (m15Cursor < m15All.length && m15All[m15Cursor].openTime + M15_MS <= m5CloseTime) m15Cursor++;
    if (h1Cursor === 0 || m15Cursor === 0) continue;

    const h1Window = h1All.slice(0, h1Cursor);
    const m15Window = m15All.slice(0, m15Cursor);
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: m5CloseTime,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });
    if (ntz.blocked) continue;

    const regimeH1 = classifyRegime(h1Window);
    const regimeM15 = classifyRegime(m15Window);
    const matrix = routeRegimeMatrix(regimeH1.state, regimeM15.state);
    if (matrix.strategy !== 'RANGE_TRADING') continue;

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    const signal = findRangeSignal(m5Window, m15Window, atrM5);
    if (signal) signals.push(signal);
  }

  const spanMs = m5All.length > 0 ? m5All[m5All.length - 1].openTime - m5All[0].openTime : 0;
  return { signals, spanDays: spanMs / (24 * 60 * 60 * 1000) };
}

// Huong 1: same buffer formula as slCalculator.ts's slFromRangeTrading, different multiplier.
function slV1(signal: RangeSignal, atrBufferMultiplier: number): number {
  const buffer = signal.atrM5 * atrBufferMultiplier;
  return signal.direction === 'LONG' ? signal.nearLevel - buffer : signal.nearLevel + buffer;
}

// Huong 2: SL placed as a fraction of the range width itself, instead of an ATR buffer.
function slV2(signal: RangeSignal, k: number): number {
  const rangeWidth = Math.abs(signal.farLevel - signal.nearLevel);
  const offset = rangeWidth * k;
  return signal.direction === 'LONG' ? signal.nearLevel - offset : signal.nearLevel + offset;
}

interface VariantSample {
  slPct: number;
  passesRr: boolean;
}

function evaluateVariant(signal: RangeSignal, slPrice: number): VariantSample | null {
  const distance = Math.abs(signal.entryPrice - slPrice);
  if (distance <= 0) return null;
  const slPct = (distance / signal.entryPrice) * 100;
  const rr = calculateRr({
    direction: signal.direction,
    entryPrice: signal.entryPrice,
    slPrice,
    targetRMultiple: TARGET_R_MULTIPLE,
    cappedTpPrice: signal.farLevel,
  });
  return { slPct, passesRr: rr.passesThreshold };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values: number[]): string {
  if (values.length === 0) return 'n=0';
  const sorted = [...values].sort((a, b) => a - b);
  return `n=${values.length}  p25=${percentile(sorted, 0.25).toFixed(3)}%  median=${percentile(sorted, 0.5).toFixed(3)}%  p75=${percentile(sorted, 0.75).toFixed(3)}%`;
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  const perSymbol: Record<string, { signals: RangeSignal[]; spanDays: number }> = {};
  for (const symbol of symbols) {
    console.log(`Detecting RANGE_TRADING signals for ${symbol}...`);
    perSymbol[symbol] = await findRangeSignals(symbol, dataDir);
    console.log(`  ${perSymbol[symbol].signals.length} RANGE_TRADING signals over ${perSymbol[symbol].spanDays.toFixed(1)} days`);
  }

  const v1Multipliers = [1.0, 1.5, 2.0];
  const v2Ks = [0.15, 0.2, 0.25];

  const results: {
    label: string;
    perSymbolPct: Record<string, number[]>;
    perSymbolPassPerDay: Record<string, number>;
    allPct: number[];
    allPassCount: number;
    totalDays: number;
  }[] = [];

  function buildVariant(label: string, slFn: (s: RangeSignal) => number) {
    const perSymbolPct: Record<string, number[]> = {};
    const perSymbolPassPerDay: Record<string, number> = {};
    const allPct: number[] = [];
    let allPassCount = 0;
    let totalDays = 0;

    for (const symbol of symbols) {
      const { signals, spanDays } = perSymbol[symbol];
      const pctValues: number[] = [];
      let passCount = 0;
      for (const signal of signals) {
        const sample = evaluateVariant(signal, slFn(signal));
        if (!sample) continue;
        pctValues.push(sample.slPct);
        allPct.push(sample.slPct);
        if (sample.passesRr) {
          passCount++;
          allPassCount++;
        }
      }
      perSymbolPct[symbol] = pctValues;
      perSymbolPassPerDay[symbol] = spanDays > 0 ? passCount / spanDays : 0;
      totalDays = spanDays; // same 90-day span for every symbol
    }

    results.push({ label, perSymbolPct, perSymbolPassPerDay, allPct, allPassCount, totalDays });
  }

  for (const mult of v1Multipliers) {
    buildVariant(`Huong1 ATR-buffer x${mult}`, (s) => slV1(s, mult));
  }
  for (const k of v2Ks) {
    buildVariant(`Huong2 range-width k=${k}`, (s) => slV2(s, k));
  }

  console.log('\n=== SL% distribution theo symbol, cho tung phuong an ===');
  for (const r of results) {
    console.log(`\n${r.label}:`);
    for (const symbol of symbols) {
      console.log(`  ${symbol}: ${summarize(r.perSymbolPct[symbol])}`);
    }
  }

  console.log('\n=== So sanh tong hop (tat ca symbol gop lai, doi chieu nguong ~0.42%) ===');
  console.log('phuong_an'.padEnd(28) + 'n'.padEnd(8) + 'p25'.padEnd(10) + 'median'.padEnd(10) + 'p75'.padEnd(10));
  for (const r of results) {
    const sorted = [...r.allPct].sort((a, b) => a - b);
    const p25 = percentile(sorted, 0.25);
    const median = percentile(sorted, 0.5);
    const p75 = percentile(sorted, 0.75);
    console.log(
      r.label.padEnd(28) +
        String(sorted.length).padEnd(8) +
        `${p25.toFixed(3)}%`.padEnd(10) +
        `${median.toFixed(3)}%`.padEnd(10) +
        `${p75.toFixed(3)}%`.padEnd(10),
    );
  }

  console.log(`\n=== Tin hieu RANGE_TRADING/ngay con lai sau loc R:R>=${TARGET_R_MULTIPLE}R (TP cap = bien doi dien cua range) ===`);
  for (const r of results) {
    console.log(`\n${r.label}:`);
    let totalPassPerDay = 0;
    for (const symbol of symbols) {
      const perDay = r.perSymbolPassPerDay[symbol];
      totalPassPerDay += perDay;
      console.log(`  ${symbol}: ${perDay.toFixed(2)} tin hieu/ngay`);
    }
    console.log(`  TONG (5 symbol): ${totalPassPerDay.toFixed(2)} tin hieu/ngay`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
