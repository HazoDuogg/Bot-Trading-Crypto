import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_COIN_BACKTEST_CONFIG,
  loadM15CandlesBetween,
} from '../src/backtest/runNukidaBacktest.js';
import { runNukidaWalkForwardRolling } from '../src/backtest/runNukidaWalkForwardRolling.js';
import { createDefaultStrategyAdapter } from '../src/orchestrator/nukidaFsm.js';

// TICKET-028: Setup-B-only comparison of the confirmation-candle filter (Class D,
// experimental) across the same 7 rolling walk-forward windows used since TICKET-021.
// Reuses runNukidaWalkForwardRolling's fsmConfigOverride hook (no engine rewrite) for the
// trade-level PF/netR comparison, and a direct createDefaultStrategyAdapter scan (same
// technique as scripts/calibrateRejectionCandle.ts) for the signal-level filter rate,
// since that is unaffected by downstream entry-fill/expiry mechanics.

async function countSetupBSignals(
  dataDirectory: string,
  startInclusive: number,
  endExclusive: number,
  confirmationCandleEnabled: boolean,
): Promise<number> {
  let total = 0;
  for (const coin of Object.keys(DEFAULT_COIN_BACKTEST_CONFIG)) {
    let candles;
    try {
      candles = await loadM15CandlesBetween(
        path.resolve(dataDirectory, `${coin}_15m_3y.csv`),
        startInclusive,
        endExclusive,
      );
    } catch {
      continue;
    }
    const adapter = createDefaultStrategyAdapter({ setupBConfirmationCandle: confirmationCandleEnabled });
    for (let index = 0; index < candles.length; index += 1) {
      const stage = adapter.onClosedCandle(candles.slice(0, index + 1), index);
      total += stage.setups.filter((setup) => setup.setupFamily === 'B_BREAK_PULLBACK_FAILURE').length;
    }
  }
  return total;
}

async function main(): Promise<void> {
  const dataDirectory = path.resolve(process.cwd(), 'apps/bot/data');

  console.info('Running BASELINE (setupBConfirmationCandle=false) rolling walk-forward...');
  const baseline = await runNukidaWalkForwardRolling(dataDirectory);

  console.info('Running Class D (setupBConfirmationCandle=true) rolling walk-forward...');
  const classD = await runNukidaWalkForwardRolling(dataDirectory, {
    fsmConfigOverride: { setupBConfirmationCandle: true },
  });

  const rows: Array<{
    windowIndex: number;
    baseline: { closedTrades: number; netR: number; profitFactor: number | null };
    classD: { closedTrades: number; netR: number; profitFactor: number | null };
    setupBSignals: { raw: number; passed: number; filteredPct: number | null };
  }> = [];
  for (const baseWindow of baseline.windows) {
    const classDWindow = classD.windows.find((w) => w.window.index === baseWindow.window.index)!;
    const baseB = baseWindow.report.bySetupFamily.B_BREAK_PULLBACK_FAILURE?.realisticCost;
    const classDB = classDWindow.report.bySetupFamily.B_BREAK_PULLBACK_FAILURE?.realisticCost;

    const rawSignals = await countSetupBSignals(
      dataDirectory,
      baseWindow.window.startInclusive,
      baseWindow.window.endExclusive,
      false,
    );
    const passedSignals = await countSetupBSignals(
      dataDirectory,
      baseWindow.window.startInclusive,
      baseWindow.window.endExclusive,
      true,
    );
    const filteredPct = rawSignals === 0 ? null : ((rawSignals - passedSignals) / rawSignals) * 100;

    rows.push({
      windowIndex: baseWindow.window.index,
      baseline: {
        closedTrades: baseB?.closedTrades ?? 0,
        netR: baseB?.netR ?? 0,
        profitFactor: baseB?.profitFactor ?? null,
      },
      classD: {
        closedTrades: classDB?.closedTrades ?? 0,
        netR: classDB?.netR ?? 0,
        profitFactor: classDB?.profitFactor ?? null,
      },
      setupBSignals: { raw: rawSignals, passed: passedSignals, filteredPct },
    });
    console.info(
      `WINDOW ${baseWindow.window.index}: baseline n=${baseB?.closedTrades ?? 0} netR=${(baseB?.netR ?? 0).toFixed(2)} ` +
        `PF=${baseB?.profitFactor?.toFixed(3) ?? 'N/A'} | classD n=${classDB?.closedTrades ?? 0} ` +
        `netR=${(classDB?.netR ?? 0).toFixed(2)} PF=${classDB?.profitFactor?.toFixed(3) ?? 'N/A'} | ` +
        `signals raw=${rawSignals} passed=${passedSignals} filtered=${filteredPct?.toFixed(1) ?? 'N/A'}%`,
    );
  }

  const outputPath = path.resolve(dataDirectory, 'nukida-ticket028-setupB-confirmation-candle.json');
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        note:
          'TICKET-028 Class D experimental comparison: Setup B confirmation-candle filter, ' +
          'baseline (flag off, D1-D8 fingerprint unchanged) vs classD (flag on). Setup B metrics only.',
        rows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.info(`Report: ${outputPath}`);
}

await main();
