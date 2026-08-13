/**
 * TICKET-G2R P1 — consolidates the per-(variant,scenario) runs produced by g2rVariantReplay.ts into
 * the ticket's required comparison artifacts. Pure post-processing of existing run outputs; runs no
 * simulation of its own.
 *   data/g2r-neutral-full-orchestrator-comparison.csv
 *   data/g2r-neutral-trade-reconciliation.csv
 *   data/g2r-cooldown-comparison.csv
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const RUN_DIR = path.resolve(process.cwd(), 'data/g2r-runs');
const OUT_DIR = path.resolve(process.cwd(), 'data');

// A breakdown bucket below this many trades cannot support a conclusion — labelled, never dropped.
const THIN_SAMPLE_MIN = 20;

interface Trade {
  variant: string; scenario: string; tradeSource: string; symbol: string; side: string;
  setupType: string; regime: string; entryTimestamp: number; exitTimestamp: number;
  exitReason: string; netPnl: number;
}

const csvEscape = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file: string, header: string[], rows: unknown[][]): void => {
  writeFileSync(path.join(OUT_DIR, file), [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n');
  console.log(`wrote data/${file} (${rows.length} rows)`);
};

/**
 * `C0_CURRENT` and `N0_CURRENT` are the SAME run by construction — hooksFor() returns `undefined`
 * for both, so runReplay takes the identical code path with identical inputs and is deterministic.
 * Aliasing avoids a redundant ~15-minute replay; every aliased row is labelled in its `note` column.
 */
function resolveRun(variant: string, scenario: string): { variant: string; aliased: boolean } {
  if (variant === 'C0_CURRENT' && !existsSync(path.join(RUN_DIR, `C0_CURRENT-${scenario}-trades.csv`)) && existsSync(path.join(RUN_DIR, `N0_CURRENT-${scenario}-trades.csv`))) {
    return { variant: 'N0_CURRENT', aliased: true };
  }
  return { variant, aliased: false };
}

