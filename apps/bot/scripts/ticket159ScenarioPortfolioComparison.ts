/**
 * TICKET-159 — Scenario/portfolio comparison and holdout/stability/sensitivity consolidation
 * (READ-ONLY; reads already-computed summaries/ledgers, no re-simulation).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SCENARIOS = ['fee_only', 'light', 'central', 'conservative'] as const;
const CHALLENGERS = ['overextension_guard', 'breakout_pullback_continuation'] as const;

interface Portfolio {
  trades: number;
  wins: number;
  winRate: number;
  pf: number | null;
  netPnl: number;
  expectancy: number;
  maxDd: number;
  averageWin: number;
  averageLoss: number;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function csv(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n') + '\n';
}

interface Row {
  [key: string]: string;
}
function parseCsv(filePath: string): Row[] {
  const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function main() {
  const comparisonRows: Record<string, unknown>[] = [];

  for (const scenario of SCENARIOS) {
    const baseline: { portfolio: Portfolio; momentumDirect: Portfolio } = readJson(`ticket157-ob_disabled-${scenario}-summary.json`);
    comparisonRows.push({ candidate: 'CURRENT_ENTRY', scenario: scenario.toUpperCase(), scope: 'PORTFOLIO', ...baseline.portfolio });
    comparisonRows.push({ candidate: 'CURRENT_ENTRY', scenario: scenario.toUpperCase(), scope: 'MOMENTUM_DIRECT', ...baseline.momentumDirect });

    for (const challenger of CHALLENGERS) {
      const summary: { portfolio: Portfolio; momentumDirect: Portfolio } = readJson(`ticket159-${challenger}-${scenario}-summary.json`);
      comparisonRows.push({ candidate: challenger.toUpperCase(), scenario: scenario.toUpperCase(), scope: 'PORTFOLIO', ...summary.portfolio });
      comparisonRows.push({ candidate: challenger.toUpperCase(), scenario: scenario.toUpperCase(), scope: 'MOMENTUM_DIRECT', ...summary.momentumDirect });
    }
  }

  // Focused SHORT ETH/XRP slice, from each candidate's own CENTRAL ledger (the ticket's headline target).
  for (const candidate of ['CURRENT_ENTRY', ...CHALLENGERS.map((c) => c.toUpperCase())]) {
    const ledgerFile =
      candidate === 'CURRENT_ENTRY' ? 'ticket157-ob_disabled-central-ledger.csv' : `ticket159-${candidate.toLowerCase()}-central-ledger.csv`;
    const rows = parseCsv(path.join(DATA_DIR, ledgerFile));
    const focused = rows.filter((row) => (row.symbol === 'ETHUSDT' || row.symbol === 'XRPUSDT') && row.side === 'SHORT');
    const netPnl = focused.reduce((sum, row) => sum + Number(row.netPnl), 0);
    const wins = focused.filter((row) => Number(row.netPnl) > 0).length;
    const gross = focused.filter((row) => Number(row.netPnl) > 0).reduce((sum, row) => sum + Number(row.netPnl), 0);
    const gloss = -focused.filter((row) => Number(row.netPnl) < 0).reduce((sum, row) => sum + Number(row.netPnl), 0);
    comparisonRows.push({
      candidate,
      scenario: 'CENTRAL',
      scope: 'SHORT_ETH_XRP',
      trades: focused.length,
      wins,
      winRate: focused.length ? (wins / focused.length) * 100 : 0,
      pf: gloss ? gross / gloss : null,
      netPnl,
      expectancy: focused.length ? netPnl / focused.length : 0,
      maxDd: '',
      averageWin: wins ? gross / wins : 0,
      averageLoss: focused.length - wins ? -gloss / (focused.length - wins) : 0,
    });
  }

  writeFileSync(path.join(DATA_DIR, 'ticket159-scenario-portfolio-comparison.csv'), csv(comparisonRows));
  console.log(`Wrote ${comparisonRows.length} scenario/portfolio comparison rows.`);
}
main();
