/**
 * TICKET-113 — DATA EXPORT ONLY, not part of the official backtest/live pipeline. Adds more indicator
 * columns to TICKET-109's data/all-candidates-with-outcomes.csv (324,176 rows: every momentum-gate
 * candidate evaluated during the official 258-trade backtest replay, passed and rejected alike) so PM
 * can slice AI-approved-vs-rejected x won-vs-lost quadrants. No new formulas, no changes to
 * orchestrator.ts/backtest.ts — re-runs the EXACT same official 8-flag replay one more time (byte-
 * identical CONFIG to ticket108/ticket109's own copy), this time also wiring up the existing (TICKET-078)
 * onRegimeMetrics diagnostic callback alongside TICKET-109's onMomentumGateEvaluation callback in the
 * SAME processCandle() call, to capture regimeOutput.computedMetrics (adx1h/atrPercentile5m/
 * atrTrend5m/bbWidthPercentile15m/volumeZScore5m) for the exact same step that produced each evaluation.
 *
 * correlatedRiskRatio: same per-step value the loop already computes (identical to ticket108/109's own
 * copy — computeCorrelatedRiskRatio() from regime/correlatedRisk.ts).
 * macroDirection: same wilderDIDirectionSeries(w1d.window, MACRO_TREND_ADX_PERIOD_1D) call ticket108
 * already used (verbatim copy — identical to what tryOpenNewPosition() itself computes internally in
 * orchestrator.ts).
 * distanceToNearestSwingAtr: verbatim copy of orchestrator.ts's own (non-exported)
 * computeDistanceToNearestSwingAtr(candles5m) — detectSwingPoints/latestSwingPointBefore/wilderATRSeries
 * applied to the SAME already-"now"-truncated window5m this replay builds every step (no i-FRACTAL_N
 * offset needed here, unlike generateMomentumTrainingDataV2/V3.ts's full-history-precompute case — see
 * orchestrator.ts's own comment on computeDistanceToNearestSwingAtr for why). This is the literal
 * function production itself calls during scoreMomentumForSide() for schema-driven models.
 *
 * consecutiveLossStreak: NEW aggregation (not a formula) — walks the 258 REAL trades in
 * data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv in chronological order
 * (sorted by exitTimestamp) per symbol+side, incrementing a running streak on loss (pnlUsd < 0, same
 * sign convention as win := pnlUsd > 0 used throughout TICKET-108/109) and resetting to 0 on a
 * non-loss (pnlUsd >= 0). For each of the 324,176 candidate rows, looks up the streak value AS OF the
 * most recent REAL trade on that exact symbol+side whose exitTimestamp is strictly before this row's
 * timestamp (0 if none yet) — never looks at a trade that closes after this row's timestamp.
 *
 * Run: npx tsx apps/bot/scripts/ticket113FullyEnrichCandidates.ts (from repo root, after `npm run build`)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { detectSwingPoints, latestSwingPointBefore } from '../dist/entry/detectors/swingPoints.js';
import { lastDefined, wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { processCandle, type MomentumGateEvaluation, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// Same bounded sliding windows as backtest.ts / ticket108/109's own copies.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT official 12-flag command that produced the 258-trade CSV — byte-identical to ticket108/109's
// own CONFIG (see those scripts' own comments for the full flag list).
const CONFIG: OrchestratorConfig = {
  entryRouterConfig: { ...DEFAULT_ENTRY_ROUTER_CONFIG, obSlBufferAtrMultiplier: 0.87 },
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 0.15,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG, momentumFilterEnabled: false },
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, neutralTransitionTradingEnabled: false, neutralTransitionMomentumGateThreshold: 0.55 },
  planAutoSelectionConfig: { ...DEFAULT_PLAN_AUTO_SELECTION_CONFIG, planAutoSelectionEnabled: true, planAutoSelectionMomentumThreshold: 0.7 },
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
const START_BALANCE = 100;
const SKIP_DAYS = 20;

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

/** Verbatim copy of orchestrator.ts's own (non-exported) computeDistanceToNearestSwingAtr — see that
 * file's own doc comment: operates on an already-"now"-truncated candles5m window, so no i-FRACTAL_N
 * offset is needed (unlike generateMomentumTrainingDataV2/V3.ts's full-history-precompute case). This
 * is the literal function production calls internally during scoreMomentumForSide(). */
