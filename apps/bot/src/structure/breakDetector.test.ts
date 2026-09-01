import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { detectSwingPoints } from './swingPoints.js';
import { detectMeaningfulBreak, evaluateDominance } from './breakDetector.js';

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: index * 900_000, open, high, low, close, volume: 100 };
}

function flatAtrHistory(): Candle[] {
  return Array.from({ length: 15 }, (_, index) => candle(index, 99, 100, 98, 99));
}

describe('detectMeaningfulBreak', () => {
  it('detects a close beyond level plus 0.1 times prior ATR14', () => {
    const candles = [...flatAtrHistory(), candle(15, 99, 125, 98, 100.21)];

    expect(detectMeaningfulBreak(candles, { level: 100, direction: 'up', startIndex: 15 })).toEqual({
      brokeAt: 15,
      direction: 'up',
      level: 100,
    });
  });

  it('rejects a wick through the level when close does not clear the buffer', () => {
    const candles = [...flatAtrHistory(), candle(15, 99, 105, 98, 100.19)];

    expect(detectMeaningfulBreak(candles, { level: 100, direction: 'up', startIndex: 15 })).toBeNull();
  });

  it('detects the symmetric downward break', () => {
    const candles = [...flatAtrHistory(), candle(15, 99, 100, 75, 97.79)];

    expect(detectMeaningfulBreak(candles, { level: 98, direction: 'down', startIndex: 15 })).toEqual({
      brokeAt: 15,
      direction: 'down',
      level: 98,
    });
  });
});

