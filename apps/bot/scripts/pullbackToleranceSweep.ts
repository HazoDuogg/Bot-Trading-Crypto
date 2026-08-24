import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNoTradeZone } from '../src/noTradeZone/noTradeZone.js';
import type { Candle } from '../src/noTradeZone/types.js';
import { classifyRegime } from '../src/regime/regimeClassifier.js';
import { routeRegimeMatrix } from '../src/regime/regimeMatrix.js';
import { DEFAULT_REGIME_CONFIG } from '../src/regime/types.js';
import type { Direction } from '../src/regime/types.js';
import { detectPinBar } from '../src/entry/pinBar.js';
import { detectEngulfing } from '../src/entry/engulfing.js';
import { checkPullbackZone } from '../src/entry/pullbackZone.js';
import { computeAtr } from '../src/noTradeZone/atr.js';
import { calculateSl } from '../src/risk/slCalculator.js';
import type { EntryStrategy } from '../src/risk/types.js';
import { calculatePartialTp } from '../src/risk/partialTpCalculator.js';
import { DEFAULT_PARTIAL_TP_CONFIG, TAKER_ONLY_FEE_CONFIG } from '../src/risk/partialTp.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';

// TICKET-RT-020: re-sweeps checkPullbackZone()'s toleranceAtrMultiplier at the correct scale
// (2x-6x ATR M5, not RT-019's 0.3-1.0x which never got near the real p25=2.84/median=4.62 measured
// on BTC). checkPullbackZone() itself is UNCHANGED (per ticket instruction) — this script only
// varies the tolerance passed to it and does NOT wire the filter into any production script (the
// 3 scripts RT-019 touched already carry the filter with the old 0.5 default; that default is out
// of scope here — only measurement, no new integration).
//
// One pass collects every TREND_PULLBACK candidate (regime+candlestick match, BEFORE any pullback
// filter) per symbol along with its distanceAtr, entry/SL/TP prices, outcome, and sizing — then the
// tolerance sweep re-filters that same in-memory set, avoiding 5 redundant full candle re-scans.

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

const TOLERANCE_SWEEP = [2.0, 3.0, 4.0, 5.0, 6.0];

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

