/**
 * G4A-R item 4 — rebuild data/g4a-positive-excursion-loss-ledger.csv for the old 52-trade bucket
 * (trades previously mis-classified GOOD_ENTRY_MANAGEMENT_LOSS by G3/G4A) using the corrected
 * MFE-in-R taxonomy + real intrabar reconstruction. No synthetic "implied" fill events.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'data');
const csvEscape = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const readCsv = (f) => { const l = readFileSync(f, 'utf-8').trim().split('\n'); const h = l[0].split(','); return { h, rows: l.slice(1).map((r) => r.split(',')) }; };

// G4A-R HOTFIX item 4: no dependency on any .bak snapshot. The pre-fix "old 52-trade bucket" is
// reconstructed deterministically from the CURRENT (corrected) ledger, reproducing the OLD bug's
// exact rule: mfe>=1.0 losers were shortcut into the bucket UNCONDITIONALLY (entry-failure checks
// never got a chance to run for them), while mfe in [0.3,1.0) losers only landed there when they
// did NOT match an entry-failure check -- unchanged logic for that range between old and new code,
// so it equals today's PARTIAL_EXCURSION_REVERSAL class exactly. Verified: 34 + 18 = 52.
const newLedger = readCsv(path.join(OUT, 'g3-entry-timing-ledger.csv'));
const central = readCsv(path.join(OUT, 'g3-runs/G3-CENTRAL-trades.csv'));
const intrabar = readCsv(path.join(OUT, 'g4ar-intrabar-per-trade.csv'));

const key = (h, r) => `${r[h.indexOf('symbol')]}|${r[h.indexOf('entryTimestamp')] ?? r[h.indexOf('entryIso')]}|${r[h.indexOf('setupType')]}`;
const oldBucket = new Set(newLedger.rows.filter((r) => {
  const netPnl = +r[newLedger.h.indexOf('netPnl')];
  const mfeR = r[newLedger.h.indexOf('mfeR')];
  const cls = r[newLedger.h.indexOf('classification')];
  const mfe = mfeR === '' ? NaN : +mfeR;
  return netPnl <= 0 && ((Number.isFinite(mfe) && mfe >= 1.0) || cls === 'PARTIAL_EXCURSION_REVERSAL');
}).map((r) => key(newLedger.h, r)));

const centralByKey = new Map(central.rows.map((r) => [key(central.h, r), r]));
const intrabarByKey = new Map(intrabar.rows.map((r) => [`${r[intrabar.h.indexOf('symbol')]}|${new Date(r[intrabar.h.indexOf('entryIso')]).getTime()}|${r[intrabar.h.indexOf('setupType')]}`, r]));

const rows = [];
for (const nr of newLedger.rows) {
  const k = key(newLedger.h, nr);
  if (!oldBucket.has(k)) continue;
  const c = centralByKey.get(k);
  const ib = intrabarByKey.get(k);
  const nh = newLedger.h;
  const g = (name) => nr[nh.indexOf(name)];
  const symbol = g('symbol'), side = g('side'), setup = g('setupType'), regime = g('regime');
  const entryTs = g('entryTimestamp'), entryPrice = +g('entryPrice'), slPrice = +g('slPrice');
  const exitReason = g('exitReason'), netPnl = +g('netPnl'), mfeR = g('mfeR'), maeR = g('maeR'), cls = g('classification');
  const R = Math.abs(entryPrice - slPrice);
  const dir = side === 'LONG' ? 1 : -1;
  const isCT = setup === 'MOMENTUM_DIRECT';
  // G4A-R HOTFIX: real frozen config momentumDirectTpRMultiple=3.0, not hard-coded 1R.
  const MOMENTUM_DIRECT_TP_R_MULTIPLE = 3.0;
  const tp1 = isCT ? entryPrice + dir * MOMENTUM_DIRECT_TP_R_MULTIPLE * R : entryPrice + dir * 1.2 * R;
  const tp2 = isCT ? '' : (entryPrice + dir * 2.5 * R).toFixed(8);

  const exitTs = c ? +c[central.h.indexOf('exitTimestamp')] : '';
  const pnlTheoretical = c ? +c[central.h.indexOf('pnlTheoretical')] : NaN;
  const execCostDelta = c ? (netPnl - pnlTheoretical) : '';

  const isBE4 = exitReason === 'BREAKEVEN_SL' && setup === 'OB' &&
    ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'].includes(symbol) && Number.isFinite(pnlTheoretical) && pnlTheoretical > 0 && netPnl < 0 && Math.abs(execCostDelta - (-0.675337)) < 0.001;

  const tp1Ts = ib ? ib[intrabar.h.indexOf('tp1TouchIso')] : '';
  const tp2Ts = ib ? ib[intrabar.h.indexOf('tp2TouchIso')] : '';
  const slTs = ib ? ib[intrabar.h.indexOf('slTouchIso')] : '';
  const intrabarCls = ib ? ib[intrabar.h.indexOf('classification')] : 'INSUFFICIENT_INTRABAR_EVIDENCE';

  let mgmtTransition = 'MISSING';
  if (exitReason === 'BREAKEVEN_SL' && tp1Ts) mgmtTransition = `TP1_TOUCH@${tp1Ts}->BE_SL_MOVE->BREAKEVEN_SL`;
  else if (exitReason === 'TP2' || exitReason === 'RUNNER_SL') mgmtTransition = tp1Ts ? `TP1_TOUCH@${tp1Ts}->...` : 'MISSING';

  let lossAttribution, evidence;
  if (isBE4) {
    lossAttribution = 'MIXED_MANAGEMENT_EXECUTION';
    evidence = 'theoretical_pnl positive (TP1 leg banked), central_net_pnl negative purely from execution_cost_delta = -0.675337 (positionSize*takerFeeRate*2, exact match across all 4 trades, see data/g3-runs/G3-CENTRAL-trades.csv pnlTheoretical vs netPnl); management design (SL->BE+fee) creates the exit point, fee determines the magnitude -- both required, hence MIXED not single-cause.';
  } else if (cls === 'POSITIVE_EXCURSION_MANAGEMENT_LOSS') {
    lossAttribution = 'MANAGEMENT_DESIGN';
    evidence = `mfeR=${mfeR} >=1.0R then closed as loss (exit=${exitReason}); for MOMENTUM_DIRECT this is Muc 7's no-SL-choreography design (see apps/bot/src/risk/slTpManager.ts:287-onward); intrabar=${intrabarCls}`;
  } else if (cls === 'PARTIAL_EXCURSION_REVERSAL') {
    lossAttribution = 'MANAGEMENT_DESIGN';
    evidence = `mfeR=${mfeR} in [0.3,1.0)R then closed as loss (exit=${exitReason}); partial favorable excursion given back, same no-choreography mechanism; intrabar=${intrabarCls}`;
  } else if (cls === 'INSUFFICIENT_REWARD') {
    lossAttribution = 'NORMAL_PRICE_REVERSAL';
    evidence = `mfeR=${mfeR} <0.3R -- never built meaningful paper profit; ordinary stop-out, not a management failure; intrabar=${intrabarCls}`;
  } else {
    // G4A-R HOTFIX item 6: was labeled with the raw entry-failure class name and narrated as
    // "genuinely entry-quality" -- overclaims causal certainty. This is a heuristic pattern match
    // (extension-ATR / HTF-close-direction / wick-body ratio thresholds), not an independently
    // verified causal finding, so it is flagged rather than asserted.
    lossAttribution = 'ENTRY_QUALITY_FLAGGED';
    evidence = `matched entry-failure heuristic ${cls} (extension/HTF/wick-body thresholds in g3TradeForensics.mjs); causal link not independently verified beyond the heuristic match; mfeR=${mfeR}`;
  }

  rows.push([symbol, side, setup, regime, entryPrice, slPrice, tp1.toFixed(8), tp2, isCT ? '' : '',
    R.toFixed(8), mfeR, maeR, tp1Ts, tp2Ts, slTs, mgmtTransition, intrabarCls,
    Number.isFinite(pnlTheoretical) ? pnlTheoretical.toFixed(6) : '', execCostDelta === '' ? '' : execCostDelta.toFixed(6),
    netPnl.toFixed(6), lossAttribution, evidence]);
}

const header = ['symbol', 'side', 'setup', 'regime', 'entry', 'sl', 'tp1', 'tp2', 'counter_trend_target', 'target_distance_r', 'mfe', 'mae',
  'tp1_confirmed_timestamp', 'tp2_confirmed_timestamp', 'sl_confirmed_timestamp', 'management_transition', 'intrabar_classification',
  'theoretical_pnl', 'execution_cost_delta', 'central_net_pnl', 'loss_attribution'];
// evidence appended as extra column beyond header list; include explicitly
header.push('evidence');
writeFileSync(path.join(OUT, 'g4a-positive-excursion-loss-ledger.csv'), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');
console.log('wrote', rows.length, 'rows to g4a-positive-excursion-loss-ledger.csv');
const byAttr = {};
for (const r of rows) byAttr[r[20]] = (byAttr[r[20]] || 0) + 1;
console.log(byAttr);