function loadTrades(variantIn: string, scenario: string): Trade[] | null {
  const { variant } = resolveRun(variantIn, scenario);
  const f = path.join(RUN_DIR, `${variant}-${scenario}-trades.csv`);
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = cells[i]));
    return {
      variant: o.variant, scenario: o.scenario, tradeSource: o.tradeSource, symbol: o.symbol, side: o.side,
      setupType: o.setupType, regime: o.regime, entryTimestamp: Number(o.entryTimestamp), exitTimestamp: Number(o.exitTimestamp),
      exitReason: o.exitReason, netPnl: Number(o.netPnl),
    };
  });
}
function loadSummary(variantIn: string, scenario: string): Record<string, unknown> | null {
  const { variant } = resolveRun(variantIn, scenario);
  const f = path.join(RUN_DIR, `${variant}-${scenario}-summary.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null;
}

interface Stats { n: number; wins: number; wr: number; pf: number; net: number; expectancy: number; maxDdPct: number; maxDdUsd: number }
function stats(trades: Trade[], startBalance = 100): Stats {
  const sorted = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
  let balance = startBalance, peak = startBalance, maxDdPct = 0, maxDdUsd = 0, gp = 0, gl = 0, wins = 0;
  for (const t of sorted) {
    balance += t.netPnl;
    if (t.netPnl > 0) { wins++; gp += t.netPnl; } else gl += Math.abs(t.netPnl);
    if (balance > peak) peak = balance;
    const ddUsd = peak - balance;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
  }
  const n = sorted.length;
  return { n, wins, wr: n > 0 ? (wins / n) * 100 : NaN, pf: gl > 0 ? gp / gl : wins > 0 ? Infinity : NaN, net: balance - startBalance, expectancy: n > 0 ? (balance - startBalance) / n : NaN, maxDdPct, maxDdUsd };
}
const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const month = (ts: number): string => new Date(ts).toISOString().slice(0, 7);

/** Confirmed DANGER_ZONE / MANIPULATED entry timestamps per symbol, from the production run's own diagnostic logs. */
function loadRegimeEpisodes(file: string, tag: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!existsSync(path.join(OUT_DIR, file))) return out;
  const re = new RegExp(`\\[${tag}\\] symbol=(\\w+) timestamp=([0-9TZ:.\\-]+)`);
  for (const line of readFileSync(path.join(OUT_DIR, file), 'utf8').split('\n')) {
    const m = re.exec(line);
    if (m === null) continue;
    (out[m[1]] = out[m[1]] ?? []).push(Date.parse(m[2]));
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}
/** Trades opened within `hours` AFTER a confirmed episode candle on the SAME symbol. */
function tradesInsideEpisodes(trades: Trade[], episodes: Record<string, number[]>, hours: number): { count: number; net: number } {
  const windowMs = hours * 3_600_000;
  let count = 0, net = 0;
  for (const t of trades) {
    const list = episodes[t.symbol];
    if (list === undefined) continue;
    // binary search for the newest episode candle at or before this entry
    let lo = 0, hi = list.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid] <= t.entryTimestamp) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found >= 0 && t.entryTimestamp - list[found] <= windowMs) { count++; net += t.netPnl; }
  }
  return { count, net };
}

function main(): void {
  const available = existsSync(RUN_DIR) ? readdirSync(RUN_DIR).filter((f) => f.endsWith('-summary.json')).map((f) => f.replace('-summary.json', '')) : [];
  console.log(`runs found: ${available.join(', ')}`);

  const SCENARIOS = ['FEE_ONLY', 'LIGHT', 'CENTRAL', 'CONSERVATIVE'];
  const NEUTRAL_VARIANTS = ['N0_CURRENT', 'N1_BLOCK_ALL', 'N2_NO_POST_DANGER_DOWNGRADE'];
  const COOLDOWN_VARIANTS = ['C0_CURRENT', 'C1_ENTRY_ANCHORED', 'C2_SHORTER_WINDOW'];

  // ---------------------------------------------------------------- NEUTRAL comparison
  const nRows: unknown[][] = [];
  const push = (variant: string, scenario: string, scope: string, key: string, s: Stats, note: string): void => {
    nRows.push([variant, scenario, 'BACKTEST_PROXY', scope, key, s.n, s.wins, fmt(s.wr), fmt(s.pf), fmt(s.net), fmt(s.expectancy), fmt(s.maxDdPct), fmt(s.maxDdUsd),
      s.n < THIN_SAMPLE_MIN ? `THIN_SAMPLE(n<${THIN_SAMPLE_MIN}) — not conclusive` : '', note]);
  };

  for (const scenario of SCENARIOS) {
    for (const variant of NEUTRAL_VARIANTS) {
      const trades = loadTrades(variant, scenario);
      if (trades === null) { nRows.push([variant, scenario, 'BACKTEST_PROXY', 'OVERALL', 'ALL', '', '', '', '', '', '', '', '', '', 'NOT_RUN — outside this session\'s completed budget']); continue; }
      const sum = loadSummary(variant, scenario);
      push(variant, scenario, 'OVERALL', 'ALL', stats(trades), `neutralConfirmedSteps=${sum?.neutralConfirmedSteps ?? ''};entryBlockedSteps=${sum?.entryBlockedSteps ?? ''}`);
      const groups: Array<[string, (t: Trade) => string]> = [
        ['SETUP', (t) => t.setupType], ['REGIME', (t) => t.regime], ['SYMBOL', (t) => t.symbol],
        ['SIDE', (t) => t.side], ['MONTH', (t) => month(t.exitTimestamp)], ['EXIT_REASON', (t) => t.exitReason],
      ];
      for (const [scope, keyFn] of groups) {
        const buckets: Record<string, Trade[]> = {};
        for (const t of trades) (buckets[keyFn(t)] = buckets[keyFn(t)] ?? []).push(t);
        for (const k of Object.keys(buckets).sort()) push(variant, scenario, scope, k, stats(buckets[k]), '');
      }
      // leave-one-month-out (LEDGER-LEVEL: recomputed from this variant's own realized ledger, NOT a
      // re-simulated holdout — path dependence is therefore NOT re-derived. Labelled as such.)
      const months = [...new Set(trades.map((t) => month(t.exitTimestamp)))].sort();
      for (const m of months) {
        push(variant, scenario, 'LOMO_EXCLUDING', m, stats(trades.filter((t) => month(t.exitTimestamp) !== m)), 'LEDGER_LEVEL_LOMO — not a re-simulated holdout');
      }
    }
  }
  writeCsv('g2r-neutral-full-orchestrator-comparison.csv',
    ['variant', 'scenario', 'tradeSource', 'scope', 'key', 'trades', 'wins', 'winRatePct', 'profitFactor', 'netPnl', 'expectancy', 'maxDdPct', 'maxDdUsd', 'thinSampleLabel', 'note'],
    nRows);

  // ---------------------------------------------------------------- NEUTRAL trade reconciliation vs N0
  const rRows: unknown[][] = [];
  const idOf = (t: Trade): string => `${t.symbol}|${t.side}|${t.entryTimestamp}`;
  for (const scenario of SCENARIOS) {
    const base = loadTrades('N0_CURRENT', scenario);
    if (base === null) continue;
    const baseMap = new Map(base.map((t) => [idOf(t), t]));
    for (const variant of NEUTRAL_VARIANTS.filter((v) => v !== 'N0_CURRENT').concat(COOLDOWN_VARIANTS.filter((v) => v !== 'C0_CURRENT'))) {
      const cand = loadTrades(variant, scenario);
      if (cand === null) continue;
      const candMap = new Map(cand.map((t) => [idOf(t), t]));
      for (const [id, t] of baseMap) {
        const other = candMap.get(id);
        if (other === undefined) {
          rRows.push([scenario, variant, 'BACKTEST_PROXY', 'ONLY_IN_N0_CURRENT', t.symbol, t.side, t.setupType, t.regime, new Date(t.entryTimestamp).toISOString(), new Date(t.exitTimestamp).toISOString(), t.exitReason, fmt(t.netPnl), '', 'suppressed by the variant']);
        } else if (Math.abs(other.netPnl - t.netPnl) > 1e-6 || other.exitTimestamp !== t.exitTimestamp) {
          rRows.push([scenario, variant, 'BACKTEST_PROXY', 'PATH_DIVERGED', t.symbol, t.side, t.setupType, t.regime, new Date(t.entryTimestamp).toISOString(), new Date(t.exitTimestamp).toISOString(), t.exitReason, fmt(t.netPnl), fmt(other.netPnl), 'same entry identity, different outcome — path/balance divergence']);
        }
      }
      for (const [id, t] of candMap) {
        if (!baseMap.has(id)) rRows.push([scenario, variant, 'BACKTEST_PROXY', 'ONLY_IN_VARIANT', t.symbol, t.side, t.setupType, t.regime, new Date(t.entryTimestamp).toISOString(), new Date(t.exitTimestamp).toISOString(), t.exitReason, '', fmt(t.netPnl), 'restored/created by the variant']);
      }
    }
  }
  writeCsv('g2r-neutral-trade-reconciliation.csv',
    ['scenario', 'variant', 'tradeSource', 'diffType', 'symbol', 'side', 'setupType', 'regimeAtEntry', 'entryIso', 'exitIso', 'exitReason', 'n0NetPnl', 'variantNetPnl', 'explanation'],
    rRows);

  // ---------------------------------------------------------------- cooldown comparison
  const dangerEpisodes = loadRegimeEpisodes('danger-zone-log.txt', 'DANGER_ZONE');
  const manipEpisodes = loadRegimeEpisodes('manipulated-log.txt', 'MANIPULATED');
  console.log(`danger episodes: ${Object.entries(dangerEpisodes).map(([k, v]) => `${k}=${v.length}`).join(';')}`);
  console.log(`manipulated episodes: ${Object.entries(manipEpisodes).map(([k, v]) => `${k}=${v.length}`).join(';')}`);

  const cRows: unknown[][] = [];
  for (const scenario of SCENARIOS) {
    for (const variant of COOLDOWN_VARIANTS) {
      const trades = loadTrades(variant, scenario);
      if (trades === null) { cRows.push([variant, scenario, 'BACKTEST_PROXY', 'OVERALL', 'ALL', '', '', '', '', '', '', '', '', 'NOT_RUN — outside this session\'s completed budget']); continue; }
      const s = stats(trades);
      const sum = loadSummary(variant, scenario);
      const alias = resolveRun(variant, scenario);
      cRows.push([variant, scenario, 'BACKTEST_PROXY', 'OVERALL', 'ALL', s.n, fmt(s.wr), fmt(s.pf), fmt(s.net), fmt(s.expectancy), fmt(s.maxDdPct), fmt(s.maxDdUsd),
        s.n < THIN_SAMPLE_MIN ? `THIN_SAMPLE(n<${THIN_SAMPLE_MIN})` : '',
        `neutralConfirmedSteps=${sum?.neutralConfirmedSteps ?? ''}${alias.aliased ? `;ALIASED_TO=${alias.variant}-${scenario} (identical code path, hooks disabled in both)` : ''}`]);
      // PROTECTION CHECK — more trading inside known-dangerous periods is a RED FLAG, not a win.
      for (const [tag, eps, hrs] of [['DANGER_72H', dangerEpisodes, 72], ['DANGER_24H', dangerEpisodes, 24], ['MANIPULATED_24H', manipEpisodes, 24]] as Array<[string, Record<string, number[]>, number]>) {
        const r = tradesInsideEpisodes(trades, eps, hrs);
        cRows.push([variant, scenario, 'BACKTEST_PROXY', 'PROTECTION', tag, r.count, '', '', fmt(r.net), '', '', '', '', `trades opened within ${hrs}h of a confirmed episode candle on the same symbol — HIGHER = LESS PROTECTED`]);
      }
      for (const [scope, keyFn] of [['SYMBOL', (t: Trade) => t.symbol], ['SIDE', (t: Trade) => t.side], ['MONTH', (t: Trade) => month(t.exitTimestamp)]] as Array<[string, (t: Trade) => string]>) {
        const buckets: Record<string, Trade[]> = {};
        for (const t of trades) (buckets[keyFn(t)] = buckets[keyFn(t)] ?? []).push(t);
        for (const k of Object.keys(buckets).sort()) {
          const b = stats(buckets[k]);
          cRows.push([variant, scenario, 'BACKTEST_PROXY', scope, k, b.n, fmt(b.wr), fmt(b.pf), fmt(b.net), fmt(b.expectancy), fmt(b.maxDdPct), fmt(b.maxDdUsd), b.n < THIN_SAMPLE_MIN ? `THIN_SAMPLE(n<${THIN_SAMPLE_MIN})` : '', '']);
        }
      }
      const months = [...new Set(trades.map((t) => month(t.exitTimestamp)))].sort();
      for (const m of months) {
        const b = stats(trades.filter((t) => month(t.exitTimestamp) !== m));
        cRows.push([variant, scenario, 'BACKTEST_PROXY', 'LOMO_EXCLUDING', m, b.n, fmt(b.wr), fmt(b.pf), fmt(b.net), fmt(b.expectancy), fmt(b.maxDdPct), fmt(b.maxDdUsd), '', 'LEDGER_LEVEL_LOMO — not a re-simulated holdout']);
      }
    }
  }
  writeCsv('g2r-cooldown-comparison.csv',
    ['variant', 'scenario', 'tradeSource', 'scope', 'key', 'trades', 'winRatePct', 'profitFactor', 'netPnl', 'expectancy', 'maxDdPct', 'maxDdUsd', 'thinSampleLabel', 'note'],
    cRows);
}

main();
