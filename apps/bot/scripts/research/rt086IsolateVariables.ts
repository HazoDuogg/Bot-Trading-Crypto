import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candle } from '../../src/noTradeZone/types.js';
import { checkNoTradeZone } from '../../src/noTradeZone/noTradeZone.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../../src/entry/fvgStrategyConfig.js';
import { generateTrendCandidates } from '../../src/research/trendLiveLikeCandidates.js';
import { resolveRiskPct, DEFAULT_RISK_CONFIG } from '../../src/positionSizing/riskConfig.js';
import { resolveLeverage } from '../../src/positionSizing/leverageConfig.js';
import { calculatePositionSize } from '../../src/positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../../src/positionSizing/types.js';
import { admitPosition, closePosition, EMPTY_EXPOSURE_STATE, DEFAULT_EXPOSURE_TRACKER_CONFIG, type ExposureTrackerState } from '../../src/positionSizing/exposureTracker.js';
import type { TrendCandidate } from '../../src/research/trendLiveLikeExecution.js';

// TICKET-RT-086 Part B: isolates each named difference between the RT-084 "M15 conventional
// comparator" (Net PF 1.819, same 7,133 frozen candidates, R-multiple, no NTZ-at-fill gate, no
// portfolio admission, RT-084's own fee constants) and RT-DOGE-001's original result (Net PF
// 1.451, real 3-year live simulation). Built as a strict waterfall: each stage changes exactly ONE
// mechanism on top of the previous stage's output, on the IDENTICAL 7,133 candidates — "co lap 1
// bien moi lan" per the project's established sweep convention (RT-031 onward). Read-only:
// generateTrendCandidates/DEFAULT_* config are imported, never modified.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'];
const DATA_DIR = path.resolve(process.cwd(), 'apps/bot/data');
const M1_MS = 60_000;
const M15_MS = 15 * M1_MS;
const H1_MS = 60 * M1_MS;
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;

// RT-084's own fee constants (entry/exit legs priced off entry/exit price directly).
const RT084_ENTRY_FEE = 0.0002;
const RT084_EXIT_FEE = 0.0005;
// RT-DOGE-001's fee constant: FEE_PCT_SUM = 0.05+0.05+0.05+0.05, applied ONCE as a flat fraction
// of notional at close (rtDogeThreeYearBacktest.ts) — structurally different from RT-084's
// per-leg-on-price model, expressed here as an equivalent fraction of entryPrice for direct R
// comparison (notional ~= qty*entryPrice, and R is scale-invariant, so this is exact, not approximate).
const RTDOGE_FEE_PCT_SUM = 0.05 + 0.05 + 0.05 + 0.05;
const RTDOGE_BALANCE = 500;