describe('evaluateDominance', () => {
  it('marks bull dominance when a counter-test occurs without a valid reclaim', () => {
    const candles = [
      ...flatAtrHistory(),
      candle(15, 99, 101, 99, 100.3),
      candle(16, 100.3, 100.5, 99.9, 100.1),
      candle(17, 100.1, 100.4, 99.95, 100.2),
      candle(18, 100.2, 100.6, 100.05, 100.4),
      candle(19, 100.4, 100.7, 100.1, 100.5),
    ];
    const breakout = detectMeaningfulBreak(candles, { level: 100, direction: 'up', startIndex: 15 });

    expect(breakout).not.toBeNull();
    expect(evaluateDominance(candles, breakout!)).toEqual({
      side: 'BULL',
      brokeLevel: 100,
      counterTestFailed: true,
      counterTestIndex: 16,
    });
    expect(evaluateDominance(candles, breakout!, { minimumTestOccurrence: 1 })).toEqual(
      evaluateDominance(candles, breakout!),
    );
  });

  it('stays neutral when the counter side reclaims through the D2 buffer', () => {
    const candles = [
      ...flatAtrHistory(),
      candle(15, 99, 101, 99, 100.3),
      candle(16, 100.3, 100.4, 97, 99.7),
      candle(17, 99.7, 100, 99, 99.5),
      candle(18, 99.5, 100, 99, 99.6),
    ];
    const breakout = detectMeaningfulBreak(candles, { level: 100, direction: 'up', startIndex: 15 });

    expect(evaluateDominance(candles, breakout!)).toEqual({
      side: 'NEUTRAL',
      brokeLevel: 100,
      counterTestFailed: false,
      counterTestIndex: 16,
    });
  });

  it('produces symmetric bear dominance evidence', () => {
    const candles = [
      ...flatAtrHistory(),
      candle(15, 99, 99, 97, 97.7),
      candle(16, 97.7, 98.1, 97.5, 97.9),
      candle(17, 97.9, 98, 97.4, 97.6),
      candle(18, 97.6, 97.9, 97.2, 97.4),
      candle(19, 97.4, 97.8, 97.1, 97.3),
    ];
    const breakout = detectMeaningfulBreak(candles, { level: 98, direction: 'down', startIndex: 15 });

    expect(evaluateDominance(candles, breakout!)).toEqual({
      side: 'BEAR',
      brokeLevel: 98,
      counterTestFailed: true,
      counterTestIndex: 16,
    });
  });

  it('finds a late counter-test within 10 candles and starts reclaim timing there', () => {
    const candles = [
      ...flatAtrHistory(),
      candle(15, 99, 101, 99, 100.3),
      ...Array.from({ length: 6 }, (_, offset) => candle(16 + offset, 100.4, 100.8, 100.1, 100.5)),
      candle(22, 100.5, 100.7, 99.9, 100.2),
      candle(23, 100.2, 100.5, 100.05, 100.3),
      candle(24, 100.3, 100.6, 100.1, 100.4),
      candle(25, 100.4, 100.7, 100.2, 100.5),
    ];
    const breakout = detectMeaningfulBreak(candles, { level: 100, direction: 'up', startIndex: 15 });

    expect(evaluateDominance(candles, breakout!)).toEqual({
      side: 'BULL',
      brokeLevel: 100,
      counterTestFailed: true,
      counterTestIndex: 22,
    });
  });

  it('counts separate touch-and-withdraw episodes and blocks the first test when N=2', () => {
    const candles = [
      ...flatAtrHistory(),
      candle(15, 99, 101, 99, 100.3),
      candle(16, 100.3, 100.5, 99.9, 100.3),
      candle(17, 100.3, 100.7, 100.2, 100.5),
      ...Array.from({ length: 10 }, (_, offset) =>
        candle(18 + offset, 100.4, 100.8, 100.1, 100.5),
      ),
      candle(28, 100.5, 100.6, 99.9, 100.2),
      candle(29, 100.2, 100.6, 100.05, 100.4),
      candle(30, 100.4, 100.7, 100.1, 100.5),
      candle(31, 100.5, 100.8, 100.2, 100.6),
    ];
    const breakout = { brokeAt: 15, direction: 'up' as const, level: 100 };

    expect(
      evaluateDominance(candles.slice(0, 18), breakout, { minimumTestOccurrence: 2 }),
    ).toEqual({
      side: 'NEUTRAL',
      brokeLevel: 100,
      counterTestFailed: false,
      counterTestIndex: null,
    });
    expect(evaluateDominance(candles, breakout, { minimumTestOccurrence: 2 })).toEqual({
      side: 'BULL',
      brokeLevel: 100,
      counterTestFailed: true,
      counterTestIndex: 28,
    });
  });
});

describe('BTCUSDT 3-year sanity diagnostic', () => {
  it('reports a causal recent-six-month break rate without hard-coding the reference rate', async () => {
    const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const all = rows.map((row) => {
      const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
      return { openTime, open, high, low, close, volume } satisfies Candle;
    });
    const endTime = all.at(-1)!.openTime;
    const recent = all.filter((item) => item.openTime >= endTime - 180 * 24 * 60 * 60 * 1000);
    const swings = detectSwingPoints(recent);
    const breakIndices = new Set<number>();
    for (const type of ['high', 'low'] as const) {
      const sameType = swings.filter((swing) => swing.type === type);
      for (let index = 0; index < sameType.length; index += 1) {
        const swing = sameType[index];
        const nextSwing = sameType[index + 1];
        const result = detectMeaningfulBreak(recent, {
          level: swing.price,
          direction: type === 'high' ? 'up' : 'down',
          startIndex: swing.index + 3,
          endIndex: nextSwing === undefined ? recent.length - 1 : nextSwing.index + 2,
        });
        if (result !== null) breakIndices.add(result.brokeAt);
      }
    }
    const rate = recent.length === 0 ? 0 : breakIndices.size / recent.length;

    console.info(
      `BTCUSDT recent-6m D2 break candles: ${(rate * 100).toFixed(2)}% ` +
        `(${breakIndices.size}/${recent.length}); reference≈8.9%`,
    );
    expect(swings.length).toBeGreaterThan(0);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  }, 30_000);
});
