/**
 * TICKET-137 — Neutral MOMENTUM_DIRECT Side Bias & 5m Direction Validation.
 * PURE AUDIT — no production decision logic touched, no new backtest.ts CLI flag added. Reuses the
 * exported `processCandle()` (orchestrator.ts) with the exact official 8-flag baseline config, wiring
 * the EXISTING `onMomentumGateEvaluation` diagnostic callback (TICKET-109) to capture BOTH the LONG
 * and SHORT MomentumGateEvaluation for every NEUTRAL_TRANSITION MOMENTUM_DIRECT decision point — this
 * is a real production callback firing from real production code, not a re-implemented replica.
 *
 * Phần A — side-selection trace: reconstructs exactly which rule picked LONG vs SHORT (per the
 * orchestrator.ts formula: if both longPasses/shortPasses, higher score wins ties->LONG; else
 * whichever one passed) and where macro/production filtering further affects the outcome.
 * direction5m/adxDirection1h/macroDirection1d are independently computed (pure functions,
 * `computeDirection5m` TICKET-130, `wilderDIDirectionSeries`) at the SAME window the orchestrator
 * itself used this step, purely for offline reporting — never fed back into any decision.
 *
 * Phần B — price-movement validation of direction5m against the REAL trades CSV (the exact 194
 * MOMENTUM_DIRECT+NEUTRAL_TRANSITION trades from the official baseline run), using only CLOSED
 * candles after each entry (no look-ahead for signal generation — outcome is offline-only).
 *
 * Phần C — coin x period breakdown, period boundaries chosen so each period contains a meaningful
 * number of the real 194 trades (data-driven, not a blind calendar split — see buildPeriods()).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { detectRegime } from '../dist/regime/regimeDetector.js';
import { EntryConfig } from '../dist/entry/config.js';
import {
  processCandle,
  type MomentumGateEvaluation,
  type ProcessCandleInput,
} from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import {
  DEFAULT_MOMENTUM_FILTER_CONFIG,
  DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
} from '../dist/xgbFilter/config.js';
import { computeDirection5m, type Direction5m } from '../dist/orchestrator/neutral5mDirectionSelector.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const TRADES_CSV = path.resolve(
  process.cwd(),
  'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated-oodriskreduction-1.037776.csv',
);
const OUT_PHASEA_CSV = path.resolve(process.cwd(), 'data/ticket137-phaseA-side-selection-trace.csv');
const OUT_PHASEB_CSV = path.resolve(process.cwd(), 'data/ticket137-phaseB-trade-validation.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket137-neutral-momentum-side-bias-5m-validation.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;
const SKIP_DAYS = 20;

// ---- Official baseline config (exact 8-flag command, re-verified TICKET-137 Bước 2). ----
const BASELINE_CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87 },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 15 / 100,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true },
  maxConcurrentPositionsPerSymbol: 2,
  momentumDirectEnabled: true,
  momentumDirectThreshold: 0.5,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 1.27,
  momentumDirectTpRMultiple: 3.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
  oodGuardConfig: { emaRatioSlowThreshold: 1.037776, mode: 'RISK_REDUCTION', scoreCapValue: 0, riskReductionMultiplier: 0.3 },
};

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

function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
}

// ============================================================================================
// PHẦN A — side-selection trace
// ============================================================================================

interface PhaseARow {
  symbol: string;
  timestamp: number;
  longScore: number | undefined;
  shortScore: number | undefined;
  threshold: number;
  longPassed: boolean;
  shortPassed: boolean;
  oodFlaggedShort: boolean;
  sideSelected: 'LONG' | 'SHORT' | 'NONE';
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  macroDirection1d: 'UP' | 'DOWN' | 'FLAT' | undefined;
  direction5m: Direction5m;
  macroBlocked: boolean;
  openedProduction: boolean;
  openedSide: 'LONG' | 'SHORT' | undefined;
  openedRiskMultiplier: number | undefined;
}

async function runPhaseA(): Promise<PhaseARow[]> {
  console.log('Phần A: re-walk toàn bộ baseline, capture MomentumGateEvaluation LONG+SHORT cho mọi NEUTRAL_TRANSITION MOMENTUM_DIRECT...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // keyed by `${symbol}|${timestamp}` — LONG/SHORT evaluations for the same decision point arrive as
  // 2 separate callback invocations within the same processCandle() call, joined here.
  const pending = new Map<string, { longScore?: number; shortScore?: number; threshold: number; longPassed?: boolean; shortPassed?: boolean; oodFlaggedShort: boolean; regime: MarketRegime }>();

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  const rows: PhaseARow[] = [];
  const openedThisStep = new Map<string, { side: 'LONG' | 'SHORT'; riskMultiplier: number }>();

  console.log(`Phần A: chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin...`);

  for (let step = startStep; step < totalSteps; step++) {
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

    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions
        .filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT')
        .map((entry) => ({ symbol, side: entry.position.side })),
    );

    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }

    for (const symbol of SYMBOLS) {
      const sd = symbolsData[symbol];
      const currentCandle = sd.candles5m[step];
      const decisionTime = currentCandle.timestamp + 5 * 60_000;

      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const windowSessionVolume5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M_SESSION_VOLUME + 1), step + 1);
      const w15 = closedWindow(sd.candles15m, sd.ptr15m, 15 * 60_000, decisionTime, WINDOW_15M);
      sd.ptr15m = w15.ptr;
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const allOpenPositionsRisk = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
      const totalOpenMarginDollar = Object.values(openMarginBySymbol).reduce((sum, m) => sum + m, 0);

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
        totalOpenMarginDollar,
        accountBalance: 100_000, // TICKET-137 JUDGMENT CALL: fixed large accountBalance so riskPool/marginCap NEVER binds
        // differently than the real official-baseline run did — this script only needs the diagnostic
        // MomentumGateEvaluation + the real production OPEN/SKIPPED verdict for TRUE production
        // fidelity we instead cross-check against the real trades CSV (194 trades) rather than
        // re-deriving accountBalance sequentially (which would require a byte-identical second full
        // run anyway). See report §Phương pháp for the explicit accounting of this divergence risk.
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      const key = `${symbol}|${currentCandle.timestamp}`;

      const result = await processCandle(
        input,
        sd.state,
        BASELINE_CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (evaluation: MomentumGateEvaluation) => {
          if (evaluation.gateType !== 'MOMENTUM_DIRECT' || evaluation.regime !== MarketRegime.NEUTRAL_TRANSITION) return;
          let entry = pending.get(key);
          if (!entry) {
            entry = { threshold: evaluation.threshold, oodFlaggedShort: false, regime: evaluation.regime };
            pending.set(key, entry);
          }
          if (evaluation.side === 'LONG') {
            entry.longScore = evaluation.score;
            entry.longPassed = evaluation.passed;
          } else {
            entry.shortScore = evaluation.score;
            entry.shortPassed = evaluation.passed;
            entry.oodFlaggedShort = evaluation.oodFlagged === true;
          }
        },
      );
      sd.state = result.symbolState;

      for (const event of result.events) {
        if (event.type === 'OPEN' && event.setupType === 'MOMENTUM_DIRECT' && event.regime === MarketRegime.NEUTRAL_TRANSITION) {
          openedThisStep.set(key, { side: event.side, riskMultiplier: event.riskMultiplier });
        }
      }

      const entry = pending.get(key);
      if (entry !== undefined && (entry.longScore !== undefined || entry.shortScore !== undefined)) {
        pending.delete(key);

        // adxDirection1h is a pure function of the 1h window, independent of regime hysteresis state
        // (same note as ticket136NeutralMomentumSideMissed5mAudit.ts) — recomputed directly via
        // detectRegime() here purely for offline reporting (ProcessCandleResult doesn't expose
        // regimeOutput itself), never fed back into any decision.
        const adxRegimeOutput = detectRegime({
          candles5m: window5m,
          candles15m: w15.window,
          candles1h: w1hBySymbol[symbol],
          previousRegime: null,
          previousCandidateRegime: null,
          streakCount: 0,
          previousDangerZoneTimestamp: null,
          candles5mSessionVolume: windowSessionVolume5m,
          correlatedRiskRatio,
        });
        const adxDirection1h = adxRegimeOutput.adxDirection1h;
        const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
        const macroDirection1d = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
        // TICKET-130's own computeDirection5m() — the exact function tryMomentumDirect() calls when
        // neutral5mDirectionSelectorEnabled=true (inactive in baseline, computed here purely offline).
        const direction5m = computeDirection5m(window5m, w1m.window);

        const longPassed = entry.longPassed === true;
        const shortPassed = entry.shortPassed === true;
        let sideSelected: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
        if (longPassed && shortPassed) {
          sideSelected = (entry.longScore as number) >= (entry.shortScore as number) ? 'LONG' : 'SHORT';
        } else if (longPassed) {
          sideSelected = 'LONG';
        } else if (shortPassed) {
          sideSelected = 'SHORT';
        }

        const macroBlocked =
          sideSelected !== 'NONE' &&
          ((sideSelected === 'LONG' && macroDirection1d === 'DOWN') || (sideSelected === 'SHORT' && macroDirection1d === 'UP'));

        const opened = openedThisStep.get(key);

        rows.push({
          symbol,
          timestamp: currentCandle.timestamp,
          longScore: entry.longScore,
          shortScore: entry.shortScore,
          threshold: entry.threshold,
          longPassed,
          shortPassed,
          oodFlaggedShort: entry.oodFlaggedShort,
          sideSelected,
          adxDirection1h,
          macroDirection1d,
          direction5m,
          macroBlocked,
          openedProduction: opened !== undefined,
          openedSide: opened?.side,
          openedRiskMultiplier: opened?.riskMultiplier,
        });
      }
      openedThisStep.delete(key);
    }

    const progressStep = step - startStep;
    if (progressStep % 4000 === 0) console.log(`  bước ${progressStep}/${totalSteps - startStep}, rows=${rows.length}...`);
  }

  console.log(`Phần A: xong, ${rows.length} decision points (NEUTRAL_TRANSITION MOMENTUM_DIRECT, >=1 side scored).`);
  return rows;
}

// ============================================================================================
// PHẦN B — price-movement validation of direction5m against REAL trades
// ============================================================================================

interface RealTradeRow {
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: string;
  setupType: string;
  entryTimestamp: number;
  entryPrice: number;
  exitTimestamp: number;
  exitPrice: number;
  exitReason: string;
  pnlUsd: number;
}

function readTradesCsv(filePath: string): RealTradeRow[] {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.slice(1).map((line) => {
    const [symbol, side, regime, setupType, , entryTimestamp, entryPrice, exitTimestamp, exitPrice, exitReason, pnlUsd] = line.split(',');
    return {
      symbol,
      side: side as 'LONG' | 'SHORT',
      regime,
      setupType,
      entryTimestamp: Number(entryTimestamp),
      entryPrice: Number(entryPrice),
      exitTimestamp: Number(exitTimestamp),
      exitPrice: Number(exitPrice),
      exitReason,
      pnlUsd: Number(pnlUsd),
    };
  });
}

type Structure = 'HH_HL' | 'LL_LH' | 'MIXED' | 'INSUFFICIENT_DATA';

interface PhaseBRow {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTimestamp: number;
  entryPrice: number;
  direction5m: Direction5m;
  group: 'ALIGNED' | 'CONFLICT' | 'NONE';
  return3: number | null;
  return6: number | null;
  return12: number | null;
  directionalReturn3: number | null;
  directionalReturn6: number | null;
  directionalReturn12: number | null;
  mfe12: number | null;
  mae12: number | null;
  structure12: Structure;
  exitReason: string;
  pnlUsd: number;
}

function computeStructure(window: CandleData[]): Structure {
  if (window.length < 4) return 'INSUFFICIENT_DATA';
  const mid = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, mid);
  const secondHalf = window.slice(mid);
  const firstHigh = Math.max(...firstHalf.map((c) => c.high));
  const firstLow = Math.min(...firstHalf.map((c) => c.low));
  const secondHigh = Math.max(...secondHalf.map((c) => c.high));
  const secondLow = Math.min(...secondHalf.map((c) => c.low));
  if (secondHigh > firstHigh && secondLow > firstLow) return 'HH_HL';
  if (secondHigh < firstHigh && secondLow < firstLow) return 'LL_LH';
  return 'MIXED';
}

function runPhaseB(phaseARows: PhaseARow[]): PhaseBRow[] {
  console.log('Phần B: đọc real trades CSV, tính return/MFE/MAE/structure từ OHLCV 5m thật...');
  const allTrades = readTradesCsv(TRADES_CSV);
  const target = allTrades.filter((t) => t.setupType === 'MOMENTUM_DIRECT' && t.regime === 'NEUTRAL_TRANSITION');
  console.log(`Phần B: ${target.length} trades MOMENTUM_DIRECT+NEUTRAL_TRANSITION (thực tế từ trades CSV).`);

  const dir5mByKey = new Map<string, Direction5m>();
  for (const r of phaseARows) dir5mByKey.set(`${r.symbol}|${r.timestamp}`, r.direction5m);

  const candlesBySymbol: Record<string, CandleData[]> = {};
  for (const symbol of SYMBOLS) candlesBySymbol[symbol] = readCsv(path.join(OHLCV_DIR, `${symbol}_5m.csv`));

  const rows: PhaseBRow[] = [];
  for (const trade of target) {
    const candles = candlesBySymbol[trade.symbol];
    const idx = candles.findIndex((c) => c.timestamp === trade.entryTimestamp);
    const direction5m = dir5mByKey.get(`${trade.symbol}|${trade.entryTimestamp}`) ?? 'NONE';
    const group: 'ALIGNED' | 'CONFLICT' | 'NONE' = direction5m === 'NONE' ? 'NONE' : direction5m === trade.side ? 'ALIGNED' : 'CONFLICT';

    if (idx === -1) {
      rows.push({
        symbol: trade.symbol, side: trade.side, entryTimestamp: trade.entryTimestamp, entryPrice: trade.entryPrice,
        direction5m, group, return3: null, return6: null, return12: null,
        directionalReturn3: null, directionalReturn6: null, directionalReturn12: null,
        mfe12: null, mae12: null, structure12: 'INSUFFICIENT_DATA', exitReason: trade.exitReason, pnlUsd: trade.pnlUsd,
      });
      continue;
    }

    const entryClose = candles[idx].close;
    const signFactor = trade.side === 'LONG' ? 1 : -1;

    function returnAfter(n: number): number | null {
      const i = idx + n;
      if (i >= candles.length) return null;
      return (candles[i].close - entryClose) / entryClose;
    }
    const return3 = returnAfter(3);
    const return6 = returnAfter(6);
    const return12 = returnAfter(12);

    const window12 = candles.slice(idx + 1, Math.min(candles.length, idx + 13));
    let mfe12: number | null = null;
    let mae12: number | null = null;
    if (window12.length > 0 && direction5m !== 'NONE') {
      const dirFactor = direction5m === 'LONG' ? 1 : -1;
      // MFE: best favorable excursion relative to direction5m's side, reference price = entry close.
      const favorableExtremes = window12.map((c) => (dirFactor === 1 ? c.high : c.low));
      const adverseExtremes = window12.map((c) => (dirFactor === 1 ? c.low : c.high));
      const bestFavorable = dirFactor === 1 ? Math.max(...favorableExtremes) : Math.min(...favorableExtremes);
      const worstAdverse = dirFactor === 1 ? Math.min(...adverseExtremes) : Math.max(...adverseExtremes);
      mfe12 = ((bestFavorable - entryClose) / entryClose) * dirFactor;
      mae12 = ((worstAdverse - entryClose) / entryClose) * dirFactor * -1; // positive = adverse magnitude
    }

    const structure12 = computeStructure(window12);

    rows.push({
      symbol: trade.symbol,
      side: trade.side,
      entryTimestamp: trade.entryTimestamp,
      entryPrice: trade.entryPrice,
      direction5m,
      group,
      return3,
      return6,
      return12,
      directionalReturn3: return3 !== null ? return3 * signFactor : null,
      directionalReturn6: return6 !== null ? return6 * signFactor : null,
      directionalReturn12: return12 !== null ? return12 * signFactor : null,
      mfe12,
      mae12,
      structure12,
      exitReason: trade.exitReason,
      pnlUsd: trade.pnlUsd,
    });
  }
  return rows;
}

// ============================================================================================
// CSV writers
// ============================================================================================

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
}

function phaseAToCsv(rows: PhaseARow[]): string {
  const header = ['symbol', 'timestamp', 'longScore', 'shortScore', 'threshold', 'longPassed', 'shortPassed', 'oodFlaggedShort', 'sideSelected', 'adxDirection1h', 'macroDirection1d', 'direction5m', 'macroBlocked', 'openedProduction', 'openedSide', 'openedRiskMultiplier'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.symbol, r.timestamp, r.longScore, r.shortScore, r.threshold, r.longPassed, r.shortPassed, r.oodFlaggedShort, r.sideSelected, r.adxDirection1h, r.macroDirection1d, r.direction5m, r.macroBlocked, r.openedProduction, r.openedSide, r.openedRiskMultiplier].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

function phaseBToCsv(rows: PhaseBRow[]): string {
  const header = ['symbol', 'side', 'entryTimestamp', 'entryPrice', 'direction5m', 'group', 'return3', 'return6', 'return12', 'directionalReturn3', 'directionalReturn6', 'directionalReturn12', 'mfe12', 'mae12', 'structure12', 'exitReason', 'pnlUsd'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.symbol, r.side, r.entryTimestamp, r.entryPrice, r.direction5m, r.group, r.return3, r.return6, r.return12, r.directionalReturn3, r.directionalReturn6, r.directionalReturn12, r.mfe12, r.mae12, r.structure12, r.exitReason, r.pnlUsd].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

// ============================================================================================
// Report
// ============================================================================================

function fmt(n: number | null | undefined, d = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  return n.toFixed(d);
}
function pctFmt(n: number | null | undefined, d = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(d)}%`;
}

interface PeriodDef {
  label: string;
  fromMs: number;
  toMsExclusive: number;
}

/**
 * TICKET-137 JUDGMENT CALL — Phần C period boundaries. NOT an equal calendar-time split (the ticket
 * explicitly forbids that pattern since prior tickets found it produces empty periods): boundaries
 * are chosen from the REAL 194-trade timestamp distribution's own terciles (33rd/66th percentile of
 * trade COUNT, not calendar time), guaranteeing each of the 3 periods holds a comparable, non-empty
 * number of real trades. Computed once from phaseB rows' entryTimestamp, documented explicitly here
 * and in the report (never silently re-derived elsewhere).
 */