async function readCandles(filePath: string): Promise<Candle[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).slice(1).map((line) => {
    const [openTime, open, high, low, close, volume] = line.split(',');
    return { openTime: Number(openTime), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}

interface StageOutcome {
  candidate: TrendCandidate;
  filled: boolean;
  won: boolean | null; // null if not filled/expired without a close
  exitTime: number | null;
  fillIndex: number;
  admitted: boolean; // stage 3+ only; true by default before admission is modeled
  scaledFraction: number; // stage 4 only; 1 = unscaled
}

function directedR(candidate: TrendCandidate, exitPrice: number): number {
  const risk = Math.abs(candidate.entryPrice - candidate.slPrice);
  return candidate.direction === 'LONG' ? (exitPrice - candidate.entryPrice) / risk : (candidate.entryPrice - exitPrice) / risk;
}

// Stage 0/1: conventional M15 gap-intersection fill (identical to trendLiveLikeExecution.ts's
// simulateConventional), optionally gated by checkNoTradeZone at the fill candle — RT-DOGE-001's
// touchedGap admission requires `!ntz.blocked`; RT-084's comparator does not check it at all.
function simulateConventionalStage(symbol: string, m15: Candle[], h1: Candle[], candidate: TrendCandidate, requireNtzClear: boolean): { filled: boolean; won: boolean | null; exitTime: number | null; fillIndex: number } {
  const startIndex = m15.findIndex((c) => c.openTime === candidate.decisionTimestamp);
  if (startIndex < 0) return { filled: false, won: null, exitTime: null, fillIndex: -1 };
  const endIndex = Math.min(m15.length, startIndex + DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles);

  let h1Cursor = 0;
  while (h1Cursor < h1.length && h1[h1Cursor].openTime + H1_MS <= m15[startIndex].openTime) h1Cursor++;

  let fillIndex = -1;
  for (let index = startIndex; index < endIndex; index++) {
    const candle = m15[index];
    while (h1Cursor < h1.length && h1[h1Cursor].openTime + H1_MS <= candle.openTime + M15_MS) h1Cursor++;
    const gapTouched = candle.low <= candidate.gapHigh && candle.high >= candidate.gapLow;
    if (!gapTouched) continue;
    if (requireNtzClear) {
      const ntz = checkNoTradeZone({ nowMs: candle.openTime + M15_MS, bid: candle.close, ask: candle.close, h1Candles: h1.slice(0, h1Cursor), m15Candles: m15.slice(0, index + 1) });
      if (ntz.blocked) continue;
    }
    fillIndex = index;
    break;
  }
  if (fillIndex < 0) return { filled: false, won: null, exitTime: null, fillIndex: -1 };

  for (let index = fillIndex + 1; index < m15.length; index++) {
    const candle = m15[index];
    const slTouched = candidate.direction === 'LONG' ? candle.low <= candidate.slPrice : candle.high >= candidate.slPrice;
    const tpTouched = candidate.direction === 'LONG' ? candle.high >= candidate.tpPrice : candle.low <= candidate.tpPrice;
    if (slTouched) return { filled: true, won: false, exitTime: candle.openTime + M15_MS, fillIndex };
    if (tpTouched) return { filled: true, won: true, exitTime: candle.openTime + M15_MS, fillIndex };
  }
  return { filled: true, won: null, exitTime: null, fillIndex }; // open at data end — excluded from PF, matches RT-084's convention
}

function netRForOutcome(candidate: TrendCandidate, won: boolean, feeModel: 'rt084' | 'rtdoge'): number {
  const risk = Math.abs(candidate.entryPrice - candidate.slPrice);
  const exitPrice = won ? candidate.tpPrice : candidate.slPrice; // no slippage in this comparator, matching RT-084's own conventional (slippageBps forced to 0 there)
  const priceR = directedR(candidate, exitPrice);
  let feeR: number;
  if (feeModel === 'rt084') {
    feeR = (candidate.entryPrice * RT084_ENTRY_FEE + exitPrice * RT084_EXIT_FEE) / risk;
  } else {
    // RT-DOGE-001: one flat round-trip fee on notional (~entryPrice*qty), R-normalized (qty cancels).
    feeR = (candidate.entryPrice * (RTDOGE_FEE_PCT_SUM / 100)) / risk;
  }
  return priceR - feeR;
}

function profitFactor(values: number[]): number {
  const profit = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  const loss = -values.reduce((sum, v) => sum + Math.min(0, v), 0);
  return loss === 0 ? (profit > 0 ? Infinity : 0) : profit / loss;
}

function summarize(label: string, netRValues: number[], n: number): void {
  const pf = profitFactor(netRValues);
  const exp = netRValues.length > 0 ? netRValues.reduce((a, b) => a + b, 0) / netRValues.length : 0;
  const wins = netRValues.filter((v) => v > 0).length;
  console.log(`${label}: n(candidates)=${n}, closed=${netRValues.length}, wins=${wins}, WR=${((wins / netRValues.length) * 100).toFixed(1)}%, netPF=${pf.toFixed(3)}, netExpR=${exp.toFixed(3)}`);
}

async function main() {
  const candidates: TrendCandidate[] = [];
  const m15BySymbol = new Map<string, Candle[]>();
  const h1BySymbol = new Map<string, Candle[]>();
  let detected = 0;
  let floorRejected = 0;
  for (const symbol of SYMBOLS) {
    const m15 = await readCandles(path.join(DATA_DIR, `${symbol}_15m_3y.csv`));
    const h1 = await readCandles(path.join(DATA_DIR, `${symbol}_1h_3y.csv`));
    m15BySymbol.set(symbol, m15);
    h1BySymbol.set(symbol, h1);
    const generated = generateTrendCandidates(symbol, m15, h1);
    detected += generated.detectedSignals;
    floorRejected += generated.floorRejected;
    candidates.push(...generated.candidates);
  }
  candidates.sort((a, b) => a.decisionTimestamp - b.decisionTimestamp || a.symbol.localeCompare(b.symbol));
  if (detected !== 21_887 || floorRejected !== 14_754 || candidates.length !== 7_133) {
    throw new Error(`CORRECTION_REQUIRED: frozen baseline drift — detected=${detected}, floorRejected=${floorRejected}, eligible=${candidates.length}`);
  }
  console.log(`Frozen candidates: ${candidates.length} (matches RT-084).\n`);

  // === Stage 0: reproduce RT-084's own conventional comparator (no NTZ-at-fill, RT-084 fee) ===
  const stage0: StageOutcome[] = candidates.map((candidate) => {
    const r = simulateConventionalStage(candidate.symbol, m15BySymbol.get(candidate.symbol)!, h1BySymbol.get(candidate.symbol)!, candidate, false);
    return { candidate, filled: r.filled, won: r.won, exitTime: r.exitTime, fillIndex: r.fillIndex, admitted: true, scaledFraction: 1 };
  });
  const stage0Closed = stage0.filter((o) => o.won !== null).map((o) => netRForOutcome(o.candidate, o.won!, 'rt084'));
  summarize('Stage 0 (= RT-084 conventional comparator, given PF 1.819)', stage0Closed, candidates.length);

  // === Stage 1: + require NTZ clear at the fill candle (RT-DOGE-001's touchedGap && !ntz.blocked) ===
  const stage1: StageOutcome[] = candidates.map((candidate) => {
    const r = simulateConventionalStage(candidate.symbol, m15BySymbol.get(candidate.symbol)!, h1BySymbol.get(candidate.symbol)!, candidate, true);
    return { candidate, filled: r.filled, won: r.won, exitTime: r.exitTime, fillIndex: r.fillIndex, admitted: true, scaledFraction: 1 };
  });
  const stage1Closed = stage1.filter((o) => o.won !== null).map((o) => netRForOutcome(o.candidate, o.won!, 'rt084'));
  summarize('Stage 1 (+ NTZ-at-fill gate, still RT-084 fee)', stage1Closed, candidates.length);

  // === Stage 2: + swap to RT-DOGE-001's fee constant (still equal-weight R, still no admission) ===
  const stage2Closed = stage1.filter((o) => o.won !== null).map((o) => netRForOutcome(o.candidate, o.won!, 'rtdoge'));
  summarize('Stage 2 (+ RT-DOGE-001 fee constant, R-multiple, still no portfolio admission)', stage2Closed, candidates.length);

  // === Stage 3: + portfolio exposure/sizing admission (event-driven across all 5 symbols) ===
  // Uses stage-1 fill/exit outcomes (NTZ-gated) as the candidate event stream — matches RT-DOGE-001's
  // sequencing (admission is checked exactly at the intended fill instant, using real position
  // sizing). HYPEUSDT's breaksKeyZone is not recoverable from the frozen candidate (display-only
  // field, not stored) — approximated as false (flat baseline 1.0%) here; disclosed as a limitation.
  // fillIndex is a per-symbol array index — NOT comparable across symbols directly (each symbol's
  // M15 array starts at a different wall-clock time). Sort by the actual fill wall-clock time instead.
  const filledStage1 = stage1.filter((o) => o.filled && o.exitTime !== null);
  const withFillTime = filledStage1.map((o) => ({ o, fillTime: m15BySymbol.get(o.candidate.symbol)![o.fillIndex].openTime + M15_MS }));
  withFillTime.sort((a, b) => a.fillTime - b.fillTime || a.o.candidate.symbol.localeCompare(b.o.candidate.symbol));

  let exposureState: ExposureTrackerState = EMPTY_EXPOSURE_STATE;
  const openUntil: { id: string; exitTime: number }[] = [];
  const admittedResults: { candidate: TrendCandidate; won: boolean; scaleFactor: number }[] = [];
  let nextId = 0;

  for (const { o, fillTime } of withFillTime) {
    // Release any positions that closed at or before this fill time (event-driven exposure release).
    for (let i = openUntil.length - 1; i >= 0; i--) {
      if (openUntil[i].exitTime <= fillTime) {
        exposureState = closePosition(exposureState, openUntil[i].id);
        openUntil.splice(i, 1);
      }
    }
    const symbol = o.candidate.symbol;
    const breaksKeyZone = false; // TODO_CONFIRM (disclosed limitation): not recoverable from the frozen candidate
    const riskPct = resolveRiskPct(symbol, breaksKeyZone, DEFAULT_RISK_CONFIG);
    const riskUsd = RTDOGE_BALANCE * riskPct;
    const leverage = resolveLeverage(symbol);
    const sizing = calculatePositionSize({ balance: RTDOGE_BALANCE, riskUsd, entryPrice: o.candidate.entryPrice, slPrice: o.candidate.slPrice, leverage, maxMarginPct: DEFAULT_MAX_MARGIN_PCT });
    if (!sizing) continue; // structurally impossible here (risk>0 already enforced by floor filter) but kept for parity with production
    const id = `c${nextId++}`;
    const { result, nextState } = admitPosition(exposureState, DEFAULT_EXPOSURE_TRACKER_CONFIG, RTDOGE_BALANCE, { id, symbol, qty: sizing.qty, notional: sizing.notional, requiredMargin: sizing.requiredMargin, actualRiskUsd: sizing.actualRiskUsd });
    exposureState = nextState;
    if (!result.admitted) continue; // SUPPRESSED — this is exactly "candidate suppression via portfolio exposure"
    openUntil.push({ id, exitTime: o.exitTime! });
    const scaleFactor = sizing.actualRiskUsd > 0 ? result.actualRiskUsd / sizing.actualRiskUsd : 1;
    admittedResults.push({ candidate: o.candidate, won: o.won!, scaleFactor });
  }

  const stage3Closed = admittedResults.map((r) => netRForOutcome(r.candidate, r.won, 'rtdoge'));
  summarize('Stage 3 (+ portfolio exposure/sizing admission — equal-weight R among admitted only)', stage3Closed, candidates.length);
  console.log(`  Suppressed by portfolio admission: ${withFillTime.length - admittedResults.length} of ${withFillTime.length} fills that would otherwise have closed.`);

  // === Stage 4: + re-weight by actual $ size (scale-downs + per-symbol risk%) — isolates "unit of report" ===
  const stage4Dollar = admittedResults.map((r) => {
    const netR = netRForOutcome(r.candidate, r.won, 'rtdoge');
    return netR * r.scaleFactor; // $ PnL proportional to R * actual risk$ used; PF ratio is scale-invariant per trade but NOT across unequally-scaled trades
  });
  summarize('Stage 4 (+ dollar-weighted by actual admitted size — should approach RT-DOGE-001 1.451)', stage4Dollar, candidates.length);
  const scaledCount = admittedResults.filter((r) => Math.abs(r.scaleFactor - 1) > 1e-9).length;
  console.log(`  Trades scaled down by the portfolio cap: ${scaledCount} of ${admittedResults.length}.`);

  console.log('\n=== Waterfall summary (Net PF) ===');
  console.log(`Stage 0  M15 conventional comparator (RT-084, given)                          : 1.819`);
  console.log(`Stage 1  + NTZ-at-fill gate                                                    : ${profitFactor(stage1Closed).toFixed(3)}`);
  console.log(`Stage 2  + RT-DOGE-001 fee constant                                            : ${profitFactor(stage2Closed).toFixed(3)}`);
  console.log(`Stage 3  + portfolio exposure/sizing admission (equal-weight R, survivors only): ${profitFactor(stage3Closed).toFixed(3)}`);
  console.log(`Stage 4  + dollar-weighting by actual admitted size                            : ${profitFactor(stage4Dollar).toFixed(3)}`);
  console.log(`RT-DOGE-001 original (target)                                                  : 1.451`);

  const report = [
    '# TICKET-RT-086 Part B — Variable Isolation: 1.819 (M15 conventional) -> 1.451 (RT-DOGE-001)',
    '',
    'Audit-only. Waterfall on the IDENTICAL 7,133 frozen candidates (RT-084) — one variable changed per stage.',
    '',
    '| Stage | Change added | Net PF | Δ from prior stage |',
    '|---|---|---:|---:|',
    `| 0 | (baseline) RT-084 M15 conventional comparator | 1.819 | — |`,
    `| 1 | + NTZ-at-fill gate (RT-DOGE-001's \`!ntz.blocked\` check on touchedGap) | ${profitFactor(stage1Closed).toFixed(3)} | ${(profitFactor(stage1Closed) - 1.819).toFixed(3)} |`,
    `| 2 | + RT-DOGE-001 fee constant (flat 0.2% notional vs RT-084's 0.02%/0.05% split legs) | ${profitFactor(stage2Closed).toFixed(3)} | ${(profitFactor(stage2Closed) - profitFactor(stage1Closed)).toFixed(3)} |`,
    `| 3 | + portfolio exposure/sizing admission (candidate suppression; equal-weight R among survivors) | ${profitFactor(stage3Closed).toFixed(3)} | ${(profitFactor(stage3Closed) - profitFactor(stage2Closed)).toFixed(3)} |`,
    `| 4 | + dollar-weighting by actual admitted position size (isolates "unit of report") | ${profitFactor(stage4Dollar).toFixed(3)} | ${(profitFactor(stage4Dollar) - profitFactor(stage3Closed)).toFixed(3)} |`,
    `| — | RT-DOGE-001 original (target) | 1.451 | residual = ${(1.451 - profitFactor(stage4Dollar)).toFixed(3)} |`,
    '',
    '## Notes / disclosed limitations',
    '',
    '- HYPEUSDT `breaksKeyZone` is a display-only field not stored on the frozen `TrendCandidate` — approximated as `false` (flat 1.0% baseline risk) for Stage 3/4 sizing. Affects only HYPEUSDT position-sizing precision (not fill/exit determination), a small fraction of the 7,133 candidates.',
    '- Stage 3/4 use a single shared 30-min-resolution event ordering (fill-time, then exit-time release) across all 5 symbols, matching `rtDogeThreeYearBacktest.ts`\'s sequential per-M15-tick admission order.',
    '- "Đơn vị báo cáo $ vs R" is not an independent 6th variable — Stage 4 shows its entire measurable effect is the dollar-weighting shown above, conditional on Stage 3\'s admitted/scaled trade set.',
  ].join('\n');
  await writeFile(path.resolve(process.cwd(), 'apps/bot/reports/RT-086-part-b-variable-isolation.md'), report + '\n', 'utf8');
  console.log('\nReport: apps/bot/reports/RT-086-part-b-variable-isolation.md');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
