/**
 * G4B-R2 -- audit-only C1/C2 replay on the complete MOMENTUM_DIRECT population.
 *
 * Important invariants:
 * - C1/C2 are the two rules frozen in data/g4b-candidate-registration.md.
 * - Each baseline exit timestamp identifies a 5m candle. The replay therefore consumes
 *   1m bars in [entryTimestamp, exitTimestamp + 5m), not merely through the first minute.
 * - A newly armed stop cannot be treated as touched by the pre-trigger portion of the
 *   trigger candle. Such within-1m ordering is bounded explicitly (conservative/favorable).
 * - Execution costs use the T153B fill-price model and quantity-weight every exit slice.
 * - Portfolio ordering is by realised exit time and MaxDD starts from $100.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const OHLCV = path.join(DATA, 'ohlcv');
const FIVE_MINUTES = 5 * 60_000;
const TARGET_R = 3;
const TAKER_FEE_RATE = 0.0004; // locked T153B / baseline config
const SCENARIOS = {
  FEE_ONLY: { slippageBpsPerSide: 0, spreadBpsTotal: 0 },
  LIGHT: { slippageBpsPerSide: 1, spreadBpsTotal: 1 },
  CENTRAL: { slippageBpsPerSide: 2, spreadBpsTotal: 2 },
  CONSERVATIVE: { slippageBpsPerSide: 5, spreadBpsTotal: 5 },
};

const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function readCsv(file) {
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.map((line) => Object.fromEntries(header.map((key, i) => [key, line.split(',')[i] ?? ''])));
}
function writeCsv(file, rows) {
  const header = Object.keys(rows[0] ?? {});
  writeFileSync(file, [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n');
}

const candlesBySymbol = Object.fromEntries(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].map((symbol) => [
  symbol,
  readCsv(path.join(OHLCV, `${symbol}_1m.csv`)).map((r) => ({
    t: +r.timestampUtc, o: +r.open, h: +r.high, l: +r.low, c: +r.close,
  })),
]));
const baseline = readCsv(path.join(DATA, 'g3-runs', 'G3-CENTRAL-trades.csv'));

const touches = (c, level) => c.l <= level && c.h >= level;
function window1m(symbol, entryTs, exitTs) {
  return candlesBySymbol[symbol].filter((c) => c.t >= entryTs && c.t < exitTs + FIVE_MINUTES);
}

function baselineOutcome(t) {
  return {
    exitTs: +t.exitTimestamp,
    exitPrice: referenceExitPrice(t),
    exitReason: t.exitReason,
    slices: [{ weight: 1, price: referenceExitPrice(t) }],
    triggered: false,
    classification: 'UNCHANGED_BASELINE_PATH',
  };
}

function referenceExitPrice(t) {
  // pnlTheoretical already includes the configured round-trip taker fee. Add it back
  // to recover the reference-price gross return used by T153B's fill model.
  const entry = +t.entryPrice;
  const notional = +t.positionSize;
  const direction = t.side === 'LONG' ? 1 : -1;
  const gross = +t.pnlTheoretical + notional * TAKER_FEE_RATE * 2;
  return entry * (1 + direction * gross / notional);
}

function afterTriggerBounds(candles, triggerIndex, protective, target) {
  const triggerCandle = candles[triggerIndex];
  const protectiveInTrigger = touches(triggerCandle, protective);
  const targetInTrigger = touches(triggerCandle, target);

  // OHLC cannot say whether a protective-level revisit happened after arming. Bound it.
  if (protectiveInTrigger) {
    return {
      conservative: { kind: 'PROTECTIVE', ts: triggerCandle.t },
      favorable: targetInTrigger ? { kind: 'TARGET', ts: triggerCandle.t } : scanAfter(candles, triggerIndex + 1, protective, target),
      ambiguous: true,
    };
  }
  if (targetInTrigger) {
    const target = { kind: 'TARGET', ts: triggerCandle.t };
    return { conservative: target, favorable: target, ambiguous: false };
  }
  const later = scanAfter(candles, triggerIndex + 1, protective, target);
  return { conservative: later, favorable: later, ambiguous: later.kind === 'AMBIGUOUS' };
}

function scanAfter(candles, fromIndex, protective, target) {
  for (let i = fromIndex; i < candles.length; i++) {
    const hitProtective = touches(candles[i], protective);
    const hitTarget = touches(candles[i], target);
    if (hitProtective && hitTarget) return { kind: 'AMBIGUOUS', ts: candles[i].t };
    if (hitProtective) return { kind: 'PROTECTIVE', ts: candles[i].t };
    if (hitTarget) return { kind: 'TARGET', ts: candles[i].t };
  }
  return { kind: 'BASELINE', ts: null };
}

function findTrigger(candles, originalSl, trigger) {
  for (let i = 0; i < candles.length; i++) {
    const hitSl = touches(candles[i], originalSl);
    const hitTrigger = touches(candles[i], trigger);
    if (hitSl && hitTrigger) return { kind: 'AMBIGUOUS', index: i, ts: candles[i].t };
    if (hitSl) return { kind: 'SL', index: i, ts: candles[i].t };
    if (hitTrigger) return { kind: 'TRIGGER', index: i, ts: candles[i].t };
  }
  return { kind: 'BASELINE', index: -1, ts: null };
}

function candidateOutcome(t, candidate, mode) {
  const base = baselineOutcome(t);
  const entry = +t.entryPrice;
  const originalSl = +t.slPrice;
  const direction = t.side === 'LONG' ? 1 : -1;
  const R = Math.abs(entry - originalSl);
  const triggerR = candidate === 'C1' ? 1 : 1.5;
  const protectiveR = candidate === 'C1' ? 0 : 0.5;
  const trigger = entry + direction * triggerR * R;
  const protective = entry + direction * protectiveR * R;
  const target = entry + direction * TARGET_R * R;
  const candles = window1m(t.symbol, +t.entryTimestamp, +t.exitTimestamp);
  const phase1 = findTrigger(candles, originalSl, trigger);

  if (phase1.kind === 'BASELINE' || phase1.kind === 'SL') return base;
  if (phase1.kind === 'AMBIGUOUS' && mode === 'conservative') {
    return { ...base, exitTs: phase1.ts, exitPrice: originalSl, slices: [{ weight: 1, price: originalSl }], classification: 'AMBIGUOUS_TRIGGER_ORDER' };
  }

  const phase2 = afterTriggerBounds(candles, phase1.index, protective, target);
  let resolved = mode === 'conservative' ? phase2.conservative : phase2.favorable;
  if (resolved.kind === 'AMBIGUOUS') resolved = mode === 'conservative'
    ? { kind: 'PROTECTIVE', ts: resolved.ts }
    : { kind: 'TARGET', ts: resolved.ts };
  if (resolved.kind === 'BASELINE') {
    if (candidate === 'C1') return { ...base, triggered: true, classification: phase2.ambiguous ? 'AMBIGUOUS_TRIGGER_CANDLE' : 'TRIGGERED_BASELINE_EXIT' };
    // C2 has already banked the 50% trigger slice even when the remaining half reaches
    // neither its new stop nor 3R before the original path exits.
    return {
      ...base,
      slices: [{ weight: 0.5, price: trigger }, { weight: 0.5, price: base.exitPrice }],
      triggered: true,
      classification: phase2.ambiguous ? 'AMBIGUOUS_TRIGGER_CANDLE' : 'TRIGGERED_BASELINE_EXIT',
    };
  }

  const secondPrice = resolved.kind === 'TARGET' ? target : protective;
  const slices = candidate === 'C1'
    ? [{ weight: 1, price: secondPrice }]
    : [{ weight: 0.5, price: trigger }, { weight: 0.5, price: secondPrice }];
  return {
    exitTs: resolved.ts,
    exitPrice: secondPrice,
    exitReason: resolved.kind === 'TARGET' ? 'TARGET_3R' : candidate === 'C1' ? 'BREAKEVEN' : 'TRAIL_0_5R',
    slices,
    triggered: true,
    classification: phase1.kind === 'AMBIGUOUS' || phase2.ambiguous ? 'AMBIGUOUS_INTRABAR_ORDER' : 'CONFIRMED',
  };
}

function pnlFor(t, outcome, scenario) {
  // Preserve the observed Central ledger whenever management did not change the path.
  // This avoids reverse-engineering a rounded reference exit from a six-decimal PnL cell.
  if (scenario === 'CENTRAL' && outcome.classification === 'UNCHANGED_BASELINE_PATH') return +t.netPnl;
  const entry = +t.entryPrice;
  const notional = +t.positionSize;
  const direction = t.side === 'LONG' ? 1 : -1;
  const { slippageBpsPerSide, spreadBpsTotal } = SCENARIOS[scenario];
  const adverse = (slippageBpsPerSide + spreadBpsTotal / 2) / 10_000;
  const entryFill = entry * (1 + direction * adverse);
  let grossAfterFill = 0;
  let exitWeight = 0;
  for (const slice of outcome.slices) {
    const exitFill = slice.price * (1 - direction * adverse);
    grossAfterFill += notional * slice.weight * direction * ((exitFill - entryFill) / entryFill);
    exitWeight += slice.weight;
  }
  if (Math.abs(exitWeight - 1) > 1e-12) throw new Error(`exit weights != 1 for ${t.symbol}|${t.entryTimestamp}`);
  // Full-notional entry plus quantity-weighted exits. C2 is not charged two full-notional exits.
  const fee = notional * TAKER_FEE_RATE * (1 + exitWeight);
  return grossAfterFill - fee;
}

function metrics(rows, field, excluded = new Set()) {
  const ordered = rows.filter((_, i) => !excluded.has(i)).sort((a, b) => a[`${field}ExitTs`] - b[`${field}ExitTs`] || a.entryTs - b.entryTs);
  let balance = 100, peak = 100, maxDdUsd = 0, maxDdPct = 0, grossProfit = 0, grossLoss = 0, streak = 0, longest = 0;
  for (const row of ordered) {
    const pnl = row[field];
    balance += pnl;
    if (pnl > 0) { grossProfit += pnl; streak = 0; } else { grossLoss += Math.abs(pnl); streak++; longest = Math.max(longest, streak); }
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    maxDdUsd = Math.max(maxDdUsd, dd);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? dd / peak * 100 : 0);
  }
  const net = balance - 100;
  return { n: ordered.length, net, PF: grossLoss ? grossProfit / grossLoss : null, expectancy: ordered.length ? net / ordered.length : 0, finalBalance: balance, maxDdUsd, maxDdPct, longestLosingStreak: longest };
}

// Tight, deterministic regression checks for the four review findings.
(function regressionChecks() {
  const bars = [{ t: 0, o: 100, h: 101.2, l: 99.8, c: 101 }, { t: 60_000, o: 101, h: 101.1, l: 99.9, c: 100 }];
  const bounded = afterTriggerBounds(bars, 0, 100, 103);
  if (!bounded.ambiguous || bounded.conservative.kind !== 'PROTECTIVE' || bounded.favorable.kind !== 'PROTECTIVE' || bounded.favorable.ts !== 60_000) throw new Error('trigger-candle ordering regression');
  const finalMinute = window1m('BTCUSDT', 1768750200000, 1768750200000);
  if (!finalMinute.some((c) => c.t === 1768750440000)) throw new Error('5m exit-window regression');
  const fee = 1000 * TAKER_FEE_RATE * (1 + 0.5 + 0.5);
  if (Math.abs(fee - 0.8) > 1e-12) throw new Error('weighted execution-cost regression');
  const m = metrics([{ entryTs: 0, x: -50, xExitTs: 1 }], 'x');
  if (m.finalBalance !== 50 || m.maxDdPct !== 50) throw new Error('$100 MaxDD regression');
})();

const md = baseline.filter((t) => t.setupType === 'MOMENTUM_DIRECT');
if (md.length !== 139) throw new Error(`expected 139 MOMENTUM_DIRECT trades, got ${md.length}`);
const modes = ['conservative', 'favorable'];
const outcomes = new Map();
for (const t of md) for (const candidate of ['C1', 'C2']) for (const mode of modes) outcomes.set(`${t.symbol}|${t.entryTimestamp}|${candidate}|${mode}`, candidateOutcome(t, candidate, mode));

const replayRows = [];
for (const t of md) {
  const row = { symbol: t.symbol, side: t.side, entryIso: t.entryIso, baselineExitIso: t.exitIso, baselineExitReason: t.exitReason };
  for (const candidate of ['C1', 'C2']) for (const mode of modes) {
    const o = outcomes.get(`${t.symbol}|${t.entryTimestamp}|${candidate}|${mode}`);
    row[`${candidate.toLowerCase()}_${mode}_classification`] = o.classification;
    row[`${candidate.toLowerCase()}_${mode}_triggered`] = o.triggered ? 1 : 0;
    row[`${candidate.toLowerCase()}_${mode}_exitIso`] = new Date(o.exitTs).toISOString();
    row[`${candidate.toLowerCase()}_${mode}_exitReason`] = o.exitReason;
    row[`${candidate.toLowerCase()}_${mode}_exitSlices`] = o.slices.map((s) => `${s.weight}@${s.price}`).join('|');
  }
  replayRows.push(row);
}
writeCsv(path.join(DATA, 'g4br-full-population-replay.csv'), replayRows);

const report = { methodology: { population: md.length, exitWindow: '[entryTimestamp, exitTimestamp + 5m)', intrabarOrdering: 'trigger-candle newly-armed-stop ordering bounded', executionCosts: 'T153B fill-price model; exit slices quantity-weighted', startBalance: 100, portfolioOrder: 'candidate realized exit timestamp' }, scenarios: {}, tally: {} };
for (const mode of modes) {
  report.tally[mode] = {};
  for (const candidate of ['C1', 'C2']) {
    const counts = {};
    for (const t of md) { const cls = outcomes.get(`${t.symbol}|${t.entryTimestamp}|${candidate}|${mode}`).classification; counts[cls] = (counts[cls] ?? 0) + 1; }
    report.tally[mode][candidate.toLowerCase()] = counts;
  }
}

for (const scenario of Object.keys(SCENARIOS)) {
  const rows = baseline.map((t) => {
    const base = baselineOutcome(t);
    const row = { entryTs: +t.entryTimestamp };
    for (const config of ['c0', 'c1', 'c2']) {
      const candidate = config.toUpperCase();
      const outcome = config === 'c0' || t.setupType !== 'MOMENTUM_DIRECT' ? base : outcomes.get(`${t.symbol}|${t.entryTimestamp}|${candidate}|conservative`);
      row[config] = pnlFor(t, outcome, scenario);
      row[`${config}ExitTs`] = outcome.exitTs;
    }
    return row;
  });
  report.scenarios[scenario] = { c0: metrics(rows, 'c0'), c1: metrics(rows, 'c1'), c2: metrics(rows, 'c2') };
}

writeFileSync(path.join(DATA, 'g4br-grid.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ regressionChecks: 'PASS', tally: report.tally, scenarios: report.scenarios }, null, 2));
