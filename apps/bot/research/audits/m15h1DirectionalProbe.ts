import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { computeMeanReversionSignals } from '../../core/entry/meanReversionSignal.js';

// TICKET-04X-T: cheap directional-probability check for an M15-signal/H1-regime combo -- pure
// price direction only, NO TP/SL/$/R/fill simulation of any kind (deliberately excluded per the
// ticket, to answer "is this combo worth a full backtest" before investing in one).
//
// Reuses computeMeanReversionSignals exactly as-is: that function is generic in which two candle
// series/durations it's given (it just needs a "higher timeframe -> regime" series and a "lower
// timeframe -> zscore/signal" series with a causal closed-candle mapping between them). Calling it
// with (h1Candles, m15Candles, H1_MS, M15_MS) instead of (m15Candles, m5Candles, ...) reuses the
// identical algorithm/mapping logic already locked and tested in TICKET-04X-N, just swapping which
// two timeframes play the "regime" and "signal" roles -- no new formula, no parameter re-tuning.
const H1_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const HORIZONS_M15_CANDLES = [4, 8, 16, 40]; // ~1h/2h/4h/10h, locked before running

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

interface HorizonStats {
  horizon: number;
  n: number;
  correct: number;
  pctCorrect: number | null;
}

function evaluate(signals: readonly { signal: 'LONG' | 'SHORT' | 'NONE' }[], m15Candles: readonly Candle[], direction: 'LONG' | 'SHORT' | 'ALL'): HorizonStats[] {
  return HORIZONS_M15_CANDLES.map((horizon) => {
    let n = 0;
    let correct = 0;
    for (let i = 0; i < m15Candles.length; i += 1) {
      const s = signals[i];
      if (s.signal === 'NONE') continue;
      if (direction !== 'ALL' && s.signal !== direction) continue;
      const targetIdx = i + horizon;
      if (targetIdx >= m15Candles.length) continue; // no lookahead past available data
      n += 1;
      const closeNow = m15Candles[i].close;
      const closeFuture = m15Candles[targetIdx].close;
      const isCorrect = s.signal === 'LONG' ? closeFuture > closeNow : closeFuture < closeNow;
      if (isCorrect) correct += 1;
    }
    return { horizon, n, correct, pctCorrect: n === 0 ? null : (100 * correct) / n };
  });
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const auditsDirectory = fileURLToPath(new URL('./', import.meta.url));

  console.info('Loading CSVs...');
  const h1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_1h_3y.csv'));
  const m15Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_15m_3y.csv'));
  console.info(`  H1=${h1Candles.length} M15=${m15Candles.length}`);

  // H1 plays the "regime" role, M15 plays the "signal" role -- same computeMeanReversionSignals
  // call shape as the M15-regime/M5-signal combo, just with the two timeframes shifted up one level.
  const signals = computeMeanReversionSignals(h1Candles, m15Candles, H1_MS, M15_MS);
  const totalSignals = signals.filter((s) => s.signal !== 'NONE').length;
  const longCount = signals.filter((s) => s.signal === 'LONG').length;
  const shortCount = signals.filter((s) => s.signal === 'SHORT').length;
  console.info(`Total signals: ${totalSignals} (LONG=${longCount}, SHORT=${shortCount})`);

  const longStats = evaluate(signals, m15Candles, 'LONG');
  const shortStats = evaluate(signals, m15Candles, 'SHORT');
  const allStats = evaluate(signals, m15Candles, 'ALL');

  console.info('\n########## M15-signal / H1-regime: pure directional accuracy ##########');
  console.info('horizon(M15 candles) | LONG n | LONG %correct | SHORT n | SHORT %correct | ALL n | ALL %correct');
  for (let k = 0; k < HORIZONS_M15_CANDLES.length; k += 1) {
    const l = longStats[k];
    const s = shortStats[k];
    const a = allStats[k];
    console.info(
      `${String(l.horizon).padEnd(21)} | ${String(l.n).padEnd(6)} | ${(l.pctCorrect?.toFixed(2) ?? 'N/A').padEnd(13)} | ` +
        `${String(s.n).padEnd(7)} | ${(s.pctCorrect?.toFixed(2) ?? 'N/A').padEnd(14)} | ${String(a.n).padEnd(5)} | ${a.pctCorrect?.toFixed(2) ?? 'N/A'}`,
    );
  }

  const output = {
    warning:
      'TICKET-04X-T: pure price-direction probe only -- NO TP/SL/$/R/fill simulation. Answers only ' +
      '"does price close in the predicted direction after N candles", not whether that direction is ' +
      'ever captured as profit (spread, fees, and adverse excursion before reaching N are all ignored).',
    generatedAt: new Date().toISOString(),
    horizonsM15Candles: HORIZONS_M15_CANDLES,
    totalSignals,
    longCount,
    shortCount,
    byHorizon: HORIZONS_M15_CANDLES.map((horizon, k) => ({
      horizon,
      long: longStats[k],
      short: shortStats[k],
      all: allStats[k],
    })),
  };

  const outputPath = resolve(auditsDirectory, 'm15h1DirectionalProbe.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.info(`\nOutput: ${outputPath}`);
}

await main();
