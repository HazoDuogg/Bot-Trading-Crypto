import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { findSwingPoints } from '../src/regime/swingPoints.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Strategy, Direction } from '../src/regime/types.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { detectBos } from '../src/entry/bos.js';
import { DEFAULT_BOS_CONFIG } from '../src/entry/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy } from '../src/risk/types.js';


const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;
const RANGE_PROXIMITY_ATR_MULTIPLIER = 1;

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

interface SignalRecord {
  symbol: string;
  strategy: Strategy;
  slPct: number;
}

function rangeSignal(
  m5Window: Candle[],
  m15Window: Candle[],
  atrM5: number,
): { direction: Direction; rangeLevel: number } | null {
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

  if (distToLow <= proximity && distToLow <= distToHigh) return { direction: 'LONG', rangeLevel: lastLow.price };
  if (distToHigh <= proximity) return { direction: 'SHORT', rangeLevel: lastHigh.price };
  return null;
}

function candlestickDirection(m5Window: Candle[]): Direction | null {
  const current = m5Window[m5Window.length - 1];
  const pinBar = detectPinBar(current);
  if (pinBar.isPinBar && pinBar.direction) return pinBar.direction;

  if (m5Window.length >= 2) {
    const prev = m5Window[m5Window.length - 2];
    const engulfing = detectEngulfing(prev, current);
    if (engulfing.isEngulfing && engulfing.direction) return engulfing.direction;
  }
  return null;
}

async function processSymbol(symbol: string, dataDir: string): Promise<{ signals: SignalRecord[]; spanDays: number }> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));

  const signals: SignalRecord[] = [];
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
    if (matrix.strategy === 'STANDBY') continue;

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    let direction: Direction | undefined;
    let rangeLevel: number | undefined;
    let brokenLevel: number | undefined;

    if (matrix.strategy === 'TREND_PULLBACK') {
      const signalDir = candlestickDirection(m5Window);
      if (signalDir !== matrix.direction) continue;
      direction = matrix.direction;
    } else if (matrix.strategy === 'RANGE_TRADING') {
      const range = rangeSignal(m5Window, m15Window, atrM5);
      if (!range) continue;
      const signalDir = candlestickDirection(m5Window);
      if (signalDir !== range.direction) continue;
      direction = range.direction;
      rangeLevel = range.rangeLevel;
    } else {
      const bos = detectBos(m5Window, DEFAULT_BOS_CONFIG);
      if (!bos.isBos || bos.direction !== matrix.direction) continue;
      direction = matrix.direction;
      brokenLevel = bos.brokenLevel;
    }
    if (!direction) continue;

    const entryPrice = m5Window[m5Window.length - 1].close;
    const slResult = calculateSl({
      strategy: matrix.strategy as EntryStrategy,
      direction,
      entryPrice,
      m5Candles: m5Window,
      swingPivotWidth: SWING_WIDTH,
      rangeLevel,
      brokenLevel,
      atrM5,
    });
    if (!slResult) continue;

    signals.push({ symbol, strategy: matrix.strategy, slPct: (slResult.distance / entryPrice) * 100 });
  }

  const spanMs = m5All.length > 0 ? m5All[m5All.length - 1].openTime - m5All[0].openTime : 0;
  const spanDays = spanMs / (24 * 60 * 60 * 1000);
  return { signals, spanDays };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function printDistribution(label: string, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  console.log(
    `  ${label}: n=${values.length}  min=${min.toFixed(3)}%  p25=${p25.toFixed(3)}%  median=${median.toFixed(3)}%  p75=${p75.toFixed(3)}%  max=${max.toFixed(3)}%`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  const allSignals: SignalRecord[] = [];
  const spanBySymbol: Record<string, number> = {};

  for (const symbol of symbols) {
    console.log(`Processing ${symbol}...`);
    const { signals, spanDays } = await processSymbol(symbol, dataDir);
    allSignals.push(...signals);
    spanBySymbol[symbol] = spanDays;
    console.log(`  ${signals.length} signals over ${spanDays.toFixed(1)} days`);
  }

  console.log('\n=== SL% distribution theo symbol ===');
  for (const symbol of symbols) {
    const values = allSignals.filter((s) => s.symbol === symbol).map((s) => s.slPct);
    if (values.length === 0) {
      console.log(`  ${symbol}: n=0 (khong co tin hieu nao)`);
      continue;
    }
    printDistribution(symbol, values);
  }

  console.log('\n=== SL% distribution theo strategy ===');
  const strategies: Strategy[] = ['TREND_PULLBACK', 'RANGE_TRADING', 'BREAKOUT_WATCH'];
  for (const strategy of strategies) {
    const values = allSignals.filter((s) => s.strategy === strategy).map((s) => s.slPct);
    if (values.length === 0) {
      console.log(`  ${strategy}: n=0 (khong co tin hieu nao)`);
      continue;
    }
    printDistribution(strategy, values);
  }

  console.log('\n=== SL% distribution theo symbol x strategy ===');
  for (const symbol of symbols) {
    for (const strategy of strategies) {
      const values = allSignals.filter((s) => s.symbol === symbol && s.strategy === strategy).map((s) => s.slPct);
      if (values.length === 0) continue;
      printDistribution(`${symbol} / ${strategy}`, values);
    }
  }

  console.log('\n=== So tin hieu / ngay trung binh (truoc R:R filter) ===');
  for (const symbol of symbols) {
    const count = allSignals.filter((s) => s.symbol === symbol).length;
    const spanDays = spanBySymbol[symbol];
    const perDay = spanDays > 0 ? count / spanDays : 0;
    console.log(`  ${symbol}: ${count} tin hieu / ${spanDays.toFixed(1)} ngay = ${perDay.toFixed(2)} tin hieu/ngay`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