function buildPeriods(sortedTimestamps: number[]): PeriodDef[] {
  const n = sortedTimestamps.length;
  const p1 = sortedTimestamps[Math.floor(n / 3)];
  const p2 = sortedTimestamps[Math.floor((2 * n) / 3)];
  const min = sortedTimestamps[0];
  const max = sortedTimestamps[n - 1] + 1;
  return [
    { label: 'P1', fromMs: min, toMsExclusive: p1 },
    { label: 'P2', fromMs: p1, toMsExclusive: p2 },
    { label: 'P3', fromMs: p2, toMsExclusive: max },
  ];
}

interface GroupStats { n: number; wins: number; winRate: number | null; pf: number | null; netPnl: number; avgDirReturn3: number | null; avgDirReturn6: number | null; avgDirReturn12: number | null; avgMfe: number | null; avgMae: number | null; }
function statsFromB(rows: PhaseBRow[]): GroupStats {
  const wins = rows.filter((r) => r.pnlUsd > 0);
  const losses = rows.filter((r) => r.pnlUsd <= 0);
  const grossWin = wins.reduce((s, r) => s + r.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnlUsd, 0));
  const avg = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    n: rows.length,
    wins: wins.length,
    winRate: rows.length > 0 ? (wins.length / rows.length) * 100 : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    netPnl: rows.reduce((s, r) => s + r.pnlUsd, 0),
    avgDirReturn3: avg(rows.map((r) => r.directionalReturn3)),
    avgDirReturn6: avg(rows.map((r) => r.directionalReturn6)),
    avgDirReturn12: avg(rows.map((r) => r.directionalReturn12)),
    avgMfe: avg(rows.map((r) => r.mfe12)),
    avgMae: avg(rows.map((r) => r.mae12)),
  };
}
function statRow(label: string, s: GroupStats): string {
  const pfStr = s.pf === Infinity ? '∞' : fmt(s.pf, 3);
  return `| ${label} | ${s.n} | ${s.winRate !== null ? fmt(s.winRate, 1) + '%' : 'N/A'} | ${pfStr} | ${s.netPnl >= 0 ? '+' : ''}${fmt(s.netPnl, 2)} | ${pctFmt(s.avgDirReturn3)} | ${pctFmt(s.avgDirReturn6)} | ${pctFmt(s.avgDirReturn12)} | ${pctFmt(s.avgMfe)} | ${pctFmt(s.avgMae)} |`;
}

