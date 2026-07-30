/**
 * TICKET-109 — DATA EXPORT ONLY, not part of the official backtest/live pipeline. TICKET-108 computed
 * AUC on the 258 real trades that PASSED the AI momentum gate — a truncated/restricted score range,
 * since only candidates that scored >= threshold ever became real trades. This script exports the
 * FULL score distribution: every momentum-gate candidate EVALUATED during the official 258-trade
 * backtest replay, both PASSED (became a real trade, or was later rejected downstream by Risk
 * Pool/margin cap) and REJECTED (scored below threshold, never became a trade). PM computes AUC
 * themselves from the output CSV — this script does not compute or report AUC, nor draw any
 * conclusion about model quality.
 *
 * Re-runs the EXACT official 12-flag backtest replay — same code path, same config, same
 * windowing/loop structure as ticket108EnrichTradesWithIndicators.ts (itself copied verbatim from
 * backtest.ts's established no-look-ahead simulation pattern).
 *
 * Uses orchestrator.ts's new (TICKET-109) diagnostic-only onMomentumGateEvaluation callback — fires
 * for EVERY momentum-gate score computed (tryMomentumDirect()'s LONG+SHORT scoring, and the
 * NEUTRAL_TRANSITION regime's own mandatory momentum gate), passed and rejected alike. Pure
 * pass-through, never changes any decision — see MomentumGateEvaluation's own doc comment in
 * orchestrator.ts. NOTE: under this exact official config, neutralTransitionGateConfig.
 * neutralTransitionTradingEnabled=false, so the NEUTRAL_TRANSITION gate returns before ever computing
 * a score — this replay's evaluations are therefore ALL gateType='MOMENTUM_DIRECT' (confirmed by the
 * source CSV itself: 0 of the 258 real trades have regime=NEUTRAL_TRANSITION with a non-MOMENTUM_DIRECT
 * setupType). The NEUTRAL_TRANSITION branch below is still implemented generically (for correctness
 * and in case a future config re-enables it) but is inert for this specific run.
 *
 * For REJECTED (passed=false) and PASSED-but-not-a-real-trade candidates (gate passed, but a later
 * check — Risk Pool / max-total-margin — still rejected it before it became a real trade), the
 * hypothetical outcome is simulated by forward-walking REAL subsequent 5m candles with orchestrator.
 * ts's own advancePosition() (PLAN_A/PLAN_B or COUNTER_TREND, matching whichever scenario the real
 * setup would have used), reusing openPosition()/computeRealizedPnl() from slTpManager.ts — the exact
 * "parallel shadow simulation" mechanism TICKET-045's simulateMssTimeoutOutcomes.ts already
 * established (copied/adapted here, not re-derived). Simulated PnL uses a FIXED notional position
 * size (same convention as TICKET-045/TICKET-019's shadow simulations) since these candidates never
 * went through DynamicRMarginSizer — pnlUsd for these rows is therefore NOT on the same dollar scale
 * as real trades' pnlUsd (which reflects real position sizing); win/loss (pnlUsd > 0) is what matters
 * for AUC and is invariant to this choice (computeRealizedPnl's gross P&L and fee both scale linearly
 * with positionSize, no constant term).
 *
 * For PASSED (passed=true) candidates that DID become a real trade: matched by symbol+timestamp+side
 * against data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv, using its REAL
 * recorded pnlUsd/win (win = pnlUsd > 0) — never re-simulated.
 *
 * Run: npx tsx apps/bot/scripts/ticket109ExportAllCandidatesWithOutcomes.ts (from repo root)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CandleData } from '../dist/regime/types.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { advancePosition, processCandle, selectTpPlan, type MomentumGateEvaluation, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OpenTradeEvent, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { computeRealizedPnl, openPosition, priceAtR, type ManagedPositionState, type SlTpManagerInput } from '../dist/risk/slTpManager.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');

// Same bounded sliding windows as backtest.ts / ticket108's own copy.
const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

// EXACT official 12-flag command that produced the 258-trade CSV (byte-identical to ticket108's own
// CONFIG — see that script's own comment for the full flag list).
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

// Shadow-simulation constants — TICKET-045 precedent (simulateMssTimeoutOutcomes.ts).
const FIXED_POSITION_SIZE = 1000;
const TAKER_FEE_RATE = CONFIG.takerFeeRate;

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

interface CapturedEvaluation extends MomentumGateEvaluation {
  /** Index into this symbol's FULL (unwindowed) candles5m array — where the forward shadow walk starts. */
  step: number;
}

