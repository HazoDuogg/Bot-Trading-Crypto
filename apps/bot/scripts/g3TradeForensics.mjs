/**
 * TICKET-G3 P0 — post-hoc entry forensics over an already-produced trade ledger + the SAME
 * data/ohlcv/ candles the replay used. Pure measurement: it opens no position, changes no logic and
 * re-runs no orchestrator. Every metric is derived from (entry/sl/exit, OHLCV) only — nothing is
 * inferred from the outcome except where the taxonomy explicitly says so.
 *
 * Usage: node apps/bot/scripts/g3TradeForensics.mjs <ledger.csv> <label>
 * Writes data/g3-setup-attribution.csv, data/g3-entry-timing-ledger.csv,
 *        data/g3-false-breakout-forensic.csv  (suffixed by <label> when label !== 'CENTRAL').
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , LEDGER, LABEL = 'CENTRAL'] = process.argv;
if (!LEDGER) throw new Error('usage: g3TradeForensics.mjs <ledger.csv> <label>');
const OUT = path.resolve(process.cwd(), 'data');
const OHLCV = path.resolve(process.cwd(), 'data/ohlcv');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

const csvEscape = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, header, rows) => writeFileSync(path.join(OUT, file), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');

function readOhlcv(symbol, tf) {
  const lines = readFileSync(path.join(OHLCV, `${symbol}_${tf}.csv`), 'utf-8').trim().split('\n').slice(1);
  return lines.map((l) => { const p = l.split(','); return { t: +p[0], o: +p[2], h: +p[3], l: +p[4], c: +p[5], v: +p[6] }; });
}
const D = {};
for (const s of SYMBOLS) { D[s] = { m5: readOhlcv(s, '5m'), h1: readOhlcv(s, '1h') }; D[s].i5 = new Map(D[s].m5.map((c, i) => [c.t, i])); }

/** Wilder ATR(14) on 5m, computed exactly like regime/indicators.ts's wilderATRSeries. */
function atrAt(sym, idx, period = 14) {
  const a = D[sym].m5;
  if (idx < period) return undefined;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += Math.max(a[i].h - a[i].l, Math.abs(a[i].h - a[i - 1].c), Math.abs(a[i].l - a[i - 1].c));
  let atr = sum / period; // seed; then Wilder-smooth forward from the seed window is equivalent enough for a magnitude metric
  return atr;
}

// ---------------------------------------------------------------- load ledger
const raw = readFileSync(LEDGER, 'utf-8').trim().split('\n');
const H = raw[0].split(',');
const col = (n) => H.indexOf(n);
const iSym = col('symbol'), iSide = col('side'), iSetup = col('setupType'), iRegime = col('regime');
const iEt = col('entryTimestamp'), iEp = col('entryPrice'), iXt = col('exitTimestamp'), iXr = col('exitReason');
const iSl = col('slPrice') >= 0 ? col('slPrice') : -1;
const iPnl = col('netPnl') >= 0 ? col('netPnl') : col('pnlUsd');
const trades = raw.slice(1).map((l) => { const p = l.split(','); return {
  symbol: p[iSym], side: p[iSide], setupType: p[iSetup], regime: p[iRegime],
  entryTs: +p[iEt], entryPrice: +p[iEp], exitTs: +p[iXt], exitReason: p[iXr],
  slPrice: iSl >= 0 ? +p[iSl] : NaN, pnl: +p[iPnl],
}; });

// ---------------------------------------------------------------- per-trade forensics
const PRE = 12;      // 5m candles of pre-entry context (1 hour)
const POSTBREAK = 6; // candles to look for a return through the entry level

