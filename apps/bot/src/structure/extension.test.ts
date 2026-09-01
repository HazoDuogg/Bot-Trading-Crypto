import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAtrTracker } from '../noTradeZone/atr.js';
import type { Candle } from '../noTradeZone/types.js';
import { detectMeaningfulBreak, type BreakResult } from './breakDetector.js';
import { detectSwingPoints } from './swingPoints.js';
import {
  D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO,
  detectNoChaseExtension,
} from './extension.js';

describe('detectNoChaseExtension', () => {
  it('marks distance greater than 2.0 ATR as over-extended', () => {
    expect(detectNoChaseExtension({ currentClose: 121, breakLevel: 100, frozenAtr: 10 })).toEqual({
      isOverExtended: true,
      distanceAtrRatio: 2.1,
    });
  });

  it('does not mark distance below 2.0 ATR', () => {
    expect(detectNoChaseExtension({ currentClose: 119, breakLevel: 100, frozenAtr: 10 })).toEqual({
      isOverExtended: false,
      distanceAtrRatio: 1.9,
    });
  });

  it('includes the exact 2.0 ATR boundary', () => {
    expect(detectNoChaseExtension({ currentClose: 80, breakLevel: 100, frozenAtr: 10 })).toEqual({
      isOverExtended: true,
      distanceAtrRatio: 2,
    });
    expect(D8_NO_CHASE_V1_MAX_DISTANCE_ATR_RATIO).toBe(2);
  });

  it('uses only the supplied break-time ATR and has no candle-series lookahead input', () => {
    const frozenAtBreak = 2;

    expect(detectNoChaseExtension({ currentClose: 105, breakLevel: 100, frozenAtr: frozenAtBreak })).toEqual({
      isOverExtended: true,
      distanceAtrRatio: 2.5,
    });
  });
});

describe('BTCUSDT 3-year sanity diagnostic', () => {
  it('logs eight-candle over-extension after causal D2 breaks without hard-coding a target rate', async () => {
    const csvPath = fileURLToPath(new URL('../../data/BTCUSDT_15m_3y.csv', import.meta.url));
    const rows = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/u).slice(1);
    const all = rows.map((row) => {
      const [openTime, open, high, low, close, volume] = row.split(',').map(Number);
      return { openTime, open, high, low, close, volume } satisfies Candle;
    });
    const cutoff = all.at(-1)!.openTime - 180 * 24 * 60 * 60 * 1000;
    const recent = all.filter((item) => item.openTime >= cutoff);
    const swings = detectSwingPoints(recent);
    const breaks = new Map<string, BreakResult>();
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
        if (result !== null) breaks.set(`${result.brokeAt}:${result.direction}`, result);
      }
    }

    const tracker = createAtrTracker(14);
    const atrAtIndex = recent.map((item) => tracker.next(item));
    const completeEvents = [...breaks.values()].filter((item) => item.brokeAt + 8 < recent.length);
    let overExtended = 0;
    for (const event of completeEvents) {
      const frozenAtr = atrAtIndex[event.brokeAt - 1];
      if (frozenAtr === null || frozenAtr === undefined) continue;
      let flagged = detectNoChaseExtension({
        currentClose: recent[event.brokeAt].close,
        breakLevel: event.level,
        frozenAtr,
      }).isOverExtended;
      for (let offset = 1; offset <= 8 && !flagged; offset += 1) {
        const current = recent[event.brokeAt + offset];
        const retested = event.direction === 'up' ? current.low <= event.level : current.high >= event.level;
        if (retested) break;
        flagged = detectNoChaseExtension({ currentClose: current.close, breakLevel: event.level, frozenAtr }).isOverExtended;
      }
      if (flagged) overExtended += 1;
    }
    const rate = overExtended / completeEvents.length;

    console.info(
      `BTCUSDT recent-6m D8 over-extension before retest/8-candle expiry: ${(rate * 100).toFixed(2)}% ` +
        `(${overExtended}/${completeEvents.length}); cross-coin non-retest reference≈18.4%`,
    );
    expect(completeEvents.length).toBeGreaterThan(0);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  }, 30_000);
});
