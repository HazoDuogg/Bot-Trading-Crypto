import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  D5_COMPRESSION_V1_ATR_PERIOD,
  D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO,
  D5_COMPRESSION_V1_WINDOW,
  detectCompression,
  detectCompressionSeries,
} from './compression.js';

function candle(index: number, high: number, low: number, close = (high + low) / 2): Candle {
  return { openTime: index * 900_000, open: close, high, low, close, volume: 100 };
}

function atrHistory(range: number): Candle[] {
  return Array.from({ length: D5_COMPRESSION_V1_ATR_PERIOD + 1 }, (_, index) =>
    candle(index, 100 + range / 2, 100 - range / 2, 100),
  );
}

describe('detectCompression', () => {
  it('detects a clearly compressed eight-candle window', () => {
    const history = atrHistory(10);
    const window = Array.from({ length: D5_COMPRESSION_V1_WINDOW }, (_, offset) =>
      candle(history.length + offset, 106, 94, 100),
    );

    expect(detectCompression([...history, ...window])).toEqual({
      isCompressed: true,
      bandwidthAtrRatio: 1.2,
      windowStartIndex: 15,
      windowEndIndex: 22,
    });
  });

  it('rejects a clearly non-compressed window', () => {
    const history = atrHistory(10);
    const window = Array.from({ length: D5_COMPRESSION_V1_WINDOW }, (_, offset) =>
      candle(history.length + offset, 115, 85, 100),
    );

    const result = detectCompression([...history, ...window]);
    expect(result?.isCompressed).toBe(false);
    expect(result?.bandwidthAtrRatio).toBe(3);
  });

  it('freezes ATR before the window and ignores candles after the requested window end', () => {
    const history = atrHistory(2);
    const gappedWindow = Array.from({ length: D5_COMPRESSION_V1_WINDOW }, (_, offset) =>
      candle(history.length + offset, 1_005, 1_000, 1_002),
    );
    const future = [candle(23, 10_000, 1, 5_000), candle(24, 20_000, 1, 10_000)];
    const withoutFuture = detectCompression([...history, ...gappedWindow]);
    const withFuture = detectCompression([...history, ...gappedWindow, ...future], 22);

    expect(withoutFuture).toEqual(withFuture);
    expect(withFuture).toEqual({
      isCompressed: false,
      bandwidthAtrRatio: 2.5,
      windowStartIndex: 15,
      windowEndIndex: 22,
    });
  });

  it('returns null until ATR14 plus the complete window are available', () => {
    const tooShort = Array.from({ length: D5_COMPRESSION_V1_ATR_PERIOD + D5_COMPRESSION_V1_WINDOW }, (_, index) =>
      candle(index, 101, 99, 100),
    );

    expect(detectCompression(tooShort.slice(0, -1))).toBeNull();
    expect(D5_COMPRESSION_V1_MAX_BANDWIDTH_ATR_RATIO).toBe(1.95);
  });
});

describe('BTCUSDT 3-year sanity diagnostic', () => {
  it('logs the recent-six-month activation rate without hard-coding the reference into logic', async () => {
    const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const candles = rows.map((row) => {
      const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
      return { openTime, open, high, low, close, volume } satisfies Candle;
    });
    const cutoff = candles.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
    const recentResults = detectCompressionSeries(candles).filter(
      (result) => candles[result.windowEndIndex].openTime >= cutoff,
    );
    const compressed = recentResults.filter((result) => result.isCompressed).length;
    const activationRate = compressed / recentResults.length;
    const sortedRatios = recentResults.map((result) => result.bandwidthAtrRatio).sort((left, right) => left - right);
    const p25 = sortedRatios[Math.floor(sortedRatios.length * 0.25)];

    console.info(
      `BTCUSDT recent-6m D5 activation: ${(activationRate * 100).toFixed(2)}% ` +
        `(${compressed}/${recentResults.length}); p25=${p25.toFixed(3)}; reference≈23-26%`,
    );
    expect(recentResults.length).toBeGreaterThan(0);
    expect(activationRate).toBeGreaterThanOrEqual(0.15);
    expect(activationRate).toBeLessThanOrEqual(0.35);
  });
});
