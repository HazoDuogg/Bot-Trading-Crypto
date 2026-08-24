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
import { DEFAULT_PARTIAL_TP_CONFIG } from '../src/risk/partialTp.js';
import { calculatePositionSize } from '../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../src/positionSizing/types.js';
import { admitPosition } from '../src/positionSizing/exposureTracker.js';
import { EMPTY_EXPOSURE_STATE } from '../src/positionSizing/exposureTracker.js';
import type { AdmitCandidateInput, ExposureTrackerConfig, ExposureTrackerState } from '../src/positionSizing/exposureTracker.js';

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
  candidate: AdmitCandidateInput;
  tp1TimeMs: number | null;
  closeTimeMs: number; // when the position is fully flat (TP2, SL, or TP1-then-SL)
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
        // Same candle can also clear TP2 (fast wick through both) — full close right here.
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
  // CLOSE/PARTIAL before OPEN on exact ties (frees margin first); PARTIAL before CLOSE is naturally
  // ordered since tp1TimeMs <= closeTimeMs always.
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

interface SweepRow {
  maxTotalUsedMargin: number;
  minRiskFraction: number;
  totalSignals: number;
  skippedCount: number;
  scaledDownCount: number;
  totalRiskReduced: number;
  bySymbol: Record<string, { skipped: number; scaledDown: number; riskReduced: number }>;
  skippedWins: number;
  skippedLosses: number;
  skippedUndetermined: number;
}

function runSweep(events: SimEvent[], symbols: string[], config: ExposureTrackerConfig): SweepRow {
  let state: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const admittedMarginById = new Map<string, number>();

  const row: SweepRow = {
    maxTotalUsedMargin: config.maxTotalUsedMargin,
    minRiskFraction: config.minRiskFraction,
    totalSignals: 0,
    skippedCount: 0,
    scaledDownCount: 0,
    totalRiskReduced: 0,
    bySymbol: Object.fromEntries(symbols.map((s) => [s, { skipped: 0, scaledDown: 0, riskReduced: 0 }])),
    skippedWins: 0,
    skippedLosses: 0,
    skippedUndetermined: 0,
  };

  for (const event of events) {
    if (event.type === 'OPEN') {
      row.totalSignals++;
      const { result, nextState } = admitPosition(state, config, BALANCE, event.signal.candidate);
      state = nextState;

      const riskReduced = event.signal.candidate.actualRiskUsd - result.actualRiskUsd;
      if (!result.admitted) {
        row.skippedCount++;
        row.bySymbol[event.signal.symbol].skipped++;
        row.bySymbol[event.signal.symbol].riskReduced += riskReduced;
        row.totalRiskReduced += riskReduced;
        if (event.signal.outcome === 'TP2' || event.signal.outcome === 'TP1_THEN_SL') row.skippedWins++;
        else if (event.signal.outcome === 'SL_ONLY') row.skippedLosses++;
        else row.skippedUndetermined++;
      } else {
        admittedMarginById.set(event.signal.id, result.requiredMargin);
        if (result.scaledDown) {
          row.scaledDownCount++;
          row.bySymbol[event.signal.symbol].scaledDown++;
          row.bySymbol[event.signal.symbol].riskReduced += riskReduced;
          row.totalRiskReduced += riskReduced;
        }
      }
    } else if (event.type === 'PARTIAL') {
      const admittedMargin = admittedMarginById.get(event.signal.id);
      if (admittedMargin === undefined) continue; // was skipped at OPEN, nothing to release
      const releaseAmount = admittedMargin * DEFAULT_PARTIAL_TP_CONFIG.tp1ClosePct;
      state = releasePartialMargin(state, event.signal.id, releaseAmount);
    } else {
      if (!admittedMarginById.has(event.signal.id)) continue; // was skipped at OPEN
      state = closePositionById(state, event.signal.id);
      admittedMarginById.delete(event.signal.id);
    }
  }

  return row;
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

  const events = buildEvents(allSignals);

  const rows: SweepRow[] = [];
  for (const maxTotalUsedMargin of MAX_TOTAL_USED_MARGIN_SWEEP) {
    for (const minRiskFraction of MIN_RISK_FRACTION_SWEEP) {
      rows.push(runSweep(events, symbols, { maxTotalUsedMargin, minRiskFraction }));
    }
  }

  console.log('=== Sweep 4x4: maxTotalUsedMargin x minRiskFraction (baseline = tat ca signal duoc mo full size, khong co exposure tracker) ===\n');
  console.log(
    'cap'.padEnd(8) +
    'floor'.padEnd(8) +
    'total'.padEnd(8) +
    'skipped'.padEnd(10) +
    'scaledDn'.padEnd(10) +
    'riskReduced$'.padEnd(14) +
    'skip_win'.padEnd(10) +
    'skip_loss'.padEnd(10) +
    'skip_undet',
  );
  for (const row of rows) {
    console.log(
      `${(row.maxTotalUsedMargin * 100).toFixed(0)}%`.padEnd(8) +
      `${(row.minRiskFraction * 100).toFixed(0)}%`.padEnd(8) +
      String(row.totalSignals).padEnd(8) +
      String(row.skippedCount).padEnd(10) +
      String(row.scaledDownCount).padEnd(10) +
      row.totalRiskReduced.toFixed(2).padEnd(14) +
      String(row.skippedWins).padEnd(10) +
      String(row.skippedLosses).padEnd(10) +
      String(row.skippedUndetermined),
    );
  }

  console.log('\n=== Breakdown theo tung symbol, cho tung to hop ===');
  for (const row of rows) {
    console.log(`\ncap=${(row.maxTotalUsedMargin * 100).toFixed(0)}% floor=${(row.minRiskFraction * 100).toFixed(0)}%:`);
    for (const symbol of symbols) {
      const s = row.bySymbol[symbol];
      console.log(`  ${symbol}: skipped=${s.skipped}  scaledDown=${s.scaledDown}  riskReduced=$${s.riskReduced.toFixed(2)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