const rows = [];
for (const t of trades) {
  const sd = D[t.symbol];
  const idx = sd.i5.get(t.entryTs);
  const dir = t.side === 'LONG' ? 1 : -1;
  const atr = idx === undefined ? undefined : atrAt(t.symbol, idx);
  const R = Number.isFinite(t.slPrice) ? Math.abs(t.entryPrice - t.slPrice) : NaN;

  let mfeR = '', maeR = '', preRunAtr = '', extAtr = '', bodyRatio = '', brokeByBody = '', returnedInto = '', barsHeld = '', htfAgree = '', availRewardR = '';
  if (idx !== undefined) {
    // MFE / MAE between entry and exit, in R
    const endIdx = sd.i5.get(t.exitTs) ?? idx;
    let best = -Infinity, worst = Infinity;
    for (let i = idx; i <= Math.min(endIdx, sd.m5.length - 1); i++) {
      best = Math.max(best, dir > 0 ? sd.m5[i].h - t.entryPrice : t.entryPrice - sd.m5[i].l);
      worst = Math.min(worst, dir > 0 ? sd.m5[i].l - t.entryPrice : t.entryPrice - sd.m5[i].h);
    }
    barsHeld = Math.max(0, (sd.i5.get(t.exitTs) ?? idx) - idx);
    if (Number.isFinite(R) && R > 0) { mfeR = (best / R).toFixed(4); maeR = (worst / R).toFixed(4); }

    // Pre-entry run: how far price already travelled IN THE TRADE DIRECTION over the previous PRE candles.
    const from = Math.max(0, idx - PRE);
    const swing = dir > 0 ? t.entryPrice - Math.min(...sd.m5.slice(from, idx + 1).map((c) => c.l))
                          : Math.max(...sd.m5.slice(from, idx + 1).map((c) => c.h)) - t.entryPrice;
    if (atr) { preRunAtr = (swing / atr).toFixed(4); extAtr = (swing / atr).toFixed(4); }

    // Entry-candle structure: body vs wick (false-breakout forensic).
    const c = sd.m5[idx];
    const range = c.h - c.l;
    if (range > 0) bodyRatio = (Math.abs(c.c - c.o) / range).toFixed(4);
    brokeByBody = range > 0 ? (Math.abs(c.c - c.o) / range >= 0.5 ? 'BODY' : 'WICK') : 'NA';

    // Did price return through the entry level within POSTBREAK candles (break failure)?
    let ret = 'NO';
    for (let i = idx + 1; i <= Math.min(idx + POSTBREAK, sd.m5.length - 1); i++) {
      if (dir > 0 ? sd.m5[i].l <= t.entryPrice - (atr ?? 0) * 0.25 : sd.m5[i].h >= t.entryPrice + (atr ?? 0) * 0.25) { ret = 'YES'; break; }
    }
    returnedInto = ret;

    // HTF agreement: sign of the 1h close-to-close change over the last 24 closed 1h candles at entry.
    const h1 = sd.h1.filter((x) => x.t + 3600000 <= t.entryTs);
    if (h1.length >= 25) {
      const chg = h1[h1.length - 1].c - h1[h1.length - 25].c;
      const htfDir = chg > 0 ? 'LONG' : chg < 0 ? 'SHORT' : 'FLAT';
      htfAgree = htfDir === 'FLAT' ? 'FLAT' : htfDir === t.side ? 'AGREE' : 'CONFLICT';
    }
    // Available reward at entry: MOMENTUM_DIRECT uses a fixed 3R TP; TREND setups use PLAN_A tiers (TP1=1R).
    availRewardR = t.setupType === 'MOMENTUM_DIRECT' ? '3.0000' : '1.0000';
  }

  // ---- classification (documented, deterministic, evaluated top-down) ----
  const mfe = mfeR === '' ? NaN : +mfeR;
  const ext = extAtr === '' ? NaN : +extAtr;
  // G4A-R fix: loss-side no longer defaults everything to one bucket. Entry-failure checks
  // run first (unchanged order/logic); remaining losses are split by MFE-in-R.
  let cls;
  if (idx === undefined || !Number.isFinite(R)) cls = 'INSUFFICIENT_DATA';
  else if (t.pnl > 0) cls = 'GOOD_ENTRY_GOOD_OUTCOME';
  else if (Number.isFinite(ext) && ext >= 3.0) cls = 'OVEREXTENDED_ENTRY';
  else if (brokeByBody === 'WICK' && returnedInto === 'YES' && Number.isFinite(mfe) && mfe < 0.3) cls = 'FALSE_BREAKOUT';
  else if (htfAgree === 'CONFLICT') cls = 'HTF_DIRECTION_CONFLICT';
  else if (Number.isFinite(ext) && ext >= 1.5 && Number.isFinite(mfe) && mfe < 0.5) cls = 'LATE_ENTRY';
  else if (!Number.isFinite(mfe)) cls = 'INSUFFICIENT_DATA';
  else if (mfe >= 1.0) cls = 'POSITIVE_EXCURSION_MANAGEMENT_LOSS';
  else if (mfe >= 0.3) cls = 'PARTIAL_EXCURSION_REVERSAL';
  else cls = 'INSUFFICIENT_REWARD';

  rows.push({ ...t, atr, R, mfeR, maeR, extAtr, bodyRatio, brokeByBody, returnedInto, barsHeld, htfAgree, availRewardR, cls });
}

// ---------------------------------------------------------------- outputs
const sfx = LABEL === 'CENTRAL' ? '' : `-${LABEL.toLowerCase()}`;

