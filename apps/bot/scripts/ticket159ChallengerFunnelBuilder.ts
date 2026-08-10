/**
 * TICKET-159 — Challenger funnel and trade reconciliation (READ-ONLY, no re-simulation).
 *
 * Joins the frozen baseline ledger (`ticket157-ob_disabled-*-ledger.csv`) against each challenger's
 * already-computed ledger (`ticket159-<variant>-<scenario>-ledger.csv`) by orderId
 * (`symbol-entryTimestamp`), across all four cost scenarios. For MOMENTUM_DIRECT trades the baseline
 * has but a challenger dropped, the OVEREXTENSION_GUARD block reason is resolved exactly from the
 * Step 1 timing dataset's decision-time geometry (same function the production gate itself uses).
 * BREAKOUT_PULLBACK_CONTINUATION's own INVALIDATED/TIMEOUT/GEOMETRY_BLOCKED distinction requires
 * replaying its stateful arm/advance machinery candle-by-candle, which this pass does not attempt
 * (documented as a limitation, not guessed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { momentumGuardBlockReason } from '../dist/backtest/momentumEntryTimingResearch.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SCENARIOS = ['fee_only', 'light', 'central', 'conservative'] as const;
const VARIANTS = ['overextension_guard', 'breakout_pullback_continuation'] as const;

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

function main() {
  const timingRows = parseCsv(path.join(DATA_DIR, 'ticket159-timing-dataset.csv'));
  const timingByOrderId = new Map(timingRows.map((row) => [row.orderId, row]));

  const funnelRows: Record<string, unknown>[] = [];

  for (const scenario of SCENARIOS) {
    const baseline = parseCsv(path.join(DATA_DIR, `ticket157-ob_disabled-${scenario}-ledger.csv`));
    const baselineByOrderId = new Map(baseline.map((row) => [row.orderId, row]));

    for (const variant of VARIANTS) {
      const challengerFile = path.join(DATA_DIR, `ticket159-${variant}-${scenario}-ledger.csv`);
      const challenger = parseCsv(challengerFile);
      const challengerByOrderId = new Map(challenger.map((row) => [row.orderId, row]));

      for (const [orderId, baseRow] of baselineByOrderId) {
        const challengerRow = challengerByOrderId.get(orderId);
        const status = challengerRow ? 'RETAINED' : 'REMOVED';
        let blockReason = '';
        if (!challengerRow && baseRow.setup === 'MOMENTUM_DIRECT') {
          const timing = timingByOrderId.get(orderId);
          if (variant === 'overextension_guard' && timing) {
            const extensionAtr = timing.extensionAtr === '' ? null : Number(timing.extensionAtr);
            const availableRewardR = timing.availableRewardR === '' ? null : Number(timing.availableRewardR);
            const geometry = extensionAtr === null ? null : { extensionAtr, availableRewardR, triggerLevel: 0, triggerTimestamp: 0, atr14: 0, structuralBoundary: null };
            blockReason = momentumGuardBlockReason(geometry, 1.0, 1.2) ?? 'NOT_MOMENTUM_DIRECT_OR_UNBLOCKED_BY_GUARD';
          } else if (variant === 'breakout_pullback_continuation') {
            blockReason = 'REQUIRES_STATEFUL_ARM_REPLAY_NOT_COMPUTED_THIS_PASS';
          } else {
            blockReason = 'NO_DECISION_TIME_GEOMETRY_AVAILABLE';
          }
        }
        funnelRows.push({
          scenario: scenario.toUpperCase(),
          variant: variant.toUpperCase(),
          orderId,
          symbol: baseRow.symbol,
          side: baseRow.side,
          baselineSetup: baseRow.setup,
          status,
          blockReason,
          baselineNetPnl: baseRow.netPnl,
          challengerNetPnl: challengerRow?.netPnl ?? '',
        });
      }

      for (const [orderId, challengerRow] of challengerByOrderId) {
        if (!baselineByOrderId.has(orderId)) {
          funnelRows.push({
            scenario: scenario.toUpperCase(),
            variant: variant.toUpperCase(),
            orderId,
            symbol: challengerRow.symbol,
            side: challengerRow.side,
            baselineSetup: '',
            status: 'ADDED_OR_DELAYED',
            blockReason: 'path_dependent_divergence_downstream_of_earlier_blocked_trade_changing_balance_sizing',
            baselineNetPnl: '',
            challengerNetPnl: challengerRow.netPnl,
          });
        }
      }
    }
  }

  writeFileSync(path.join(DATA_DIR, 'ticket159-challenger-funnel.csv'), csv(funnelRows));

  const counts = new Map<string, Record<string, number>>();
  for (const row of funnelRows) {
    const key = `${row.variant}|${row.scenario}`;
    const bucket = counts.get(key) ?? { RETAINED: 0, REMOVED: 0, ADDED_OR_DELAYED: 0 };
    bucket[row.status as string]++;
    counts.set(key, bucket);
  }
  console.log(JSON.stringify(Object.fromEntries(counts), null, 2));
}
main();
