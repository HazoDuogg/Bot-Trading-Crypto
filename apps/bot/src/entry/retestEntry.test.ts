import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';
import { detectSetupA, type SetupSignal } from '../setup/setupDetectorA.js';
import { detectSetupB } from '../setup/setupDetectorB.js';
import { detectBaseZones } from '../structure/baseZone.js';
import {
  D2_BREAK_V1_ATR_PERIOD,
  D6_RECLAIM_WINDOW,
  detectMeaningfulBreak,
  evaluateDominance,
  type BreakResult,
  type DominanceEvidence,
} from '../structure/breakDetector.js';
import { evaluateBreakoutStrength } from '../structure/breakoutStrength.js';
import { detectCompression } from '../structure/compression.js';
import { evaluateQuality } from '../structure/quality.js';
import { detectSwingPoints } from '../structure/swingPoints.js';
import { RETEST_ENTRY_EXPIRY_CANDLES, evaluateRetestEntry } from './retestEntry.js';

function candle(index: number, low: number, high: number, close: number): Candle {
  return { openTime: index * 900_000, open: close, high, low, close, volume: 100 };
}

function signal(direction: 'BULL' | 'BEAR', triggerIndex = 0, level = 100): SetupSignal {
  return {
    setupFamily: 'B_BREAK_PULLBACK_FAILURE',
    direction,
    triggerIndex,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: {
        side: direction,
        brokeLevel: level,
        counterTestFailed: true,
        counterTestIndex: triggerIndex - 3,
      },
      d2: { brokeAt: Math.max(0, triggerIndex - 6), level },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

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

function latestDominanceBefore(
  timeline: readonly TimedDominance[],
  index: number,
): DominanceEvidence | null {
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

function collectSetupSignals(candles: readonly Candle[]): SetupSignal[] {
  const breaks = collectCausalBreaks(candles);
  const tracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
  const atrAtIndex = candles.map((item) => tracker.next(item));
  const strengthForBreak = (breakout: BreakResult) => {
    const frozenAtr = atrAtIndex[breakout.brokeAt - 1];
    return frozenAtr === null || frozenAtr === undefined
      ? null
      : evaluateBreakoutStrength(candles[breakout.brokeAt], frozenAtr);
  };
  const qualityByEndIndex = candles.map((_, index) => evaluateQuality(candles, index));
  const timeline: TimedDominance[] = [];
  const dominanceByBreak = new Map<BreakResult, DominanceEvidence>();
  for (const breakout of breaks) {
    const evidence = evaluateDominance(candles, breakout);
    dominanceByBreak.set(breakout, evidence);
    if (evidence.side !== 'NEUTRAL' && evidence.counterTestIndex !== null) {
      timeline.push({ confirmedAt: evidence.counterTestIndex + D6_RECLAIM_WINDOW, evidence });
    }
  }
  timeline.sort((left, right) => left.confirmedAt - right.confirmedAt);

  const signals: SetupSignal[] = [];
  for (const breakout of breaks) {
    const dominance = dominanceByBreak.get(breakout)!;
    if (dominance.counterTestIndex === null) continue;
    const quality = qualityByEndIndex[dominance.counterTestIndex + D6_RECLAIM_WINDOW];
    if (quality?.label !== 'CLEAN') continue;
    const breakoutStrength = strengthForBreak(breakout);
    if (breakoutStrength === null) continue;
    const setup = detectSetupB({ closedCandles: candles, quality, breakout, breakoutStrength });
    if (setup !== null) signals.push(setup);
  }

  for (const baseZone of detectBaseZones(candles)) {
    if (baseZone.end_index - baseZone.start_index + 1 < 8) continue;
    const compression = detectCompression(candles, baseZone.end_index);
    if (compression === null || !compression.isCompressed) continue;
    const candidates = [
      detectMeaningfulBreak(candles, {
        level: baseZone.high,
        direction: 'up',
        startIndex: baseZone.end_index + 1,
      }),
      detectMeaningfulBreak(candles, {
        level: baseZone.low,
        direction: 'down',
        startIndex: baseZone.end_index + 1,
      }),
    ].filter((item): item is BreakResult => item !== null);
    for (const breakout of candidates) {
      const dominance = latestDominanceBefore(timeline, breakout.brokeAt);
      const quality = qualityByEndIndex[breakout.brokeAt];
      if (dominance === null || quality?.label !== 'CLEAN') continue;
      const breakoutStrength = strengthForBreak(breakout);
      if (breakoutStrength === null) continue;
      const setup = detectSetupA({
        baseZone,
        quality,
        compression,
        dominance,
        breakout,
        breakoutStrength,
      });
      if (setup !== null) signals.push(setup);
    }
  }
  return signals;
}

describe('evaluateRetestEntry', () => {
  it('fills a BULL limit one tick below the break level on candle two after trigger', () => {
    const candles = [
      candle(0, 100, 104, 103),
      candle(1, 100, 105, 103),
      candle(2, 98, 101, 100),
    ];

    expect(
      evaluateRetestEntry({
        signal: signal('BULL'),
        closedCandles: candles,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', atIndex: 2, fillPrice: 99 });
  });

  it('expires exactly eight candles after trigger when no candle fills or cancels', () => {
    const candles = Array.from({ length: 10 }, (_, index) => candle(index, 101, 105, 103));
    const guarded = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === '9') throw new Error('read after expiry');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluateRetestEntry({
        signal: signal('BULL'),
        closedCandles: guarded,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'EXPIRED', atIndex: 8 });
    expect(RETEST_ENTRY_EXPIRY_CANDLES).toBe(8);
  });

  it('cancels before fill when the same candle is already over-extended', () => {
    const candles = [
      candle(0, 100, 104, 103),
      candle(1, 101, 110, 105),
      candle(2, 98, 125, 121),
      candle(3, 98, 101, 100),
    ];
    const guarded = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === '3') throw new Error('read after cancellation');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluateRetestEntry({
        signal: signal('BULL'),
        closedCandles: guarded,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'CANCELLED_OVER_EXTENDED', atIndex: 2 });
  });

  it('applies the symmetric one-tick-above limit for BEAR', () => {
    const candles = [
      candle(0, 96, 100, 97),
      candle(1, 95, 100, 97),
      candle(2, 99, 102, 100),
    ];

    expect(
      evaluateRetestEntry({
        signal: signal('BEAR'),
        closedCandles: candles,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', atIndex: 2, fillPrice: 101 });
  });

  it('does not read the trigger candle or any candle after an early fill', () => {
    const candles = [
      candle(0, 1, 1_000, 500),
      candle(1, 1, 1_000, 500),
      candle(2, 1, 1_000, 500),
      candle(3, 100, 105, 103),
      candle(4, 98, 101, 100),
      candle(5, 1, 1_000, 500),
    ];
    const guarded = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === '0' || property === '1' || property === '2') {
          throw new Error('read at or before trigger');
        }
        if (property === '5') throw new Error('read after fill');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluateRetestEntry({
        signal: signal('BULL', 2),
        closedCandles: guarded,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', atIndex: 4, fillPrice: 99 });
  });
});

describe('BTCUSDT six-month setup-to-entry sanity diagnostic', () => {
  it('logs terminal retest-entry outcomes for real D4-filtered SetupSignals', async () => {
    const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const all = rows.map((row) => {
      const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
      return { openTime, open, high, low, close, volume } satisfies Candle;
    });
    const cutoff = all.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
    const recent = all.filter((item) => item.openTime >= cutoff);
    const signals = collectSetupSignals(recent);
    const tracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
    const atrAtIndex = recent.map((item) => tracker.next(item));
    const outcomes = { FILLED: 0, EXPIRED: 0, CANCELLED_OVER_EXTENDED: 0 };
    let evaluatedSignals = 0;
    for (const setup of signals) {
      if (setup.triggerIndex + RETEST_ENTRY_EXPIRY_CANDLES >= recent.length) continue;
      const frozenAtrAtTrigger = atrAtIndex[setup.triggerIndex];
      if (frozenAtrAtTrigger === null || frozenAtrAtTrigger === undefined) continue;
      const result = evaluateRetestEntry({
        signal: setup,
        closedCandles: recent,
        frozenAtrAtTrigger,
        tickSize: 0.1,
      });
      outcomes[result.status] += 1;
      evaluatedSignals += 1;
    }
    const percentage = (count: number): string => ((100 * count) / evaluatedSignals).toFixed(2);

    console.info(
      `BTCUSDT recent-6m retest entry: FILLED=${outcomes.FILLED}/${evaluatedSignals} ` +
        `(${percentage(outcomes.FILLED)}%), EXPIRED=${outcomes.EXPIRED} ` +
        `(${percentage(outcomes.EXPIRED)}%), CANCELLED_OVER_EXTENDED=` +
        `${outcomes.CANCELLED_OVER_EXTENDED} ` +
        `(${percentage(outcomes.CANCELLED_OVER_EXTENDED)}%); signals=${signals.length}`,
    );
    expect(signals.length).toBeGreaterThan(0);
    expect(evaluatedSignals).toBeGreaterThan(0);
    expect(outcomes.FILLED + outcomes.EXPIRED + outcomes.CANCELLED_OVER_EXTENDED).toBe(
      evaluatedSignals,
    );
  }, 30_000);
});
