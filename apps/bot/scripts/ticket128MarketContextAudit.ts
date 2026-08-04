/**
 * TICKET-128 — 5M-PRIORITY MARKET CONTEXT AUDIT — Step 3 (re-walk + enrich).
 *
 * PURE DATA EXPORT, read-only, additive. Re-walks the full OHLCV set exactly like
 * apps/bot/scripts/ticket113FullyEnrichCandidates.ts (its own doc comment is the precedent this
 * script follows verbatim: same processCandle()/onMomentumGateEvaluation wiring, same window
 * constants, same no-look-ahead two-pointer convention) so every row lines up 1:1 (by
 * symbol+timestamp+side) with data/all-candidates-fully-enriched.csv (324,176 rows — every
 * momentum-gate-evaluated candidate from the official 258-trade backtest replay, passed and
 * rejected alike). Never touches orchestrator.ts/entryRouter.ts/tactical/ — onMomentumGateEvaluation
 * is a pure pass-through diagnostic callback that never affects any decision (see orchestrator.ts's
 * own MomentumGateEvaluation doc comment).
 *
 * For each candidate row this additionally computes, at that EXACT original timestamp (no
 * look-ahead):
 *   - crossFeatures (emaRatioFast/emaRatioSlow) via xgbFilter/featureBuilder.ts's
 *     computeMomentumCrossFeatures() (read-only reuse, same candles1hMomentum window production uses).
 *   - adxDirection1h (from the SAME onRegimeMetrics computedMetrics dict ticket113 already captures,
 *     just not carried into its own CSV output).
 *   - recent, sided structural break for BOTH directions, on the 1m window
 *     (entry/detectors/structuralBreakRecent.ts, TICKET-125's fix — reused as-is).
 *   - Layer A/B/C labels+scores (ticket128MarketContextScoring.ts, this ticket's own new, independent
 *     scoring library — see that file's doc comment for methodology/threshold rationale).
 *
 * Run (from repo root, after `npm run build && npm run build:scripts`):
 *   node apps/bot/scripts-dist/ticket128MarketContextAudit.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { EntryConfig } from '../dist/entry/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { computeMomentumCrossFeatures } from '../dist/xgbFilter/featureBuilder.js';
import { detectRecentStructuralBreak, type RecentStructuralBreak } from '../dist/entry/detectors/structuralBreakRecent.js';
import { processCandle, type MomentumGateEvaluation, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { computeLayerA, computeLayerB, computeLayerC, computeHhHlPattern, computeReturnInAtr5m128, layerAScoreForSide } from './ticket128MarketContextScoring.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const SOURCE_CSV = path.resolve(process.cwd(), 'data/all-candidates-fully-enriched.csv');
const OUT_CSV = path.resolve(process.cwd(), 'data/ticket128-market-context-audit.csv');

// Same bounded sliding windows as backtest.ts / ticket108/109/113/125's own copies.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT official 8-flag command that produced the 258-trade CSV — byte-identical to ticket108/109/113's own CONFIG.
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

/** Two-pointer: advances `ptr` to the latest candle already CLOSED, never looks ahead. Copied from backtest.ts/ticket113. */
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

interface CapturedRow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  adx1h: number | undefined;
  adxDirection1h: 'UP' | 'DOWN' | 'FLAT' | undefined;
  emaRatioFast: number | undefined;
  emaRatioSlow: number | undefined;
  returnInAtr5m: number | undefined;
  structBreakLongAge: number | undefined;
  structBreakShortAge: number | undefined;
  hhHlPattern: string;
  layerADirection: string;
  layerAScoreLong: number;
  layerAScoreShort: number;
  layerAScoreForCandidateSide: number;
  layerBQuality: string;
  /** Layer C computed WITHOUT macroDirection (unavailable mid-walk) — a placeholder recomputed for
   * real after the join against all-candidates-fully-enriched.csv (which already has macroDirection
   * for this exact timestamp). See main()'s post-join loop. */
}

