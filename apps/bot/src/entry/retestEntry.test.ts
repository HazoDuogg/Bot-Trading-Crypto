import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';
import { detectSetupA, type SetupSignal } from '../setup/setupDetectorA.js';
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
import { evaluateM1RetestWindow } from './retestEntry.js';

const M15_WINDOW_MS = 15 * 60 * 1000;

function m1(openTime: number, low: number, high: number, close: number, volume = 100): Candle {
  return { openTime, open: close, high, low, close, volume };
}

// The trigger M15 candle's own 15 M1 sub-candles, with a volume spike on the last one — a
// liquidity sweep against MA20=100 (spike must exceed 100 * 2.5 = 250).
function sweepingTriggerWindow(triggerCandleOpenTime: number): Candle[] {
  return Array.from({ length: 15 }, (_, offset) =>
    m1(triggerCandleOpenTime + offset * 60_000, 100, 101, 100, offset === 14 ? 300 : 100),
  );
}

function signal(direction: 'BULL' | 'BEAR', level = 100): SetupSignal {
  return {
    setupFamily: 'A_COMPRESSION_BREAKOUT',
    direction,
    triggerIndex: 0,
    reasonTrace: {
      quality: { label: 'CLEAN', efficiency: 0.2, sweepCount: 1 },
      dominance: { side: direction, brokeLevel: level, counterTestFailed: true, counterTestIndex: -3 },
      d2: { brokeAt: 0, level },
      d7: { bodyRatio: 0.7, rangeAtrRatio: 1.2, isStrong: true },
    },
  };
}

// A window fully covered by flat, non-touching, non-extended M1 candles (15 of them).
function fullWindow(windowStart: number, low: number, high: number, close: number): Candle[] {
  return Array.from({ length: 15 }, (_, offset) => m1(windowStart + offset * 60_000, low, high, close));
}

// 20 low-volume M1 candles ending right before `beforeOpenTime`, so the liquidity-sweep MA20
// has enough history and stays well under any test-window candle's volume (no false sweep).
function precedingLowVolume(beforeOpenTime: number): Candle[] {
  return Array.from({ length: 20 }, (_, offset) =>
    m1(beforeOpenTime - (20 - offset) * 60_000, 100, 101, 100),
  );
}

