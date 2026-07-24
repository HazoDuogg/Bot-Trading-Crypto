/**
 * TICKET-045 — counterfactual: for every case the real MSS staleness check (TICKET-011/040) rejects
 * as MSS_TIMEOUT on the confirmed-baseline backtest (the same 173 cases entry-funnel-report.md /
 * TICKET-044 counts), simulates what would happen if the bot accepted the stale confirmation anyway
 * — entryPrice = the confirming candle's own close (real price at that exact moment), slPrice = the
 * SAME OB/FVG/Sweep + ATR-buffer formula runTrendStyle() already uses — then walks forward through
 * REAL subsequent price data with orchestrator.ts's own advancePosition() (PLAN_A, same as the
 * confirmed backtest) to see the real TP/SL outcome.
 *
 * Separate, read-only analysis script — does NOT modify entryRouter.ts/orchestrator.ts/backtest.ts,
 * does NOT change any live/backtest decision logic. Same "parallel shadow simulation" pattern as
 * generateTrainingData.ts (TICKET-019): reuses processCandle()/routeEntry()/openPosition()/
 * advancePosition()/computeRealizedPnl() — the actual, already-tested functions — never re-derives
 * any OB/FVG/Sweep/MSS/SL/TP formula.
 *
 * Detection: processCandle() runs UNMODIFIED, on the exact confirmed-baseline config, with the same
 * accountBalance/risk-pool/position-open state threading as backtest.ts — so the set of detected
 * MSS_TIMEOUT cases matches entry-funnel-report.md exactly (a case only counts if the real pipeline
 * would genuinely have reached and rejected it: symbol had no open position, regime/setup/macro all
 * passed). Reconstruction: for each detected case, a SECOND, independent routeEntry() call — same
 * EntryRouterConfig except mssStalenessToleranceCandles set effectively infinite — reconstructs the
 * DraftSetup (entryPrice/slPrice/side/setupType) the real code computed internally but discarded.
 * detectOrderBlock/FVG/Sweep/detectMarketStructureShift are pure functions of the SAME candle
 * windows already built for the detection call, so this second call is guaranteed to reproduce the
 * exact same zone/confirmation — zero formula reimplementation, not even a near-copy.
 *
 * The confirming candle's own timestamp (needed to know where in REAL history to start the forward
 * walk — NOT "now", since the confirmation itself was found stale/old) is derived from `candlesLate`
 * (TICKET-044's FunnelEvent.candlesLate) against the SAME 1m window (`candlesMss`) already in scope
 * this step: mssWindow and candlesMss share the same tail (mssWindow is candlesMss filtered from
 * some START point onward), so counting `candlesLate` back from the end of candlesMss lands on the
 * exact same candle detectMarketStructureShift() itself confirmed — no separate MSS walk needed.
 *
 * Run: `npm run simulate-mss-timeout` (requires `npm run build` + `npm run fetch-ohlcv -- --days=180`
 * first, same OHLCV data as backtest.ts's confirmed baseline).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { advancePosition, processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type ExitReason, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG, routeEntry } from '../dist/entry/entryRouter.js';
import { EntryConfig } from '../dist/entry/config.js';
import type { EntryRouterConfig, FunnelEvent } from '../dist/entry/types.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';
import { computeRealizedPnl, openPosition, type ManagedPositionState, type SlTpManagerInput } from '../dist/risk/slTpManager.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_PATH = path.resolve(process.cwd(), 'data/mss-timeout-outcomes-report.md');
const START_BALANCE = 400;

// Same window sizes as backtest.ts — kept in sync manually (each script is self-contained, same
// convention as calibrateThresholds.ts/generateTrainingData.ts).
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
// TICKET-024: momentum's own EMA(200) needs far more 1h history than regime/entry's own WINDOW_1H(40)
// — must be built even though this script doesn't read routeEntry()'s momentum score itself, because
// the confirmed baseline's OrchestratorConfig has momentumFilterEnabled=true, and processCandle()
// uses candles1hMomentum for the SOFT sizing multiplier, which affects risk-pool eligibility and
// therefore the position-open state this script needs to match byte-for-byte (see main() doc comment).
const WINDOW_1H_MOMENTUM = 250;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// Fixed shadow position size — pnlPct/exitReason are exactly invariant to this choice (same proven
// property as generateTrainingData.ts's FIXED_POSITION_SIZE: computeRealizedPnl's gross P&L and fee
// both scale linearly with positionSize, no constant term).
const FIXED_POSITION_SIZE = 1000;
const TAKER_FEE_RATE = 0.0004; // matches backtest.ts's confirmed baseline

function readCsv(filePath: string): CandleData[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [timestampUtc, , open, high, low, close, volume] = line.split(',');
    return { timestamp: Number(timestampUtc), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface SymbolData {
  candles5m: CandleData[];
  candles15m: CandleData[];
  candles1h: CandleData[];
  candles1m: CandleData[];
  candles1d: CandleData[];
  ptr15m: number;
  ptr1h: number;
  ptr1m: number;
  ptr1d: number;
  state: SymbolState;
}

function loadSymbolData(symbol: string): SymbolData {
  return {
    candles5m: readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`)),
    candles15m: readCsv(path.join(OHLCV_DIR, `${symbol}_15m.csv`)),
    candles1h: readCsv(path.join(OHLCV_DIR, `${symbol}_1h.csv`)),
    candles1m: readCsv(path.join(OHLCV_DIR, `${symbol}_1m.csv`)),
    candles1d: readCsv(path.join(OHLCV_DIR, `${symbol}_1d.csv`)),
    ptr15m: -1,
    ptr1h: -1,
    ptr1m: -1,
    ptr1d: -1,
    state: INITIAL_SYMBOL_STATE,
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

// TICKET-045: confirmed baseline's entryRouterConfig, verbatim (see README TICKET-039/040/041) — the
// ONLY difference from what backtest.ts's confirmed run used is mssStalenessToleranceCandles, which
// stays at the REAL default (5) here too, since detection must match entry-funnel-report.md exactly.
const CONFIRMED_ENTRY_ROUTER_CONFIG: EntryRouterConfig = {
  ...DEFAULT_ENTRY_ROUTER_CONFIG,
  macroTrendFilterEnabled: true,
  obDisabledSymbols: ['XRPUSDT'],
  macroTrendFilterAppliesToBoxBreakout: false,
  mssStalenessToleranceCandles: EntryConfig.MSS_STALENESS_TOLERANCE_CANDLES,
};

// TICKET-045: identical to CONFIRMED_ENTRY_ROUTER_CONFIG except staleness is effectively disabled —
// used ONLY to reconstruct the DraftSetup a detected MSS_TIMEOUT case would have produced; never
// used for detection (that stays on the real 5-candle tolerance above).
const RECONSTRUCTION_ENTRY_ROUTER_CONFIG: EntryRouterConfig = {
  ...CONFIRMED_ENTRY_ROUTER_CONFIG,
  mssStalenessToleranceCandles: Number.MAX_SAFE_INTEGER,
};

interface ShadowResult {
  exitReason: ExitReason;
  pnlPct: number;
}

/** Opens a fixed-size shadow position and walks it forward through REAL candles using
 * orchestrator.ts's own advancePosition() — same pattern as generateTrainingData.ts's
 * simulateShadowTrade(). `null` if the available history runs out before the position resolves. */
