import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Direction, Strategy } from '../src/regime/types.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { detectBos } from '../src/entry/bos.js';
import { DEFAULT_BOS_CONFIG } from '../src/entry/types.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy, FeeConfig } from '../src/risk/types.js';
import { calculatePartialTp } from '../src/risk/partialTpCalculator.js';

// TICKET-RT-010: measures calculatePartialTp() pass rate via full backtest replay (not the static
// percentile check from TICKET-RT-009's report), comparing taker-fee (scenario A, current default)
// vs a maker-fee-on-exit approximation (scenario B). Detection pipeline (NTZ -> Regime H1/M15 ->
// M5 entry signal) is identical to TICKET-RT-006/007's scripts, restricted to TREND_PULLBACK and
// BREAKOUT_WATCH only (RANGE_TRADING doesn't use this partial-TP model). SL comes from the real,
// unmodified calculateSl() — no src file is changed by this script.
//
// LIMITATION (per ticket): roundTripCost() charges one fee rate for both legs of the trade. Scenario B
// (takerFeePct=0.02) is a simplified stand-in for "entry taker 0.05% + exit maker 0.02%" — it actually
// prices BOTH legs at 0.02%, understating true blended cost slightly (a true split would be higher than
// B's cost but lower than A's). Not fixed here per ticket instruction; treat B as a directional/optimistic
// upper bound on the benefit of maker exits, not an exact figure.

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;

const FEE_SCENARIO_A: FeeConfig = { takerFeePct: 0.05, slippagePct: 0.05 };
const FEE_SCENARIO_B: FeeConfig = { takerFeePct: 0.02, slippagePct: 0.05 };

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

interface Sample {
  symbol: string;
  strategy: 'TREND_PULLBACK' | 'BREAKOUT_WATCH';
  passesA: boolean;
  passesB: boolean;
  netRA: number;
  netRB: number;
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

async function processSymbol(symbol: string, dataDir: string): Promise<{ samples: Sample[]; spanDays: number }> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));

  const samples: Sample[] = [];
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
    if (matrix.strategy !== 'TREND_PULLBACK' && matrix.strategy !== 'BREAKOUT_WATCH') continue;

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    let direction: Direction | undefined;
    let brokenLevel: number | undefined;

    if (matrix.strategy === 'TREND_PULLBACK') {
      const signalDir = candlestickDirection(m5Window);
      if (signalDir !== matrix.direction) continue;
      direction = matrix.direction;
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
      brokenLevel,
      atrM5,
    });
    if (!slResult) continue;

    const resultA = calculatePartialTp({
      direction,
      entryPrice,
      slPrice: slResult.slPrice,
      feeConfig: FEE_SCENARIO_A,
    });
    const resultB = calculatePartialTp({
      direction,
      entryPrice,
      slPrice: slResult.slPrice,
      feeConfig: FEE_SCENARIO_B,
    });

    samples.push({
      symbol,
      strategy: matrix.strategy,
      passesA: resultA.passes,
      passesB: resultB.passes,
      netRA: resultA.netRMultiple,
      netRB: resultB.netRMultiple,
    });
  }

  const spanMs = m5All.length > 0 ? m5All[m5All.length - 1].openTime - m5All[0].openTime : 0;
  return { samples, spanDays: spanMs / (24 * 60 * 60 * 1000) };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');
  const strategies: Strategy[] = ['TREND_PULLBACK', 'BREAKOUT_WATCH'];

  const bySymbol: Record<string, { samples: Sample[]; spanDays: number }> = {};
  for (const symbol of symbols) {
    console.log(`Processing ${symbol}...`);
    bySymbol[symbol] = await processSymbol(symbol, dataDir);
    console.log(`  ${bySymbol[symbol].samples.length} signals (TREND_PULLBACK + BREAKOUT_WATCH) over ${bySymbol[symbol].spanDays.toFixed(1)} days`);
  }

  console.log('\n=== Ket qua theo symbol x strategy (Kich ban A: taker 0.05%/0.05% vs B: 0.02%/0.05%) ===');
  for (const symbol of symbols) {
    const { samples, spanDays } = bySymbol[symbol];
    for (const strategy of strategies) {
      const subset = samples.filter((s) => s.strategy === strategy);
      if (subset.length === 0) {
        console.log(`  ${symbol} / ${strategy}: n=0`);
        continue;
      }
      const passA = subset.filter((s) => s.passesA).length;
      const passB = subset.filter((s) => s.passesB).length;
      const pctA = (passA / subset.length) * 100;
      const pctB = (passB / subset.length) * 100;
      const perDayA = spanDays > 0 ? passA / spanDays : 0;
      const perDayB = spanDays > 0 ? passB / spanDays : 0;
      const netRAValues = subset.map((s) => s.netRA);
      const netRBValues = subset.map((s) => s.netRB);

      console.log(`\n  ${symbol} / ${strategy}  (n=${subset.length}, ${spanDays.toFixed(1)} ngay)`);
      console.log(
        `    A (taker): pass=${passA}/${subset.length} (${pctA.toFixed(1)}%)  ${perDayA.toFixed(2)} lenh pass/ngay  netR mean=${mean(netRAValues).toFixed(3)} median=${median(netRAValues).toFixed(3)}`,
      );
      console.log(
        `    B (maker-exit approx): pass=${passB}/${subset.length} (${pctB.toFixed(1)}%)  ${perDayB.toFixed(2)} lenh pass/ngay  netR mean=${mean(netRBValues).toFixed(3)} median=${median(netRBValues).toFixed(3)}`,
      );
    }
  }

  console.log('\n=== So sanh A vs B — rieng BTC va ETH ===');
  console.log(
    'symbol/strategy'.padEnd(28) +
      'passA%'.padEnd(10) +
      'passB%'.padEnd(10) +
      'delta_pp'.padEnd(10) +
      'A/ngay'.padEnd(10) +
      'B/ngay'.padEnd(10),
  );
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const { samples, spanDays } = bySymbol[symbol];
    for (const strategy of strategies) {
      const subset = samples.filter((s) => s.strategy === strategy);
      if (subset.length === 0) continue;
      const passA = subset.filter((s) => s.passesA).length;
      const passB = subset.filter((s) => s.passesB).length;
      const pctA = (passA / subset.length) * 100;
      const pctB = (passB / subset.length) * 100;
      const perDayA = spanDays > 0 ? passA / spanDays : 0;
      const perDayB = spanDays > 0 ? passB / spanDays : 0;
      console.log(
        `${symbol} / ${strategy}`.padEnd(28) +
          `${pctA.toFixed(1)}%`.padEnd(10) +
          `${pctB.toFixed(1)}%`.padEnd(10) +
          `${(pctB - pctA).toFixed(1)}pp`.padEnd(10) +
          `${perDayA.toFixed(2)}`.padEnd(10) +
          `${perDayB.toFixed(2)}`.padEnd(10),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
