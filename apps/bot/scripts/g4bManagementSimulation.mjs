/**
 * G4B — standalone backtest-only simulation of C1 (breakeven-at-1R) / C2 (partial-1.5R-trail-0.5R)
 * against the 23-trade MOMENTUM_DIRECT/MANAGEMENT_DESIGN subset. Reads only data/*.csv. Does NOT
 * touch apps/bot/src. G4B_MOMENTUM_MANAGEMENT env var is documentation-only, read only here.
 * Candidates and parameters are frozen in data/g4b-candidate-registration.md before this ran.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'data');
const csvEscape = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const readCsv = (f) => { const l = readFileSync(f, 'utf-8').trim().split('\n'); const h = l[0].split(','); return { h, rows: l.slice(1).map((r) => parseCsvLine(r)) }; };
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const ledger = readCsv(path.join(OUT, 'g4a-positive-excursion-loss-ledger.csv'));
const central = readCsv(path.join(OUT, 'g3-runs/G3-CENTRAL-trades.csv'));
const intrabar = readCsv(path.join(OUT, 'g4ar-intrabar-per-trade.csv'));

const lh = ledger.h, ch = central.h, ih = intrabar.h;
const lcol = (n) => lh.indexOf(n), ccol = (n) => ch.indexOf(n), icol = (n) => ih.indexOf(n);

const keyCentral = (r) => `${r[ccol('symbol')]}|${r[ccol('entryTimestamp')]}|${r[ccol('setupType')]}`;
const centralByKey = new Map(central.rows.map((r) => [keyCentral(r), r]));
const keyIntrabar = (r) => `${r[icol('symbol')]}|${new Date(r[icol('entryIso')]).getTime()}|${r[icol('setupType')]}`;
const intrabarByKey = new Map(intrabar.rows.map((r) => [keyIntrabar(r), r]));

const mdManagement = ledger.rows.filter((r) => r[lcol('setup')] === 'MOMENTUM_DIRECT' && r[lcol('loss_attribution')] === 'MANAGEMENT_DESIGN');
console.log('MOMENTUM_DIRECT MANAGEMENT_DESIGN population:', mdManagement.length);

function findCentralRow(lr) {
  const symbol = lr[lcol('symbol')], entry = +lr[lcol('entry')];
  // match by symbol + entry price + setup (ledger has no raw entryTimestamp column; entry price is precise enough combined with setup/symbol given no duplicate entry prices observed)
  const candidates = central.rows.filter((r) => r[ccol('symbol')] === symbol && r[ccol('setupType')] === 'MOMENTUM_DIRECT' && Math.abs(+r[ccol('entryPrice')] - entry) < 1e-6);
  return candidates[0] || null;
}

const results = [];
for (const lr of mdManagement) {
  const symbol = lr[lcol('symbol')], side = lr[lcol('side')];
  const entry = +lr[lcol('entry')], sl = +lr[lcol('sl')];
  const mfeR = +lr[lcol('mfe')], maeR = +lr[lcol('mae')];
  const c0Pnl = +lr[lcol('central_net_pnl')];
  const execCostDelta = +lr[lcol('execution_cost_delta')];
  const cRow = findCentralRow(lr);
  const actualRiskDollar = cRow ? +cRow[ccol('actualRiskDollar')] : null;
  const entryIso = cRow ? cRow[ccol('entryIso')] : '';
  const ib = cRow ? intrabarByKey.get(`${symbol}|${cRow[ccol('entryTimestamp')]}|MOMENTUM_DIRECT`) : null;
  const intrabarCls = ib ? ib[icol('classification')] : 'INSUFFICIENT_INTRABAR_EVIDENCE';

  let c1Pnl = c0Pnl, c1Triggered = false;
  if (mfeR >= 1.0 && actualRiskDollar != null) {
    c1Triggered = true;
    c1Pnl = 0 * actualRiskDollar + execCostDelta; // breakeven gross + observed fee cost
  }

  let c2Pnl = c0Pnl, c2Triggered = false;
  if (mfeR >= 1.5 && actualRiskDollar != null) {
    c2Triggered = true;
    c2Pnl = (0.5 * 1.5 + 0.5 * 0.5) * actualRiskDollar + execCostDelta; // = 1.0 * actualRiskDollar + fee
  }

  results.push({
    symbol, side, entry, sl, mfeR, maeR, actualRiskDollar, entryIso, intrabarCls,
    c0Pnl, c1Pnl, c1Triggered, c1Delta: c1Pnl - c0Pnl,
    c2Pnl, c2Triggered, c2Delta: c2Pnl - c0Pnl,
  });
}

const header = ['symbol', 'side', 'entry', 'sl', 'mfeR', 'maeR', 'actualRiskDollar', 'entryIso', 'intrabar_classification',
  'c0_pnl', 'c1_triggered', 'c1_pnl', 'c1_delta', 'c2_triggered', 'c2_pnl', 'c2_delta'];
const outRows = results.map((r) => [r.symbol, r.side, r.entry, r.sl, r.mfeR, r.maeR, r.actualRiskDollar, r.entryIso, r.intrabarCls,
  r.c0Pnl.toFixed(6), r.c1Triggered, r.c1Pnl.toFixed(6), r.c1Delta.toFixed(6), r.c2Triggered, r.c2Pnl.toFixed(6), r.c2Delta.toFixed(6)]);
writeFileSync(path.join(OUT, 'g4b-simulation-results.csv'), [header.join(','), ...outRows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');

function summarize(field) {
  const affected = results.filter((r) => field === 'c1' ? r.c1Triggered : r.c2Triggered);
  const deltaSum = affected.reduce((s, r) => s + (field === 'c1' ? r.c1Delta : r.c2Delta), 0);
  const savedFullLosses = affected.filter((r) => (field === 'c1' ? r.c1Pnl : r.c2Pnl) > r.c0Pnl).length;
  return { n: affected.length, netBenefit: deltaSum, savedFullLosses };
}
console.log('C1 summary (MD MANAGEMENT_DESIGN subset):', summarize('c1'));
console.log('C2 summary (MD MANAGEMENT_DESIGN subset):', summarize('c2'));

// ---- Central 211-trade PF/net recompute under each config ----
function recomputeCentral(deltaByKey) {
  let net = 0, grossWin = 0, grossLoss = 0;
  for (const r of central.rows) {
    let pnl = +r[ccol('netPnl')];
    const k = `${r[ccol('symbol')]}|${+r[ccol('entryPrice')]}`;
    if (deltaByKey.has(k)) pnl = pnl + deltaByKey.get(k);
    net += pnl;
    if (pnl >= 0) grossWin += pnl; else grossLoss += -pnl;
  }
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  return { net, pf, grossWin, grossLoss };
}
const c1DeltaByKey = new Map(results.filter((r) => r.c1Triggered).map((r) => [`${r.symbol}|${r.entry}`, r.c1Delta]));
const c2DeltaByKey = new Map(results.filter((r) => r.c2Triggered).map((r) => [`${r.symbol}|${r.entry}`, r.c2Delta]));
const c0 = recomputeCentral(new Map());
const c1 = recomputeCentral(c1DeltaByKey);
const c2 = recomputeCentral(c2DeltaByKey);
console.log('CENTRAL C0:', c0);
console.log('CENTRAL C1:', c1);
console.log('CENTRAL C2:', c2);

writeFileSync(path.join(OUT, 'g4b-central-recompute.json'), JSON.stringify({ c0, c1, c2, c1n: c1DeltaByKey.size, c2n: c2DeltaByKey.size }, null, 2));
console.log('wrote data/g4b-simulation-results.csv and data/g4b-central-recompute.json');
