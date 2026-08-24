import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Direction } from '../src/regime/types.js';
import { detectBreakout, DEFAULT_BREAKOUT_CONFIG } from '../src/entry/breakout.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy } from '../src/risk/types.js';
import { calculatePartialTp } from '../src/risk/partialTpCalculator.js';
import { DEFAULT_PARTIAL_TP_CONFIG, TAKER_ONLY_FEE_CONFIG } from '../src/risk/partialTp.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';

// TICKET-RT-021: measures the M15+volume breakout detector (src/entry/breakout.ts) against the
// M5-BOS baseline (src/entry/bos.ts, unchanged, used by measureWickSweep.ts/exposureTrackerSweep.ts/
// exposureTrackerPnl.ts/diagnoseEntries.ts) — confirmed baseline from TICKET-RT-019's diagnoseEntries.ts
// run: BREAKOUT_WATCH n=936, SL_ONLY=56.4%, TP1_THEN_SL=15.8%, TP2=27.7%, PnL=-$722.22, winRate=36.3%,
// PF=0.78. This script does NOT touch bos.ts, TREND_PULLBACK, Regime, NTZ, or Position Sizing.
//
// Decision cadence stays M5 (checked at every M5 close), but detectBreakout() is only evaluated when
// a new M15 candle has just closed (M15 close times are always also M5 close times, so the M5 candle
// that closes the M15 candle IS the "nearest following M5 close" — no separate lookup needed). Entry
// only fires on the false->true EDGE of isBreakout for the current BREAKOUT_WATCH direction — an
// already-broken-out range doesn't keep re-triggering, and a direction/regime change resets the edge
// tracker so a stale breakout in the old direction can't leak into a new one.

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

type Outcome = 'TP2' | 'TP1_THEN_SL' | 'SL_ONLY' | 'STILL_OPEN';

