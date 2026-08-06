/**
 * TICKET-142A (supplement) — "Chế độ B" hypothetical audit: same Mode A candidate-level offline
 * outcome methodology (see ticket142aMomentumCandidateOutcome.ts's header doc comment — identical
 * technique, not re-explained here), but the candidate set ALSO includes unique candidates that were
 * blocked ONLY by the macro_conflict hard-block (thesisState==='WEAK', invalidReason==='macro_conflict').
 *
 * Verified first (see data/ticket142a-macro-conflict-audit-comparison.md §1): of 434 unique
 * (isNewEvent) candidates in the T142A integrity CSV, 227 are VALID and 207 are WEAK — and ALL 207
 * WEAK candidates have invalidReason==='macro_conflict' (100%, no other WEAK reason exists in this
 * baseline run). So Chế độ B's candidate set = all 434 unique candidates.
 *
 * Does NOT modify momentumThesis.ts/orchestrator.ts. For macro_conflict candidates,
 * momentumThesis.ts's real gate short-circuits BEFORE computing entry/SL/TP (returns null for all
 * three — see its lines ~344-347), because macroConflictRiskMultiplier only affects position-SIZING,
 * never the entry/SL/TP price formula itself. So this script recomputes entry/SL/TP for those
 * candidates ONLY, using a verbatim replica of momentumThesis.ts's private computeMomentumSlPrice()
 * + the same exported priceAtR() — same formula, same inputs (currentCandle/atr/side), just not
 * short-circuited. This is read-only post-hoc reconstruction, not a production behavior change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketRegime, type CandleData } from '../dist/regime/types.js';
import { computeCorrelatedRiskRatio } from '../dist/regime/correlatedRisk.js';
import { RegimeConfig } from '../dist/regime/config.js';
import { lastDefined, wilderATRSeries } from '../dist/regime/indicators.js';
import { EntryConfig } from '../dist/entry/config.js';
import { processCandle, advancePosition, type ProcessCandleInput } from '../dist/orchestrator/orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from '../dist/orchestrator/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../dist/entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../dist/xgbFilter/config.js';
import { openPosition, computeRealizedPnl, priceAtR, type ManagedPositionState } from '../dist/risk/slTpManager.js';
import type { OpenPositionRisk } from '../dist/risk/riskPool.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const OHLCV_DIR = path.resolve(process.cwd(), 'data/ohlcv');
const OUT_CSV = path.resolve(process.cwd(), 'data/ticket142a-momentum-candidate-outcome-macroauditB.csv');
const OUT_MD = path.resolve(process.cwd(), 'data/ticket142a-momentum-candidate-outcome-macroauditB.md');

const WINDOW_5M = 320;
const WINDOW_15M = 325;
const WINDOW_1H = 40;
const WINDOW_1M = 200;
const WINDOW_1D = 40;
const WINDOW_1H_MOMENTUM = 500;
const WINDOW_5M_SESSION_VOLUME = 14 * 288 + 1;

const POSITION_SIZE_USD = 1000; // Same JUDGMENT CALL as Mode A — identical methodology, kept identical.
const TAKER_FEE_RATE = 0.0004;

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

// ---- Official baseline config (project_official_backtest_config.md's 8-flag command) + momentumCandidateIntegrityEnabled=true ----
// Identical to Mode A's config — NOT modified for this audit (macro hard-block stays ON in the real
// pipeline; only the CANDIDATE SET captured below differs).
const config: OrchestratorConfig = {
  entryRouterConfig: {
    ...DEFAULT_ENTRY_ROUTER_CONFIG,
    entryStyleForNeutral: 'SIDEWAY_STYLE',
    macroTrendFilterEnabled: false,
    obDisabledSymbols: [],
    macroTrendFilterAppliesToBoxBreakout: false,
    mssStalenessToleranceCandles: 5,
    obBosLookforwardK: 10,
    obSlBufferAtrMultiplier: 0.87,
  },
  tpPlan: 'PLAN_A',
  takerFeeRate: TAKER_FEE_RATE,
  riskDollarOrPercent: 15,
  maxMarginCap: 37.5,
  leverage: 30,
  riskPoolMaxPct: 15 / 100,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: { ...DEFAULT_MOMENTUM_FILTER_CONFIG },
  neutralTransitionGateConfig: { ...DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG },
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
  oodGuardConfig: {
    emaRatioSlowThreshold: 1.037776,
    mode: 'RISK_REDUCTION',
    scoreCapValue: 0,
    riskReductionMultiplier: 0.3,
  },
  momentumCandidateIntegrityEnabled: true,
};
const SKIP_DAYS = 20;

// Verbatim replica of momentumThesis.ts's private computeMomentumSlPrice() — same formula, needed
// here ONLY to reconstruct entry/SL/TP for macro_conflict candidates where the real gate short-
// circuited before computing them (see file header doc comment).
function computeMomentumSlPriceReplica(side: 'LONG' | 'SHORT', entryPrice: number, currentCandle: CandleData, atr: number, minSlPercent: number): number {
  const rawSlPrice = side === 'LONG' ? currentCandle.low : currentCandle.high;
  const buffer = EntryConfig.SL_BUFFER_ATR_MULTIPLIER * atr;
  let slPrice = side === 'LONG' ? rawSlPrice - buffer : rawSlPrice + buffer;
  const rawSlDistancePercent = (Math.abs(entryPrice - slPrice) / entryPrice) * 100;
  if (rawSlDistancePercent < minSlPercent) {
    const flooredDistance = (minSlPercent / 100) * entryPrice;
    slPrice = side === 'LONG' ? entryPrice - flooredDistance : entryPrice + flooredDistance;
  }
  return slPrice;
}

interface CapturedCandidate {
  symbol: string;
  timestamp: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  slPrice: number;
  tpPriceOverride: number;
  momentumScore: number;
  htfContext: string;
  safetyState5m: string;
  thesisState: 'VALID' | 'WEAK';
  invalidReason: string | null;
}

interface SimResult extends CapturedCandidate {
  exitReason: string | null;
  exitPrice: number | null;
  exitTimestamp: number | null;
  pnlUsd: number | null;
  outcome: 'RESOLVED_WIN' | 'RESOLVED_LOSS' | 'UNRESOLVED';
}

async function main(): Promise<void> {
  console.log('Đọc CSV OHLCV (5m/15m/1h/1m/1d x 4 coin)...');
  const symbolsData: Record<string, SymbolData> = {};
  for (const symbol of SYMBOLS) symbolsData[symbol] = loadSymbolData(symbol);

  // ---- Phase 1: replay official baseline (macro hard-block INTACT, unchanged), capture unique
  // VALID candidates AND unique WEAK/macro_conflict candidates (Chế độ B's audit set). ----
  const captured: CapturedCandidate[] = [];

  const rawTotalSteps = Math.min(...SYMBOLS.map((s) => symbolsData[s].candles5m.length));
  const warmupStartStep = Math.max(WINDOW_5M - 1, WINDOW_15M * 3, WINDOW_1H * 12) + 5 + SKIP_DAYS * 288;
  const startStep = warmupStartStep;
  const totalSteps = rawTotalSteps;

  let accountBalance = 100; // matches --start-balance=100
  console.log(`Chạy lại pipeline thật (official baseline config) — ${totalSteps - startStep} bước x ${SYMBOLS.length} coin...`);

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
      symbolsData[symbol].state.openPositions.filter((entry) => entry.meta.setupType === 'MOMENTUM_DIRECT').map((entry) => ({ symbol, side: entry.position.side })),
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

      const allOpenPositionsRisk: OpenPositionRisk[] = SYMBOLS.filter((s) => openRiskBySymbol[s] !== undefined).map((s) => ({ id: s, actualRiskDollar: openRiskBySymbol[s] }));
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

      const result = await processCandle(input, sd.state, config);
      sd.state = result.symbolState;
      accountBalance = result.accountBalance;

      const diag = sd.state.momentumCandidateIntegrityDiagnostic?.lastResult;
      if (diag && diag.isNewEvent && diag.side !== 'NONE' && diag.momentumScore !== null) {
        const isValid = diag.thesisState === 'VALID';
        const isMacroConflictWeak = diag.thesisState === 'WEAK' && diag.invalidReason === 'macro_conflict';
        if (isValid || isMacroConflictWeak) {
          let entryPrice: number;
          let slPrice: number;
          let tpPriceOverride: number;
          if (isValid && diag.entryPrice !== null && diag.stopLoss !== null && diag.tpPriceOverride !== null) {
            entryPrice = diag.entryPrice;
            slPrice = diag.stopLoss;
            tpPriceOverride = diag.tpPriceOverride;
          } else {
            // macro_conflict WEAK — real gate short-circuited before computing entry/SL/TP;
            // reconstruct with the identical formula (independent of macroDirection — see header).
            const atr = lastDefined(wilderATRSeries(window5m, RegimeConfig.ATR_PERIOD_5M));
            if (atr === undefined) continue; // same atr_undefined fallthrough the real gate would hit
            entryPrice = currentCandle.close;
            slPrice = computeMomentumSlPriceReplica(diag.side, entryPrice, currentCandle, atr, config.momentumDirectMinSlPercent);
            const r = Math.abs(entryPrice - slPrice);
            tpPriceOverride = priceAtR(entryPrice, r, config.momentumDirectTpRMultiple, diag.side);
          }
          captured.push({
            symbol: diag.symbol,
            timestamp: diag.timestamp,
            side: diag.side,
            entryPrice,
            slPrice,
            tpPriceOverride,
            momentumScore: diag.momentumScore,
            htfContext: diag.htfContext,
            safetyState5m: diag.safetyState5m,
            thesisState: isValid ? 'VALID' : 'WEAK',
            invalidReason: diag.invalidReason,
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
  }

  const validCount = captured.filter((c) => c.thesisState === 'VALID').length;
  const macroConflictCount = captured.filter((c) => c.thesisState === 'WEAK').length;
  console.log(`Bắt được ${captured.length} unique candidate (Chế độ B): ${validCount} VALID + ${macroConflictCount} WEAK/macro_conflict.`);

  // ---- Phase 2: isolated per-candidate forward simulation (real slTpManager.ts + advancePosition()) ----
  // Identical to Mode A's Phase 2 — same production functions, same $1000 fixed notional.
  const results: SimResult[] = [];
  for (const cand of captured) {
    const sd = symbolsData[cand.symbol];
    const entryStep = sd.candles5m.findIndex((c) => c.timestamp === cand.timestamp);
    if (entryStep === -1) {
      results.push({ ...cand, exitReason: null, exitPrice: null, exitTimestamp: null, pnlUsd: null, outcome: 'UNRESOLVED' });
      continue;
    }

    let pos: ManagedPositionState;
    try {
      pos = openPosition({
        scenario: 'COUNTER_TREND',
        entryPrice: cand.entryPrice,
        slPrice: cand.slPrice,
        side: cand.side,
        tpPlan: config.tpPlan, // ignored by computeTpLevels() for COUNTER_TREND
        tpPriceOverride: cand.tpPriceOverride,
        positionSize: POSITION_SIZE_USD,
        takerFeeRate: TAKER_FEE_RATE,
      });
    } catch (e) {
      console.error(`openPosition() lỗi cho ${cand.symbol}@${cand.timestamp}:`, (e as Error).message);
      results.push({ ...cand, exitReason: null, exitPrice: null, exitTimestamp: null, pnlUsd: null, outcome: 'UNRESOLVED' });
      continue;
    }

    let resolved = false;
    let exitReason: string | null = null;
    let exitPrice: number | null = null;
    let exitTimestamp: number | null = null;
    for (let step = entryStep + 1; step < sd.candles5m.length; step++) {
      const candle = sd.candles5m[step];
      const window5m = sd.candles5m.slice(Math.max(0, step - WINDOW_5M + 1), step + 1);
      const { position, exitReason: er, exitPrice: ep } = advancePosition(pos, candle, window5m, config.isLowConfidenceOrLowLiquidity);
      pos = position;
      if (pos.closed) {
        resolved = true;
        exitReason = er;
        exitPrice = ep;
        exitTimestamp = candle.timestamp;
        break;
      }
    }

    if (!resolved) {
      results.push({ ...cand, exitReason: null, exitPrice: null, exitTimestamp: null, pnlUsd: null, outcome: 'UNRESOLVED' });
      continue;
    }
    const pnlUsd = computeRealizedPnl(pos, exitPrice as number);
    results.push({ ...cand, exitReason, exitPrice, exitTimestamp, pnlUsd, outcome: pnlUsd > 0 ? 'RESOLVED_WIN' : 'RESOLVED_LOSS' });
  }

  const unresolvedCount = results.filter((r) => r.outcome === 'UNRESOLVED').length;
  console.log(`Mô phỏng xong: ${results.length} candidate, ${unresolvedCount} UNRESOLVED.`);

  writeFileSync(OUT_CSV, toCsv(results));
  console.log(`→ ${OUT_CSV}`);
  writeFileSync(OUT_MD, buildReport(results));
  console.log(`→ ${OUT_MD}`);
}

function toCsv(results: SimResult[]): string {
  const header = 'symbol,timestamp,side,entryPrice,slPrice,tpPriceOverride,momentumScore,htfContext,safetyState5m,thesisState,invalidReason,exitReason,exitPrice,exitTimestamp,pnlUsd,outcome';
  const rows = results.map((r) =>
    [
      r.symbol,
      r.timestamp,
      r.side,
      r.entryPrice,
      r.slPrice,
      r.tpPriceOverride,
      r.momentumScore,
      r.htfContext,
      r.safetyState5m,
      r.thesisState,
      r.invalidReason ?? '',
      r.exitReason ?? '',
      r.exitPrice ?? '',
      r.exitTimestamp ?? '',
      r.pnlUsd ?? '',
      r.outcome,
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

// Same MaxDD JUDGMENT CALL as Mode A — cumulative-PnL curve in ENTRY-timestamp order, peak-to-trough.
function computeStats(resolved: SimResult[]): { trades: number; wr: string; pf: string; netPnl: string; maxDd: string } {
  const trades = resolved.length;
  const wins = resolved.filter((r) => (r.pnlUsd ?? 0) > 0);
  const losses = resolved.filter((r) => (r.pnlUsd ?? 0) <= 0);
  const grossWin = wins.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + (r.pnlUsd ?? 0), 0));
  const netPnl = grossWin - grossLoss;
  const pf = grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss;
  const wr = trades === 0 ? 0 : (wins.length / trades) * 100;

  const sorted = [...resolved].sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of sorted) {
    cum += r.pnlUsd ?? 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return { trades, wr: `${wr.toFixed(1)}%`, pf: pf === Infinity ? '∞' : pf.toFixed(3), netPnl: `$${netPnl.toFixed(2)}`, maxDd: `-$${maxDd.toFixed(2)}` };
}

function buildReport(results: SimResult[]): string {
  const resolved = results.filter((r) => r.outcome !== 'UNRESOLVED');
  const lines: string[] = [
    '# TICKET-142A (supplement) — Chế độ B (hypothetical macro-conflict-removed audit) Outcome Simulation',
    '',
    'CHỈ ĐỂ AUDIT — không phản ánh production thật, không đề xuất sửa production. Xem data/ticket142a-macro-conflict-audit-comparison.md để so sánh với Chế độ A.',
    '',
    `Tổng candidate (unique VALID + unique WEAK/macro_conflict, sau dedup): ${results.length}. Resolved: ${resolved.length}. Unresolved: ${results.length - resolved.length}.`,
    `positionSize=$${POSITION_SIZE_USD} cố định/candidate (JUDGMENT CALL — không risk pool, giống hệt Mode A), takerFeeRate=${TAKER_FEE_RATE}, scenario=COUNTER_TREND (đúng MOMENTUM_DIRECT thật).`,
    '',
    '## Chế độ B — tổng quan',
    '',
    '| Mode | Trades | WR | PF | Net PnL | Max DD |',
    '|---|---|---|---|---|---|',
  ];
  const overall = computeStats(resolved);
  lines.push(`| Chế độ B (macro-conflict-removed, all) | ${overall.trades} | ${overall.wr} | ${overall.pf} | ${overall.netPnl} | ${overall.maxDd} |`);
  lines.push('');

  lines.push('## Theo LONG/SHORT', '', '| Side | Trades | WR | PF | Net PnL | Max DD |', '|---|---|---|---|---|---|');
  for (const side of ['LONG', 'SHORT'] as const) {
    const s = computeStats(resolved.filter((r) => r.side === side));
    lines.push(`| ${side} | ${s.trades} | ${s.wr} | ${s.pf} | ${s.netPnl} | ${s.maxDd} |`);
  }
  lines.push('');

  const symbols = Array.from(new Set(resolved.map((r) => r.symbol))).sort();
  lines.push('## Theo coin', '', '| Coin | Trades | WR | PF | Net PnL | Max DD |', '|---|---|---|---|---|---|');
  for (const sym of symbols) {
    const s = computeStats(resolved.filter((r) => r.symbol === sym));
    lines.push(`| ${sym} | ${s.trades} | ${s.wr} | ${s.pf} | ${s.netPnl} | ${s.maxDd} |`);
  }
  lines.push('');

  const htfContexts = Array.from(new Set(resolved.map((r) => r.htfContext))).sort();
  lines.push('## Theo HTFContext', '', '| HTFContext | Trades | WR | PF | Net PnL | Max DD |', '|---|---|---|---|---|---|');
  for (const ctx of htfContexts) {
    const s = computeStats(resolved.filter((r) => r.htfContext === ctx));
    lines.push(`| ${ctx} | ${s.trades} | ${s.wr} | ${s.pf} | ${s.netPnl} | ${s.maxDd} |`);
  }
  lines.push('');

  const safetyStates = Array.from(new Set(resolved.map((r) => r.safetyState5m))).sort();
  lines.push('## Theo SafetyState5m', '', '| SafetyState5m | Trades | WR | PF | Net PnL | Max DD |', '|---|---|---|---|---|---|');
  for (const st of safetyStates) {
    const s = computeStats(resolved.filter((r) => r.safetyState5m === st));
    lines.push(`| ${st} | ${s.trades} | ${s.wr} | ${s.pf} | ${s.netPnl} | ${s.maxDd} |`);
  }
  lines.push('');

  const sortedByTime = [...resolved].sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  const third = Math.ceil(sortedByTime.length / 3);
  const phases = [sortedByTime.slice(0, third), sortedByTime.slice(third, third * 2), sortedByTime.slice(third * 2)];
  lines.push('## 3 giai đoạn thời gian (số candidate gần bằng nhau)', '', '| Giai đoạn | Trades | WR | PF | Net PnL | Max DD |', '|---|---|---|---|---|---|');
  phases.forEach((phase, i) => {
    const s = computeStats(phase);
    lines.push(`| Giai đoạn ${i + 1} | ${s.trades} | ${s.wr} | ${s.pf} | ${s.netPnl} | ${s.maxDd} |`);
  });
  lines.push('');

  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error('ticket142aMomentumCandidateOutcomeNoMacroAudit failed:', err);
  process.exit(1);
});