function simulateShadowTrade(side: 'LONG' | 'SHORT', entryPrice: number, slPrice: number, candles5m: CandleData[], entryStepIndex: number): ShadowResult | null {
  const openInput: SlTpManagerInput = {
    scenario: 'TREND', // entryRouter has no COUNTER_TREND path
    entryPrice,
    slPrice,
    side,
    tpPlan: 'PLAN_A', // matches the confirmed baseline
    positionSize: FIXED_POSITION_SIZE,
    takerFeeRate: TAKER_FEE_RATE,
  };
  let pos: ManagedPositionState = openPosition(openInput);

  for (let j = entryStepIndex + 1; j < candles5m.length; j++) {
    const candle = candles5m[j];
    const atrWindow = candles5m.slice(Math.max(0, j - WINDOW_5M + 1), j + 1);
    const { position, exitReason, exitPrice } = advancePosition(pos, candle, atrWindow, false); // isLowConfidenceOrLowLiquidity=false, matches the confirmed baseline's OrchestratorConfig
    pos = position;
    if (pos.closed) {
      const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
      return { exitReason: exitReason as ExitReason, pnlPct: (pnlUsd / FIXED_POSITION_SIZE) * 100 };
    }
  }
  return null; // ran out of future data before closing
}

/** Largest index i such that candles5m[i] had already CLOSED (open+5min <= timestamp) — the last 5m
 * candle available as of the MSS confirmation moment. Binary search: candles5m is timestamp-sorted. */
