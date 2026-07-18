/**
 * TICKET-019 — generates a larger labeled dataset for a future XGBoost filter than the 56 real
 * trades the chosen baseline (TICKET-017 "cả 2") produces in 180 days.
 *
 * Unlike backtest.ts (one managed position per symbol at a time — routeEntry() only runs while
 * that symbol's real position is flat), this script calls detectRegime()/routeEntry() on EVERY 5m
 * candle for every symbol, independent of any position (real or shadow) that might already be
 * "open" for that symbol. PM-confirmed (TICKET-019 clarification): Draft Setups are expected to
 * overlap in time — each row is an independent "if this setup had been taken" trial, not a
 * portfolio simulation, so overlap needs no special handling.
 *
 * For every Draft Setup found, a PARALLEL shadow position (fixed notional size, independent of any
 * real accountBalance/riskPool) is opened via risk/slTpManager.js's openPosition() and walked
 * forward candle-by-candle with orchestrator.ts's own advancePosition() (exported for reuse, not
 * re-derived) until it closes, producing the label. No OB/FVG/Sweep/BoxBreakout/SL-TP formula is
 * reimplemented — only detectRegime/routeEntry/openPosition/advancePosition/computeRealizedPnl are
 * called, all already existing and already tested.
 *
 * wasActuallyTraded is a lookup by (symbol, entryTimestamp) against data/backtest-trades-both.csv
 * (the TICKET-017 "cả 2" baseline run) — true if this exact signal was one of the real trades taken,
 * false otherwise (PM-confirmed: covers BOTH "risk pool blocked" and "another position already open"
 * cases without distinguishing — informational only, not meant for filtering rows).
 *
 * Entry-router config (TICKET-020): policy rules OFF — macroTrendFilterEnabled=false,
 * obDisabledSymbols=[] — since these are exactly the hard-coded rules XGBoost will later replace
 * with a learned score, so the setups they'd otherwise block need real win/loss labels too. This is
 * LOCAL to this script only; DEFAULT_ENTRY_ROUTER_CONFIG and backtest.ts/orchestrator.ts's real
 * strategy config are untouched. Structural conditions (OB/FVG/Sweep/MSS confirmation, Box
 * Breakout) are NOT touched — still gate what counts as a valid setup, same as live.
 *
 * Output: data/training/draft-setups-labeled.csv — separate from data/backtest-report*.md /
 * data/backtest-trades*.csv, does not read state from or overwrite them (only reads
 * backtest-trades-both.csv for the wasActuallyTraded lookup).
 *
 * Run from repo root: `npm run generate-training-data`
 * (requires `npm run build` + data/ohlcv/*_{5m,15m,1h,1m,1d}.csv + data/backtest-trades-both.csv
 * already present — the latter from `npm run backtest -- --tp-plan=PLAN_A --macro-trend-filter=true
 * --ob-disabled-symbols=XRPUSDT --macro-trend-box-breakout=false`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG, routeEntry } from '../dist/entry/entryRouter.js';
import { EntryConfig } from '../dist/entry/config.js';
import type { EntryRouterConfig } from '../dist/entry/types.js';
import { advancePosition } from '../dist/orchestrator/orchestrator.js';
import type { RegimeHysteresisState, ExitReason } from '../dist/orchestrator/types.js';
import { openPosition, computeRealizedPnl, type ManagedPositionState, type SlTpManagerInput, type TpPlan } from '../dist/risk/slTpManager.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const TRADES_PATH = path.resolve(process.cwd(), 'data/backtest-trades-both.csv');
const OUT_DIR = path.resolve(process.cwd(), 'data/training');
const OUT_PATH = path.join(OUT_DIR, 'draft-setups-labeled.csv');

// Same bounded-window sizes as backtest.ts — kept in sync manually (each script is self-contained,
// same convention as calibrateThresholds.ts).
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;

// Fixed shadow position size — arbitrary constant, chosen only for readability. pnlUsd/label_pnlPct
// are exactly invariant to this choice: computeRealizedPnl's gross P&L (sum of tier% x positionSize)
// and its fee (positionSize x takerFeeRate x 2) both scale linearly with positionSize with no
// constant term, so their ratio (label_pnlPct) and sign (label_win) never depend on the value picked.
const FIXED_POSITION_SIZE = 1000;
const TP_PLAN: TpPlan = 'PLAN_A'; // matches the chosen baseline (TICKET-017 "cả 2")
const TAKER_FEE_RATE = 0.0004; // matches backtest.ts

// TICKET-020: policy rules OFF for training-data collection — Macro Trend Filter and
// OB_DISABLED_SYMBOLS are exactly the hard-coded rules XGBoost will later replace with a learned
// score, so the training set must include the setups they'd otherwise block, with real win/loss
// labels, for the model to learn from. Structural conditions (OB/FVG/Sweep/MSS confirmation, Box
// Breakout) are NOT touched — routeEntry()'s own detectors still gate what counts as a valid setup,
// same as live. Local to this script only — does NOT change DEFAULT_ENTRY_ROUTER_CONFIG, which
// backtest.ts/orchestrator.ts still use unmodified for the real strategy backtest.
const ENTRY_ROUTER_CONFIG: EntryRouterConfig = {
  ...DEFAULT_ENTRY_ROUTER_CONFIG,
  macroTrendFilterEnabled: false,
  obDisabledSymbols: [],
  macroTrendFilterAppliesToBoxBreakout: false, // moot once macroTrendFilterEnabled is false, kept explicit
};

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return {
      timestamp: Number(timestampUtc),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };
  });
}

interface SymbolCandles {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
}

function loadSymbolCandles(symbol: string): SymbolCandles {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
  };
}

/** Two-pointer: advances `ptr` to the latest candle already CLOSED (open+interval <= decisionTime), never looks ahead. Identical to backtest.ts's own. */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

