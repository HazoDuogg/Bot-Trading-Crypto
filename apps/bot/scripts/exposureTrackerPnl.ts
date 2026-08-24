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
import { admitPosition } from '../src/positionSizing/exposureTracker.js';
import { EMPTY_EXPOSURE_STATE } from '../src/positionSizing/exposureTracker.js';
import type { AdmitCandidateInput, ExposureTrackerConfig, ExposureTrackerState } from '../src/positionSizing/exposureTracker.js';

// TICKET-RT-018: confirms/adjusts the cap=70%/floor=40% choice from TICKET-RT-015/016 with real
// $PnL instead of just skip/scale-down counts. Deliberately a NEW file, not an edit of
// exposureTrackerSweep.ts (per ticket instruction) — signal-finding/event-building logic below is
// duplicated from that script, not imported, to keep the two scripts independent.
//
// Scope: only TP2/TP1_THEN_SL/SL_ONLY outcomes from the existing hard SL/TP scan get PnL — no
// Breakeven-SL modeling (that module doesn't exist yet, saved for the full Buoc 6-7 backtest).
// STILL_OPEN trades are excluded from PnL/win-rate/profit-factor entirely, counted separately.
// Skipped-by-exposure-tracker trades contribute exactly pnl=0 (no fees, per ticket spec) and so
// never count toward wins or losses.

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

const MAX_TOTAL_USED_MARGIN_SWEEP = [0.5, 0.6, 0.7, 0.8];
const MIN_RISK_FRACTION_SWEEP = [0.2, 0.3, 0.4, 0.5];

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
  id: string;
  symbol: string;
  entryTimeMs: number;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  candidate: AdmitCandidateInput;
  tp1TimeMs: number | null;
  closeTimeMs: number;
  outcome: Outcome;
}

async function findSignals(symbol: string, dataDir: string): Promise<Signal[]> {
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

      const zone = checkPullbackZone({
        direction: matrix.direction,
        entryPrice: m5Window[m5Window.length - 1].close,
        m15Candles: m15Window,
        swingPivotWidth: SWING_WIDTH,
        atrM5,
        toleranceAtrMultiplier: DEFAULT_PULLBACK_ZONE_CONFIG.toleranceAtrMultiplier,
      });
      if (!zone.valid) continue;

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

    const { tp1TimeMs, closeTimeMs, outcome } = scanOutcome(
      m5All,
      i,
      direction,
      slResult.slPrice,
      partialTp.tp1Price,
      partialTp.tp2Price,
    );

    signals.push({
      id: `${symbol}-${m5All[i].openTime}`,
      symbol,
      entryTimeMs: m5CloseTime,
      direction,
      entryPrice,
      slPrice: slResult.slPrice,
      tp1Price: partialTp.tp1Price,
      tp2Price: partialTp.tp2Price,
      candidate: {
        id: `${symbol}-${m5All[i].openTime}`,
        symbol,
        qty: sizing.qty,
        notional: sizing.notional,
        requiredMargin: sizing.requiredMargin,
        actualRiskUsd: sizing.actualRiskUsd,
      },
      tp1TimeMs,
      closeTimeMs,
      outcome,
    });
  }

  return signals;
}

function scanOutcome(
  m5All: Candle[],
  entryIndex: number,
  direction: Direction,
  slPrice: number,
  tp1Price: number,
  tp2Price: number,
): { tp1TimeMs: number | null; closeTimeMs: number; outcome: Outcome } {
  let tp1TimeMs: number | null = null;
  let tp1Hit = false;

  for (let j = entryIndex + 1; j < m5All.length; j++) {
    const candle = m5All[j];
    const closeMs = candle.openTime + M5_MS;
    const slTouched = direction === 'LONG' ? candle.low <= slPrice : candle.high >= slPrice;
    const tp1Touched = direction === 'LONG' ? candle.high >= tp1Price : candle.low <= tp1Price;
    const tp2Touched = direction === 'LONG' ? candle.high >= tp2Price : candle.low <= tp2Price;

    if (!tp1Hit) {
      if (slTouched) return { tp1TimeMs: null, closeTimeMs: closeMs, outcome: 'SL_ONLY' };
      if (tp1Touched) {
        tp1Hit = true;
        tp1TimeMs = closeMs;
        if (tp2Touched) return { tp1TimeMs, closeTimeMs: closeMs, outcome: 'TP2' };
        continue;
      }
    } else {
      if (slTouched) return { tp1TimeMs, closeTimeMs: closeMs, outcome: 'TP1_THEN_SL' };
      if (tp2Touched) return { tp1TimeMs, closeTimeMs: closeMs, outcome: 'TP2' };
    }
  }

  const lastCloseMs = m5All[m5All.length - 1].openTime + M5_MS;
  return { tp1TimeMs, closeTimeMs: lastCloseMs, outcome: 'STILL_OPEN' };
}