function buildReport(phaseA: PhaseARow[], phaseB: PhaseBRow[], commitHash: string, baselineRunSummary: string): string {
  const lines: string[] = [];
  lines.push('# TICKET-137 — Neutral MOMENTUM_DIRECT Side Bias & 5m Direction Validation');
  lines.push('');
  lines.push('Nhánh `cai-tien`. Audit thuần túy — KHÔNG sửa production decision code, KHÔNG thêm CLI flag mới vào `backtest.ts`. Chỉ đo/phân tích offline.');
  lines.push('');

  lines.push('## Phương pháp');
  lines.push('');
  lines.push('- **Phần A**: script mới `ticket137NeutralMomentumSideBiasTrace.ts` re-walk TOÀN BỘ dataset OHLCV (4 coin, 5m/15m/1h/1m/1d), gọi trực tiếp `processCandle()` (export thật của `orchestrator.ts`) với đúng config baseline 8-flag, và wire callback `onMomentumGateEvaluation` (TICKET-109, đã có sẵn trong production, chỉ là chưa được backtest.ts ghi hết ra CSV) — callback này bắn cho CẢ LONG và SHORT mỗi khi `tryMomentumDirect()` chấm điểm, TRƯỚC bất kỳ early-return nào. Script join 2 lần bắn (LONG + SHORT) theo `symbol+timestamp`, lọc `gateType=MOMENTUM_DIRECT` và `regime=NEUTRAL_TRANSITION`.');
  lines.push('- `sideSelected` **tái tạo ĐÚNG công thức thật** đọc từ `orchestrator.ts` dòng ~576-581 (`if (!longPasses && !shortPasses) return null; ... side = longPasses && shortPasses ? (longScore>=shortScore?LONG:SHORT) : longPasses?LONG:SHORT`), dùng chính `passed`/`score` mà callback trả về — KHÔNG re-derive bằng công thức riêng.');
  lines.push('- `direction5m`/`adxDirection1h`/`macroDirection1d` được tính ĐỘC LẬP (offline, không đọc từ callback vì `neutral5mDirectionSelectorEnabled=false` dưới baseline khiến trường này luôn `undefined` trong evaluation thật) bằng đúng hàm production: `computeDirection5m()` (TICKET-130, `neutral5mDirectionSelector.ts`, hàm PHÙ HỢP nhất vì đây chính là hàm `tryMomentumDirect()` gọi khi selector bật — KHÔNG dùng bản "relaxed" của TICKET-131, vốn dành cho routing OB/FVG/SWEEP, không liên quan MOMENTUM_DIRECT), `wilderDIDirectionSeries()` trên cùng window 1D orchestrator dùng. Các hàm này KHÔNG BAO GIỜ được feed ngược vào quyết định — chỉ ghi ra để báo cáo.');
  lines.push('- `macroBlocked`: tái tạo đúng check dòng ~612 `if ((side===LONG && macroDirection===DOWN) || (side===SHORT && macroDirection===UP)) return null` — CHỈ áp dụng cho side đã "thắng" so sánh (`sideSelected`), không áp dụng cho side thua.');
  lines.push('- `openedProduction`/`openedSide`/`openedRiskMultiplier`: đọc TRỰC TIẾP từ `result.events` thật của chính lần chạy `processCandle()` này (event `OPEN` với `setupType=MOMENTUM_DIRECT`, `regime=NEUTRAL_TRANSITION`) — không suy luận, là kết quả production thật.');
  lines.push('- **JUDGMENT CALL quan trọng**: script Phần A dùng `accountBalance=100000` cố định (không lặp lại state cân bằng vốn tuần tự $100→$1142.09 của lần chạy baseline gốc) để risk-pool/margin-cap KHÔNG BAO GIỜ trở thành yếu tố giới hạn khác với lần chạy thật — mục đích của Phần A là trace side-selection/score/threshold/macro (các bước XẢY RA TRƯỚC risk-pool), không phải tái lập PNL. Vì vậy cột `openedProduction` của script này CÓ THỂ khác nhẹ so với 194 trades thật (risk-pool có thể chặn ở balance thấp thật mà không chặn ở đây, hoặc circuit breaker cooldown phụ thuộc lịch sử SL trước đó cũng có thể lệch nhẹ) — Phần A dùng để giải thích NGUỒN GỐC side bias (score/threshold/so sánh/macro), KHÔNG dùng `openedProduction` của Phần A làm nguồn số liệu chính cho outcome/PNL. Phần B mới là nguồn outcome chính thức, đọc THẲNG từ trades CSV thật (194 trades, balance thật).');
  lines.push('- **Phần B**: đọc 194 trade THẬT (setupType=MOMENTUM_DIRECT, regime=NEUTRAL_TRANSITION) từ file trades CSV của lần chạy baseline chính thức. Join với `direction5m` đã tính ở Phần A theo đúng `symbol+entryTimestamp`. Return/MFE/MAE tính TRỰC TIẾP từ OHLCV 5m thật, chỉ dùng nến ĐÃ ĐÓNG sau entry (không look-ahead cho TÍN HIỆU — outcome chỉ dùng để đánh giá offline, đúng yêu cầu ticket).');
  lines.push('  - `return{3,6,12}` = `(close[entry_idx+N] - close[entry_idx]) / close[entry_idx]` — return giá THÔ, không dấu.');
  lines.push('  - `directionalReturn{3,6,12}` = `return{N} × (side===LONG ? 1 : -1)` — return theo hướng lệnh THẬT đã mở (dương = lệnh đi đúng hướng).');
  lines.push('  - `mfe12`/`mae12`: JUDGMENT CALL — window 12 nến sau entry (khớp horizon dài nhất), reference price = `entryPrice`/`close[entry_idx]`, tính THEO SIDE của `direction5m` (không phải theo side lệnh thật) per yêu cầu ticket "MFE và MAE theo side của Direction 5m": `mfe12 = (bestFavorableExtreme - entryClose)/entryClose × dirFactor` (dirFactor=+1 nếu direction5m=LONG dùng high, -1 nếu SHORT dùng low), `mae12` tương tự với extreme bất lợi, luôn dương = độ lớn adverse excursion. `N/A` khi `direction5m=NONE` (không có "side" để tính theo).');
  lines.push('  - `structure12`: JUDGMENT CALL — chia 12 nến sau entry làm 2 nửa, so `high`/`low` max/min nửa sau vs nửa đầu: cả 2 đều tăng → `HH_HL`, cả 2 đều giảm → `LL_LH`, còn lại → `MIXED`. Không dùng thư viện swing-point phức tạp (giữ công thức minh bạch, đơn giản).');
  lines.push('- **Phần C** — period boundaries: xem `buildPeriods()`, chia theo TERCILE của SỐ LƯỢNG trade thật (không phải calendar đều), đảm bảo P1/P2/P3 đều có đủ trade thật.');
  lines.push('');

  // ---- Baseline reproduction ----
  lines.push('## Xác nhận baseline (Bước 2)');
  lines.push('');
  lines.push('```');
  lines.push(baselineRunSummary);
  lines.push('```');
  lines.push('');
  lines.push(`Commit: \`${commitHash}\``);
  lines.push('');

  const realShort = phaseB.filter((r) => r.side === 'SHORT').length;
  const realLong = phaseB.filter((r) => r.side === 'LONG').length;
  lines.push(`**Premise ticket (192/194 SHORT)**: thực tế đo được ${realShort}/${phaseB.length} SHORT, ${realLong}/${phaseB.length} LONG trong 194 trade MOMENTUM_DIRECT+NEUTRAL_TRANSITION thật.`);
  lines.push('');

  // ---- Phần A funnel ----
  lines.push('## Phần A — Funnel Stage | LONG | SHORT');
  lines.push('');
  const longScored = phaseA.filter((r) => r.longScore !== undefined).length;
  const shortScored = phaseA.filter((r) => r.shortScore !== undefined).length;
  const longThreshold = phaseA.filter((r) => r.longPassed).length;
  const shortThreshold = phaseA.filter((r) => r.shortPassed).length;
  const longWonCompare = phaseA.filter((r) => r.sideSelected === 'LONG').length;
  const shortWonCompare = phaseA.filter((r) => r.sideSelected === 'SHORT').length;
  const longMacroBlocked = phaseA.filter((r) => r.sideSelected === 'LONG' && r.macroBlocked).length;
  const shortMacroBlocked = phaseA.filter((r) => r.sideSelected === 'SHORT' && r.macroBlocked).length;
  const longOpenedProd = phaseA.filter((r) => r.sideSelected === 'LONG' && r.openedProduction && r.openedSide === 'LONG').length;
  const shortOpenedProd = phaseA.filter((r) => r.sideSelected === 'SHORT' && r.openedProduction && r.openedSide === 'SHORT').length;

  lines.push('| Stage | LONG | SHORT |');
  lines.push('|---|---|---|');
  lines.push(`| Được chấm score | ${longScored} | ${shortScored} |`);
  lines.push(`| Qua threshold (>= ${BASELINE_CONFIG.momentumDirectThreshold}) | ${longThreshold} | ${shortThreshold} |`);
  lines.push(`| Thắng so sánh side (trở thành \`side\` trong tryMomentumDirect) | ${longWonCompare} | ${shortWonCompare} |`);
  lines.push(`| Bị macro (1D) block (post-hoc, chỉ áp dụng cho side đã thắng) | ${longMacroBlocked} | ${shortMacroBlocked} |`);
  lines.push(`| Được mở production (re-run diagnostic, KHÔNG dùng làm số liệu chính thức — xem Phương pháp) | ${longOpenedProd} | ${shortOpenedProd} |`);
  lines.push('');
  lines.push(`(Số liệu outcome/PNL CHÍNH THỨC nằm ở Phần B, đọc thẳng trades CSV thật: ${realLong} LONG / ${realShort} SHORT.)`);
  lines.push('');

  // ---- Root cause breakdown ----
  const bothPassed = phaseA.filter((r) => r.longPassed && r.shortPassed);
  const shortOnlyPassed = phaseA.filter((r) => r.shortPassed && !r.longPassed);
  const longOnlyPassed = phaseA.filter((r) => r.longPassed && !r.shortPassed);
  const nonePassed = phaseA.filter((r) => !r.longPassed && !r.shortPassed);
  const bothPassedShortWon = bothPassed.filter((r) => r.sideSelected === 'SHORT').length;

  lines.push('## Phần A — Root cause: (a) head-to-head hay (b) chỉ SHORT qua threshold?');
  lines.push('');
  lines.push('| Tình huống | Số decision point | % |');
  lines.push('|---|---|---|');
  lines.push(`| Cả 2 side đều qua threshold (head-to-head) | ${bothPassed.length} | ${pctFmt(bothPassed.length / phaseA.length, 2)} |`);
  lines.push(`|   → trong đó SHORT thắng so sánh score | ${bothPassedShortWon} | ${bothPassed.length > 0 ? pctFmt(bothPassedShortWon / bothPassed.length, 2) : 'N/A'} |`);
  lines.push(`| CHỈ SHORT qua threshold (LONG rớt) | ${shortOnlyPassed.length} | ${pctFmt(shortOnlyPassed.length / phaseA.length, 2)} |`);
  lines.push(`| CHỈ LONG qua threshold (SHORT rớt) | ${longOnlyPassed.length} | ${pctFmt(longOnlyPassed.length / phaseA.length, 2)} |`);
  lines.push(`| Không side nào qua threshold | ${nonePassed.length} | ${pctFmt(nonePassed.length / phaseA.length, 2)} |`);
  lines.push(`| **Tổng decision points** | **${phaseA.length}** | |`);
  lines.push('');
  const avgLongScore = phaseA.filter((r) => r.longScore !== undefined).reduce((s, r) => s + (r.longScore as number), 0) / Math.max(1, longScored);
  const avgShortScore = phaseA.filter((r) => r.shortScore !== undefined).reduce((s, r) => s + (r.shortScore as number), 0) / Math.max(1, shortScored);
  lines.push(`Điểm trung bình toàn bộ decision points: longScore avg=${fmt(avgLongScore, 4)} (qua threshold ${pctFmt(longThreshold / Math.max(1, longScored), 1)}), shortScore avg=${fmt(avgShortScore, 4)} (qua threshold ${pctFmt(shortThreshold / Math.max(1, shortScored), 1)}).`);
  lines.push('');
  lines.push('**Kết luận root cause**: nếu `CHỈ SHORT qua threshold` chiếm đa số tuyệt đối trong tổng lệch, đây là hiện tượng (b) — "chỉ SHORT vượt threshold 0.5", KHÔNG PHẢI đấu tay đôi sát nút; nếu `bothPassedShortWon` chiếm tỷ trọng lớn trong nhóm head-to-head, đó là hiện tượng (a). Số liệu thật ở bảng trên. **Xác nhận từ code**: công thức `side = longPasses && shortPasses ? (longScore>=shortScore?LONG:SHORT) : longPasses?LONG:SHORT` (orchestrator.ts dòng ~580-581) TỰ NÓ không thiên vị SHORT — thiên vị chỉ có thể đến từ phân bố điểm/pass-rate 2 model bullish/bearish khác nhau, đúng như số liệu trên chứng minh.');
  lines.push('');

  // ---- HTF/OOD notes ----
  const shortOodFlaggedCount = phaseA.filter((r) => r.oodFlaggedShort).length;
  lines.push('## Ghi chú — OOD guard / HTF adxDirection1h KHÔNG giải thích side bias');
  lines.push('');
  lines.push(`- OOD guard (P97.5 Risk Reduction): ${shortOodFlaggedCount} decision points có \`oodFlaggedShort=true\` trong tổng ${phaseA.length} — guard này (mode=RISK_REDUCTION) CHỈ nhân \`riskMultiplier\` SHORT xuống 0.3 SAU KHI side đã được chọn là SHORT, KHÔNG BAO GIỜ ảnh hưởng score/threshold/so sánh side — xác nhận qua code (\`oodRiskMultiplier\` chỉ nhân vào \`riskMultiplier\` trả về của \`DraftSetup\`, không đụng \`longScore\`/\`shortScore\`/\`side\`).`);
  lines.push('- `adxDirection1h` (HTF 1h) KHÔNG phải một gate cho MOMENTUM_DIRECT — nó chỉ là 1 FEATURE đưa vào model (`buildFeatureVector`), không có check `if (side!==adxDirection1h) return null` nào trong `tryMomentumDirect()` (khác với cascade OB/FVG/SWEEP dùng `entryRouterConfig.macroTrendFilterEnabled`). Do đó cột "Bị macro/HTF ảnh hưởng" trong funnel Phần A CHỈ phản ánh macro 1D (`macroDirection1d`), không có dòng HTF riêng — ghi rõ ở đây để không gây hiểu lầm.');
  lines.push(`- \`neutral5mDirectionSelectorEnabled\` = ${BASELINE_CONFIG.neutral5mDirectionSelectorEnabled ?? false} dưới baseline — inert (xác nhận qua config object dùng để chạy).`);
  lines.push('');

  // ---- Phần B ----
  lines.push('## Phần B — Bảng tổng theo nhóm Direction5m (chỉ 194 trade thật)');
  lines.push('');
  lines.push('| Nhóm | Trades | WR | PF | Net PnL | Avg dirReturn3 | Avg dirReturn6 | Avg dirReturn12 | Avg MFE | Avg MAE |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const dir5mLong = phaseB.filter((r) => r.direction5m === 'LONG');
  const dir5mShort = phaseB.filter((r) => r.direction5m === 'SHORT');
  const dir5mNone = phaseB.filter((r) => r.direction5m === 'NONE');
  const aligned = phaseB.filter((r) => r.group === 'ALIGNED');
  const conflict = phaseB.filter((r) => r.group === 'CONFLICT');
  const noneGroup = phaseB.filter((r) => r.group === 'NONE');
  lines.push(statRow('Direction5m=LONG', statsFromB(dir5mLong)));
  lines.push(statRow('Direction5m=SHORT', statsFromB(dir5mShort)));
  lines.push(statRow('Direction5m=NONE', statsFromB(dir5mNone)));
  lines.push(statRow('ALIGNED với MOMENTUM_DIRECT', statsFromB(aligned)));
  lines.push(statRow('CONFLICT với MOMENTUM_DIRECT', statsFromB(conflict)));
  lines.push(statRow('direction5m=NONE (không thể align/conflict)', statsFromB(noneGroup)));
  lines.push(statRow('TỔNG', statsFromB(phaseB)));
  lines.push('');

  lines.push('## Phần B — Structure sau entry (12 nến)');
  lines.push('');
  lines.push('| Structure | Count | WR | PF | Net PnL |');
  lines.push('|---|---|---|---|---|');
  for (const s of ['HH_HL', 'LL_LH', 'MIXED', 'INSUFFICIENT_DATA'] as Structure[]) {
    const rows = phaseB.filter((r) => r.structure12 === s);
    const stats = statsFromB(rows);
    const pfStr = stats.pf === Infinity ? '∞' : fmt(stats.pf, 3);
    lines.push(`| ${s} | ${rows.length} | ${stats.winRate !== null ? fmt(stats.winRate, 1) + '%' : 'N/A'} | ${pfStr} | ${stats.netPnl >= 0 ? '+' : ''}${fmt(stats.netPnl, 2)} |`);
  }
  lines.push('');

  // ---- Phần C ----
  const sortedTs = [...phaseB.map((r) => r.entryTimestamp)].sort((a, b) => a - b);
  const periods = sortedTs.length >= 3 ? buildPeriods(sortedTs) : [];
  lines.push('## Phần C — Coin × Giai đoạn (tercile theo SỐ LƯỢNG trade thật, không phải calendar đều)');
  lines.push('');
  if (periods.length > 0) {
    for (const p of periods) {
      lines.push(`- **${p.label}**: ${new Date(p.fromMs).toISOString().slice(0, 10)} → ${new Date(p.toMsExclusive).toISOString().slice(0, 10)} (exclusive)`);
    }
  } else {
    lines.push('- Không đủ dữ liệu (< 3 trade) để chia giai đoạn.');
  }
  lines.push('');
  lines.push('| Coin | Giai đoạn | Trades | WR | PF | Net PnL | SHORT% |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const symbol of SYMBOLS) {
    for (const p of periods) {
      const rows = phaseB.filter((r) => r.symbol === symbol && r.entryTimestamp >= p.fromMs && r.entryTimestamp < p.toMsExclusive);
      if (rows.length === 0) {
        lines.push(`| ${symbol} | ${p.label} | 0 | N/A | N/A | N/A | N/A |`);
        continue;
      }
      const stats = statsFromB(rows);
      const pfStr = stats.pf === Infinity ? '∞' : fmt(stats.pf, 3);
      const shortPct = (rows.filter((r) => r.side === 'SHORT').length / rows.length) * 100;
      lines.push(`| ${symbol} | ${p.label} | ${rows.length} | ${stats.winRate !== null ? fmt(stats.winRate, 1) + '%' : 'N/A'} | ${pfStr} | ${stats.netPnl >= 0 ? '+' : ''}${fmt(stats.netPnl, 2)} | ${shortPct.toFixed(1)}% |`);
    }
  }
  lines.push('');
  lines.push('| Giai đoạn (tổng 4 coin) | Trades | WR | PF | Net PnL | SHORT% |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of periods) {
    const rows = phaseB.filter((r) => r.entryTimestamp >= p.fromMs && r.entryTimestamp < p.toMsExclusive);
    const stats = statsFromB(rows);
    const pfStr = stats.pf === Infinity ? '∞' : fmt(stats.pf, 3);
    const shortPct = rows.length > 0 ? (rows.filter((r) => r.side === 'SHORT').length / rows.length) * 100 : 0;
    lines.push(`| ${p.label} | ${rows.length} | ${stats.winRate !== null ? fmt(stats.winRate, 1) + '%' : 'N/A'} | ${pfStr} | ${stats.netPnl >= 0 ? '+' : ''}${fmt(stats.netPnl, 2)} | ${rows.length > 0 ? shortPct.toFixed(1) + '%' : 'N/A'} |`);
  }
  lines.push('');

  // ---- Mandatory conclusion ----
  const overallStats = statsFromB(phaseB);
  const alignedStats = statsFromB(aligned);
  const conflictStats = statsFromB(conflict);
  const shortStats = statsFromB(phaseB.filter((r) => r.side === 'SHORT'));

  // Consistency of SHORT edge across periods.
  const shortStatsByPeriod = periods.map((p) => statsFromB(phaseB.filter((r) => r.side === 'SHORT' && r.entryTimestamp >= p.fromMs && r.entryTimestamp < p.toMsExclusive)));
  const shortStableAcrossPeriods = shortStatsByPeriod.every((s) => s.n >= 5) && shortStatsByPeriod.filter((s) => (s.pf ?? 0) > 1.0).length >= Math.ceil(periods.length / 2);

  let conclusion: string;
  const conflictWorse = conflict.length >= 15 && aligned.length >= 15 && conflictStats.pf !== null && alignedStats.pf !== null && conflictStats.pf < alignedStats.pf;
  const alignmentReflectsPrice = alignedStats.avgDirReturn6 !== null && conflictStats.avgDirReturn6 !== null && alignedStats.avgDirReturn6 > conflictStats.avgDirReturn6;

  if (!alignmentReflectsPrice && dir5mLong.length + dir5mShort.length >= 15) {
    conclusion = `C — Direction 5m hiện tại KHÔNG phản ánh tốt hướng giá: nhóm ALIGNED (avg dirReturn6=${pctFmt(alignedStats.avgDirReturn6)}) không rõ ràng tốt hơn nhóm CONFLICT (avg dirReturn6=${pctFmt(conflictStats.avgDirReturn6)}) — direction5m không đáng tin để dùng làm bộ lọc hướng.`;
  } else if (conflict.length >= 15 && conflictStats.netPnl > 0 && conflictStats.pf !== null && alignedStats.pf !== null && conflictStats.pf >= alignedStats.pf) {
    conclusion = `D — MOMENTUM_DIRECT đang khai thác pullback: nhóm CONFLICT_5M (PF=${fmt(conflictStats.pf, 3)}, Net PnL=${fmt(conflictStats.netPnl, 2)}, n=${conflict.length}) không kém, thậm chí tốt hơn ALIGNED_5M (PF=${fmt(alignedStats.pf, 3)}, n=${aligned.length}) — ép cùng chiều Direction 5m sẽ loại bỏ đúng phần lệnh đang có edge, xác nhận lại phát hiện của TICKET-136 trong context điểm số long/short này.`;
  } else if (shortStats.n >= 20 && shortStats.pf !== null && shortStats.pf > 1.1 && shortStats.netPnl > 0 && shortStableAcrossPeriods) {
    conclusion = `B — Side SHORT lệch do dữ liệu/model (bảng Root Cause ở trên), KHÔNG PHẢI bug logic (công thức so sánh side không thiên vị SHORT — đã xác nhận từ code), và SHORT vẫn có edge ổn định qua các giai đoạn (PF=${fmt(shortStats.pf, 3)}, Net PnL=${fmt(shortStats.netPnl, 2)}, n=${shortStats.n}).`;
  } else if (phaseB.length < 20) {
    conclusion = `E — Chưa đủ dữ liệu: chỉ ${phaseB.length} trade MOMENTUM_DIRECT+NEUTRAL_TRANSITION thật (< 20) để kết luận đáng tin cậy giữa A/B/C/D.`;
  } else {
    conclusion = `E — Dữ liệu không đủ mạnh/nhất quán để chọn dứt khoát 1 trong A/C/D theo các ngưỡng đã định nghĩa (xem các bảng số liệu ở trên để tự đánh giá thêm nếu cần).`;
  }
  lines.push('## KẾT LUẬN BẮT BUỘC');
  lines.push('');
  lines.push(`**${conclusion}**`);
  lines.push('');
  lines.push(`(Tham chiếu: overall Phần B — n=${overallStats.n}, WR=${fmt(overallStats.winRate, 1)}%, PF=${overallStats.pf === Infinity ? '∞' : fmt(overallStats.pf, 3)}, Net PnL=${fmt(overallStats.netPnl, 2)}.)`);
  lines.push('');

  lines.push('## Không thực hiện (xác nhận)');
  lines.push('');
  lines.push('- Không đổi side selection logic trong orchestrator.ts.');
  lines.push('- Không đảo tín hiệu Direction 5m.');
  lines.push('- Không bật Neutral routing (`neutralTransitionTradingEnabled`/`neutral5mDirectionSelectorEnabled`/`neutral5mDirectionGatedRoutingEnabled` đều giữ default/false trong BASELINE_CONFIG).');
  lines.push('- Không đổi AI threshold (giữ 0.5).');
  lines.push('- Không xử lý reversal.');
  lines.push('- Không chạy variant production nào khác baseline 8-flag.');
  lines.push('- Không sửa `backtest.ts` — script này hoàn toàn mới, additive.');
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const phaseA = await runPhaseA();
  const phaseB = runPhaseB(phaseA);

  writeFileSync(OUT_PHASEA_CSV, phaseAToCsv(phaseA));
  console.log(`Đã ghi ${OUT_PHASEA_CSV} (${phaseA.length} rows)`);
  writeFileSync(OUT_PHASEB_CSV, phaseBToCsv(phaseB));
  console.log(`Đã ghi ${OUT_PHASEB_CSV} (${phaseB.length} rows)`);

  const report = buildReport(phaseA, phaseB, process.env.GIT_COMMIT_HASH ?? 'N/A', process.env.BASELINE_RUN_SUMMARY ?? 'N/A — xem data/backtest-report-baseline-planauto-maxpos2-momentumdirect-correlated-oodriskreduction-1.037776.md');
  writeFileSync(OUT_MD, report);
  console.log(`Đã ghi ${OUT_MD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