/** (symbol, entryTimestamp) keys of every real trade actually opened in the chosen-baseline backtest run. */
function loadTradedKeys(filePath: string): Set<string> {
  if (!existsSync(filePath)) {
    throw new Error(
      `generateTrainingData: thiếu ${filePath} — chạy 'npm run backtest -- --tp-plan=PLAN_A --macro-trend-filter=true --ob-disabled-symbols=XRPUSDT --macro-trend-box-breakout=false' trước.`,
    );
  }
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  const header = lines[0].split(',');
  const idxSymbol = header.indexOf('symbol');
  const idxEntryTs = header.indexOf('entryTimestamp');
  const keys = new Set<string>();
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    keys.add(`${cols[idxSymbol]}|${cols[idxEntryTs]}`);
  }
  return keys;
}

interface ShadowResult {
  exitReason: ExitReason;
  pnlUsd: number;
  pnlPct: number;
}

/** Opens a fixed-size shadow position at the Draft Setup's price and walks it forward through REAL
 * future candles (already in hand, no look-ahead concern here — we're deliberately simulating what
 * happens next) using orchestrator.ts's own advancePosition(), until it closes. `null` if the
 * available history runs out before the position resolves (near the end of the dataset). */
function simulateShadowTrade(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  slPrice: number,
  candles5m: CandleData[],
  entryStepIndex: number,
): ShadowResult | null {
  const openInput: SlTpManagerInput = {
    scenario: 'TREND', // entryRouter has no COUNTER_TREND path (same assumption as orchestrator.ts)
    entryPrice,
    slPrice,
    side,
    tpPlan: TP_PLAN,
    positionSize: FIXED_POSITION_SIZE,
    takerFeeRate: TAKER_FEE_RATE,
  };
  let pos: ManagedPositionState = openPosition(openInput);

  for (let j = entryStepIndex + 1; j < candles5m.length; j++) {
    const candle = candles5m[j];
    const atrWindow = candles5m.slice(Math.max(0, j - WINDOW_5M + 1), j + 1);
    const { position, exitReason, exitPrice } = advancePosition(pos, candle, atrWindow, false);
    pos = position;
    if (pos.closed) {
      const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
      return { exitReason: exitReason as ExitReason, pnlUsd, pnlPct: (pnlUsd / FIXED_POSITION_SIZE) * 100 };
    }
  }
  return null; // ran out of future data before closing
}