/** Adapted from simulateMssTimeoutOutcomes.ts's simulateShadowTrade (TICKET-045) — same mechanism,
 * generalized to accept either scenario (COUNTER_TREND for MOMENTUM_DIRECT, TREND for NEUTRAL_TRANSITION-
 * gated OB/FVG/BOX_BREAKOUT/SWEEP). `null` if the available history runs out before the position resolves. */
function simulateShadowTrade(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  slPrice: number,
  candles5m: CandleData[],
  entryStepIndex: number,
  scenarioInput: { scenario: 'TREND' | 'COUNTER_TREND'; tpPlan: 'PLAN_A' | 'PLAN_B'; tpPriceOverride?: number },
): { win: boolean; pnlUsd: number } | null {
  const openInput: SlTpManagerInput = {
    scenario: scenarioInput.scenario,
    entryPrice,
    slPrice,
    side,
    tpPlan: scenarioInput.tpPlan,
    tpPriceOverride: scenarioInput.tpPriceOverride,
    positionSize: FIXED_POSITION_SIZE,
    takerFeeRate: TAKER_FEE_RATE,
  };
  let pos: ManagedPositionState = openPosition(openInput);

  for (let j = entryStepIndex + 1; j < candles5m.length; j++) {
    const candle = candles5m[j];
    const atrWindow = candles5m.slice(Math.max(0, j - WINDOW_5M + 1), j + 1);
    const { position, exitReason: _exitReason, exitPrice } = advancePosition(pos, candle, atrWindow, CONFIG.isLowConfidenceOrLowLiquidity);
    pos = position;
    if (pos.closed) {
      const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
      return { win: pnlUsd > 0, pnlUsd };
    }
  }
  return null; // ran out of future data before closing
}

interface OutputRow {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  setupType: string;
  momentumScore: number;
  passed: boolean;
  win: boolean | null; // null = could not be resolved (ran out of future data)
  pnlUsd: number | null;
}

