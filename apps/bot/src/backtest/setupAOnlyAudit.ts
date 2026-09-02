import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStrategyFingerprint } from '../orchestrator/fingerprint.js';
import {
  TICKET_020_STRATEGY_FINGERPRINT,
  runNukidaWalkForwardRolling,
} from './runNukidaWalkForwardRolling.js';

// TICKET-031: measures whether running Setup A alone (Setup B switched off) beats the
// current A+B baseline on overall portfolio results across the same 7 rolling
// walk-forward windows. This does NOT decide whether to disable Setup B — Vinh Tam makes
// that call after reading this report; it only reports the numbers side by side.

export interface WindowMetricSnapshot {
  closedTrades: number;
  netR: number;
  profitFactor: number | null;
}

export interface SetupFamilyConfigComparisonRow {
  windowIndex: number;
  aOnly: WindowMetricSnapshot;
  aPlusB: WindowMetricSnapshot;
}

export interface SetupAOnlyAuditReport {
  warning: string;
  generatedAt: string;
  fingerprintAOnly: string;
  fingerprintAPlusB: string;
  fingerprintUnchangedFromBaseline: boolean;
  rows: SetupFamilyConfigComparisonRow[];
  totals: {
    aOnly: { closedTrades: number; netR: number };
    aPlusB: { closedTrades: number; netR: number };
    netRDelta: number;
  };
}

function snapshot(metrics: { closedTrades: number; netR: number; profitFactor: number | null }): WindowMetricSnapshot {
  return { closedTrades: metrics.closedTrades, netR: metrics.netR, profitFactor: metrics.profitFactor };
}

export async function buildSetupAOnlyAuditReport(dataDirectory: string): Promise<SetupAOnlyAuditReport> {
  const aPlusB = await runNukidaWalkForwardRolling(dataDirectory);
  const aOnly = await runNukidaWalkForwardRolling(dataDirectory, {
    fsmConfigOverride: { enabledSetupFamilies: ['A_COMPRESSION_BREAKOUT'] },
  });

  const fingerprintAOnly = aOnly.windows[0]?.fingerprint ?? computeStrategyFingerprint().hash;
  const fingerprintAPlusB = aPlusB.windows[0]?.fingerprint ?? computeStrategyFingerprint().hash;

  const rows: SetupFamilyConfigComparisonRow[] = aPlusB.windows.map((withB) => {
    const withoutB = aOnly.windows.find((w) => w.window.index === withB.window.index)!;
    return {
      windowIndex: withB.window.index,
      aOnly: snapshot(withoutB.report.overall.realisticCost),
      aPlusB: snapshot(withB.report.overall.realisticCost),
    };
  });

  const totalNetR = (side: 'aOnly' | 'aPlusB') =>
    rows.reduce((sum, row) => sum + row[side].netR, 0);
  const totalTrades = (side: 'aOnly' | 'aPlusB') =>
    rows.reduce((sum, row) => sum + row[side].closedTrades, 0);

  return {
    warning:
      'MEASUREMENT ONLY: does not decide whether to disable Setup B. See totals.netRDelta ' +
      'for the headline comparison; the decision is made by Vinh Tam after reading this report.',
    generatedAt: new Date().toISOString(),
    fingerprintAOnly,
    fingerprintAPlusB,
    fingerprintUnchangedFromBaseline:
      fingerprintAOnly === TICKET_020_STRATEGY_FINGERPRINT &&
      fingerprintAPlusB === TICKET_020_STRATEGY_FINGERPRINT,
    rows,
    totals: {
      aOnly: { closedTrades: totalTrades('aOnly'), netR: totalNetR('aOnly') },
      aPlusB: { closedTrades: totalTrades('aPlusB'), netR: totalNetR('aPlusB') },
      netRDelta: totalNetR('aOnly') - totalNetR('aPlusB'),
    },
  };
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const report = await buildSetupAOnlyAuditReport(dataDirectory);
  console.info(report.warning);
  console.info(
    `Fingerprint A_ONLY=${report.fingerprintAOnly} A_PLUS_B=${report.fingerprintAPlusB} ` +
      `unchangedFromBaseline=${report.fingerprintUnchangedFromBaseline}`,
  );
  for (const row of report.rows) {
    console.info(
      `WINDOW ${row.windowIndex}: A_ONLY n=${row.aOnly.closedTrades} netR=${row.aOnly.netR.toFixed(2)} ` +
        `PF=${row.aOnly.profitFactor?.toFixed(3) ?? 'N/A'} | A_PLUS_B n=${row.aPlusB.closedTrades} ` +
        `netR=${row.aPlusB.netR.toFixed(2)} PF=${row.aPlusB.profitFactor?.toFixed(3) ?? 'N/A'}`,
    );
  }
  console.info(
    `\nTOTAL 7 windows: A_ONLY netR=${report.totals.aOnly.netR.toFixed(2)} ` +
      `(n=${report.totals.aOnly.closedTrades}) vs A_PLUS_B netR=${report.totals.aPlusB.netR.toFixed(2)} ` +
      `(n=${report.totals.aPlusB.closedTrades}) | delta=${report.totals.netRDelta.toFixed(2)}`,
  );
  const outputPath = resolve(dataDirectory, 'nukida-ticket031-setupA-only-audit.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(`\nReport: ${outputPath}`);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
