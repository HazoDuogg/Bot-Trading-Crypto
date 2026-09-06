import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../backtest/engine/noTradeZone/types.js';
import { simulateLimitFill } from '../../backtest/engine/limitFillSimulation.js';

// TICKET-04X-M sensitivity step: measures ONLY fill rate / time-to-fill across N — no PnL/netR,
// no real signal. Synthetic orders only: at fixed daily anchors across the full BTC M1 history,
// place a hypothetical limit at each of a fixed set of % offsets from that instant's price, both
// directions, then check whether/when it fills within a bounded horizon.
const BTC_TICK_SIZE = 0.1; // matches DEFAULT_COIN_BACKTEST_CONFIG.BTCUSDT.tickSize
const N_VALUES = [0, 1, 2, 3];
// "Cách đều nhau theo % cố định": an evenly-spaced (0.1%-step) grid of offsets, not tied to any
// real entry/signal logic.
const OFFSET_PERCENTAGES = [0.001, 0.002, 0.003, 0.004, 0.005];
const ANCHOR_STRIDE_CANDLES = 1440; // ~1 day, keeps the sweep tractable over 3y of M1 data
const HORIZON_CANDLES = 4320; // 3 days, same ceiling POSITION_MANAGEMENT_V2_MAX_M1_CANDLES uses

async function loadCsv(csvPath: string): Promise<Candle[]> {
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

async function main(): Promise<void> {
  const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
  const m1Candles = await loadCsv(resolve(dataDirectory, 'BTCUSDT_rt094_1m.csv'));
  console.info(`Loaded ${m1Candles.length} BTC M1 candles`);

  const anchorIndexes: number[] = [];
  for (let i = 0; i < m1Candles.length; i += ANCHOR_STRIDE_CANDLES) anchorIndexes.push(i);
  console.info(`Anchors: ${anchorIndexes.length}, offsets: ${OFFSET_PERCENTAGES.length}, directions: 2`);
  console.info(`Total synthetic orders per N: ${anchorIndexes.length * OFFSET_PERCENTAGES.length * 2}`);

  for (const n of N_VALUES) {
    let total = 0;
    let filledCount = 0;
    let candlesToFillSum = 0;

    for (const anchorIndex of anchorIndexes) {
      const anchorPrice = m1Candles[anchorIndex].close;
      const horizon = m1Candles.slice(anchorIndex + 1, anchorIndex + 1 + HORIZON_CANDLES);
      if (horizon.length === 0) continue;

      for (const pct of OFFSET_PERCENTAGES) {
        for (const direction of ['BULL', 'BEAR'] as const) {
          const limitPrice = direction === 'BULL' ? anchorPrice * (1 - pct) : anchorPrice * (1 + pct);
          const result = simulateLimitFill({ limitPrice, direction, m1Candles: horizon, tickSize: BTC_TICK_SIZE, n });
          total += 1;
          if (result.filled) {
            filledCount += 1;
            candlesToFillSum += result.filledAtIndex! + 1;
          }
        }
      }
    }

    const fillRatePct = (100 * filledCount) / total;
    const avgCandlesToFill = filledCount > 0 ? candlesToFillSum / filledCount : null;
    console.info(
      `N=${n} | filled=${fillRatePct.toFixed(2)}% (${filledCount}/${total}) | avgCandlesToFill=${avgCandlesToFill === null ? 'N/A' : avgCandlesToFill.toFixed(1)}`,
    );
  }
}

await main();
