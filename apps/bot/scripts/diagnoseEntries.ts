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
import { checkPullbackZone, DEFAULT_PULLBACK_ZONE_CONFIG } from '../src/entry/pullbackZone.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy } from '../src/risk/types.js';
import { calculatePartialTp } from '../src/risk/partialTpCalculator.js';
import { DEFAULT_PARTIAL_TP_CONFIG, TAKER_ONLY_FEE_CONFIG } from '../src/risk/partialTp.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';

// TICKET-RT-019: before/after breakdown for the TREND_PULLBACK "valid pullback zone" filter
// (src/entry/pullbackZone.ts). Run with `--pullback-filter` to measure AFTER; omit it to measure
// BEFORE (current production behavior — no pullback-zone gate). Reports outcome distribution
// (SL_ONLY/TP1_THEN_SL/TP2/STILL_OPEN) and $PnL/winRate/profit-factor per strategy, using the
// candidate's FULL qty/notional from Buoc 5/5a (no portfolio exposure-tracker layer here — this
// ticket is about entry quality, not portfolio margin).

const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const M5_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const SWING_WIDTH = DEFAULT_REGIME_CONFIG.swingPivotWidth;

const BALANCE = 500;
const RISK_PCT = 0.01;
const RISK_USD = BALANCE * RISK_PCT;
const LEVERAGE: Record<string, number> = {
  BTCUSDT: 20,
  ETHUSDT: 20,
  SOLUSDT: 10,
  HYPEUSDT: 10,
  XRPUSDT: 10,
};

const ENTRY_FEE_PCT = TAKER_ONLY_FEE_CONFIG.entryFeePct + TAKER_ONLY_FEE_CONFIG.entrySlippagePct;
const EXIT_FEE_PCT = TAKER_ONLY_FEE_CONFIG.exitFeePct + TAKER_ONLY_FEE_CONFIG.exitSlippagePct;

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

type Outcome = 'TP2' | 'TP1_THEN_SL' | 'SL_ONLY' | 'STILL_OPEN';

interface Signal {
  symbol: string;
  strategy: 'TREND_PULLBACK' | 'BREAKOUT_WATCH';
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  qty: number;
  notional: number;
  outcome: Outcome;
}

function scanOutcome(
  m5All: Candle[],
  entryIndex: number,
  direction: Direction,
  slPrice: number,
  tp1Price: number,
  tp2Price: number,
): Outcome {
  let tp1Hit = false;
  for (let j = entryIndex + 1; j < m5All.length; j++) {
    const candle = m5All[j];
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tp1Touched = direction === 'LONG' ? candle.high >= tp1Price : candle.low <= tp1Price;
    const tp2Touched = direction === 'LONG' ? candle.high >= tp2Price : candle.low <= tp2Price;

    if (!tp1Hit) {
      if (slTouched) return 'SL_ONLY';
      if (tp1Touched) {
        tp1Hit = true;
        if (tp2Touched) return 'TP2';
        continue;
      }
    } else {
      if (slTouched) return 'TP1_THEN_SL';
      if (tp2Touched) return 'TP2';
    }
  }
  return 'STILL_OPEN';
}

async function findSignals(symbol: string, dataDir: string, applyPullbackFilter: boolean): Promise<Signal[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));
  const leverage = LEVERAGE[symbol];

  const signals: Signal[] = [];
  let h1Cursor = 0;
  let m15Cursor = 0;

  for (let i = 0; i < m5All.length; i++) {
    const m5CloseTime = m5All[i].openTime + M5_MS;

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

      if (applyPullbackFilter) {
        const entryPriceForFilter = m5Window[m5Window.length - 1].close;
        const zone = checkPullbackZone({
          direction: matrix.direction,
          entryPrice: entryPriceForFilter,
          m15Candles: m15Window,
          swingPivotWidth: SWING_WIDTH,
          atrM5,
          toleranceAtrMultiplier: DEFAULT_PULLBACK_ZONE_CONFIG.toleranceAtrMultiplier,
        });
        if (!zone.valid) continue;
      }

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

    const partialTp = calculatePartialTp({ direction, entryPrice, slPrice: slResult.slPrice });
    if (!partialTp.passes) continue;

    const sizing = calculatePositionSize({
      balance: BALANCE,
      riskUsd: RISK_USD,
      entryPrice,
      slPrice: slResult.slPrice,
      leverage,
      maxMarginPct: DEFAULT_MAX_MARGIN_PCT,
    });
    if (!sizing) continue;

    const outcome = scanOutcome(m5All, i, direction, slResult.slPrice, partialTp.tp1Price, partialTp.tp2Price);

    signals.push({
      symbol,
      strategy: matrix.strategy,
      direction,
      entryPrice,
      slPrice: slResult.slPrice,
      tp1Price: partialTp.tp1Price,
      tp2Price: partialTp.tp2Price,
      qty: sizing.qty,
      notional: sizing.notional,
      outcome,
    });
  }

  return signals;
}