interface Row {
  symbol: string;
  timestampUtc: number;
  regime: string;
  setupType: string;
  side: string;
  adx1h: number;
  atrPercentile5m: number;
  bbWidthPercentile15m: number;
  atrTrend5m: string;
  volumeZScore5m: number;
  adxDirection1h: string;
  macroDirection: string;
  slDistancePercent: number;
  wasActuallyTraded: boolean;
  label_win: 0 | 1;
  label_pnlPct: number;
  label_exitReason: string;
}

function rowsForSymbol(symbol: string, tradedKeys: Set<string>): { rows: Row[]; unresolvedCount: number } {
  const sc = loadSymbolCandles(symbol);
  const rows: Row[] = [];
  let unresolvedCount = 0;

  let ptr15m = -1;
  let ptr1h = -1;
  let ptr1m = -1;
  let ptr1d = -1;
  let regimeState: RegimeHysteresisState = { previousRegime: null, previousCandidateRegime: null, streakCount: 0, previousDangerZoneTimestamp: null };

  const totalSteps = sc.candles5m.length;
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5;

  for (let step = startStep; step < totalSteps; step++) {
    const currentCandle = sc.candles5m[step];
    const decisionTime = currentCandle.timestamp + 5 * 60_000;

    const window5m = sc.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
    const w15 = closedWindow(sc.candles15m, ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
    ptr15m = w15.ptr;
    const w1h = closedWindow(sc.candles1h, ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
    ptr1h = w1h.ptr;
    const w1m = closedWindow(sc.candles1m, ptr1m, 60_000, decisionTime, WINDOW_1M);
    ptr1m = w1m.ptr;
    const w1d = closedWindow(sc.candles1d, ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
    ptr1d = w1d.ptr;

    // Step 1 — regime, always runs (same as orchestrator.ts), hysteresis state threaded across steps.
    const regimeOutput = detectRegime({
      candles5m: window5m,
      candles15m: w15.window,
      candles1h: w1h.window,
      previousRegime: regimeState.previousRegime,
      previousCandidateRegime: regimeState.previousCandidateRegime,
      streakCount: regimeState.streakCount,
      previousDangerZoneTimestamp: regimeState.previousDangerZoneTimestamp,
    });
    regimeState = {
      previousRegime: regimeOutput.regime,
      previousCandidateRegime: regimeOutput.candidateRegime,
      streakCount: regimeOutput.streakCount,
      previousDangerZoneTimestamp: regimeOutput.lastDangerZoneTimestamp,
    };

    // Same computation as orchestrator.ts (TICKET-017 Phần A) — same wilderDIDirectionSeries call, on 1D candles.
    const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
    const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

    // Step 2 — try routeEntry() on EVERY candle, NOT gated by any position (real or shadow) being
    // open. This is the deliberate scope difference from backtest.ts/orchestrator.ts (TICKET-019
    // clarification): overlapping Draft Setups on the same symbol are expected and accepted.
    const draftSetup = routeEntry(
      {
        regime: regimeOutput.regime,
        symbol,
        adxDirection1h: regimeOutput.adxDirection1h,
        macroDirection,
        candles5m: window5m,
        candles15m: w15.window,
        candlesMss: w1m.window,
        bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m,
        volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m,
      },
      ENTRY_ROUTER_CONFIG,
    );

    if (draftSetup === null) continue;

    const shadow = simulateShadowTrade(draftSetup.side, draftSetup.entryPrice, draftSetup.slPrice, sc.candles5m, step);
    if (shadow === null) {
      unresolvedCount++;
      continue; // no future data left to resolve this setup — cannot label it, skip the row
    }

    const slDistancePercent = Math.abs(draftSetup.entryPrice - draftSetup.slPrice) / draftSetup.entryPrice;
    const wasActuallyTraded = tradedKeys.has(`${symbol}|${currentCandle.timestamp}`);

    rows.push({
      symbol,
      timestampUtc: currentCandle.timestamp,
      regime: draftSetup.regime,
      setupType: draftSetup.setupType,
      side: draftSetup.side,
      adx1h: regimeOutput.computedMetrics.adx1h as number,
      atrPercentile5m: regimeOutput.computedMetrics.atrPercentile5m as number,
      bbWidthPercentile15m: regimeOutput.computedMetrics.bbWidthPercentile15m as number,
      atrTrend5m: regimeOutput.computedMetrics.atrTrend5m as string,
      volumeZScore5m: regimeOutput.computedMetrics.volumeZScore5m as number,
      adxDirection1h: regimeOutput.adxDirection1h ?? '',
      macroDirection: macroDirection ?? '',
      slDistancePercent,
      wasActuallyTraded,
      label_win: shadow.pnlUsd > 0 ? 1 : 0,
      label_pnlPct: shadow.pnlPct,
      label_exitReason: shadow.exitReason,
    });
  }

  return { rows, unresolvedCount };
}

function rowsCsv(rows: Row[]): string {
  const header =
    'symbol,timestampUtc,regime,setupType,side,adx1h,atrPercentile5m,bbWidthPercentile15m,atrTrend5m,volumeZScore5m,adxDirection1h,macroDirection,slDistancePercent,wasActuallyTraded,label_win,label_pnlPct,label_exitReason';
  const lines = rows.map((r) =>
    [
      r.symbol,
      r.timestampUtc,
      r.regime,
      r.setupType,
      r.side,
      r.adx1h,
      r.atrPercentile5m,
      r.bbWidthPercentile15m,
      r.atrTrend5m,
      r.volumeZScore5m,
      r.adxDirection1h,
      r.macroDirection,
      r.slDistancePercent,
      r.wasActuallyTraded,
      r.label_win,
      r.label_pnlPct,
      r.label_exitReason,
    ].join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

function main(): void {
  for (const symbol of SYMBOLS) {
    const missing = ['5m', '15m', '1h', '1m', '1d'].filter((tf) => !existsSync(path.join(OHLCV_DIR, `${symbol}_${tf}.csv`)));
    if (missing.length > 0) {
      throw new Error(`generateTrainingData: thiếu file CSV cho ${symbol} (${missing.join(', ')}) — chạy npm run fetch-ohlcv trước.`);
    }
  }

  const tradedKeys = loadTradedKeys(TRADES_PATH);
  console.log(`Đã nạp ${tradedKeys.size} lệnh thật từ ${TRADES_PATH} để đối chiếu wasActuallyTraded.`);

  const allRows: Row[] = [];
  let totalUnresolved = 0;

  for (const symbol of SYMBOLS) {
    console.log(`Quét ${symbol}...`);
    const { rows, unresolvedCount } = rowsForSymbol(symbol, tradedKeys);
    allRows.push(...rows);
    totalUnresolved += unresolvedCount;
    console.log(`  → ${rows.length} Draft Setup có nhãn, ${unresolvedCount} setup bị bỏ qua (hết dữ liệu tương lai để đóng lệnh).`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, rowsCsv(allRows));

  const totalRows = allRows.length;
  const tradedCount = allRows.filter((r) => r.wasActuallyTraded).length;
  const winCount = allRows.filter((r) => r.label_win === 1).length;

  console.log('');
  console.log(`Tổng số dòng: ${totalRows}`);
  console.log(
    `wasActuallyTraded=true: ${tradedCount} (${totalRows > 0 ? ((tradedCount / totalRows) * 100).toFixed(1) : '0.0'}%) — false: ${totalRows - tradedCount} (${totalRows > 0 ? (((totalRows - tradedCount) / totalRows) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(`label_win=1: ${winCount} (${totalRows > 0 ? ((winCount / totalRows) * 100).toFixed(1) : '0.0'}%) — label_win=0: ${totalRows - winCount} (${totalRows > 0 ? (((totalRows - winCount) / totalRows) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(`Setup bị bỏ qua vì hết dữ liệu tương lai (không có nhãn): ${totalUnresolved}`);
  console.log(`→ ${OUT_PATH}`);
}

main();