type EventType = 'PARTIAL' | 'CLOSE' | 'OPEN';
interface SimEvent {
  type: EventType;
  timeMs: number;
  signal: Signal;
}

function buildEvents(signals: Signal[]): SimEvent[] {
  const events: SimEvent[] = [];
  for (const signal of signals) {
    events.push({ type: 'OPEN', timeMs: signal.entryTimeMs, signal });
    if (signal.tp1TimeMs !== null && signal.outcome !== 'SL_ONLY') {
      events.push({ type: 'PARTIAL', timeMs: signal.tp1TimeMs, signal });
    }
    events.push({ type: 'CLOSE', timeMs: signal.closeTimeMs, signal });
  }
  const rank: Record<EventType, number> = { PARTIAL: 0, CLOSE: 0, OPEN: 1 };
  events.sort((a, b) => a.timeMs - b.timeMs || rank[a.type] - rank[b.type]);
  return events;
}

function releasePartialMargin(state: ExposureTrackerState, id: string, releaseAmount: number): ExposureTrackerState {
  return {
    openPositions: state.openPositions.map((p) => (p.id === id ? { ...p, requiredMargin: Math.max(0, p.requiredMargin - releaseAmount) } : p)),
  };
}

function closePositionById(state: ExposureTrackerState, id: string): ExposureTrackerState {
  return { openPositions: state.openPositions.filter((p) => p.id !== id) };
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

// Uses the ADMITTED qty/notional (post exposure-tracker scale-down, if any) — pnl is realized only
// on whatever size actually got opened. tp1ClosePct/tp2ClosePct come from the real, unmodified
// DEFAULT_PARTIAL_TP_CONFIG (0.5/0.5).
function computePnl(signal: Signal, admittedQty: number, admittedNotional: number): number {
  const { tp1ClosePct, tp2ClosePct } = DEFAULT_PARTIAL_TP_CONFIG;
  const { direction, entryPrice, slPrice, tp1Price, tp2Price, outcome } = signal;

  if (outcome === 'TP2') {
    return (
      admittedQty * tp1ClosePct * directedDelta(direction, entryPrice, tp1Price) +
      admittedQty * tp2ClosePct * directedDelta(direction, entryPrice, tp2Price) -
      entryFee(admittedNotional) -
      exitFee(tp1ClosePct * admittedNotional) -
      exitFee(tp2ClosePct * admittedNotional)
    );
  }
  if (outcome === 'TP1_THEN_SL') {
    return (
      admittedQty * tp1ClosePct * directedDelta(direction, entryPrice, tp1Price) +
      admittedQty * tp2ClosePct * directedDelta(direction, entryPrice, slPrice) -
      entryFee(admittedNotional) -
      exitFee(tp1ClosePct * admittedNotional) -
      exitFee(tp2ClosePct * admittedNotional)
    );
  }
  // SL_ONLY
  return admittedQty * directedDelta(direction, entryPrice, slPrice) - entryFee(admittedNotional) - exitFee(admittedNotional);
}

interface PnlRow {
  maxTotalUsedMargin: number;
  minRiskFraction: number;
  totalPnl: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  stillOpenCount: number;
  totalOpened: number; // OPEN events processed (admitted + skipped), excludes nothing
}

function runSweepPnl(events: SimEvent[], config: ExposureTrackerConfig): PnlRow {
  let state: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const admittedById = new Map<string, { qty: number; notional: number; requiredMargin: number }>();

  const row: PnlRow = {
    maxTotalUsedMargin: config.maxTotalUsedMargin,
    minRiskFraction: config.minRiskFraction,
    totalPnl: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    stillOpenCount: 0,
    totalOpened: 0,
  };

  for (const event of events) {
    if (event.type === 'OPEN') {
      row.totalOpened++;
      const { result, nextState } = admitPosition(state, config, BALANCE, event.signal.candidate);
      state = nextState;

      if (event.signal.outcome === 'STILL_OPEN') {
        row.stillOpenCount++;
        if (result.admitted) admittedById.set(event.signal.id, { qty: result.qty, notional: result.notional, requiredMargin: result.requiredMargin });
        continue; // excluded from PnL/win-loss entirely
      }

      if (!result.admitted) {
        // pnl = 0, no fee — nothing to add to totalPnl, and not a win nor a loss.
        continue;
      }

      admittedById.set(event.signal.id, { qty: result.qty, notional: result.notional, requiredMargin: result.requiredMargin });
      const pnl = computePnl(event.signal, result.qty, result.notional);
      row.totalPnl += pnl;
      if (pnl > 0) {
        row.wins++;
        row.grossProfit += pnl;
      } else if (pnl < 0) {
        row.losses++;
        row.grossLoss += Math.abs(pnl);
      }
    } else if (event.type === 'PARTIAL') {
      const admitted = admittedById.get(event.signal.id);
      if (!admitted) continue;
      const releaseAmount = admitted.requiredMargin * DEFAULT_PARTIAL_TP_CONFIG.tp1ClosePct;
      state = releasePartialMargin(state, event.signal.id, releaseAmount);
    } else {
      if (!admittedById.has(event.signal.id)) continue;
      state = closePositionById(state, event.signal.id);
      admittedById.delete(event.signal.id);
    }
  }

  return row;
}

function printRow(row: PnlRow): void {
  const decided = row.wins + row.losses;
  const winRate = decided > 0 ? (row.wins / decided) * 100 : 0;
  const profitFactor = row.grossLoss > 0 ? row.grossProfit / row.grossLoss : row.grossProfit > 0 ? Infinity : 0;
  const finalBalance = BALANCE + row.totalPnl;
  console.log(
    `cap=${(row.maxTotalUsedMargin * 100).toFixed(0)}%`.padEnd(10) +
      `floor=${(row.minRiskFraction * 100).toFixed(0)}%`.padEnd(10) +
      `PnL=$${row.totalPnl.toFixed(2)}`.padEnd(16) +
      `final=$${finalBalance.toFixed(2)}`.padEnd(16) +
      `winRate=${winRate.toFixed(1)}%`.padEnd(14) +
      `PF=${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf'}`.padEnd(10) +
      `wins=${row.wins}`.padEnd(10) +
      `losses=${row.losses}`.padEnd(12) +
      `stillOpen=${row.stillOpenCount}/${row.totalOpened} (${((row.stillOpenCount / row.totalOpened) * 100).toFixed(1)}%)`,
  );
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'XRPUSDT'];
  const dataDir = path.resolve(process.cwd(), 'apps/bot/data');

  let allSignals: Signal[] = [];
  for (const symbol of symbols) {
    console.log(`Finding signals for ${symbol}...`);
    const signals = await findSignals(symbol, dataDir);
    console.log(`  ${signals.length} passing TREND_PULLBACK/BREAKOUT_WATCH signals`);
    allSignals = allSignals.concat(signals);
  }
  console.log(`\nTotal signals across 5 coin (interleaved): ${allSignals.length}\n`);
  console.log(
    `LUU Y: PnL nay chi dung outcome scan cung (TP1/TP2/SL co dinh, khong Breakeven SL) — chua phai ` +
      `backtest day du Buoc 6-7. Fee dung TAKER_ONLY_FEE_CONFIG (scenario A). Von co dinh $500, khong compound.\n`,
  );

  const events = buildEvents(allSignals);

  const rows: PnlRow[] = [];
  for (const maxTotalUsedMargin of MAX_TOTAL_USED_MARGIN_SWEEP) {
    for (const minRiskFraction of MIN_RISK_FRACTION_SWEEP) {
      rows.push(runSweepPnl(events, { maxTotalUsedMargin, minRiskFraction }));
    }
  }

  console.log('=== Sweep 4x4: PnL $, winRate, profit factor, STILL_OPEN ===\n');
  for (const row of rows) printRow(row);

  console.log('\n=== So sanh cap=70%/floor=40% (lua chon hien tai) voi cac to hop lan can ===\n');
  const neighbors: Array<[number, number]> = [
    [0.7, 0.4], // current DEFAULT_EXPOSURE_TRACKER_CONFIG
    [0.7, 0.3],
    [0.6, 0.4],
    [0.8, 0.4],
  ];
  for (const [cap, floor] of neighbors) {
    const row = rows.find((r) => r.maxTotalUsedMargin === cap && r.minRiskFraction === floor);
    if (row) printRow(row);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
