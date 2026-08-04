/**
 * TICKET-119 — DATA EXPORT ONLY, not part of the official backtest/live pipeline. Captures the
 * `regime` (MarketRegime) diagnostic value now on MomentumGateEvaluation (TICKET-119's one-line
 * addition to orchestrator.ts's interface — see that file's own comment) for every candidate row in
 * data/training/momentum-v6-labeled.csv (TICKET-118), so PM can break down AUC by regime.
 *
 * Re-runs the EXACT official 8-flag backtest replay one more time — byte-identical CONFIG to
 * ticket108/109/113's own copies (same windowing/loop structure, same processCandle() call). Unlike
 * ticket113FullyEnrichCandidates.ts (which needed the separate onRegimeMetrics callback to read
 * regimeOutput.computedMetrics), `regime` is now read directly off each MomentumGateEvaluation
 * (evaluation.regime) since TICKET-119 added it to that interface as a pure pass-through of
 * regimeOutput.regime at the exact call site — no new formula, no state re-derivation.
 *
 * Matches rows to data/training/momentum-v6-labeled.csv by symbol+timestampUtc+side (same key
 * convention as ticket113). Writes data/training/momentum-v6-labeled-with-regime.csv: momentum-v6-
 * labeled.csv's own columns + one appended `regime` column. Any unmatched row aborts the script
 * (same "don't guess" convention as ticket113) rather than silently dropping/imputing.
 *
 * ANALYSIS/EXPERIMENTAL ONLY (TICKET-119) — does not touch backtest.ts/liveRunner.ts/xgbFilter/
 * config.ts or any production file, does not modify ticket109/113/118's own scripts or outputs.
 *
 * Run: npx tsx apps/bot/scripts/ticket119CaptureRegimeForV6.ts (from repo root, after `npm run build`
 * so apps/bot/dist/ reflects the orchestrator.ts regime-field addition).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { processCandle, type MomentumGateEvaluation, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// Same bounded sliding windows as backtest.ts / ticket108/109/113's own copies.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT official 8-flag config that produced the 258-trade CSV — byte-identical to ticket108/109/113's
// own copies (see those scripts' own comments for the full flag list).
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

interface CapturedRegime {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  regime: string | undefined;
}

async function main(): Promise<void> {
  console.log('TICKET-119 — Capture regime per candidate for momentum-v6-labeled.csv');
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  const capturedRegimes: CapturedRegime[] = [];
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

      const evaluationsThisStep: MomentumGateEvaluation[] = [];
      const result = await processCandle(input, sd.state, CONFIG, undefined, undefined, undefined, undefined, undefined, (evaluation) => evaluationsThisStep.push(evaluation));
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      for (const evaluation of evaluationsThisStep) {
        capturedRegimes.push({ symbol: evaluation.symbol, timestamp: evaluation.timestamp, side: evaluation.side, regime: evaluation.regime as string | undefined });
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
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — regimes captured=${capturedRegimes.length}, balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong simulation. Tổng số regime captures: ${capturedRegimes.length}`);

  const regimeByKey = new Map<string, string | undefined>();
  for (const r of capturedRegimes) {
    const key = `${r.symbol}|${r.timestamp}|${r.side}`;
    regimeByKey.set(key, r.regime); // exact match expected — one evaluation per symbol/timestamp/side
  }

  // ---- Load momentum-v6-labeled.csv (TICKET-118), match every row by symbol+timestampUtc+side. ----
  const sourcePath = path.resolve(process.cwd(), 'data/training/momentum-v6-labeled.csv');
  const sourceLines = readFileSync(sourcePath, 'utf-8').trim().split('\n');
  const header = sourceLines[0].split(',');
  const symbolIdx = header.indexOf('symbol');
  const tsIdx = header.indexOf('timestampUtc');
  const sideIdx = header.indexOf('side');
  const dataLines = sourceLines.slice(1);
  console.log(`Nguồn (${sourcePath}): ${dataLines.length} dòng.`);

  const unmatchedRows: string[] = [];
  const enrichedRows: string[] = [];
  let regimeDefinedCount = 0;
  const regimeDistribution = new Map<string, number>();

  for (const line of dataLines) {
    const cols = line.split(',');
    const symbol = cols[symbolIdx];
    const timestamp = Number(cols[tsIdx]);
    const side = cols[sideIdx] as 'LONG' | 'SHORT';
    const key = `${symbol}|${timestamp}|${side}`;
    if (!regimeByKey.has(key)) {
      unmatchedRows.push(line);
      continue;
    }
    const regime = regimeByKey.get(key);
    const regimeStr = regime ?? '';
    if (regimeStr !== '') {
      regimeDefinedCount++;
      regimeDistribution.set(regimeStr, (regimeDistribution.get(regimeStr) ?? 0) + 1);
    }
    enrichedRows.push([line, regimeStr].join(','));
  }

  if (unmatchedRows.length > 0) {
    console.error(`\nLỖI: ${unmatchedRows.length} / ${dataLines.length} dòng KHÔNG khớp được với bất kỳ regime capture nào (symbol+timestampUtc+side):`);
    for (const l of unmatchedRows.slice(0, 20)) console.error(`  ${l}`);
    if (unmatchedRows.length > 20) console.error(`  ... và ${unmatchedRows.length - 20} dòng khác`);
    console.error('\nDừng lại — không ghi file output với dòng chưa khớp/đoán mò.');
    process.exit(1);
  }

  const outHeader = [...header, 'regime'].join(',');
  const outPath = path.resolve(process.cwd(), 'data/training/momentum-v6-labeled-with-regime.csv');
  writeFileSync(outPath, [outHeader, ...enrichedRows].join('\n') + '\n');

  console.log(`\n→ ${outPath}`);
  console.log(`Tổng số dòng: ${enrichedRows.length} (khớp 100% với ${dataLines.length} dòng nguồn)`);
  console.log(`regime defined: ${regimeDefinedCount}/${enrichedRows.length}`);
  console.log('regime distribution:');
  for (const [k, v] of [...regimeDistribution.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}

main().catch((err) => {
  console.error('ticket119CaptureRegimeForV6 failed:', err);
  process.exit(1);
});