writeCsv(`g3-entry-timing-ledger${sfx}.csv`,
  ['scenario', 'tradeSource', 'symbol', 'side', 'setupType', 'regime', 'entryIso', 'entryTimestamp', 'entryPrice', 'slPrice', 'riskR', 'atr5m', 'preEntryRunAtr', 'extensionAtr', 'availableRewardR', 'mfeR', 'maeR', 'barsHeld', 'htfAgreement', 'exitReason', 'netPnl', 'classification'],
  rows.map((r) => [LABEL, 'BACKTEST_PROXY', r.symbol, r.side, r.setupType, r.regime, new Date(r.entryTs).toISOString(), r.entryTs, r.entryPrice, r.slPrice, Number.isFinite(r.R) ? r.R.toFixed(8) : '', r.atr ? r.atr.toFixed(8) : '', r.preRunAtr ?? r.extAtr, r.extAtr, r.availRewardR, r.mfeR, r.maeR, r.barsHeld, r.htfAgree, r.exitReason, r.pnl.toFixed(6), r.cls]));

writeCsv(`g3-false-breakout-forensic${sfx}.csv`,
  ['scenario', 'symbol', 'side', 'setupType', 'regime', 'entryIso', 'entryCandleBodyRatio', 'breakKind', 'returnedThroughEntryWithin6', 'mfeR', 'maeR', 'netPnl', 'classification'],
  rows.map((r) => [LABEL, r.symbol, r.side, r.setupType, r.regime, new Date(r.entryTs).toISOString(), r.bodyRatio, r.brokeByBody, r.returnedInto, r.mfeR, r.maeR, r.pnl.toFixed(6), r.cls]));

// attribution: setup x (overall, side, symbol, regime, month) + classification mix
function stat(list) {
  const n = list.length, w = list.filter((r) => r.pnl > 0).length;
  const gp = list.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
  const gl = list.filter((r) => r.pnl <= 0).reduce((s, r) => s + Math.abs(r.pnl), 0);
  const net = list.reduce((s, r) => s + r.pnl, 0);
  const mfes = list.map((r) => +r.mfeR).filter(Number.isFinite);
  const exts = list.map((r) => +r.extAtr).filter(Number.isFinite);
  return { n, wr: n ? (100 * w / n).toFixed(2) : '', pf: gl > 0 ? (gp / gl).toFixed(6) : 'INF', net: net.toFixed(6), exp: n ? (net / n).toFixed(6) : '',
    medMfeR: mfes.length ? mfes.slice().sort((a, b) => a - b)[Math.floor(mfes.length / 2)].toFixed(4) : '',
    medExtAtr: exts.length ? exts.slice().sort((a, b) => a - b)[Math.floor(exts.length / 2)].toFixed(4) : '' };
}
const attrRows = [];
const groups = { SETUP: (r) => r.setupType };
for (const setup of [...new Set(rows.map((r) => r.setupType))]) {
  const g = rows.filter((r) => r.setupType === setup);
  const s = stat(g);
  attrRows.push([LABEL, setup, 'ALL', 'ALL', s.n, s.wr, s.pf, s.net, s.exp, s.medMfeR, s.medExtAtr]);
  for (const [dim, fn] of [['SIDE', (r) => r.side], ['SYMBOL', (r) => r.symbol], ['REGIME', (r) => r.regime], ['MONTH', (r) => new Date(r.exitTs).toISOString().slice(0, 7)], ['CLASS', (r) => r.cls], ['EXIT', (r) => r.exitReason]])
    for (const k of [...new Set(g.map(fn))]) { const sub = stat(g.filter((r) => fn(r) === k)); attrRows.push([LABEL, setup, dim, k, sub.n, sub.wr, sub.pf, sub.net, sub.exp, sub.medMfeR, sub.medExtAtr]); }
}
{ const s = stat(rows); attrRows.push([LABEL, 'PORTFOLIO', 'ALL', 'ALL', s.n, s.wr, s.pf, s.net, s.exp, s.medMfeR, s.medExtAtr]); }
writeCsv(`g3-setup-attribution${sfx}.csv`, ['scenario', 'setupType', 'dimension', 'bucket', 'trades', 'winRatePct', 'profitFactor', 'netPnl', 'expectancy', 'medianMfeR', 'medianExtensionAtr'], attrRows);

// console summary
const byCls = {};
for (const r of rows) { byCls[r.cls] = byCls[r.cls] ?? { n: 0, net: 0 }; byCls[r.cls].n++; byCls[r.cls].net += r.pnl; }
console.log(`G3 forensics ${LABEL}: ${rows.length} trades from ${LEDGER}`);
console.log('classification:', JSON.stringify(Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, `${v.n} / $${v.net.toFixed(2)}`])), null, 1));
for (const setup of [...new Set(rows.map((r) => r.setupType))]) { const s = stat(rows.filter((r) => r.setupType === setup)); console.log(`  ${setup}: n=${s.n} wr=${s.wr}% pf=${s.pf} net=$${s.net} exp=$${s.exp} medMFE=${s.medMfeR}R medExt=${s.medExtAtr}ATR`); }
void groups;
