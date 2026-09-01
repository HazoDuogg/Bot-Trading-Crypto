import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  loadRecentM1Candles,
  readLastCandleOpenTime,
  runBuyAndHoldControl,
} from './controlTest.js';

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

describe('runBuyAndHoldControl', () => {
  it('reconciles a simple rising hold with the same harness and retains OPEN before final mark', () => {
    const result = runBuyAndHoldControl([
      candle(0, 100, 101, 99, 100),
      candle(60_000, 100, 111, 100, 110),
    ]);

    expect(result.execution).toEqual({ outcome: 'OPEN', m1CandlesConsumed: 1 });
    expect(result.rawChangePct).toBeCloseTo(10);
    expect(result.netR).toBeGreaterThan(0);
    expect(result.netR).toBeLessThan(result.rawChangePct / 100);
    expect(result.passed).toBe(true);
  });

  it(
    'passes on the repository BTCUSDT M1 data for the same trailing 180-day period',
    async () => {
      const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_rt094_1m.csv', import.meta.url));
      const m15Path = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
      const m15Anchor = await readLastCandleOpenTime(m15Path);
      const candles = await loadRecentM1Candles(csvPath, 180, m15Anchor);
      const result = runBuyAndHoldControl(candles);

      console.info(
        `BTCUSDT buy-and-hold control: start=${result.startPrice.toFixed(2)}, ` +
          `end=${result.endPrice.toFixed(2)}, raw=${result.rawChangePct.toFixed(2)}%, ` +
          `netR=${result.netR.toFixed(4)} (${(result.netR * 100).toFixed(2)}%), ` +
          `costDrag=${(result.costDragR * 100).toFixed(2)}%, PASS=${result.passed}`,
      );
      expect(result.rawChangePct).toBeGreaterThan(0);
      expect(result.periodStartTimestamp).toBe(m15Anchor - 180 * 24 * 60 * 60 * 1000);
      expect(result.periodEndTimestamp).toBe(m15Anchor + 14 * 60 * 1000);
      expect(result.passed).toBe(true);
    },
    30_000,
  );
});