function computeDistanceToNearestSwingAtr(candles5m: CandleData[]): number | undefined {
  const atr = lastDefined(wilderATRSeries(candles5m, RegimeConfig.ATR_PERIOD_5M));
  if (atr === undefined || atr <= 0) return undefined;
  const swingPoints = detectSwingPoints(candles5m, EntryConfig.FRACTAL_N);
  const lastIndex = candles5m.length - 1;
  const nearestHigh = latestSwingPointBefore(swingPoints, 'HIGH', lastIndex);
  const nearestLow = latestSwingPointBefore(swingPoints, 'LOW', lastIndex);
  if (nearestHigh === null && nearestLow === null) return undefined;
  const close = candles5m[lastIndex].close;
  const distHigh = nearestHigh !== null ? Math.abs(close - nearestHigh.price) : Infinity;
  const distLow = nearestLow !== null ? Math.abs(close - nearestLow.price) : Infinity;
  return Math.min(distHigh, distLow) / atr;
}

interface CapturedDiagnostics {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  adx1h: number | undefined;
  atrPercentile5m: number | undefined;
  atrTrend5m: string | undefined;
  bbWidthPercentile15m: number | undefined;
  volumeZScore5m: number | undefined;
  correlatedRiskRatio: number | undefined;
  macroDirection: 'UP' | 'DOWN' | 'FLAT' | undefined;
  distanceToNearestSwingAtr: number | undefined;
}

