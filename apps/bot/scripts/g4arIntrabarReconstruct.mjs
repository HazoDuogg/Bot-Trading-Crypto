/**
 * G4A-R item 3/6 — reconstruct real intrabar touch order from 1m OHLCV for the old 52-trade
 * bucket (and the full 211-trade CENTRAL set, cheap to run). No inference from entry time or
 * exit-reason label; only actual 1m candle price touches. Writes data/g4a-intrabar-ordering-audit.csv
 * (per-trade rows appended after the existing structural findings) and prints a summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'data');
const OHLCV = path.resolve(process.cwd(), 'data/ohlcv');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const PLAN_A = { tp1R: 1.2, tp2R: 2.5 };
// G4A-R HOTFIX: was hard-coded 1; real frozen config momentumDirectTpRMultiple=3.0
// (apps/bot/src/orchestrator/types.ts, CLI default --momentum-direct-tp-r-multiple=3.0 in
// docs/baseline-registry.md PROD_8FLAG_POST_T152 and every g3r/g1r baseline-parity report).
const MOMENTUM_DIRECT_TP_R_MULTIPLE = 3.0;

function readOhlcv1m(symbol) {
  const lines = readFileSync(path.join(OHLCV, `${symbol}_1m.csv`), 'utf-8').trim().split('\n').slice(1);
  return lines.map((l) => { const p = l.split(','); return { t: +p[0], o: +p[2], h: +p[3], l: +p[4], c: +p[5] }; });
}
const D1 = {};
for (const s of SYMBOLS) D1[s] = readOhlcv1m(s);

const csvEscape = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const trades = readFileSync(path.join(OUT, 'g3-runs/G3-CENTRAL-trades.csv'), 'utf-8').trim().split('\n');
const H = trades[0].split(',');
const col = (n) => H.indexOf(n);
const rows = trades.slice(1).map((l) => l.split(','));

function levelsFor(symbol, side, setupType, entryPrice, slPrice) {
  const dir = side === 'LONG' ? 1 : -1;
  const R = Math.abs(entryPrice - slPrice);
  if (setupType === 'MOMENTUM_DIRECT') {
    // Single fixed target at momentumDirectTpRMultiple x R (real frozen config, not an assumption).
    return { tp1: entryPrice + dir * MOMENTUM_DIRECT_TP_R_MULTIPLE * R, tp2: null, sl: slPrice, R };
  }
  return { tp1: entryPrice + dir * PLAN_A.tp1R * R, tp2: entryPrice + dir * PLAN_A.tp2R * R, sl: slPrice, R };
}

function touchTs(candles, startTs, endTs, side, level, kind) {
  // kind: 'tp' (favorable) or 'sl' (adverse). Returns first 1m candle ts where level is touched.
  const dir = side === 'LONG' ? 1 : -1;
  for (const c of candles) {
    if (c.t < startTs || c.t > endTs) continue;
    const hit = kind === 'tp'
      ? (dir > 0 ? c.h >= level : c.l <= level)
      : (dir > 0 ? c.l <= level : c.h >= level);
    if (hit) return c.t;
  }
  return null;
}

const results = [];
for (const p of rows) {
  const symbol = p[col('symbol')], side = p[col('side')], setupType = p[col('setupType')];
  const entryTs = +p[col('entryTimestamp')], exitTs = +p[col('exitTimestamp')];
  const entryPrice = +p[col('entryPrice')], slPrice = +p[col('slPrice')];
  const exitReason = p[col('exitReason')];
  const candles = D1[symbol];
  if (!candles || !candles.length) { results.push({ symbol, side, setupType, entryTs, exitReason, cls: 'INSUFFICIENT_INTRABAR_EVIDENCE', detail: 'no 1m file for symbol' }); continue; }
  const cov = candles[0].t <= entryTs && candles[candles.length - 1].t >= exitTs;
  if (!cov) { results.push({ symbol, side, setupType, entryTs, exitReason, cls: 'INSUFFICIENT_INTRABAR_EVIDENCE', detail: '1m coverage does not span entry-exit window' }); continue; }

  const lv = levelsFor(symbol, side, setupType, entryPrice, slPrice);
  const tp1Ts = touchTs(candles, entryTs, exitTs, side, lv.tp1, 'tp');
  const tp2Ts = lv.tp2 != null ? touchTs(candles, entryTs, exitTs, side, lv.tp2, 'tp') : null;
  const slTs = touchTs(candles, entryTs, exitTs, side, lv.sl, 'sl');

  // Determine order among touched events using their 1m timestamps; same 1m candle = AMBIGUOUS.
  const events = [['TP1', tp1Ts], ['TP2', tp2Ts], ['SL', slTs]].filter(([, ts]) => ts != null);
  events.sort((a, b) => a[1] - b[1]);
  let cls;
  if (events.length === 0) cls = 'INSUFFICIENT_INTRABAR_EVIDENCE'; // static TP1/TP2/orig-SL not touched -- likely trailing/runner phase moved SL dynamically, beyond this script's static-level model
  else if (events.length > 1 && events[0][1] === events[1][1]) cls = 'AMBIGUOUS';
  else cls = 'CONFIRMED';

  results.push({ symbol, side, setupType, entryTs, exitReason, tp1Ts, tp2Ts, slTs, order: events.map((e) => e[0]).join('>'), cls, detail: '' });
}

const byCls = {};
for (const r of results) byCls[r.cls] = (byCls[r.cls] || 0) + 1;
console.log('intrabar reconstruction (211 CENTRAL):', byCls);

const header = ['symbol', 'side', 'setupType', 'entryIso', 'exitReason', 'tp1TouchIso', 'tp2TouchIso', 'slTouchIso', 'touchOrder', 'classification', 'detail'];
const outRows = results.map((r) => [r.symbol, r.side, r.setupType, new Date(r.entryTs).toISOString(), r.exitReason,
  r.tp1Ts ? new Date(r.tp1Ts).toISOString() : '', r.tp2Ts ? new Date(r.tp2Ts).toISOString() : '', r.slTs ? new Date(r.slTs).toISOString() : '',
  r.order ?? '', r.cls, r.detail]);
writeFileSync(path.join(OUT, 'g4ar-intrabar-per-trade.csv'), [header.join(','), ...outRows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');
console.log('wrote data/g4ar-intrabar-per-trade.csv,', results.length, 'rows');