interface Candidate {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  qty: number;
  notional: number;
  outcome: Outcome;
  distanceAtr: number | null; // null = no relevant M15 swing found at all (never admitted regardless of tolerance)
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

async function findCandidates(symbol: string, dataDir: string): Promise<Candidate[]> {
  const h1All = await readCsv(path.join(dataDir, `${symbol}_1h.csv`));
  const m15All = await readCsv(path.join(dataDir, `${symbol}_15m.csv`));
  const m5All = await readCsv(path.join(dataDir, `${symbol}_5m.csv`));
  const leverage = LEVERAGE[symbol];

  const candidates: Candidate[] = [];
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
    if (matrix.strategy !== 'TREND_PULLBACK') continue; // this ticket is TREND_PULLBACK only

    const m5Window = m5All.slice(0, i + 1);
    const atrValues = computeAtr(m5Window, ATR_PERIOD);
    if (atrValues.length === 0) continue;
    const atrM5 = atrValues[atrValues.length - 1];

    const signalDir = candlestickDirection(m5Window);
    if (signalDir !== matrix.direction) continue;
    const direction = matrix.direction;

    const entryPrice = m5Window[m5Window.length - 1].close;

    // Distance is measured regardless of tolerance — the sweep filters on this value afterward.
    const zone = checkPullbackZone({
      direction,
      entryPrice,
      m15Candles: m15Window,
      swingPivotWidth: SWING_WIDTH,
      atrM5,
      toleranceAtrMultiplier: Infinity, // never rejects here — we only want distanceAtr
    });

    const slResult = calculateSl({
      strategy: 'TREND_PULLBACK' as EntryStrategy,
      direction,
      entryPrice,
      m5Candles: m5Window,
      swingPivotWidth: SWING_WIDTH,
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

    candidates.push({
      symbol,
      direction,
      entryPrice,
      slPrice: slResult.slPrice,
      tp1Price: partialTp.tp1Price,
      tp2Price: partialTp.tp2Price,
      qty: sizing.qty,
      notional: sizing.notional,
      outcome,
      distanceAtr: zone.distanceAtr,
    });
  }

  return candidates;
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

function computePnl(c: Candidate): number {
  const { tp1ClosePct, tp2ClosePct } = DEFAULT_PARTIAL_TP_CONFIG;
  const { direction, entryPrice, slPrice, tp1Price, tp2Price, outcome, qty, notional } = c;

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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

interface SweepRow {
  label: string;
  n: number;
  slOnlyPct: number;
  tp1ThenSlPct: number;
  tp2Pct: number;
  stillOpenPct: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

function summarize(label: string, candidates: Candidate[]): SweepRow {
  const n = candidates.length;
  const count = (o: Outcome) => candidates.filter((c) => c.outcome === o).length;
  const slOnly = count('SL_ONLY');
  const tp1ThenSl = count('TP1_THEN_SL');
  const tp2 = count('TP2');
  const stillOpen = count('STILL_OPEN');

  const decidable = candidates.filter((c) => c.outcome !== 'STILL_OPEN');
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const c of decidable) {
    const p = computePnl(c);
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

  return {
    label,
    n,
    slOnlyPct: n > 0 ? (slOnly / n) * 100 : 0,
    tp1ThenSlPct: n > 0 ? (tp1ThenSl / n) * 100 : 0,
    tp2Pct: n > 0 ? (tp2 / n) * 100 : 0,
    stillOpenPct: n > 0 ? (stillOpen / n) * 100 : 0,
    pnl,
    winRate,
    profitFactor,
  };
}

function printRow(row: SweepRow): void {
  console.log(
    row.label.padEnd(14) +
      `n=${row.n}`.padEnd(8) +
      `SL=${row.slOnlyPct.toFixed(1)}%`.padEnd(10) +
      `TP1_SL=${row.tp1ThenSlPct.toFixed(1)}%`.padEnd(12) +
      `TP2=${row.tp2Pct.toFixed(1)}%`.padEnd(10) +
      `open=${row.stillOpenPct.toFixed(1)}%`.padEnd(10) +
      `PnL=$${row.pnl.toFixed(2)}`.padEnd(14) +
      `winRate=${row.winRate.toFixed(1)}%`.padEnd(14) +
      `PF=${Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : 'inf'}`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allCandidates: Candidate[] = [];
  for (const symbol of symbols) {
    const candidates = await findCandidates(symbol, dataDir);
    console.log(`${symbol}: ${candidates.length} TREND_PULLBACK candidates (before pullback-zone filter)`);
    allCandidates = allCandidates.concat(candidates);
  }
  console.log(`\nTotal TREND_PULLBACK candidates: ${allCandidates.length}\n`);

  console.log('=== Phan phoi distanceAtr (khoang cach entry->vung swing M15 gan nhat, don vi ATR M5), theo tung symbol ===\n');
  for (const symbol of symbols) {
    const values = allCandidates
      .filter((c) => c.symbol === symbol && c.distanceAtr !== null)
      .map((c) => c.distanceAtr as number)
      .sort((a, b) => a - b);
    const noZone = allCandidates.filter((c) => c.symbol === symbol && c.distanceAtr === null).length;
    if (values.length === 0) {
      console.log(`  ${symbol}: n=0 co distanceAtr (khong co vung swing M15 nao) (${noZone} candidate khong co vung)`);
      continue;
    }
    console.log(
      `  ${symbol}: n=${values.length}  p25=${percentile(values, 0.25).toFixed(2)}  median=${percentile(values, 0.5).toFixed(2)}  p75=${percentile(values, 0.75).toFixed(2)}  min=${values[0].toFixed(2)}  max=${values[values.length - 1].toFixed(2)}  (${noZone} candidate khong co vung swing)`,
    );
  }

  const values = allCandidates.filter((c) => c.distanceAtr !== null).map((c) => c.distanceAtr as number).sort((a, b) => a - b);
  console.log(
    `  TAT CA 5 COIN: n=${values.length}  p25=${percentile(values, 0.25).toFixed(2)}  median=${percentile(values, 0.5).toFixed(2)}  p75=${percentile(values, 0.75).toFixed(2)}`,
  );

  console.log('\n=== Sweep toleranceAtrMultiplier (2x-6x ATR M5), gop ca 5 coin ===\n');
  const baselineRow = summarize('BASELINE (no filter)', allCandidates);
  printRow(baselineRow);
  console.log('');

  for (const tolerance of TOLERANCE_SWEEP) {
    const filtered = allCandidates.filter((c) => c.distanceAtr !== null && c.distanceAtr <= tolerance);
    const row = summarize(`tol=${tolerance}x`, filtered);
    printRow(row);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