interface Signal {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  rangeHeight: number | null;
  volumeRatio: number | null;
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

async function findSignals(symbol: string, dataDir: string): Promise<Signal[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));
  const leverage = LEVERAGE[symbol];

  const signals: Signal[] = [];
  let h1Cursor = 0;
  let m15Cursor = 0;
  let prevDirection: Direction | undefined;
  let prevIsBreakout = false;

  for (let i = 0; i < m5All.length; i++) {
    const m5CloseTime = m5All[i].openTime + M5_MS;

    while (h1Cursor < h1All.length && h1All[h1Cursor].openTime + H1_MS <= m5CloseTime) h1Cursor++;
    const m15CursorBefore = m15Cursor;
    while (m15Cursor < m15All.length && m15All[m15Cursor].openTime + M15_MS <= m5CloseTime) m15Cursor++;
    const newM15Close = m15Cursor > m15CursorBefore;
    if (h1Cursor === 0 || m15Cursor === 0) continue;
    if (!newM15Close) continue; // decision only evaluated at an M15 close, per ticket design

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
    if (ntz.blocked) {
      prevDirection = undefined;
      prevIsBreakout = false;
      continue;
    }

    const regimeH1 = classifyRegime(h1Window);
    const regimeM15 = classifyRegime(m15Window);
    const matrix = routeRegimeMatrix(regimeH1.state, regimeM15.state);
    if (matrix.strategy !== 'BREAKOUT_WATCH' || !matrix.direction) {
      prevDirection = undefined;
      prevIsBreakout = false;
      continue;
    }

    const breakout = detectBreakout({
      direction: matrix.direction,
      m15Candles: m15Window,
      swingPivotWidth: SWING_WIDTH,
      volumeSpikeMultiplier: DEFAULT_BREAKOUT_CONFIG.volumeSpikeMultiplier,
      volumeLookback: DEFAULT_BREAKOUT_CONFIG.volumeLookback,
    });

    const directionChanged = prevDirection !== matrix.direction;
    const isNewEdge = breakout.isBreakout && (directionChanged || !prevIsBreakout);
    prevDirection = matrix.direction;
    prevIsBreakout = breakout.isBreakout;
    if (!isNewEdge) continue;

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    const entryPrice = m5Window[m5Window.length - 1].close;
    const slResult = calculateSl({
      strategy: 'BREAKOUT_WATCH' as EntryStrategy,
      direction: matrix.direction,
      entryPrice,
      m5Candles: m5Window,
      swingPivotWidth: SWING_WIDTH,
      brokenLevel: breakout.brokenLevel ?? undefined,
      atrM5,
    });
    if (!slResult) continue;

    const partialTp = calculatePartialTp({ direction: matrix.direction, entryPrice, slPrice: slResult.slPrice });
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

    const outcome = scanOutcome(m5All, i, matrix.direction, slResult.slPrice, partialTp.tp1Price, partialTp.tp2Price);

    signals.push({
      symbol,
      direction: matrix.direction,
      entryPrice,
      slPrice: slResult.slPrice,
      tp1Price: partialTp.tp1Price,
      tp2Price: partialTp.tp2Price,
      qty: sizing.qty,
      notional: sizing.notional,
      outcome,
      rangeHeight: breakout.rangeHeight,
      volumeRatio: breakout.volumeRatio,
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

function computePnl(s: Signal): number {
  const { tp1ClosePct, tp2ClosePct } = DEFAULT_PARTIAL_TP_CONFIG;
  const { direction, entryPrice, slPrice, tp1Price, tp2Price, outcome, qty, notional } = s;

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
  return qty * directedDelta(direction, entryPrice, slPrice) - entryFee(notional) - exitFee(notional);
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allSignals: Signal[] = [];
  for (const symbol of symbols) {
    const signals = await findSignals(symbol, dataDir);
    console.log(`${symbol}: ${signals.length} M15-breakout signals`);
    allSignals = allSignals.concat(signals);
  }

  console.log(`\nTotal M15-breakout signals: ${allSignals.length}`);
  console.log(
    'Baseline (M5 BOS, TICKET-RT-019 diagnoseEntries.ts): n=936, SL_ONLY=56.4%, TP1_THEN_SL=15.8%, TP2=27.7%, PnL=-$722.22, winRate=36.3%, PF=0.78\n',
  );

  const n = allSignals.length;
  const count = (o: Outcome) => allSignals.filter((s) => s.outcome === o).length;
  const slOnly = count('SL_ONLY');
  const tp1ThenSl = count('TP1_THEN_SL');
  const tp2 = count('TP2');
  const stillOpen = count('STILL_OPEN');

  console.log('=== Breakdown (M15+volume) ===');
  console.log(`  n=${n}`);
  console.log(`  SL_ONLY: ${slOnly} (${n > 0 ? ((slOnly / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  TP1_THEN_SL: ${tp1ThenSl} (${n > 0 ? ((tp1ThenSl / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  TP2: ${tp2} (${n > 0 ? ((tp2 / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  STILL_OPEN: ${stillOpen} (${n > 0 ? ((stillOpen / n) * 100).toFixed(1) : '0.0'}%)`);

  const decidable = allSignals.filter((s) => s.outcome !== 'STILL_OPEN');
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const s of decidable) {
    const p = computePnl(s);
    pnl += p;
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += Math.abs(p);
    }
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  console.log(
    `  PnL=$${pnl.toFixed(2)}  winRate=${winRate.toFixed(1)}%  PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}  wins=${wins}  losses=${losses}`,
  );

  const ratios = allSignals.filter((s) => s.volumeRatio !== null).map((s) => s.volumeRatio as number);
  const heights = allSignals.filter((s) => s.rangeHeight !== null).map((s) => s.rangeHeight as number);
  if (ratios.length > 0) {
    console.log(`\n  volumeRatio: min=${Math.min(...ratios).toFixed(2)} max=${Math.max(...ratios).toFixed(2)} mean=${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)}`);
  }
  if (heights.length > 0) {
    console.log(`  rangeHeight (chi de do, chua ap dung vao TP): min=${Math.min(...heights).toFixed(4)} max=${Math.max(...heights).toFixed(4)} mean=${(heights.reduce((a, b) => a + b, 0) / heights.length).toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