function findLast5mIndexClosedBy(candles5m: CandleData[], timestamp: number): number {
  let lo = 0;
  let hi = candles5m.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles5m[mid].timestamp + 5 * 60_000 <= timestamp) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

interface CaseResult {
  symbol: string;
  candlesLate: number;
  exitReason: ExitReason;
  pnlPct: number;
  /** For the "distinct underlying setups" transparency note below — NOT part of the ticket's requested per-case columns. */
  entryPrice: number;
}

async function main(): Promise<void> {
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // TICKET-045: byte-for-byte the confirmed baseline's OrchestratorConfig (README TICKET-039/040/041)
  // — needed so the accountBalance/risk-pool/position-open state this loop threads evolves IDENTICALLY
  // to the real backtest run, which is what makes the detected MSS_TIMEOUT set match the 173 in
  // entry-funnel-report.md rather than some other (larger, ungated) count.
  const config: OrchestratorConfig = {
    entryRouterConfig: CONFIRMED_ENTRY_ROUTER_CONFIG,
    tpPlan: 'PLAN_A',
    takerFeeRate: 0.0004,
    riskDollarOrPercent: 20,
    maxMarginCap: 50,
    leverage: 30,
    riskPoolMaxPct: 0.15,
    isLowConfidenceOrLowLiquidity: false,
    momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG, momentumFilterEnabled: true },
    neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, neutralTransitionTradingEnabled: true, neutralTransitionMomentumGateThreshold: 0.5 },
    planAutoSelectionConfig: DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
    maxConcurrentPositionsPerSymbol: 1, // TICKET-056: confirmed baseline default — unchanged behavior.
    momentumDirectEnabled: false, // TICKET-059: confirmed baseline default — unchanged behavior.
    momentumDirectThreshold: 0.75,
    momentumDirectMaxAtrPercentile: 100, // TICKET-062: confirmed baseline default — unchanged behavior.
    momentumDirectMinSlPercent: 0.5, // TICKET-064: TODO_CONFIRM default — never read since momentumDirectEnabled is false here.
    momentumDirectTpRMultiple: 2.0, // TICKET-064: TODO_CONFIRM default — never read since momentumDirectEnabled is false here.
    momentumDirectMaxTotalConcurrent: 999, // TICKET-068: TODO_CONFIRM default — never read since momentumDirectEnabled is false here.
    momentumDirectCorrelationRiskThreshold: 999, // TICKET-071: TODO_CONFIRM default — never read since momentumDirectEnabled is false here.
    momentumDirectCorrelationRiskMultiplier: 1.0, // TICKET-071: TODO_CONFIRM default — never read since momentumDirectEnabled is false here.
  };

  let accountBalance = START_BALANCE;
  const results: CaseResult[] = [];
  let unresolvedFutureData = 0;
  let unresolvedNoReconstruction = 0;
  let mismatchWarnings = 0;

  const totalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const startStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  for (let step = startStep; step < totalSteps; step++) {
    // TICKET-056: sum ALL of a symbol's currently open positions (was a single value assuming at most 1).
    const openRiskBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
    }

    // Same TICKET-030 cross-symbol correlation pre-pass as backtest.ts — needed for byte-identical
    // regime classification/state evolution.
    const w1hBySymbol: Record<string, CandleData[]> = {};
    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const decisionTime = sd.candles5m[step].timestamp + 5 * 60_000;
      const w1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H);
      sd.ptr1h = w1h.ptr;
      w1hBySymbol[symbol] = w1h.window;
    }
    const correlatedRiskRatioSeries = computeCorrelatedRiskRatio(w1hBySymbol, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const correlatedRiskRatio = correlatedRiskRatioSeries[correlatedRiskRatioSeries.length - 1];

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      // Same already-advanced sd.ptr1h pointer as the correlation pre-pass above, just a longer
      // slice — closedWindow's ptr advancement doesn't depend on windowSize, safe/idempotent (same
      // technique backtest.ts uses for its own w1hMomentum).
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      // TICKET-056: no longer excludes `symbol` itself — must include this symbol's own already-open position(s) too.
      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({
        id: s,
        actualRiskDollar: openRiskBySymbol[s],
      }));

      // TICKET-045: independent detectRegime() call, BEFORE processCandle() mutates sd.state — pure
      // function of the same inputs processCandle()'s own Step 1 will use, so it reproduces the exact
      // same RegimeOutput (verified below via mismatchWarnings). Needed because processCandle()
      // doesn't expose computedMetrics/adxDirection1h back to the caller, and the reconstruction
      // routeEntry() call below needs them.
      const preRegimeState = sd.state.regimeState;
      const myRegimeOutput = detectRegime({
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        previousRegime: preRegimeState.previousRegime,
        previousCandidateRegime: preRegimeState.previousCandidateRegime,
        streakCount: preRegimeState.streakCount,
        previousDangerZoneTimestamp: preRegimeState.previousDangerZoneTimestamp,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
      });
      const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
      const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

      const input: ProcessCandleInput = {
        symbol,
        candles5m: window5m,
        candles15m: w15.window,
        candles1h: w1hBySymbol[symbol],
        candles1m: w1m.window,
        candles1d: w1d.window,
        candles1hMomentum: w1hMomentum.window,
        candles5mSessionVolume: windowSessionVolume5m,
        correlatedRiskRatio,
        accountBalance,
        allOpenPositionsRisk,
      };

      const funnelEventsThisStep: FunnelEvent[] = [];
      const result = await processCandle(input, sd.state, config, undefined, undefined, (_s, _t, e) => funnelEventsThisStep.push(e));
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      if (result.symbolState.regimeState.previousRegime !== myRegimeOutput.regime) {
        mismatchWarnings++; // sanity check — should never fire (see comment above); tracked, not thrown
      }

      const timeoutEvent = funnelEventsThisStep.find((e) => e.stage === 'MSS' && !e.passed && e.reason === 'MSS_TIMEOUT');
      if (!timeoutEvent || timeoutEvent.candlesLate === undefined) continue;

      const reconstructed = routeEntry(
        {
          regime: myRegimeOutput.regime,
          symbol,
          adxDirection1h: myRegimeOutput.adxDirection1h,
          macroDirection,
          candles5m: window5m,
          candles15m: w15.window,
          candlesMss: w1m.window,
          bbWidthPercentile15m: myRegimeOutput.computedMetrics.bbWidthPercentile15m,
          volumeZScore5m: myRegimeOutput.computedMetrics.volumeZScore5m,
        },
        RECONSTRUCTION_ENTRY_ROUTER_CONFIG,
      );
      if (reconstructed === null) {
        unresolvedNoReconstruction++;
        continue;
      }

      // mssWindow (inside entryRouter.ts) and w1m.window share the same tail — candlesLate counted
      // back from the end of w1m.window lands on the exact same confirming candle (see file doc comment).
      const confirmedIndexInW1m = w1m.window.length - 1 - timeoutEvent.candlesLate;
      const confirmingCandle = w1m.window[confirmedIndexInW1m];
      if (confirmingCandle === undefined || Math.abs(confirmingCandle.close - reconstructed.entryPrice) > 1e-6) {
        mismatchWarnings++; // sanity check on the derivation above — tracked, not thrown
      }

      const entryStepIndex = findLast5mIndexClosedBy(sd.candles5m, confirmingCandle.timestamp);
      const shadow = simulateShadowTrade(reconstructed.side, reconstructed.entryPrice, reconstructed.slPrice, sd.candles5m, entryStepIndex);
      if (shadow === null) {
        unresolvedFutureData++;
        continue;
      }

      results.push({ symbol, candlesLate: timeoutEvent.candlesLate, exitReason: shadow.exitReason, pnlPct: shadow.pnlPct, entryPrice: reconstructed.entryPrice });
    }
  }

  if (mismatchWarnings > 0) {
    console.log(`CẢNH BÁO: ${mismatchWarnings} lần kiểm tra nội bộ (regime/entryPrice) không khớp như kỳ vọng — xem comment trong script.`);
  }

  const totalDetected = results.length + unresolvedFutureData + unresolvedNoReconstruction;
  console.log(`Tổng số case MSS_TIMEOUT phát hiện được: ${totalDetected}`);
  console.log(`  → mô phỏng được đến khi đóng lệnh: ${results.length}`);
  console.log(`  → bỏ qua (hết dữ liệu tương lai để đóng lệnh): ${unresolvedFutureData}`);
  console.log(`  → bỏ qua (không tái tạo được DraftSetup, VD thiếu lịch sử ATR): ${unresolvedNoReconstruction}`);

  // TICKET-046: the SAME underlying stale MSS confirmation commonly fires MSS_TIMEOUT on several
  // CONSECUTIVE 5m steps (candlesLate climbing ~5 at a time, same case-counting methodology as
  // entry-funnel-report.md — one row per FunnelEvent) until something else changes. Winning/losing
  // setups don't repeat the same number of times, so aggregating over the raw per-step rows (173)
  // instead of over the real distinct setups (18) silently over/under-weights whichever setups
  // happened to sit in the funnel longer — NOT a correction to the simulation itself (slTpManager/
  // entryPrice/slPrice untouched), only to how these already-computed rows are aggregated. One
  // group per (symbol, entryPrice) — the same confirming 1m candle always reproduces the same
  // entryPrice every time it's re-evaluated (deterministic reconstruction) — keeping the row with
  // the SMALLEST candlesLate (the first, least-stale rejection of that setup).
  function dedupeBySetup(rs: CaseResult[]): CaseResult[] {
    const bestByKey = new Map<string, CaseResult>();
    for (const r of rs) {
      const key = `${r.symbol}|${r.entryPrice}`;
      const existing = bestByKey.get(key);
      if (existing === undefined || r.candlesLate < existing.candlesLate) bestByKey.set(key, r);
    }
    return [...bestByKey.values()];
  }
  const dedupedResults = dedupeBySetup(results);

  interface Stats {
    n: number;
    wins: number;
    winrate: number;
    bucketRows: string[];
    exitReasonRows: string[];
  }
  function computeStats(rs: CaseResult[]): Stats {
    const wins = rs.filter((r) => r.pnlPct > 0).length;
    const winrate = rs.length > 0 ? (wins / rs.length) * 100 : 0;

    function bucketLabel(candlesLate: number): string {
      if (candlesLate <= 30) return '10-30';
      if (candlesLate <= 60) return '31-60';
      if (candlesLate <= 100) return '61-100';
      return '100+';
    }
    const bucketOrder = ['10-30', '31-60', '61-100', '100+'];
    const buckets: Record<string, CaseResult[]> = {};
    for (const b of bucketOrder) buckets[b] = [];
    for (const r of rs) buckets[bucketLabel(r.candlesLate)].push(r);
    const bucketRows = bucketOrder.map((b) => {
      const bs = buckets[b];
      const w = bs.filter((r) => r.pnlPct > 0).length;
      const wr = bs.length > 0 ? ((w / bs.length) * 100).toFixed(1) : '—';
      const avgPnl = bs.length > 0 ? (bs.reduce((s, r) => s + r.pnlPct, 0) / bs.length).toFixed(2) : '—';
      return `| ${b} | ${bs.length} | ${wr === '—' ? '—' : wr + '%'} | ${avgPnl === '—' ? '—' : avgPnl + '%'} |`;
    });

    const exitReasonCounts: Record<string, number> = {};
    for (const r of rs) exitReasonCounts[r.exitReason] = (exitReasonCounts[r.exitReason] ?? 0) + 1;
    const exitReasonRows = Object.entries(exitReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `| ${reason} | ${count} | ${((count / rs.length) * 100).toFixed(1)}% |`);

    return { n: rs.length, wins, winrate, bucketRows, exitReasonRows };
  }

  const rawStats = computeStats(results);
  const dedupedStats = computeStats(dedupedResults);

  const dedupedFlag = (r: CaseResult) => (dedupedResults.includes(r) ? '✓ (đại diện, candlesLate nhỏ nhất)' : '');
  const caseRowsWithFlag = results.map((r) => `| ${r.symbol} | ${r.candlesLate} | ${r.exitReason} | ${r.pnlPct.toFixed(2)}% | ${dedupedFlag(r)} |`);

  const report = [
    '# MSS_TIMEOUT Outcomes — TICKET-045/046',
    '',
    'Mô phỏng riêng biệt (không ảnh hưởng entryRouter.ts/orchestrator.ts/backtest.ts đang chạy thật) —',
    'câu hỏi: NẾU bot vẫn chấp nhận các case bị từ chối vì MSS_TIMEOUT, kết quả TP/SL thật sự sẽ ra sao.',
    'Số liệu nguyên văn, không tự kết luận nên nới ngưỡng staleness hay không.',
    '',
    `- Tổng số case MSS_TIMEOUT phát hiện được (đúng cấu hình đã chốt, khớp entry-funnel-report.md): ${totalDetected}`,
    `- Trong đó số setup (symbol+entryPrice) THỰC SỰ khác nhau: ${dedupedResults.length} — cùng 1 setup còn "cũ" bị đánh giá lại`,
    `  mỗi 5 phút (candlesLate tăng dần ~5 mỗi lần) nên xuất hiện nhiều dòng trùng entryPrice/pnlPct trong bảng chi tiết bên dưới.`,
    `- Mô phỏng được đến khi đóng lệnh: ${results.length}`,
    `- Bỏ qua vì hết dữ liệu tương lai để đóng lệnh: ${unresolvedFutureData}`,
    `- Bỏ qua vì không tái tạo được DraftSetup (VD thiếu lịch sử ATR tại thời điểm đó): ${unresolvedNoReconstruction}`,
    '',
    '## TICKET-046 — Winrate: theo dòng (chưa loại trùng) vs. theo setup thật (đã loại trùng)',
    '',
    '| | N | Winrate (pnlPct > 0 = thắng) |',
    '|---|---|---|',
    `| Theo dòng (chưa loại trùng) | ${rawStats.n} | ${rawStats.winrate.toFixed(1)}% |`,
    `| Theo setup thật (đã loại trùng, giữ candlesLate nhỏ nhất mỗi (symbol,entryPrice)) | ${dedupedStats.n} | ${dedupedStats.winrate.toFixed(1)}% |`,
    '',
    '## Winrate theo mức độ trễ (candlesLate, đơn vị: nến 1m) — theo dòng, chưa loại trùng',
    '',
    '| Nhóm độ trễ | Số case | Winrate | PNL% trung bình |',
    '|---|---|---|---|',
    ...rawStats.bucketRows,
    '',
    '## Winrate theo mức độ trễ — theo setup thật, đã loại trùng (TICKET-046)',
    '',
    '| Nhóm độ trễ | Số setup | Winrate | PNL% trung bình |',
    '|---|---|---|---|',
    ...dedupedStats.bucketRows,
    '',
    '## Phân bố exitReason — theo dòng, chưa loại trùng',
    '',
    '| exitReason | Số case | % |',
    '|---|---|---|',
    ...rawStats.exitReasonRows,
    '',
    '## Phân bố exitReason — theo setup thật, đã loại trùng (TICKET-046)',
    '',
    '| exitReason | Số setup | % |',
    '|---|---|---|',
    ...dedupedStats.exitReasonRows,
    '',
    '## Chi tiết từng dòng (cột cuối đánh dấu dòng đại diện được giữ lại sau khi loại trùng)',
    '',
    '| symbol | candlesLate | exitReason | pnlPct | đại diện setup? |',
    '|---|---|---|---|---|',
    ...caseRowsWithFlag,
    '',
  ].join('\n');

  writeFileSync(OUT_PATH, report);
  console.log(`→ ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