function directedDelta(direction: Direction, entryPrice: number, exitPrice: number): number {
  return direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function entryFee(notional: number): number {
  return (notional * ENTRY_FEE_PCT) / 100;
}

function exitFee(legNotional: number): number {
  return (legNotional * EXIT_FEE_PCT) / 100;
}

function computePnl(signal: Signal): number {
  const { tp1ClosePct, tp2ClosePct } = DEFAULT_PARTIAL_TP_CONFIG;
  const { direction, entryPrice, slPrice, tp1Price, tp2Price, outcome, qty, notional } = signal;

  if (outcome === 'TP2') {
    return (
      qty * tp1ClosePct * directedDelta(direction, entryPrice, tp1Price) +
      qty * tp2ClosePct * directedDelta(direction, entryPrice, tp2Price) -
      entryFee(notional) -
      exitFee(tp1ClosePct * notional) -
      exitFee(tp2ClosePct * notional)
    );
  }
  if (outcome === 'TP1_THEN_SL') {
    return (
      qty * tp1ClosePct * directedDelta(direction, entryPrice, tp1Price) +
      qty * tp2ClosePct * directedDelta(direction, entryPrice, slPrice) -
      entryFee(notional) -
      exitFee(tp1ClosePct * notional) -
      exitFee(tp2ClosePct * notional)
    );
  }
  // SL_ONLY — STILL_OPEN never reaches here (excluded before calling computePnl)
  return qty * directedDelta(direction, entryPrice, slPrice) - entryFee(notional) - exitFee(notional);
}

function printBreakdown(label: string, signals: Signal[]): void {
  console.log(`\n--- ${label} (n=${signals.length}) ---`);
  if (signals.length === 0) return;

  const outcomes: Outcome[] = ['SL_ONLY', 'TP1_THEN_SL', 'TP2', 'STILL_OPEN'];
  for (const outcome of outcomes) {
    const count = signals.filter((s) => s.outcome === outcome).length;
    console.log(`  ${outcome}: ${count} (${((count / signals.length) * 100).toFixed(1)}%)`);
  }

  const decidable = signals.filter((s) => s.outcome !== 'STILL_OPEN');
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const signal of decidable) {
    const pnl = computePnl(signal);
    totalPnl += pnl;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses++;
      grossLoss += Math.abs(pnl);
    }
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  console.log(
    `  PnL=$${totalPnl.toFixed(2)}  winRate=${winRate.toFixed(1)}%  PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}  wins=${wins}  losses=${losses}`,
  );
}

async function main() {
  const applyPullbackFilter = process.argv.includes('--pullback-filter');
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  console.log(`Mode: ${applyPullbackFilter ? 'AFTER (pullback-zone filter ON)' : 'BEFORE (no pullback-zone filter, current production)'}\n`);

  let allSignals: Signal[] = [];
  for (const symbol of symbols) {
    const signals = await findSignals(symbol, dataDir, applyPullbackFilter);
    console.log(`${symbol}: ${signals.length} signals`);
    allSignals = allSignals.concat(signals);
  }

  const strategies: Strategy[] = ['TREND_PULLBACK', 'BREAKOUT_WATCH'];
  for (const strategy of strategies) {
    printBreakdown(strategy, allSignals.filter((s) => s.strategy === strategy));
  }
  printBreakdown('ALL (TREND_PULLBACK + BREAKOUT_WATCH)', allSignals);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