async function main(): Promise<void> {
  console.log('TICKET-109 — Export ALL momentum-gate candidates (passed + rejected) with outcomes');
  console.log('Đọc CSV (5m/15m/1h/1m/1d x 4 coin)...');

  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  console.log(`Chạy ${totalSteps - startStep} bước x ${SYMBOLS.length} coin (từ nến 5m #${startStep})...`);

  const allEvaluations: CapturedEvaluation[] = [];
  const capturedOpens: Array<{ symbol: string; entryTimestamp: number; side: 'LONG' | 'SHORT'; setupType: string }> = [];
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
        allEvaluations.push({ ...evaluation, step });
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
          capturedOpens.push({ symbol: e.symbol, entryTimestamp: e.entryTimestamp, side: e.side, setupType: e.setupType });
        }
      }
    }

    const progressStep = step - startStep;
    if (progressStep % 2000 === 0) {
      console.log(`  bước ${progressStep}/${totalSteps - startStep} — evaluations=${allEvaluations.length}, balance=$${accountBalance.toFixed(2)}...`);
    }
  }

  console.log(`Xong simulation. Tổng số momentum-gate evaluations bắt được: ${allEvaluations.length}`);
  console.log(`Tổng số OPEN events (real trades) bắt được: ${capturedOpens.length}`);

  // ---- Sanity check: real-trade OPEN events captured here should match the official 258-trade CSV. ----
  const baselinePath = path.resolve(process.cwd(), 'data/backtest-trades-baseline-planauto-maxpos2-momentumdirect-correlated.csv');
  const baselineLines = readFileSync(baselinePath, 'utf-8').trim().split('\n');
  const baselineHeader = baselineLines[0].split(',');
  const baselineRows = baselineLines.slice(1).map((line) => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    baselineHeader.forEach((c, i) => (row[c] = cols[i]));
    return row;
  });
  console.log(`Baseline CSV: ${baselineRows.length} dòng.`);
  if (capturedOpens.length !== baselineRows.length) {
    console.warn(`CẢNH BÁO: số OPEN events replay (${capturedOpens.length}) KHÁC số dòng baseline CSV (${baselineRows.length}) — kiểm tra lại config trước khi tin tưởng kết quả.`);
  }

  const baselineByKey = new Map<string, { pnlUsd: number; win: boolean }>();
  for (const row of baselineRows) {
    const key = `${row['symbol']}|${row['entryTimestamp']}|${row['side']}`;
    const pnlUsd = Number(row['pnlUsd']);
    baselineByKey.set(key, { pnlUsd, win: pnlUsd > 0 });
  }

  // ---- Reconciliation: how many passed=true evaluations became a real trade vs. were rejected downstream. ----
  const passedEvaluations = allEvaluations.filter((e) => e.passed);
  const rejectedEvaluations = allEvaluations.filter((e) => !e.passed);
  let matchedToRealTrade = 0;
  let passedButRejectedDownstream = 0;
  let unresolvedFutureData = 0;

  const outputRows: OutputRow[] = [];

  for (const e of allEvaluations) {
    const key = `${e.symbol}|${e.timestamp}|${e.side}`;

    if (e.passed) {
      const matched = baselineByKey.get(key);
      if (matched) {
        matchedToRealTrade++;
        outputRows.push({ symbol: e.symbol, timestamp: e.timestamp, side: e.side, setupType: e.setupType, momentumScore: e.score, passed: true, win: matched.win, pnlUsd: matched.pnlUsd });
        continue;
      }
      // Gate passed but never became a real trade (Risk Pool / max-total-margin rejected it
      // downstream) — simulate exactly like a rejected candidate, per the ticket's own resolution.
      passedButRejectedDownstream++;
    }

    // Rejected (or passed-but-rejected-downstream): simulate the hypothetical outcome.
    const sd = symbolsData[e.symbol];
    const scenarioInput: { scenario: 'TREND' | 'COUNTER_TREND'; tpPlan: 'PLAN_A' | 'PLAN_B'; tpPriceOverride?: number } =
      e.gateType === 'MOMENTUM_DIRECT'
        ? {
            scenario: 'COUNTER_TREND',
            tpPlan: CONFIG.tpPlan,
            // Same formula tryMomentumDirect() itself uses (reused via slTpManager.ts's own priceAtR export).
            tpPriceOverride: priceAtR(e.entryPriceCandidate, Math.abs(e.entryPriceCandidate - e.slPriceCandidate), CONFIG.momentumDirectTpRMultiple, e.side),
          }
        : { scenario: 'TREND', tpPlan: selectTpPlan(CONFIG.tpPlan, e.score, CONFIG.planAutoSelectionConfig) };

    const shadow = simulateShadowTrade(e.side, e.entryPriceCandidate, e.slPriceCandidate, sd.candles5m, e.step, scenarioInput);
    if (shadow === null) {
      unresolvedFutureData++;
      outputRows.push({ symbol: e.symbol, timestamp: e.timestamp, side: e.side, setupType: e.setupType, momentumScore: e.score, passed: e.passed, win: null, pnlUsd: null });
    } else {
      outputRows.push({ symbol: e.symbol, timestamp: e.timestamp, side: e.side, setupType: e.setupType, momentumScore: e.score, passed: e.passed, win: shadow.win, pnlUsd: shadow.pnlUsd });
    }
  }

  // ---- Write output CSV. ----
  const outPath = path.resolve(process.cwd(), 'data/all-candidates-with-outcomes.csv');
  const header = 'symbol,timestamp,side,setupType,momentumScore,passed,win,pnlUsd';
  const lines = outputRows.map((r) => [r.symbol, r.timestamp, r.side, r.setupType, r.momentumScore, r.passed, r.win === null ? '' : r.win, r.pnlUsd === null ? '' : r.pnlUsd].join(','));
  writeFileSync(outPath, [header, ...lines].join('\n') + '\n');

  console.log(`\n→ ${outPath}`);
  console.log(`Tổng số dòng: ${outputRows.length}`);
  console.log(`  passed=true: ${passedEvaluations.length}`);
  console.log(`  passed=false: ${rejectedEvaluations.length}`);
  console.log(`Đối chiếu passed=true:`);
  console.log(`  → khớp được với 1 lệnh thật trong baseline CSV: ${matchedToRealTrade}`);
  console.log(`  → PASS gate nhưng KHÔNG thành lệnh thật (bị Risk Pool/max-total-margin từ chối sau đó) — được mô phỏng như candidate bị từ chối: ${passedButRejectedDownstream}`);
  console.log(`  → tổng baseline CSV (258 lệnh thật, mọi setupType): ${baselineRows.length}`);
  console.log(`  → trong đó setupType=MOMENTUM_DIRECT (đường duy nhất còn hoạt động dưới config chính thức này, xem comment đầu file): ${baselineRows.filter((r) => r['setupType'] === 'MOMENTUM_DIRECT').length}`);
  console.log(`Không mô phỏng được (hết dữ liệu tương lai để đóng lệnh): ${unresolvedFutureData}`);
}

main().catch((err) => {
  console.error('ticket109ExportAllCandidatesWithOutcomes failed:', err);
  process.exit(1);
});
