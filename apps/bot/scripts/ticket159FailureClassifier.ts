/**
 * TICKET-159 Step 2 — Failure classification over the Step 1 timing dataset (READ-ONLY).
 *
 * Anti-leakage rule (ticket requirement): classification thresholds are frozen using ONLY the
 * chronological development portion (first 70% of MOMENTUM_DIRECT trades by entryTimestamp) before
 * any holdout-period number is computed. The 70/30 split point matches the same convention already
 * used by ticket159Consolidate.ts's holdout split, so results are comparable.
 *
 * Classes (evaluated in this fixed priority order per trade):
 *   THESIS_FAILURE      — loser with MFE < 0.2R (thesis never developed any favorable excursion)
 *   LATE_OR_OVEREXTENDED— loser with decision-time extensionAtr above the frozen dev-P75 AND
 *                         adverse-first (or same-candle-ambiguous) timing evidence
 *   PULLBACK_SURVIVABLE — reached >= 0.3R adverse excursion (a real pullback) but closed profitable
 *   ROBUST_ENTRY        — winner with adverse excursion below 0.3R (clean favorable path)
 *   AMBIGUOUS           — none of the above resolves cleanly (incl. missing ATR/geometry data)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');

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

function csv(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n') + '\n';
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

type FailureClass = 'THESIS_FAILURE' | 'LATE_OR_OVEREXTENDED' | 'PULLBACK_SURVIVABLE' | 'ROBUST_ENTRY' | 'AMBIGUOUS';

function classify(row: Row, extensionAtrDevP75: number): { classification: FailureClass; reason: string } {
  const realizedR = Number(row.realizedR);
  const mfeR = Number(row.mfeR);
  const maeR = Number(row.maeR);
  const extensionAtr = row.extensionAtr === '' ? null : Number(row.extensionAtr);
  const adverseFirst = row.adverseFirst;
  const sameCandleAmbiguous = row.sameCandleAmbiguous === 'true';
  const isLoser = realizedR < 0;
  const isWinner = realizedR > 0;

  if (extensionAtr === null || Number.isNaN(mfeR) || Number.isNaN(maeR)) {
    return { classification: 'AMBIGUOUS', reason: 'missing decision-time or excursion data' };
  }
  if (isLoser && mfeR < 0.2) {
    return { classification: 'THESIS_FAILURE', reason: `loser with MFE ${mfeR.toFixed(3)}R < 0.2R threshold` };
  }
  if (isLoser && extensionAtr > extensionAtrDevP75 && (adverseFirst === 'true' || sameCandleAmbiguous)) {
    return {
      classification: 'LATE_OR_OVEREXTENDED',
      reason: `loser with extension ${extensionAtr.toFixed(3)}ATR > dev-P75 ${extensionAtrDevP75.toFixed(3)}ATR and adverse-first/ambiguous timing`,
    };
  }
  if (isWinner && maeR >= 0.3) {
    return { classification: 'PULLBACK_SURVIVABLE', reason: `winner survived ${maeR.toFixed(3)}R adverse excursion before closing profitable` };
  }
  if (isWinner && maeR < 0.3) {
    return { classification: 'ROBUST_ENTRY', reason: `winner with clean path, MAE ${maeR.toFixed(3)}R < 0.3R` };
  }
  return { classification: 'AMBIGUOUS', reason: 'evidence does not resolve into a single mechanism' };
}

function monthOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

function main() {
  const rows = parseCsv(path.join(DATA_DIR, 'ticket159-timing-dataset.csv'));
  const sorted = [...rows].sort((a, b) => Number(a.entryTimestamp) - Number(b.entryTimestamp));

  // Freeze the chronological development/holdout split BEFORE deriving any threshold or looking at
  // holdout numbers. 70/30 by count, matching the existing T159 holdout convention in this repo.
  const developmentCount = Math.floor(sorted.length * 0.7);
  const developmentRows = sorted.slice(0, developmentCount);
  const holdoutRows = sorted.slice(developmentCount);
  const splitTimestamp = Number(sorted[developmentCount]?.entryTimestamp ?? sorted[sorted.length - 1].entryTimestamp);

  const devExtensions = developmentRows.map((r) => Number(r.extensionAtr)).filter((v) => !Number.isNaN(v));
  const extensionAtrDevP75 = percentile(devExtensions, 0.75);

  const classified = sorted.map((row) => {
    const { classification, reason } = classify(row, extensionAtrDevP75);
    return {
      orderId: row.orderId,
      symbol: row.symbol,
      side: row.side,
      regime: row.regime,
      month: monthOf(Number(row.entryTimestamp)),
      phase: Number(row.entryTimestamp) < splitTimestamp ? 'DEVELOPMENT' : 'HOLDOUT',
      entryTimestamp: row.entryTimestamp,
      extensionAtr: row.extensionAtr,
      mfeR: row.mfeR,
      maeR: row.maeR,
      realizedR: row.realizedR,
      realizedPnlTheoretical: row.realizedPnlTheoretical,
      classification,
      reason,
    };
  });

  writeFileSync(path.join(DATA_DIR, 'ticket159-failure-classification.csv'), csv(classified));

  const byGroup = (keyFn: (r: (typeof classified)[number]) => string) => {
    const groups = new Map<string, Record<FailureClass, number>>();
    for (const row of classified) {
      const key = keyFn(row);
      const bucket = groups.get(key) ?? { THESIS_FAILURE: 0, LATE_OR_OVEREXTENDED: 0, PULLBACK_SURVIVABLE: 0, ROBUST_ENTRY: 0, AMBIGUOUS: 0 };
      bucket[row.classification as FailureClass]++;
      groups.set(key, bucket);
    }
    return groups;
  };

  const summaryRows: Record<string, unknown>[] = [];
  for (const [dimension, keyFn] of [
    ['symbol', (r: (typeof classified)[number]) => r.symbol],
    ['side', (r: (typeof classified)[number]) => r.side],
    ['month', (r: (typeof classified)[number]) => r.month],
    ['regime', (r: (typeof classified)[number]) => r.regime],
    ['symbol_side', (r: (typeof classified)[number]) => `${r.symbol}_${r.side}`],
  ] as const) {
    const groups = byGroup(keyFn);
    for (const [group, counts] of groups) {
      summaryRows.push({ dimension, group, ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
    }
  }
  writeFileSync(path.join(DATA_DIR, 'ticket159-failure-classification-by-group.csv'), csv(summaryRows));

  const totals = classified.reduce(
    (acc, row) => {
      acc[row.classification as FailureClass]++;
      return acc;
    },
    { THESIS_FAILURE: 0, LATE_OR_OVEREXTENDED: 0, PULLBACK_SURVIVABLE: 0, ROBUST_ENTRY: 0, AMBIGUOUS: 0 } as Record<FailureClass, number>,
  );

  console.log(JSON.stringify({ totalTrades: classified.length, developmentCount, holdoutCount: holdoutRows.length, splitTimestamp, extensionAtrDevP75, totals }, null, 2));
}
main();