async function main(): Promise<void> {
  console.log('TICKET-128 — 5m-Priority Market Context Audit (re-walk + enrich)...');
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  const capturedRows: CapturedRow[] = [];
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
        const adxDirection1h = regimeMetricsThisStep?.['adxDirection1h'] as 'UP' | 'DOWN' | 'FLAT' | undefined;
        const crossFeatures = computeMomentumCrossFeatures(window5m, w1hMomentum.window);

        // TICKET-125's fix — recent, sided, swing-anchored structural break, BOTH directions, on the 1m window.
        const recentLong: RecentStructuralBreak | null = detectRecentStructuralBreak(w1m.window, 'BULLISH', { fractalN: EntryConfig.FRACTAL_N });
        const recentShort: RecentStructuralBreak | null = detectRecentStructuralBreak(w1m.window, 'BEARISH', { fractalN: EntryConfig.FRACTAL_N });
        const structuralBreak = { LONG: recentLong !== null ? { ageCandles: recentLong.ageCandles } : null, SHORT: recentShort !== null ? { ageCandles: recentShort.ageCandles } : null };

        // ---- Layer A: 5m Direction Strength ----
        const layerA = computeLayerA({ candles5m: window5m, crossFeatures, structuralBreak, fractalN: EntryConfig.FRACTAL_N });
        const hhHlPattern = computeHhHlPattern(window5m, EntryConfig.FRACTAL_N);
        const returnInAtr5m = computeReturnInAtr5m128(window5m);
        const adx1h = regimeMetricsThisStep?.['adx1h'] as number | undefined;

        // ---- Layer B: 5m Market Quality (side-independent) ----
        const layerB = computeLayerB({
          candles5m: window5m,
          atrPercentile5m: regimeMetricsThisStep?.['atrPercentile5m'] as number | undefined,
          bbWidthPercentile15m: regimeMetricsThisStep?.['bbWidthPercentile15m'] as number | undefined,
          volumeZScore5m: regimeMetricsThisStep?.['volumeZScore5m'] as number | undefined,
          atrTrend5m: regimeMetricsThisStep?.['atrTrend5m'] as 'increasing' | 'decreasing' | 'flat' | undefined,
        });

        for (const evaluation of evaluationsThisStep) {
          capturedRows.push({
            symbol: evaluation.symbol,
            timestamp: evaluation.timestamp,
            side: evaluation.side,
            adx1h,
            adxDirection1h,
            emaRatioFast: crossFeatures?.emaRatioFast,
            emaRatioSlow: crossFeatures?.emaRatioSlow,
            returnInAtr5m,
            structBreakLongAge: recentLong?.ageCandles,
            structBreakShortAge: recentShort?.ageCandles,
            hhHlPattern,
            layerADirection: layerA.direction,
            layerAScoreLong: layerA.long.score,
            layerAScoreShort: layerA.short.score,
            layerAScoreForCandidateSide: layerAScoreForSide(layerA, evaluation.side),
            layerBQuality: layerB,
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
    if (progressStep % 5000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — captured=${capturedRows.length}, balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong re-walk. Tổng số rows captured: ${capturedRows.length}`);

  // ---- Join against data/all-candidates-fully-enriched.csv (324,176 rows) by symbol+timestamp+side. ----
  const sourceLines = readFileSync(SOURCE_CSV, 'utf-8').trim().split('\n');
  const sourceHeader = sourceLines[0].split(',');
  const sourceDataLines = sourceLines.slice(1);
  console.log(`Nguồn (all-candidates-fully-enriched.csv): ${sourceDataLines.length} dòng.`);

  const capturedByKey = new Map<string, CapturedRow>();
  for (const r of capturedRows) capturedByKey.set(`${r.symbol}|${r.timestamp}|${r.side}`, r);

  const idx = (name: string) => sourceHeader.indexOf(name);
  const iMacroDirection = idx('macroDirection');

  const unmatchedRows: string[] = [];
  const outRows: string[] = [];
  for (const line of sourceDataLines) {
    const cols = line.split(',');
    const symbol = cols[0];
    const timestamp = Number(cols[1]);
    const side = cols[2] as 'LONG' | 'SHORT';
    const key = `${symbol}|${timestamp}|${side}`;
    const matched = capturedByKey.get(key);
    if (!matched) {
      unmatchedRows.push(line);
      continue;
    }
    const macroDirection = cols[iMacroDirection] as 'UP' | 'DOWN' | 'FLAT' | '';
    // Layer C (HTF Context) is computed HERE, at join time, with the full input available:
    // adx1h/adxDirection1h captured during the re-walk above, plus macroDirection (1D) from the
    // already-enriched source CSV — never re-derived, straight pass-through of that column.
    const layerC = computeLayerC({
      side,
      adx1h: matched.adx1h,
      adxDirection1h: matched.adxDirection1h,
      macroDirection: macroDirection === '' ? undefined : (macroDirection as 'UP' | 'DOWN' | 'FLAT'),
    });

    outRows.push(
      [
        line,
        matched.adxDirection1h ?? '',
        matched.emaRatioFast ?? '',
        matched.emaRatioSlow ?? '',
        matched.returnInAtr5m ?? '',
        matched.structBreakLongAge ?? '',
        matched.structBreakShortAge ?? '',
        matched.hhHlPattern,
        matched.layerADirection,
        matched.layerAScoreLong,
        matched.layerAScoreShort,
        matched.layerAScoreForCandidateSide,
        matched.layerBQuality,
        layerC,
      ].join(','),
    );
  }

  if (unmatchedRows.length > 0) {
    console.error(`\nLỖI: ${unmatchedRows.length} / ${sourceDataLines.length} dòng KHÔNG khớp được với bất kỳ captured row nào (symbol+timestamp+side):`);
    for (const l of unmatchedRows.slice(0, 20)) console.error(`  ${l}`);
    if (unmatchedRows.length > 20) console.error(`  ... và ${unmatchedRows.length - 20} dòng khác`);
    console.error('\nDừng lại — không ghi file output với dòng chưa khớp/đoán mò.');
    process.exit(1);
  }

  const outHeader =
    sourceHeader.join(',') +
    ',adxDirection1h,emaRatioFast,emaRatioSlow,returnInAtr5m,structBreakLongAge,structBreakShortAge,hhHlPattern,layerADirection,layerAScoreLong,layerAScoreShort,layerAScoreForCandidateSide,layerBQuality,layerCContext';
  writeFileSync(OUT_CSV, [outHeader, ...outRows].join('\n') + '\n');
  console.log(`\n→ ${OUT_CSV}`);
  console.log(`Tổng số dòng: ${outRows.length} (khớp 100% với ${sourceDataLines.length} dòng nguồn)`);
}

main().catch((err) => {
  console.error('ticket128MarketContextAudit failed:', err);
  process.exit(1);
});
