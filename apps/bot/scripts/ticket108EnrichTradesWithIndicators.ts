/**
 * TICKET-108 — DATA EXPORT ONLY, not part of the official backtest/live pipeline. Re-runs the EXACT
 * official 12-flag backtest replay (same code path as backtest.ts, same 8-flag baseline +
 * risk-dollar-or-percent=15/max-margin-cap=37.5/start-balance=100 that produced the 258-trade
 * `data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv`), captures every
 * OpenTradeEvent, and enriches those 258 CLOSE rows with market-indicator values already computed at
 * OPEN time (adx1h, atrPercentile5m, momentumScore straight off OpenTradeEvent) plus 3 read-only
 * diagnostics recomputed via the SAME already-exported functions the production code itself calls
 * (correlatedRiskRatio, macroDirection via wilderDIDirectionSeries, atr5m via wilderATRSeries) — no
 * new formulas, no changes to backtest.ts/orchestrator.ts.
 *
 * Windowing/closedWindow/correlatedRiskRatioSeries/ProcessCandleInput-building logic copied verbatim
 * from backtest.ts (the established no-look-ahead simulation pattern), same as ticket102's precedent.
 *
 * Run: npx tsx apps/bot/scripts/ticket108EnrichTradesWithIndicators.ts (from repo root)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { wilderATRSeries, wilderDIDirectionSeries } from '../dist/regime/indicators.js';
import { processCandle, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OpenTradeEvent, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { EntryConfig } from '../dist/entry/config.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// Same bounded sliding windows as backtest.ts (see its own comment for rationale).
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT official 12-flag command that produced the 258-trade CSV:
//   --max-concurrent-positions-per-symbol=2 --momentum-direct-enabled=true --momentum-direct-threshold=0.5
//   --skip-days=20 --momentum-direct-min-sl-percent=1.27 --momentum-direct-tp-r-multiple=3.0
//   --risk-pool-max-pct=15 --plan-auto-selection-enabled=true --ob-sl-buffer-atr-multiplier=0.87
//   --risk-dollar-or-percent=15 --start-balance=100 --max-margin-cap=37.5
// Every other field below is backtest.ts's own default (see parseArgs()), hardcoded here per the ticket.
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
  entryTimestamp: number;
  setupType: string;
  entryPrice: number;
  slPrice: number;
  tpPrice: number | undefined; // first/only tpLevels entry's price
  adx1h?: number;
  atrPercentile5m?: number;
  momentumScore?: number;
  correlatedRiskRatio?: number;
  macroDirection?: 'UP' | 'DOWN' | 'FLAT';
  atr5m?: number;
}

async function main(): Promise<void> {
  console.log('TICKET-108 — Enrich 258-trade baseline CSV with market-indicator values at OPEN time');
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  const capturedOpens: CapturedOpen[] = [];
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

      const result = await processCandle(input, sd.state, CONFIG, undefined, undefined, undefined, undefined);
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      const newTotalRisk = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.actualRiskDollar, 0);
      if (newTotalRisk > 0) openRiskBySymbol[symbol] = newTotalRisk;
      else delete openRiskBySymbol[symbol];
      const newTotalMargin = sd.state.openPositions.reduce((sum, entry) => sum + entry.meta.marginRequired, 0);
      if (newTotalMargin > 0) openMarginBySymbol[symbol] = newTotalMargin;
      else delete openMarginBySymbol[symbol];

      for (const event of result.events) {
        if (event.type === 'OPEN') {
          const e = event as OpenTradeEvent;
          // TICKET-108 read-only diagnostics — same exported functions the production code itself
          // calls (orchestrator.ts's own macroDirection/atr computations), applied to this step's
          // own already-built candles1d/candles5m windows. No new logic.
          const macroDirectionSeries = wilderDIDirectionSeries(w1d.window, EntryConfig.MACRO_TREND_ADX_PERIOD_1D);
          const macroDirection = macroDirectionSeries.length > 0 ? macroDirectionSeries[macroDirectionSeries.length - 1] : undefined;
          const atr5mSeries = wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M);
          const atr5mLast = atr5mSeries.length > 0 ? atr5mSeries[atr5mSeries.length - 1] : undefined;
          const atr5m = atr5mLast !== undefined && !Number.isNaN(atr5mLast) ? atr5mLast : undefined;

          capturedOpens.push({
            symbol: e.symbol,
            entryTimestamp: e.entryTimestamp,
            setupType: e.setupType,
            entryPrice: e.entryPrice,
            slPrice: e.slPrice,
            tpPrice: e.tpLevels.length > 0 && e.tpLevels[0].price !== null ? e.tpLevels[0].price : undefined,
            adx1h: e.adx1h,
            atrPercentile5m: e.atrPercentile5m,
            momentumScore: e.momentumScore,
            correlatedRiskRatio,
            macroDirection: macroDirection === 'UP' || macroDirection === 'DOWN' || macroDirection === 'FLAT' ? macroDirection : undefined,
            atr5m,
          });
        }
      }
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — capturedOpens=${capturedOpens.length}, balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong simulation. Tổng số OPEN events bắt được (mọi symbol): ${capturedOpens.length}`);

  // ---- Load source CSV, match each row to its captured OPEN by symbol + entryTimestamp (exact). ----
  const sourcePath = path.resolve(process.cwd(), 'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv');
  const sourceLines = readFileSync(sourcePath, 'utf-8').trim().split('\n');
  const header = sourceLines[0];
  const originalColumns = header.split(',');
  const dataLines = sourceLines.slice(1);

  const opensByKey = new Map<string, CapturedOpen>();
  for (const o of capturedOpens) {
    const key = `${o.symbol}|${o.entryTimestamp}`;
    // Multiple entries could theoretically share the same symbol+entryTimestamp (maxConcurrentPositionsPerSymbol=2);
    // keep the first, and only warn if duplicates ever collide (checked below via unmatchedRows/ambiguity is not expected
    // since two positions opened in the exact same 5m step for the same symbol is astronomically unlikely given routeEntry()'s
    // single-candidate-per-step design, but tracked defensively).
    if (!opensByKey.has(key)) opensByKey.set(key, o);
  }

  const unmatchedRows: string[] = [];
  const enrichedRows: string[] = [];
  let obCount = 0;
  let obWithSlAtrCount = 0;
  let mdCount = 0;
  let mdWithSlPctCount = 0;
  let mdWithTpPctCount = 0;
  let adx1hCount = 0;
  let atrPercentile5mCount = 0;
  let correlatedRiskRatioCount = 0;
  let momentumScoreCount = 0;
  let macroDirectionCount = 0;

  for (const line of dataLines) {
    const cols = line.split(',');
    const rowObj: Record<string, string> = {};
    originalColumns.forEach((c, i) => (rowObj[c] = cols[i]));
    const symbol = rowObj['symbol'];
    const entryTimestamp = rowObj['entryTimestamp'];
    const setupType = rowObj['setupType'];
    const entryPrice = Number(rowObj['entryPrice']);
    const key = `${symbol}|${entryTimestamp}`;
    const matched = opensByKey.get(key);

    if (!matched) {
      unmatchedRows.push(line);
      continue;
    }

    const adx1h = matched.adx1h !== undefined ? String(matched.adx1h) : '';
    const atrPercentile5m = matched.atrPercentile5m !== undefined ? String(matched.atrPercentile5m) : '';
    const correlatedRiskRatio = matched.correlatedRiskRatio !== undefined ? String(matched.correlatedRiskRatio) : '';
    const momentumScore = matched.momentumScore !== undefined ? String(matched.momentumScore) : '';
    const macroDirection = matched.macroDirection ?? '';

    let obSlAtrMultiple = '';
    if (setupType === 'OB') {
      obCount++;
      if (matched.atr5m !== undefined && matched.atr5m > 0) {
        obSlAtrMultiple = String(Math.abs(entryPrice - matched.slPrice) / matched.atr5m);
        obWithSlAtrCount++;
      }
    }

    let momentumDirectSlPct = '';
    let momentumDirectTpPct = '';
    if (setupType === 'MOMENTUM_DIRECT') {
      mdCount++;
      momentumDirectSlPct = String((Math.abs(entryPrice - matched.slPrice) / entryPrice) * 100);
      mdWithSlPctCount++;
      if (matched.tpPrice !== undefined) {
        momentumDirectTpPct = String((Math.abs(entryPrice - matched.tpPrice) / entryPrice) * 100);
        mdWithTpPctCount++;
      }
    }

    if (adx1h !== '') adx1hCount++;
    if (atrPercentile5m !== '') atrPercentile5mCount++;
    if (correlatedRiskRatio !== '') correlatedRiskRatioCount++;
    if (momentumScore !== '') momentumScoreCount++;
    if (macroDirection !== '') macroDirectionCount++;

    enrichedRows.push([line, adx1h, atrPercentile5m, correlatedRiskRatio, momentumScore, macroDirection, obSlAtrMultiple, momentumDirectSlPct, momentumDirectTpPct].join(','));
  }

  if (unmatchedRows.length > 0) {
    console.error(`\nLỖI: ${unmatchedRows.length} / ${dataLines.length} dòng KHÔNG khớp được với bất kỳ OpenTradeEvent nào đã capture (symbol+entryTimestamp):`);
    for (const l of unmatchedRows) console.error(`  ${l}`);
    console.error('\nDừng lại — không ghi file output với dòng chưa khớp/đoán mò.');
    process.exit(1);
  }

  const outHeader = header + ',adx1h,atrPercentile5m,correlatedRiskRatio,momentumScore,macroDirection,obSlAtrMultiple,momentumDirectSlPct,momentumDirectTpPct';
  const outPath = path.resolve(process.cwd(), 'data/backtest-trades-enriched-with-indicators.csv');
  writeFileSync(outPath, [outHeader, ...enrichedRows].join('\n') + '\n');

  console.log(`\n→ ${outPath}`);
  console.log(`Tổng số dòng: ${enrichedRows.length} (khớp 100% với ${dataLines.length} dòng nguồn)`);
  console.log(`adx1h: ${adx1hCount}/${enrichedRows.length} có giá trị`);
  console.log(`atrPercentile5m: ${atrPercentile5mCount}/${enrichedRows.length} có giá trị`);
  console.log(`correlatedRiskRatio: ${correlatedRiskRatioCount}/${enrichedRows.length} có giá trị`);
  console.log(`momentumScore: ${momentumScoreCount}/${enrichedRows.length} có giá trị`);
  console.log(`macroDirection: ${macroDirectionCount}/${enrichedRows.length} có giá trị`);
  console.log(`OB rows: ${obCount}, obSlAtrMultiple filled: ${obWithSlAtrCount}/${obCount}`);
  console.log(`MOMENTUM_DIRECT rows: ${mdCount}, momentumDirectSlPct filled: ${mdWithSlPctCount}/${mdCount}, momentumDirectTpPct filled: ${mdWithTpPctCount}/${mdCount}`);
}

main().catch((err) => {
  console.error('ticket108EnrichTradesWithIndicators failed:', err);
  process.exit(1);
});