describe('evaluateM1RetestWindow', () => {
  it('fills a BULL limit one tick below the break level on the M1 candle that touches it', () => {
    const windowStart = 0;
    const m1Candles = [
      ...precedingLowVolume(windowStart - M15_WINDOW_MS),
      m1(0, 100, 104, 103),
      m1(60_000, 100, 105, 103),
      m1(120_000, 98, 101, 100),
      ...fullWindow(180_000, 100, 105, 103).slice(0, 12),
    ];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: windowStart,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', fillTimestamp: 120_000, fillPrice: 99 });
  });

  it('applies the symmetric one-tick-above limit for BEAR', () => {
    const m1Candles = [
      ...precedingLowVolume(-M15_WINDOW_MS),
      m1(0, 96, 100, 97),
      m1(60_000, 95, 100, 97),
      m1(120_000, 99, 102, 100),
    ];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BEAR'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', fillTimestamp: 120_000, fillPrice: 101 });
  });

  it('expires 15M when no M1 candle fills or cancels within the window', () => {
    const m1Candles = [...precedingLowVolume(-M15_WINDOW_MS), ...fullWindow(0, 101, 105, 103)];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'EXPIRED_15M', expiryTimestamp: M15_WINDOW_MS });
  });

  it('cancels before fill when an earlier M1 candle in the window is already over-extended', () => {
    // low=105 stays above limitPrice=99 (no fill match) while close=121 is far enough from
    // the break level (100) to trip the over-extension check first.
    const preceding = precedingLowVolume(-M15_WINDOW_MS);
    const m1Candles = [
      ...preceding,
      m1(0, 100, 104, 103),
      m1(60_000, 101, 110, 105),
      m1(120_000, 105, 125, 121),
      ...fullWindow(180_000, 98, 101, 100).slice(0, 12),
    ];
    const guardedIndex = String(preceding.length + 3);
    const guarded = new Proxy(m1Candles, {
      get(target, property, receiver) {
        if (property === guardedIndex) throw new Error('read after cancellation');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles: guarded,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'CANCELLED_OVER_EXTENDED', cancelTimestamp: 120_000 });
  });

  it('never reads an M1 candle outside the 15-minute window once filled', () => {
    const preceding = precedingLowVolume(-M15_WINDOW_MS);
    const m1Candles = [
      ...preceding,
      m1(0, 100, 104, 103),
      m1(60_000, 100, 105, 103),
      m1(120_000, 98, 101, 100),
      m1(M15_WINDOW_MS, 1, 1_000, 500),
    ];
    const guardedIndex = String(preceding.length + 3);
    const guarded = new Proxy(m1Candles, {
      get(target, property, receiver) {
        if (property === guardedIndex) throw new Error('read past the window end');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles: guarded,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', fillTimestamp: 120_000, fillPrice: 99 });
  });

  it('throws when the M1 feed has not yet closed the full 15-minute window', () => {
    const m1Candles = [
      ...precedingLowVolume(-M15_WINDOW_MS),
      m1(0, 101, 105, 103),
      m1(60_000, 101, 105, 103),
    ];

    expect(() =>
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toThrow('m1Candles must cover the full 15-minute retest window before it can be evaluated');
  });

  it('re-anchors the retest window to the reclaim candle after a liquidity sweep', () => {
    const triggerCandleOpenTime = -M15_WINDOW_MS;
    const m1Candles = [
      ...precedingLowVolume(triggerCandleOpenTime),
      ...sweepingTriggerWindow(triggerCandleOpenTime),
      m1(0, 95, 98, 97), // no reclaim: high (98) does not exceed the break level (100)
      m1(60_000, 100, 105, 95), // reclaim: high (105) > 100 and close (95) < 100
      m1(120_000, 95, 105, 100), // first candle of the re-anchored window: fills at 99
      ...fullWindow(180_000, 100, 105, 103).slice(0, 12),
    ];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', fillTimestamp: 120_000, fillPrice: 99 });
  });

  it('expires with SWEEP_TIMEOUT when a liquidity sweep never reclaims within 15 M1 candles', () => {
    const triggerCandleOpenTime = -M15_WINDOW_MS;
    const m1Candles = [
      ...precedingLowVolume(triggerCandleOpenTime),
      ...sweepingTriggerWindow(triggerCandleOpenTime),
      // 15 M1 candles from windowStart, none of which reclaim the break level.
      ...fullWindow(0, 95, 98, 97),
    ];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'EXPIRED_15M', expiryTimestamp: M15_WINDOW_MS, reason: 'SWEEP_TIMEOUT' });
  });

  it('behaves exactly like TICKET-039 when no liquidity sweep precedes the window', () => {
    const triggerCandleOpenTime = -M15_WINDOW_MS;
    const m1Candles = [
      ...precedingLowVolume(triggerCandleOpenTime),
      // Flat volume trigger window: no candle exceeds MA20 * 2.5, so no sweep is detected.
      ...Array.from({ length: 15 }, (_, offset) => m1(triggerCandleOpenTime + offset * 60_000, 100, 101, 100)),
      m1(0, 100, 104, 103),
      m1(60_000, 100, 105, 103),
      m1(120_000, 98, 101, 100),
      ...fullWindow(180_000, 100, 105, 103).slice(0, 12),
    ];

    expect(
      evaluateM1RetestWindow({
        signal: signal('BULL'),
        m1Candles,
        windowStartTimestamp: 0,
        frozenAtrAtTrigger: 10,
        tickSize: 1,
      }),
    ).toEqual({ status: 'FILLED', fillTimestamp: 120_000, fillPrice: 99 });
  });
});

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

async function loadCsvCandles(path: string): Promise<Candle[]> {
  const rows = (await readFile(path, 'utf8')).trim().split(/\r?\n/u).slice(1);
  return rows.map((row) => {
    const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
    return { openTime, open, high, low, close, volume } satisfies Candle;
  });
}

describe('BTCUSDT six-month setup-to-entry sanity diagnostic', () => {
  it('logs terminal M1 retest-window outcomes for real D4-filtered SetupSignals', async () => {
    const m15Path = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const m1Path = fileURLToPath(new URL('../../data/BTCUSDT_rt094_1m.csv', import.meta.url));
    const allM15 = await loadCsvCandles(m15Path);
    const allM1 = await loadCsvCandles(m1Path);
    const cutoff = allM15.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
    const recent = allM15.filter((item) => item.openTime >= cutoff);
    const recentM1 = allM1.filter((item) => item.openTime >= cutoff);
    const signals = collectSetupSignals(recent);
    const tracker = createAtrTracker(D2_BREAK_V1_ATR_PERIOD);
    const atrAtIndex = recent.map((item) => tracker.next(item));
    const outcomes = { FILLED: 0, EXPIRED_15M: 0, CANCELLED_OVER_EXTENDED: 0 };
    let evaluatedSignals = 0;
    for (const setup of signals) {
      const windowStartTimestamp = recent[setup.triggerIndex].openTime + M15_WINDOW_MS;
      if (recentM1.at(-1)!.openTime < windowStartTimestamp + M15_WINDOW_MS - 60_000) continue;
      const frozenAtrAtTrigger = atrAtIndex[setup.triggerIndex];
      if (frozenAtrAtTrigger === null || frozenAtrAtTrigger === undefined) continue;
      const result = evaluateM1RetestWindow({
        signal: setup,
        m1Candles: recentM1,
        windowStartTimestamp,
        frozenAtrAtTrigger,
        tickSize: 0.1,
      });
      outcomes[result.status] += 1;
      evaluatedSignals += 1;
    }
    const percentage = (count: number): string => ((100 * count) / evaluatedSignals).toFixed(2);

    console.info(
      `BTCUSDT recent-6m M1 retest window: FILLED=${outcomes.FILLED}/${evaluatedSignals} ` +
        `(${percentage(outcomes.FILLED)}%), EXPIRED_15M=${outcomes.EXPIRED_15M} ` +
        `(${percentage(outcomes.EXPIRED_15M)}%), CANCELLED_OVER_EXTENDED=` +
        `${outcomes.CANCELLED_OVER_EXTENDED} ` +
        `(${percentage(outcomes.CANCELLED_OVER_EXTENDED)}%); signals=${signals.length}`,
    );
    expect(signals.length).toBeGreaterThan(0);
    expect(evaluatedSignals).toBeGreaterThan(0);
    expect(outcomes.FILLED + outcomes.EXPIRED_15M + outcomes.CANCELLED_OVER_EXTENDED).toBe(
      evaluatedSignals,
    );
  }, 30_000);
});
