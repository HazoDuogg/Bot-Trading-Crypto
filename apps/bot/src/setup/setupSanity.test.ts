import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { detectBaseZones } from '../structure/baseZone.js';
import {
  D6_RECLAIM_WINDOW,
  detectMeaningfulBreak,
  evaluateDominance,
  type BreakResult,
  type DominanceEvidence,
} from '../structure/breakDetector.js';
import { detectCompression } from '../structure/compression.js';
import { evaluateQuality } from '../structure/quality.js';
import { detectSwingPoints } from '../structure/swingPoints.js';
import { detectSetupA } from './setupDetectorA.js';
import { detectSetupB } from './setupDetectorB.js';

interface TimedDominance {
  confirmedAt: number;
  evidence: DominanceEvidence;
}

function collectCausalBreaks(candles: readonly Candle[]): BreakResult[] {
  const swings = detectSwingPoints(candles);
  const breaks = new Map<string, BreakResult>();
  for (const type of ['high', 'low'] as const) {
    const sameType = swings.filter((swing) => swing.type === type);
    for (let index = 0; index < sameType.length; index += 1) {
      const swing = sameType[index];
      const nextSwing = sameType[index + 1];
      const result = detectMeaningfulBreak(candles, {
        level: swing.price,
        direction: type === 'high' ? 'up' : 'down',
        startIndex: swing.index + 3,
        endIndex: nextSwing === undefined ? candles.length - 1 : nextSwing.index + 2,
      });
      if (result !== null) breaks.set(`${result.brokeAt}:${result.direction}`, result);
    }
  }
  return [...breaks.values()].sort((left, right) => left.brokeAt - right.brokeAt);
}

function latestDominanceBefore(timeline: readonly TimedDominance[], index: number): DominanceEvidence | null {
  let left = 0;
  let right = timeline.length - 1;
  let latest: TimedDominance | null = null;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (timeline[middle].confirmedAt <= index) {
      latest = timeline[middle];
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return latest?.evidence ?? null;
}

async function countSetups(symbol: string): Promise<{
  setupACount: number;
  setupBCount: number;
  breakCount: number;
  baseCount: number;
  qualityCounts: { CLEAN: number; CHAOTIC: number; UNCLEAR: number };
  qualityWindowCount: number;
}> {
  const csvPath = fileURLToPath(new URL(`../../data/${symbol}_15m_3y.csv`, import.meta.url));
  const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
  const all = rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
  const cutoff = all.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
  const recent = all.filter((item) => item.openTime >= cutoff);
  const breaks = collectCausalBreaks(recent);
  const qualityByEndIndex = recent.map((_, windowEndIndex) =>
    evaluateQuality(recent, windowEndIndex),
  );
  const qualityCounts = { CLEAN: 0, CHAOTIC: 0, UNCLEAR: 0 };
  for (const quality of qualityByEndIndex) {
    if (quality !== null) qualityCounts[quality.label] += 1;
  }
  const qualityWindowCount = Object.values(qualityCounts).reduce((sum, count) => sum + count, 0);

  const timeline: TimedDominance[] = [];
  const dominanceByBreak = new Map<BreakResult, DominanceEvidence>();
  for (const breakout of breaks) {
    const evidence = evaluateDominance(recent, breakout);
    dominanceByBreak.set(breakout, evidence);
    if (evidence.side !== 'NEUTRAL' && evidence.counterTestIndex !== null) {
      timeline.push({ confirmedAt: evidence.counterTestIndex + D6_RECLAIM_WINDOW, evidence });
    }
  }
  timeline.sort((left, right) => left.confirmedAt - right.confirmedAt);

  let setupBCount = 0;
  for (const breakout of breaks) {
    const dominance = dominanceByBreak.get(breakout)!;
    if (dominance.counterTestIndex === null) continue;
    const triggerIndex = dominance.counterTestIndex + D6_RECLAIM_WINDOW;
    const quality = qualityByEndIndex[triggerIndex];
    if (
      quality?.label === 'CLEAN' &&
      detectSetupB({ closedCandles: recent, quality, breakout }) !== null
    ) {
      setupBCount += 1;
    }
  }
  const bases = detectBaseZones(recent);
  let setupACount = 0;
  for (const baseZone of bases) {
    if (baseZone.end_index - baseZone.start_index + 1 < 8) continue;
    const compression = detectCompression(recent, baseZone.end_index);
    if (compression === null || !compression.isCompressed) continue;
    const candidates = [
      detectMeaningfulBreak(recent, {
        level: baseZone.high,
        direction: 'up',
        startIndex: baseZone.end_index + 1,
      }),
      detectMeaningfulBreak(recent, {
        level: baseZone.low,
        direction: 'down',
        startIndex: baseZone.end_index + 1,
      }),
    ].filter((item): item is BreakResult => item !== null);
    for (const breakout of candidates) {
      const dominance = latestDominanceBefore(timeline, breakout.brokeAt);
      const quality = qualityByEndIndex[breakout.brokeAt];
      if (
        quality?.label === 'CLEAN' &&
        dominance !== null &&
        detectSetupA({ baseZone, quality, compression, dominance, breakout }) !== null
      ) {
        setupACount += 1;
      }
    }
  }
  expect(recent.length).toBeGreaterThan(0);
  return {
    setupACount,
    setupBCount,
    breakCount: breaks.length,
    baseCount: bases.length,
    qualityCounts,
    qualityWindowCount,
  };
}

describe('five-coin setup sanity diagnostic', () => {
  it.each(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'])(
    'logs %s A/B counts after real D4 quality filtering',
    async (symbol) => {
      const counts = await countSetups(symbol);
      const cleanPercentage = (100 * counts.qualityCounts.CLEAN) / counts.qualityWindowCount;
      console.info(
        `${symbol} recent-6m setup candidates: ` +
          `A=${counts.setupACount}, B=${counts.setupBCount}; ` +
          `CLEAN windows=${counts.qualityCounts.CLEAN}/${counts.qualityWindowCount} ` +
          `(${cleanPercentage.toFixed(2)}%), CHAOTIC=${counts.qualityCounts.CHAOTIC}, ` +
          `UNCLEAR=${counts.qualityCounts.UNCLEAR}; ` +
          `breaks=${counts.breakCount}, bases=${counts.baseCount}`,
      );
      expect(counts.qualityWindowCount).toBeGreaterThan(0);
      expect(
        counts.qualityCounts.CLEAN +
          counts.qualityCounts.CHAOTIC +
          counts.qualityCounts.UNCLEAR,
      ).toBe(counts.qualityWindowCount);
      expect(counts.setupACount).toBeGreaterThanOrEqual(0);
      expect(counts.setupBCount).toBeGreaterThanOrEqual(0);
    },
  );
});
