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
import { detectSwingPoints } from '../structure/swingPoints.js';
import type { QualityComposite } from '../structure/quality.js';
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

async function countConditionalSetups(symbol: string): Promise<{
  setupACount: number;
  setupBCount: number;
  breakCount: number;
  baseCount: number;
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
  const conditionalClean: QualityComposite = { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 };

  const timeline: TimedDominance[] = [];
  for (const breakout of breaks) {
    const evidence = evaluateDominance(recent, breakout);
    if (evidence.side !== 'NEUTRAL' && evidence.counterTestIndex !== null) {
      timeline.push({ confirmedAt: evidence.counterTestIndex + D6_RECLAIM_WINDOW, evidence });
    }
  }
  timeline.sort((left, right) => left.confirmedAt - right.confirmedAt);

  const setupBCount = breaks.filter(
    (breakout) => detectSetupB({ closedCandles: recent, quality: conditionalClean, breakout }) !== null,
  ).length;
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
      if (
        dominance !== null &&
        detectSetupA({ baseZone, quality: conditionalClean, compression, dominance, breakout }) !== null
      ) {
        setupACount += 1;
      }
    }
  }
  expect(recent.length).toBeGreaterThan(0);
  return { setupACount, setupBCount, breakCount: breaks.length, baseCount: bases.length };
}

describe('five-coin setup sanity diagnostic', () => {
  it.each(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'DOGEUSDT'])(
    'logs %s structural A/B counts conditional on an external CLEAN quality DTO',
    async (symbol) => {
      const counts = await countConditionalSetups(symbol);
      console.info(
        `${symbol} recent-6m setup candidates conditional on CLEAN (D4 not implemented): ` +
          `A=${counts.setupACount}, B=${counts.setupBCount}; ` +
          `breaks=${counts.breakCount}, bases=${counts.baseCount}`,
      );
      expect(counts.setupACount).toBeGreaterThanOrEqual(0);
      expect(counts.setupBCount).toBeGreaterThanOrEqual(0);
    },
  );
});
