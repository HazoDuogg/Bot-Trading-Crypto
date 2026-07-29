/**
 * TICKET-102 — INVESTIGATION ONLY (not part of the official backtest/live pipeline). Recomputes the
 * entry-logic indicators (Regime, Setup, ADX(1h), ATR percentile(5m), AI momentum score) for 3 real
 * live SHORT trades opened 2026-07-28/29 (XRPUSDT, SOLUSDT x2) by replaying the EXACT production
 * orchestrator (processCandle from ../dist/orchestrator/orchestrator.js) over real historical OHLCV,
 * using the EXACT live CONFIG copied verbatim from scripts/liveRunner.ts. Compares the recomputed
 * values against what was actually sent to Telegram at entry time.
 *
 * Does NOT modify backtest.ts / liveRunner.ts / anything under src/ — standalone read-only script.
 * Windowing/closedWindow/correlatedRiskRatio/ProcessCandleInput-building logic copied as closely as
 * possible from backtest.ts (the established no-look-ahead simulation pattern) — not reinvented.
 *
 * Run: npx tsx apps/bot/scripts/ticket102InvestigateEntryLogic.ts (from repo root)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import type { FunnelEvent } from '../dist/entry/types.js';
import { INITIAL_SYMBOL_STATE, type OpenTradeEvent, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import {
  DEFAULT_MOMENTUM_FILTER_CONFIG,
  DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
  MOMENTUM_BEARISH_MODEL_PATH,
  MOMENTUM_BEARISH_SCHEMA_PATH,
} from '../dist/xgbFilter/config.js';
import { buildFeatureVector, computeMomentumCrossFeatures, loadFeatureSchema, type RawMomentumFeatures } from '../dist/xgbFilter/featureBuilder.js';
import { scoreMomentum } from '../dist/xgbFilter/momentumScorer.js';
import { wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { EntryConfig } from '../dist/entry/config.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// Same bounded sliding windows as backtest.ts (see its own comment for rationale) — matches how the
// live bot itself keeps only a bounded recent window in memory.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500; // TICKET-106: must match backtest.ts/liveRunner.ts exactly
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT live config — copied verbatim from apps/bot/scripts/liveRunner.ts lines ~60-83 (TICKET-084/085
// 8-flag baseline + risk-dollar-or-percent=15/max-margin-cap=37.5 + obSlBufferAtrMultiplier=0.87 +
// momentumDirectMinSlPercent=1.27). Do NOT modify — this must match production exactly.
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87 },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 0.15,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: DEFAULT_MOMENTUM_FILTER_CONFIG,
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
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
};

// Simulation window: warm up from well before 2026-07-24 so regime hysteresis/streakCount state has
// properly accumulated by the time we reach the 3 trade timestamps (2026-07-28/29), rather than
// starting cold right at the trade date.
// TICKET-102 follow-up: SIM_FROM_ISO now CLI-overridable (--sim-from=YYYY-MM-DD) to run the
// warmup-sensitivity robustness check the coordinator asked for, without duplicating the whole script.
const simFromArg = process.argv.find((a) => a.startsWith('--sim-from='));
const simFromRaw = simFromArg ? simFromArg.split('=')[1] : undefined;
// Accepts either a bare date (YYYY-MM-DD, midnight assumed) or a full ISO timestamp (contains 'T').
const SIM_FROM_ISO = simFromRaw ? (simFromRaw.includes('T') ? simFromRaw : `${simFromRaw}T00:00:00.000Z`) : '2026-07-08T00:00:00.000Z'; // ~20 days of warm-up before the trades (default)
const SIM_TO_EXCLUSIVE_ISO = '2026-07-29T02:05:00.000Z'; // covers all 3 trades + a small margin
const PRINT_TRAJECTORY = process.argv.includes('--print-trajectory'); // candidateRegime/streakCount trace, 3h before each target
// TICKET-104 follow-up: print the momentum feature vector (labeled) + a window-length sensitivity
// sweep for SOLUSDT's 2 trades, whose momentumScore didn't match Telegram even after the sim-from
// fix. Root-cause investigation only — no src/ changes, this only READS dist/xgbFilter/*.
const PRINT_MOMENTUM_FEATURES = process.argv.includes('--print-momentum-features');

interface TargetTrade {
  label: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  timestampIso: string; // Telegram-reported decision-time candle (UTC)
  entryPrice: number;
  slPrice: number;
  regime: string;
  setupType: string;
  adx1h: number;
  atrPercentile5m: number;
  aiScorePct: number; // momentumScore, reported as a % on Telegram
  riskPoolBeforePct: number;
  riskPoolAfterPct: number;
}

const TARGET_TRADES: TargetTrade[] = [
  {
    label: 'Trade 1 — XRPUSDT SHORT',
    symbol: 'XRPUSDT',
    side: 'SHORT',
    timestampIso: '2026-07-28T13:30:00.000Z',
    entryPrice: 1.0502,
    slPrice: 1.0575,
    regime: 'TREND_RIDER',
    setupType: 'OB',
    adx1h: 41.8,
    atrPercentile5m: 66,
    aiScorePct: 15.9,
    riskPoolBeforePct: 0.0,
    riskPoolAfterPct: 7.8,
  },
  {
    label: 'Trade 2 — SOLUSDT SHORT',
    symbol: 'SOLUSDT',
    side: 'SHORT',
    timestampIso: '2026-07-28T14:15:00.000Z',
    entryPrice: 72.57,
    slPrice: 72.9222,
    regime: 'TREND_RIDER',
    setupType: 'OB',
    adx1h: 39.1,
    atrPercentile5m: 81,
    aiScorePct: 24.1,
    riskPoolBeforePct: 7.8,
    riskPoolAfterPct: 13.2,
  },
  {
    label: 'Trade 3 — SOLUSDT SHORT',
    symbol: 'SOLUSDT',
    side: 'SHORT',
    timestampIso: '2026-07-28T17:30:00.000Z',
    entryPrice: 73.73,
    slPrice: 74.1535,
    regime: 'TREND_RIDER',
    setupType: 'OB',
    adx1h: 35.0,
    atrPercentile5m: 77,
    aiScorePct: 21.4,
    riskPoolBeforePct: 0.0,
    riskPoolAfterPct: 7.5,
  },
];

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

/** Two-pointer: advances `ptr` to the latest candle already CLOSED (open+interval <= decisionTime), never looks ahead. Copied from backtest.ts. */
function closedWindow(candles: CandleData[], ptr: number, intervalMs: number, decisionTime: number, windowSize: number): { window: CandleData[]; ptr: number } {
  let p = ptr;
  while (p + 1 < candles.length && candles[p + 1].timestamp + intervalMs <= decisionTime) p++;
  if (p < 0) return { window: [], ptr: p };
  const start = Math.max(0, p - windowSize + 1);
  return { window: candles.slice(start, p + 1), ptr: p };
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

interface CapturedOpen {
  symbol: string;
  side: 'LONG' | 'SHORT';
  regime: string;
  setupType: string;
  entryTimestamp: number;
  entryPrice: number;
  slPrice: number;
  adx1h?: number;
  atrPercentile5m?: number;
  momentumScore?: number;
  riskPoolPctBefore: number;
  riskPoolPctAfter: number;
  correlatedRiskRatio?: number;
}

/** TICKET-102 diagnostic: for a target trade that fails to match a captured OPEN, this records exactly
 * what the replay computed for that symbol AT the target's own decision-time candle (regime, adx1h,
 * atrPercentile5m, and why routeEntry() never fired an OPEN there) — so "KHÔNG TÁI TẠO ĐƯỢC" is backed
 * by concrete evidence instead of just silence. */
interface NearTargetDiagnostic {
  symbol: string;
  decisionTimeIso: string;
  confirmedRegimeAtTarget?: string;
  adx1hAtTarget?: number;
  atrPercentile5mAtTarget?: number;
  funnelEventsAtTarget: string[]; // formatted "stage=X passed=Y reason=Z" lines
}

async function main(): Promise<void> {
  console.log('TICKET-102 — Investigate entry logic for 3 real live SHORT trades (2026-07-28/29)');
  console.log(`Simulation window: ${SIM_FROM_ISO} -> ${SIM_TO_EXCLUSIVE_ISO} (warm-up + trade dates)`);
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const referenceCandles = symbolsData.BTCUSDT.candles5m;
  const simFromMs = Date.parse(SIM_FROM_ISO);
  const simToExclusiveMs = Date.parse(SIM_TO_EXCLUSIVE_ISO);
  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));

  // Warm-up floor same as backtest.ts's own — the sliding windows themselves need enough real time
  // elapsed before ANY step is meaningful, regardless of where SIM_FROM_ISO points.
  const warmupFloorStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5;

  const simFromStepRaw = referenceCandles.findIndex((c) => c.timestamp >= simFromMs);
  const simFromStep = simFromStepRaw < 0 ? rawTotalSteps : simFromStepRaw;
  const startStep = Math.max(warmupFloorStep, simFromStep);

  const simToStepExclusiveRaw = referenceCandles.findIndex((c) => c.timestamp >= simToExclusiveMs);
  const totalSteps = simToStepExclusiveRaw < 0 ? rawTotalSteps : Math.min(rawTotalSteps, simToStepExclusiveRaw);

  if (startStep >= totalSteps) {
    throw new Error(`ticket102: startStep(${startStep}) >= totalSteps(${totalSteps}) — dữ liệu OHLCV không đủ phủ khoảng thời gian yêu cầu.`);
  }

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (nến 5m #${startStep} -> #${totalSteps - 1})...`);

  const capturedOpens: CapturedOpen[] = [];
  const nearTargetDiagnostics: NearTargetDiagnostic[] = [];
  let accountBalance = 100; // arbitrary — only affects sizing math, not the indicator fields we're verifying

  for (let step = startStep; step < totalSteps; step++) {
    const openRiskBySymbol: Record<string, number> = {};
    const openMarginBySymbol: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const totalRisk = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (totalRisk > 0) openRiskBySymbol[symbol] = totalRisk;
      const totalMargin = symbolsData[symbol].state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (totalMargin > 0) openMarginBySymbol[symbol] = totalMargin;
    }

    const momentumDirectOpenPositionsTotal = SYMBOLS.reduce(
      (sum, symbol) => sum + symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').length,
      0,
    );
    const momentumDirectOpenPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT' }> = SYMBOLS.flatMap((symbol) =>
      symbolsData[symbol].state.openPositions
        .filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT')
        .map((entry) => ({ symbol, side: entry.position.side })),
    );

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
      const w1hMomentum = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, WINDOW_1H_MOMENTUM);
      const w1m = closedWindow(sd.candles1m, sd.ptr1m, 60_000, decisionTime, WINDOW_1M);
      sd.ptr1m = w1m.ptr;
      const w1d = closedWindow(sd.candles1d, sd.ptr1d, 24 * 60 * 60_000, decisionTime, WINDOW_1D);
      sd.ptr1d = w1d.ptr;

      const isMomentumDiagTarget =
        PRINT_MOMENTUM_FEATURES && symbol === 'SOLUSDT' && TARGET_TRADES.some((t) => t.symbol === symbol && decisionTime === Date.parse(t.timestampIso));

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
        accountBalance,
        allOpenPositionsRisk,
        momentumDirectOpenPositionsTotal,
        momentumDirectOpenPositions,
      };

      // Near-target diagnostic window: within ±10 minutes (2 candles) of any TARGET_TRADES entry for
      // this symbol — captures the funnel-stage failure reasons AT the exact decision time so an
      // unmatched trade's report section can show WHY no OPEN fired there, not just that none did.
      const nearTarget = TARGET_TRADES.find((t) => t.symbol === symbol && Math.abs(decisionTime - Date.parse(t.timestampIso)) <= 10 * 60_000);
      const inTrajectoryWindow = PRINT_TRAJECTORY && TARGET_TRADES.some((t) => t.symbol === symbol && decisionTime <= Date.parse(t.timestampIso) && decisionTime >= Date.parse(t.timestampIso) - 3 * 60 * 60_000);
      const wantMetrics = nearTarget || inTrajectoryWindow || isMomentumDiagTarget;
      const funnelEventsAtTarget: string[] = [];
      let regimeMetricsAtTarget:
        | {
            adx1h?: number;
            atrPercentile5m?: number;
            adx1hRecent?: number[];
            bbWidthPercentile15m?: number;
            volumeZScore5m?: number;
            atrTrend5m?: string;
            adxDirection1h?: string;
          }
        | undefined;

      const result = await processCandle(
        input,
        sd.state,
        CONFIG,
        undefined,
        undefined,
        nearTarget ? (_s, _t, event: FunnelEvent) => funnelEventsAtTarget.push(`stage=${event.stage} passed=${event.passed}${event.passed ? '' : ` reason=${(event as unknown as { reason?: string }).reason ?? '(none)'}`}`) : undefined,
        undefined,
        wantMetrics
          ? (m) => {
              regimeMetricsAtTarget = {
                adx1h: m.adx1h,
                atrPercentile5m: m.atrPercentile5m,
                adx1hRecent: m.adx1hRecent,
                bbWidthPercentile15m: m.bbWidthPercentile15m,
                volumeZScore5m: m.volumeZScore5m,
                atrTrend5m: m.atrTrend5m,
                adxDirection1h: m.adxDirection1h,
              };
            }
          : undefined,
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      // ---- TICKET-104 root-cause diagnostic: momentum feature vector + determinism + window sensitivity ----
      if (isMomentumDiagTarget && regimeMetricsAtTarget) {
        const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
        const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;

        console.log(`\n===== [TICKET-104] Momentum feature diagnostic — ${symbol} SHORT @ ${new Date(decisionTime).toISOString()} =====`);
        console.log(`window5m length=${window5m.length}, last close=${window5m[window5m.length - 1]?.close}`);
        console.log(`w1hMomentum(production, len=${WINDOW_1H_MOMENTUM}) actualLen=${w1hMomentum.window.length}, first close=${w1hMomentum.window[0]?.close}, last close=${w1hMomentum.window[w1hMomentum.window.length - 1]?.close}`);

        const crossFeatures = computeMomentumCrossFeatures(window5m, w1hMomentum.window);
        console.log('crossFeatures (production 250-window):', crossFeatures);

        // Sensitivity sweep — does emaRatioSlow (hence momentumScore) shift materially with MORE
        // pre-seed 1h history, even though the window's TAIL (last several candles) stays identical?
        for (const altLen of [250, 300, 400, 600, 1000]) {
          const altW1h = closedWindow(sd.candles1h, sd.ptr1h, 60 * 60_000, decisionTime, altLen);
          const cf = computeMomentumCrossFeatures(window5m, altW1h.window);
          console.log(`  [SENSITIVITY] windowLen=${altLen} actualLen=${altW1h.window.length} emaRatioSlow=${cf?.emaRatioSlow?.toFixed(6)} emaRatioFast=${cf?.emaRatioFast?.toFixed(6)} volAdjReturn5m=${cf?.volAdjReturn5m?.toFixed(6)}`);
        }

        if (crossFeatures !== undefined) {
          const schema = loadFeatureSchema(MOMENTUM_BEARISH_SCHEMA_PATH);
          const raw: RawMomentumFeatures = {
            symbol,
            adx1h: regimeMetricsAtTarget.adx1h as number,
            atrPercentile5m: regimeMetricsAtTarget.atrPercentile5m as number,
            bbWidthPercentile15m: regimeMetricsAtTarget.bbWidthPercentile15m as number,
            volumeZScore5m: regimeMetricsAtTarget.volumeZScore5m as number,
            atrTrend5m: regimeMetricsAtTarget.atrTrend5m as string,
            adxDirection1h: regimeMetricsAtTarget.adxDirection1h as string,
            macroDirection,
            ...crossFeatures,
          };
          const vector = buildFeatureVector(raw, schema);
          console.log('RawMomentumFeatures:', raw);
          console.log('feature_order:', schema.feature_order);
          console.log('featureVector:', Array.from(vector));

          const score1 = await scoreMomentum(MOMENTUM_BEARISH_MODEL_PATH, vector);
          const score2 = await scoreMomentum(MOMENTUM_BEARISH_MODEL_PATH, vector);
          console.log(`scoreMomentum determinism check: call1=${score1} call2=${score2} identical=${score1 === score2}`);
          console.log(`=> momentumScore (bearish v1, production window) = ${(score1 * 100).toFixed(1)}%`);
        } else {
          console.log('crossFeatures undefined — insufficient EMA/ATR history at production window length.');
        }
        console.log('===== end diagnostic =====\n');
      }

      if (PRINT_TRAJECTORY && (symbol === 'XRPUSDT' || symbol === 'SOLUSDT') && sd.state.regimeState.previousRegime === 'DANGER_ZONE') {
        console.log(`  [DANGER_ZONE_HIT] ${symbol} ${new Date(decisionTime).toISOString()}`);
      }
      if (PRINT_TRAJECTORY) {
        const inTrajectoryWindow = TARGET_TRADES.some((t) => t.symbol === symbol && decisionTime <= Date.parse(t.timestampIso) && decisionTime >= Date.parse(t.timestampIso) - 3 * 60 * 60_000);
        if (inTrajectoryWindow) {
          console.log(
            `  [TRAJ ${symbol} ${new Date(decisionTime).toISOString()}] confirmedRegime=${sd.state.regimeState.previousRegime} candidateRegime=${sd.state.regimeState.previousCandidateRegime} streakCount=${sd.state.regimeState.streakCount} adx1h=${regimeMetricsAtTarget?.adx1h?.toFixed(1) ?? ''} adx1hRecent=[${regimeMetricsAtTarget?.adx1hRecent?.map((v) => v.toFixed(1)).join(',') ?? ''}] atrPct5m=${regimeMetricsAtTarget?.atrPercentile5m?.toFixed(0) ?? ''}`,
          );
        }
      }

      if (nearTarget) {
        nearTargetDiagnostics.push({
          symbol,
          decisionTimeIso: new Date(decisionTime).toISOString(),
          confirmedRegimeAtTarget: sd.state.regimeState.previousRegime ?? undefined,
          adx1hAtTarget: regimeMetricsAtTarget?.adx1h,
          atrPercentile5mAtTarget: regimeMetricsAtTarget?.atrPercentile5m,
          funnelEventsAtTarget,
        });
      }

      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];

      for (const event of result.events) {
        if (event.type === 'OPEN') {
          const e = event as OpenTradeEvent;
          capturedOpens.push({
            symbol: e.symbol,
            side: e.side,
            regime: e.regime,
            setupType: e.setupType,
            entryTimestamp: e.entryTimestamp,
            entryPrice: e.entryPrice,
            slPrice: e.slPrice,
            adx1h: e.adx1h,
            atrPercentile5m: e.atrPercentile5m,
            momentumScore: e.momentumScore,
            riskPoolPctBefore: e.riskPoolPctBefore,
            riskPoolPctAfter: e.riskPoolPctAfter,
            correlatedRiskRatio,
          });
        }
      }
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — capturedOpens=${capturedOpens.length}...`);
    }
  }

  console.log(`Xong simulation. Tổng số OPEN events bắt được (mọi symbol/side): ${capturedOpens.length}`);
  for (const c of capturedOpens) {
    console.log(
      `  [OPEN] ${c.symbol} ${c.side} ts=${new Date(c.entryTimestamp).toISOString()} entry=${c.entryPrice} sl=${c.slPrice} regime=${c.regime} setup=${c.setupType} adx1h=${c.adx1h} atrPct5m=${c.atrPercentile5m} momentum=${c.momentumScore}`,
    );
  }

  // ---- Matching: for each target trade, find the closest-matching captured OPEN by symbol+side+time. ----
  const TIME_TOLERANCE_MS = 20 * 60_000; // allow up to 20 minutes off (candle alignment / fill timing)
  const PRICE_TOLERANCE_PCT = 2; // generous tolerance just for MATCHING (not for the pass/fail verdict below)

  interface MatchResult {
    target: TargetTrade;
    matched: CapturedOpen | null;
    candidates: CapturedOpen[]; // all same symbol+side opens within a wider window, for diagnostics
  }

  const matchResults: MatchResult[] = TARGET_TRADES.map((target) => {
    const targetTs = Date.parse(target.timestampIso);
    const sameSymbolSide = capturedOpens.filter((c) => c.symbol === target.symbol && c.side === target.side);
    const withinWideWindow = sameSymbolSide.filter((c) => Math.abs(c.entryTimestamp - targetTs) <= 6 * 60 * 60_000);

    let best: CapturedOpen | null = null;
    let bestScore = Infinity;
    for (const c of sameSymbolSide) {
      const timeDiff = Math.abs(c.entryTimestamp - targetTs);
      if (timeDiff > TIME_TOLERANCE_MS) continue;
      const priceDiffPct = (Math.abs(c.entryPrice - target.entryPrice) / target.entryPrice) * 100;
      if (priceDiffPct > PRICE_TOLERANCE_PCT) continue;
      // Score: prioritize time closeness, price closeness secondary.
      const score = timeDiff + priceDiffPct * 60_000;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return { target, matched: best, candidates: withinWideWindow };
  });

  // ---- Build comparison report ----
  function fmt(n: number | undefined, digits = 4): string {
    return n === undefined ? 'undefined' : n.toFixed(digits);
  }
  function verdict(matchBool: boolean): string {
    return matchBool ? 'MATCH' : 'MISMATCH';
  }
  function targetTsForDiag(t: TargetTrade): number {
    return Date.parse(t.timestampIso);
  }

  const lines: string[] = [];
  lines.push('# TICKET-102 — Xác minh logic vào lệnh 3 giao dịch live thật (2026-07-28/29)');
  lines.push('');
  lines.push(`Sinh tự động bởi \`npx tsx apps/bot/scripts/ticket102InvestigateEntryLogic.ts\` — ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('Mô phỏng lại đúng production orchestrator (`processCandle` từ `dist/orchestrator/orchestrator.js`),');
  lines.push('dùng đúng CONFIG live copy nguyên văn từ `scripts/liveRunner.ts`, chạy trên dữ liệu OHLCV thật');
  lines.push(`từ ${SIM_FROM_ISO} đến ${SIM_TO_EXCLUSIVE_ISO} (bao gồm warm-up ~20 ngày trước ngày giao dịch để hysteresis/streakCount ổn định).`);
  lines.push('');

  for (const mr of matchResults) {
    const { target, matched } = mr;
    lines.push(`## ${target.label}`);
    lines.push('');
    lines.push(`Telegram timestamp: ${target.timestampIso}`);
    lines.push('');

    if (!matched) {
      lines.push('**KHÔNG TÁI TẠO ĐƯỢC** — không tìm thấy OpenTradeEvent nào khớp symbol+side+thời gian+giá trong mô phỏng.');
      lines.push('');
      if (mr.candidates.length > 0) {
        lines.push(`Các OPEN cùng symbol+side trong vòng ±6h quanh mốc thời gian (để tham khảo, KHÔNG được coi là khớp):`);
        lines.push('');
        lines.push('| entryTimestamp (UTC) | entryPrice | regime | setupType | adx1h | atrPercentile5m | momentumScore |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const c of mr.candidates) {
          lines.push(
            `| ${new Date(c.entryTimestamp).toISOString()} | ${c.entryPrice} | ${c.regime} | ${c.setupType} | ${fmt(c.adx1h, 1)} | ${fmt(c.atrPercentile5m, 0)} | ${c.momentumScore !== undefined ? (c.momentumScore * 100).toFixed(1) + '%' : 'undefined'} |`,
          );
        }
      } else {
        lines.push('Không có bất kỳ OPEN nào cùng symbol+side trong vòng ±6h quanh mốc thời gian này trong mô phỏng.');
      }
      lines.push('');

      const nearby = nearTargetDiagnostics.filter((d) => d.symbol === target.symbol && Math.abs(Date.parse(d.decisionTimeIso) - targetTsForDiag(target)) <= 10 * 60_000);
      if (nearby.length > 0) {
        lines.push('Chi tiết những gì mô phỏng thực sự tính được TẠI ĐÚNG mốc thời gian này (±10 phút, để đối chiếu):');
        lines.push('');
        lines.push('| decisionTime (UTC) | confirmedRegime | adx1h | atrPercentile5m | Funnel events tại nến này |');
        lines.push('|---|---|---|---|---|');
        for (const d of nearby) {
          lines.push(
            `| ${d.decisionTimeIso} | ${d.confirmedRegimeAtTarget ?? 'undefined'} | ${fmt(d.adx1hAtTarget, 1)} | ${fmt(d.atrPercentile5mAtTarget, 0)} | ${d.funnelEventsAtTarget.length > 0 ? d.funnelEventsAtTarget.join('; ') : '(không có FunnelEvent nào bắn ra)'} |`,
          );
        }
        lines.push('');
      }
      continue;
    }

    const aiScoreRecomputedPct = matched.momentumScore !== undefined ? matched.momentumScore * 100 : undefined;

    const rows: Array<[string, string, string, string]> = [
      ['timestamp', new Date(matched.entryTimestamp).toISOString(), target.timestampIso, verdict(Math.abs(matched.entryTimestamp - Date.parse(target.timestampIso)) <= TIME_TOLERANCE_MS)],
      ['entryPrice', String(matched.entryPrice), String(target.entryPrice), verdict((Math.abs(matched.entryPrice - target.entryPrice) / target.entryPrice) * 100 <= 0.1)],
      ['slPrice', String(matched.slPrice), String(target.slPrice), verdict((Math.abs(matched.slPrice - target.slPrice) / target.slPrice) * 100 <= 0.1)],
      ['regime', matched.regime, target.regime, verdict(matched.regime === target.regime)],
      ['setupType', matched.setupType, target.setupType, verdict(matched.setupType === target.setupType)],
      ['adx1h', fmt(matched.adx1h, 1), String(target.adx1h), verdict(matched.adx1h !== undefined && Math.abs(matched.adx1h - target.adx1h) <= 0.5)],
      ['atrPercentile5m', fmt(matched.atrPercentile5m, 0), String(target.atrPercentile5m), verdict(matched.atrPercentile5m !== undefined && Math.abs(matched.atrPercentile5m - target.atrPercentile5m) <= 0.5)],
      [
        'AI score (momentumScore)',
        aiScoreRecomputedPct !== undefined ? aiScoreRecomputedPct.toFixed(1) + '%' : 'undefined',
        target.aiScorePct.toFixed(1) + '%',
        verdict(aiScoreRecomputedPct !== undefined && Math.abs(aiScoreRecomputedPct - target.aiScorePct) <= 1),
      ],
      // BUG FIX (found during --sim-from=real-pm2-start verification): OpenTradeEvent.riskPoolPctBefore/After
      // (orchestrator.ts line ~680) are ALREADY percent numbers (e.g. 7.86 meaning 7.86%), not fractions —
      // this row used to multiply by 100 a second time, inflating e.g. 7.86 -> "786.0%". Display only, never
      // affected the underlying MATCH/MISMATCH verdicts for any other field.
      ['riskPoolPctBefore', matched.riskPoolPctBefore.toFixed(1) + '%', target.riskPoolBeforePct.toFixed(1) + '%', verdict(Math.abs(matched.riskPoolPctBefore - target.riskPoolBeforePct) <= 0.5)],
      ['riskPoolPctAfter', matched.riskPoolPctAfter.toFixed(1) + '%', target.riskPoolAfterPct.toFixed(1) + '%', verdict(Math.abs(matched.riskPoolPctAfter - target.riskPoolAfterPct) <= 0.5)],
    ];

    lines.push('| Field | RECOMPUTED | TELEGRAM-REPORTED | Verdict |');
    lines.push('|---|---|---|---|');
    for (const [field, recomputed, reported, v] of rows) lines.push(`| ${field} | ${recomputed} | ${reported} | ${v} |`);
    lines.push('');

    if (matched.correlatedRiskRatio !== undefined && (target.symbol === 'SOLUSDT')) {
      lines.push(`correlatedRiskRatio tại bước này (fed vào processCandle): **${matched.correlatedRiskRatio.toFixed(4)}**`);
      lines.push('');
    }
  }

  const reportText = lines.join('\n');
  const reportPath = path.resolve(process.cwd(), 'data/ticket102-entry-logic-verification.md');
  writeFileSync(reportPath, reportText);
  console.log('\n' + reportText);
  console.log(`\n→ ${reportPath}`);
}

main().catch((err) => {
  console.error('ticket102InvestigateEntryLogic failed:', err);
  process.exit(1);
});