async function main(): Promise<void> {
  console.log('TICKET-113 — Fully enrich all-candidates-with-outcomes.csv with more indicator columns');
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  const capturedDiagnostics: CapturedDiagnostics[] = [];
  let accountBalance = START_BALANCE;

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

      // TICKET-078's existing onRegimeMetrics diagnostic callback fires once per processCandle() call
      // for this symbol/step, BEFORE the momentum gate scores anything — same regimeOutput.computedMetrics
      // both LONG and SHORT MomentumGateEvaluations at this step share (see scoreMomentumForSide()).
      let regimeMetricsThisStep: Record<string, number | string | number[] | undefined> | undefined;
      const evaluationsThisStep: MomentumGateEvaluation[] = [];
      const result = await processCandle(
        input,
        sd.state,
        CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        (metrics) => {
          regimeMetricsThisStep = metrics;
        },
        (evaluation) => evaluationsThisStep.push(evaluation),
      );
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      if (evaluationsThisStep.length > 0) {
        // macroDirection: verbatim same computation tryOpenNewPosition() itself does internally
        // (ticket108 precedent) — reused here rather than re-derived.
        const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
        const macroDirectionRaw = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
        const macroDirection = macroDirectionRaw === 'UP' || macroDirectionRaw === 'DOWN' || macroDirectionRaw === 'FLAT' ? macroDirectionRaw : undefined;
        const distanceToNearestSwingAtr = computeDistanceToNearestSwingAtr(window5m);

        for (const evaluation of evaluationsThisStep) {
          capturedDiagnostics.push({
            symbol: evaluation.symbol,
            timestamp: evaluation.timestamp,
            side: evaluation.side,
            adx1h: regimeMetricsThisStep?.['adx1h'] as number | undefined,
            atrPercentile5m: regimeMetricsThisStep?.['atrPercentile5m'] as number | undefined,
            atrTrend5m: regimeMetricsThisStep?.['atrTrend5m'] as string | undefined,
            bbWidthPercentile15m: regimeMetricsThisStep?.['bbWidthPercentile15m'] as number | undefined,
            volumeZScore5m: regimeMetricsThisStep?.['volumeZScore5m'] as number | undefined,
            correlatedRiskRatio,
            macroDirection,
            distanceToNearestSwingAtr,
          });
        }
      }

      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — diagnostics=${capturedDiagnostics.length}, balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong simulation. Tổng số diagnostics bắt được: ${capturedDiagnostics.length}`);

  // ---- consecutiveLossStreak: build from the 258 REAL trades only (never shadow-simulated outcomes). ----
  const baselinePath = path.resolve(process.cwd(), 'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv');
  const baselineLines = readFileSync(baselinePath, 'utf-8').trim().split('\n');
  const baselineHeader = baselineLines[0].split(',');
  interface RealTrade {
    symbol: string;
    side: 'LONG' | 'SHORT';
    exitTimestamp: number;
    pnlUsd: number;
  }
  const realTrades: RealTrade[] = baselineLines.slice(1).map((line) => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    baselineHeader.forEach((c, i) => (row[c] = cols[i]));
    return { symbol: row['symbol'], side: row['side'] as 'LONG' | 'SHORT', exitTimestamp: Number(row['exitTimestamp']), pnlUsd: Number(row['pnlUsd']) };
  });
  console.log(`Baseline CSV (real trades): ${realTrades.length} dòng.`);

  // Sort chronologically (by exitTimestamp — streak updates when a trade RESOLVES) per symbol+side,
  // then walk in order building { exitTimestamp -> streakValueAfterThisTrade }.
  const tradesBySymbolSide = new Map<string, RealTrade[]>();
  for (const t of realTrades) {
    const key = `${t.symbol}|${t.side}`;
    if (!tradesBySymbolSide.has(key)) tradesBySymbolSide.set(key, []);
    tradesBySymbolSide.get(key)!.push(t);
  }
  // streakPoints[symbol|side] = sorted array of { exitTimestamp, streakAfter } — binary-searchable.
  const streakPoints = new Map<string, Array<{ exitTimestamp: number; streakAfter: number }>>();
  let maxStreakSeen = 0;
  for (const [key, trades] of tradesBySymbolSide) {
    trades.sort((a, b) => a.exitTimestamp - b.exitTimestamp);
    let streak = 0;
    const points: Array<{ exitTimestamp: number; streakAfter: number }> = [];
    for (const t of trades) {
      streak = t.pnlUsd < 0 ? streak + 1 : 0;
      maxStreakSeen = Math.max(maxStreakSeen, streak);
      points.push({ exitTimestamp: t.exitTimestamp, streakAfter: streak });
    }
    streakPoints.set(key, points);
  }

  /** Streak value as of just-before `timestamp` on this symbol+side: the streakAfter of the latest
   * real trade whose exitTimestamp < timestamp (0 if none). Binary search since points are sorted. */
  function streakAsOf(symbol: string, side: 'LONG' | 'SHORT', timestamp: number): number {
    const points = streakPoints.get(`${symbol}|${side}`);
    if (!points || points.length === 0) return 0;
    let lo = 0;
    let hi = points.length - 1;
    let result = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].exitTimestamp < timestamp) {
        result = points[mid].streakAfter;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // ---- Load source CSV (324,176 rows), match every row to captured diagnostics by symbol+timestamp+side. ----
  const sourcePath = path.resolve(process.cwd(), 'data/all-candidates-with-outcomes.csv');
  const sourceLines = readFileSync(sourcePath, 'utf-8').trim().split('\n');
  const header = sourceLines[0];
  const dataLines = sourceLines.slice(1);
  console.log(`Nguồn: ${dataLines.length} dòng.`);

  const diagnosticsByKey = new Map<string, CapturedDiagnostics>();
  for (const d of capturedDiagnostics) {
    const key = `${d.symbol}|${d.timestamp}|${d.side}`;
    diagnosticsByKey.set(key, d); // exact match expected — no duplicates possible (one evaluation per symbol/timestamp/side)
  }

  const unmatchedRows: string[] = [];
  const enrichedRows: string[] = [];
  let adx1hCount = 0;
  let atrPercentile5mCount = 0;
  let atrTrend5mCount = 0;
  let bbWidthPercentile15mCount = 0;
  let volumeZScore5mCount = 0;
  let correlatedRiskRatioCount = 0;
  let macroDirectionCount = 0;
  let distanceToNearestSwingAtrCount = 0;
  let consecutiveLossStreakCount = 0;
  const streakDistribution = new Map<number, number>();

  for (const line of dataLines) {
    const cols = line.split(',');
    const symbol = cols[0];
    const timestamp = Number(cols[1]);
    const side = cols[2] as 'LONG' | 'SHORT';
    const key = `${symbol}|${timestamp}|${side}`;
    const matched = diagnosticsByKey.get(key);

    if (!matched) {
      unmatchedRows.push(line);
      continue;
    }

    const adx1h = matched.adx1h !== undefined ? String(matched.adx1h) : '';
    const atrPercentile5m = matched.atrPercentile5m !== undefined ? String(matched.atrPercentile5m) : '';
    const correlatedRiskRatio = matched.correlatedRiskRatio !== undefined ? String(matched.correlatedRiskRatio) : '';
    const macroDirection = matched.macroDirection ?? '';
    const distanceToNearestSwingAtr = matched.distanceToNearestSwingAtr !== undefined ? String(matched.distanceToNearestSwingAtr) : '';
    const atrTrend5m = matched.atrTrend5m ?? '';
    const bbWidthPercentile15m = matched.bbWidthPercentile15m !== undefined ? String(matched.bbWidthPercentile15m) : '';
    const volumeZScore5m = matched.volumeZScore5m !== undefined ? String(matched.volumeZScore5m) : '';
    const consecutiveLossStreak = streakAsOf(symbol, side, timestamp);

    if (adx1h !== '') adx1hCount++;
    if (atrPercentile5m !== '') atrPercentile5mCount++;
    if (atrTrend5m !== '') atrTrend5mCount++;
    if (bbWidthPercentile15m !== '') bbWidthPercentile15mCount++;
    if (volumeZScore5m !== '') volumeZScore5mCount++;
    if (correlatedRiskRatio !== '') correlatedRiskRatioCount++;
    if (macroDirection !== '') macroDirectionCount++;
    if (distanceToNearestSwingAtr !== '') distanceToNearestSwingAtrCount++;
    consecutiveLossStreakCount++; // always defined (0 if no prior real trade)
    streakDistribution.set(consecutiveLossStreak, (streakDistribution.get(consecutiveLossStreak) ?? 0) + 1);

    enrichedRows.push(
      [line, adx1h, atrPercentile5m, correlatedRiskRatio, macroDirection, distanceToNearestSwingAtr, atrTrend5m, bbWidthPercentile15m, volumeZScore5m, consecutiveLossStreak].join(','),
    );
  }

  if (unmatchedRows.length > 0) {
    console.error(`\nLỖI: ${unmatchedRows.length} / ${dataLines.length} dòng KHÔNG khớp được với bất kỳ diagnostic nào đã capture (symbol+timestamp+side):`);
    for (const l of unmatchedRows.slice(0, 20)) console.error(`  ${l}`);
    if (unmatchedRows.length > 20) console.error(`  ... và ${unmatchedRows.length - 20} dòng khác`);
    console.error('\nDừng lại — không ghi file output với dòng chưa khớp/đoán mò.');
    process.exit(1);
  }

  const outHeader = header + ',adx1h,atrPercentile5m,correlatedRiskRatio,macroDirection,distanceToNearestSwingAtr,atrTrend5m,bbWidthPercentile15m,volumeZScore5m,consecutiveLossStreak';
  const outPath = path.resolve(process.cwd(), 'data/all-candidates-fully-enriched.csv');
  writeFileSync(outPath, [outHeader, ...enrichedRows].join('\n') + '\n');

  console.log(`\n→ ${outPath}`);
  console.log(`Tổng số dòng: ${enrichedRows.length} (khớp 100% với ${dataLines.length} dòng nguồn)`);
  console.log(`adx1h: ${adx1hCount}/${enrichedRows.length}`);
  console.log(`atrPercentile5m: ${atrPercentile5mCount}/${enrichedRows.length}`);
  console.log(`correlatedRiskRatio: ${correlatedRiskRatioCount}/${enrichedRows.length}`);
  console.log(`macroDirection: ${macroDirectionCount}/${enrichedRows.length}`);
  console.log(`distanceToNearestSwingAtr: ${distanceToNearestSwingAtrCount}/${enrichedRows.length}`);
  console.log(`atrTrend5m: ${atrTrend5mCount}/${enrichedRows.length}`);
  console.log(`bbWidthPercentile15m: ${bbWidthPercentile15mCount}/${enrichedRows.length}`);
  console.log(`volumeZScore5m: ${volumeZScore5mCount}/${enrichedRows.length}`);
  console.log(`consecutiveLossStreak: ${consecutiveLossStreakCount}/${enrichedRows.length} (always defined; max streak seen among real trades: ${maxStreakSeen})`);
  console.log('consecutiveLossStreak distribution:');
  const sortedStreakKeys = [...streakDistribution.keys()].sort((a, b) => a - b);
  for (const k of sortedStreakKeys) console.log(`  ${k}: ${streakDistribution.get(k)}`);
}

main().catch((err) => {
  console.error('ticket113FullyEnrichCandidates failed:', err);
  process.exit(1);
});
