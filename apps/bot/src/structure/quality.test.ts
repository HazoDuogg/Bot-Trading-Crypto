import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import {
  D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX,
  D4_QUALITY_V1_CHAOTIC_SWEEP_MIN,
  D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN,
  D4_QUALITY_V1_CLEAN_SWEEP_MAX,
  D4_QUALITY_V1_WINDOW,
  calculateSweepCount,
  evaluateQuality,
  evaluateQualitySeries,
} from './quality.js';

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: index * 900_000, open, high, low, close, volume: 100 };
}

function cleanFixture(): Candle[] {
  return Array.from({ length: D4_QUALITY_V1_WINDOW }, (_, index) =>
    candle(index, 100 + index, 101 + index, 100 + index, 101 + index),
  );
}

function chaoticFixture(): Candle[] {
  return [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 103, 99, 100),
    candle(2, 100, 103, 97, 101),
    candle(3, 101, 105, 97, 100),
    candle(4, 100, 105, 95, 101),
    ...Array.from({ length: 15 }, (_, offset) => candle(5 + offset, 100, 104, 96, 100)),
  ];
}

describe('D4 quality composite', () => {
  it('classifies a directional, rejection-free window as CLEAN', () => {
    const result = evaluateQuality(cleanFixture());

    expect(result).toEqual({ label: 'CLEAN', efficiency: 1, sweepCount: 0 });
  });

  it('classifies a low-efficiency, repeatedly swept window as CHAOTIC', () => {
    const result = evaluateQuality(chaoticFixture());

    expect(result).toEqual({ label: 'CHAOTIC', efficiency: 0, sweepCount: 4 });
  });

  it('classifies a low-efficiency window without enough sweeps as UNCLEAR', () => {
    const fixture = Array.from({ length: D4_QUALITY_V1_WINDOW }, (_, index) =>
      candle(index, 100, 101, 99, 100),
    );

    expect(evaluateQuality(fixture)).toEqual({ label: 'UNCLEAR', efficiency: 0, sweepCount: 0 });
  });

  it('counts upward and downward sweeps and safely skips zero-range rejection math', () => {
    const startingCandle = candle(0, 100, 101, 99, 100);

    expect(calculateSweepCount([startingCandle, candle(1, 100, 103, 99, 100)])).toBe(1);
    expect(calculateSweepCount([startingCandle, candle(1, 100, 101, 97, 100)])).toBe(1);
    expect(calculateSweepCount(chaoticFixture())).toBe(4);
    expect(calculateSweepCount([startingCandle, candle(1, 200, 200, 200, 200)])).toBe(0);
  });

  it('uses only the selected closed window and ignores appended future candles', () => {
    const fixture = cleanFixture();
    const atIndex19 = evaluateQuality(fixture, 19);
    const withFuture = evaluateQuality(
      [...fixture, candle(20, 120, 1_000, 1, 500), candle(21, 500, 2_000, 0, 10)],
      19,
    );

    expect(withFuture).toEqual(atIndex19);
  });

  it('returns null before a complete 20-candle window exists and exposes locked constants', () => {
    expect(evaluateQuality(cleanFixture().slice(0, -1))).toBeNull();
    expect(D4_QUALITY_V1_CLEAN_EFFICIENCY_MIN).toBe(0.148);
    expect(D4_QUALITY_V1_CLEAN_SWEEP_MAX).toBe(1);
    expect(D4_QUALITY_V1_CHAOTIC_EFFICIENCY_MAX).toBe(0.041);
    expect(D4_QUALITY_V1_CHAOTIC_SWEEP_MIN).toBe(3);
  });
});

describe('BTCUSDT 3-year sanity diagnostic', () => {
  it('logs recent-six-month quality distribution without hard-coding reference percentages', async () => {
    const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const candles = rows.map((row) => {
      const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
      return { openTime, open, high, low, close, volume } satisfies Candle;
    });
    const cutoff = candles.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
    const recent = evaluateQualitySeries(candles).filter(
      (result) => candles[result.windowEndIndex].openTime >= cutoff,
    );
    const counts = { CLEAN: 0, CHAOTIC: 0, UNCLEAR: 0 };
    for (const result of recent) counts[result.label] += 1;
    const percentage = (label: keyof typeof counts): number => (100 * counts[label]) / recent.length;

    console.info(
      `BTCUSDT recent-6m D4: CLEAN=${percentage('CLEAN').toFixed(2)}%, ` +
        `CHAOTIC=${percentage('CHAOTIC').toFixed(2)}%, UNCLEAR=${percentage('UNCLEAR').toFixed(2)}%; ` +
        `global reference=9.1/7.7/83.2%`,
    );
    expect(recent.length).toBeGreaterThan(0);
    expect(counts.CLEAN + counts.CHAOTIC + counts.UNCLEAR).toBe(recent.length);
  });
});
