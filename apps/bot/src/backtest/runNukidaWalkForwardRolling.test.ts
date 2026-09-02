import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  DAY_MS,
  M15_MS,
  assertRollingFingerprint,
  buildCoinWindowAssignments,
  buildPostStopRecoveryReport,
  buildRollingWindows,
  buildTimingComparison,
  attachTicket024TradeComparisons,
  runNukidaWalkForwardRolling,
} from './runNukidaWalkForwardRolling.js';

describe('buildRollingWindows', () => {
  it('covers the complete history with consecutive non-overlapping 180-day windows', () => {
    const historyEnd = 450 * DAY_MS;
    const windows = buildRollingWindows(0, historyEnd - M15_MS);

    expect(windows).toEqual([
      { index: 0, startInclusive: 0, endExclusive: 180 * DAY_MS, partial: false },
      {
        index: 1,
        startInclusive: 180 * DAY_MS,
        endExclusive: 360 * DAY_MS,
        partial: false,
      },
      {
        index: 2,
        startInclusive: 360 * DAY_MS,
        endExclusive: historyEnd,
        partial: true,
      },
    ]);
    expect(windows[0].endExclusive).toBe(windows[1].startInclusive);
    expect(windows[1].endExclusive).toBe(windows[2].startInclusive);
  });

  it('skips coin windows with missing start/end coverage instead of interpolating', () => {
    const windows = buildRollingWindows(0, 450 * DAY_MS - M15_MS);
    const assignments = buildCoinWindowAssignments(windows, {
      firstOpenTime: 190 * DAY_MS,
      lastOpenTime: 400 * DAY_MS - M15_MS,
    });

    expect(assignments.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'SKIPPED_NO_DATA', reason: 'NO_DATA_IN_WINDOW' },
      { status: 'SKIPPED_NO_DATA', reason: 'MISSING_WINDOW_START' },
      { status: 'SKIPPED_NO_DATA', reason: 'MISSING_WINDOW_END' },
    ]);
  });
});

describe('assertRollingFingerprint', () => {
  it('throws before a mismatched rolling window can run', () => {
    expect(() => assertRollingFingerprint('locked-hash', 'changed-hash', 3)).toThrow(
      'Strategy fingerprint mismatch at window 3',
    );
    expect(() => assertRollingFingerprint('locked-hash', 'locked-hash', 3)).not.toThrow();
  });
});

describe('buildTimingComparison', () => {
  it('puts old and new netR/PF side by side for setup, direction, and every coin', () => {
    const metric = (netR: number, profitFactor: number) => ({
      closedTrades: 1,
      grossR: netR,
      feeR: 0,
      spreadR: 0,
      slippageR: 0,
      netR,
      profitFactor,
      expectancyPerTrade: netR,
      maxDrawdownR: 0,
      winRate: 1,
      ambiguousTrades: 0,
      openTrades: 0,
    });
    const dual = (netR: number) => ({
      zeroCost: metric(netR, 1.1),
      realisticCost: metric(netR - 0.1, 1.05),
    });
    const report = (netR: number) => ({
      overall: dual(netR),
      bySetupFamily: {
        A_COMPRESSION_BREAKOUT: dual(netR + 1),
      },
      byDirection: { BULL: dual(netR + 2), BEAR: dual(netR - 2) },
    });
    const previous = {
      windows: [
        {
          window: { index: 0 },
          report: report(1),
          coinResults: [{ coin: 'BTCUSDT', status: 'COMPLETED', report: report(0.5) }],
        },
      ],
    };
    const current = [
      {
        window: { index: 0 },
        report: report(2),
        coinResults: [{ coin: 'BTCUSDT', status: 'COMPLETED', report: report(1.5) }],
      },
    ];

    const rows = buildTimingComparison(previous, current as never);

    expect(rows).toHaveLength(9);
    expect(rows.find((row) => row.segment === 'A_COMPRESSION_BREAKOUT')).toMatchObject({
      before: { realisticCost: { netR: 1.9, profitFactor: 1.05 } },
      after: { realisticCost: { netR: 2.9, profitFactor: 1.05 } },
    });
    expect(rows.find((row) => row.segment === 'BTCUSDT')).toMatchObject({
      beforeStatus: 'COMPLETED',
      afterStatus: 'COMPLETED',
      before: { realisticCost: { netR: 0.4 } },
      after: { realisticCost: { netR: 1.4 } },
    });
    expect(rows.find((row) => row.segment === 'DOGEUSDT')).toMatchObject({
      beforeStatus: 'MISSING',
      afterStatus: 'MISSING',
      before: null,
      after: null,
    });
  });
});

describe('TICKET-024 per-trade attribution baseline', () => {
  it('matches the committed old trade and reports bounded recovery percentages', () => {
    const snapshot = {
      coin: 'BTCUSDT',
      setupFamily: 'A_COMPRESSION_BREAKOUT',
      firstTouchFillTimestamp: 1_000,
      firstTouchFillPrice: 100,
      minutesSignalToFill: 4,
      costR: 0.2,
      tradePlan: { direction: 'BULL', entryPrice: 100 },
      execution: { outcome: 'LOSS', exitTimestamp: 2_000 },
    };
    const previous = {
      windows: [
        {
          window: { index: 0 },
          tradeLogs: [{ ...snapshot, reached1_5ROrMore: true, reached2ROrMore: true }],
        },
      ],
    };
    const current = [
      {
        window: { index: 0 },
        tradeLogs: [
          {
            ...snapshot,
            postStopHorizons: {
              min15: { reached1_5R: false, reached2R: false, mfeR: 1 },
              min30: { reached1_5R: true, reached2R: false, mfeR: 1.5 },
              min60: { reached1_5R: true, reached2R: true, mfeR: 2 },
              min120: { reached1_5R: true, reached2R: true, mfeR: 2.1 },
              min240: { reached1_5R: true, reached2R: true, mfeR: 2.2 },
            },
          },
        ],
      },
    ];

    const annotated = attachTicket024TradeComparisons(previous, current as never);
    const comparison = annotated[0].tradeLogs[0].ticket024Comparison;
    const report = buildPostStopRecoveryReport(previous, annotated as never);

    expect(comparison).toMatchObject({
      outcomeChanged: false,
      exitTimeDeltaMinutes: 0,
      old: {
        outcome: 'LOSS',
        firstTouchFillTimestamp: 1_000,
        costR: 0.2,
        minutesSignalToFill: 4,
      },
      current: {
        outcome: 'LOSS',
        firstTouchFillTimestamp: 1_000,
        costR: 0.2,
        minutesSignalToFill: 4,
      },
    });
    expect(report).toMatchObject({
      lossTrades: 1,
      baselineUnbounded: { reached1_5R: 1, reached2R: 1 },
      horizons: {
        min15: {
          reached1_5R: { count: 0, percentOfBaselineReached: 0 },
          reached2R: { count: 0, percentOfBaselineReached: 0 },
        },
        min30: {
          reached1_5R: { count: 1, percentOfBaselineReached: 100 },
          reached2R: { count: 0, percentOfBaselineReached: 0 },
        },
        min60: {
          reached1_5R: { count: 1, percentOfBaselineReached: 100 },
          reached2R: { count: 1, percentOfBaselineReached: 100 },
        },
      },
    });
  });
});

describe('SOLUSDT historical tick-size integration', () => {
  it(
    'completes rolling windows 0-2 with a machine-derived M1 close tick size',
    async () => {
      const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
      const result = await runNukidaWalkForwardRolling(dataDirectory, {
        coins: ['SOLUSDT'],
        windowIndexes: [0, 1, 2],
      });

      expect(result.windows.map((window) => window.coinResults[0].status)).toEqual([
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
      ]);
      expect(
        result.windows.map((window) => window.coinResults[0].tickSizeInference?.tickSize),
      ).toEqual([0.001, 0.001, 0.001]);
      expect(result.engineErrorWarnings).toEqual([]);
    },
    60_000,
  );

  it(
    'excludes the single BTC window-1 outlier and keeps the coin completed',
    async () => {
      const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
      const result = await runNukidaWalkForwardRolling(dataDirectory, {
        coins: ['BTCUSDT'],
        windowIndexes: [1],
      });
      const coin = result.windows[0].coinResults[0];

      expect(coin.status).toBe('COMPLETED');
      expect(coin.tickSizeInference?.tickSize).toBe(0.1);
      expect(coin.outliersExcluded).toBe(1);
      expect(coin.excludedTickOutliers).toMatchObject([{ close: 55181.35 }]);
      expect(result.engineErrorWarnings).toEqual([]);
    },
    60_000,
  );

  it(
    'excludes the single SOL window-4 outlier and keeps the coin completed',
    async () => {
      const dataDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
      const result = await runNukidaWalkForwardRolling(dataDirectory, {
        coins: ['SOLUSDT'],
        windowIndexes: [4],
      });
      const coin = result.windows[0].coinResults[0];

      expect(coin.status).toBe('COMPLETED');
      expect(coin.tickSizeInference?.tickSize).toBe(0.01);
      expect(coin.outliersExcluded).toBe(1);
      expect(coin.excludedTickOutliers).toMatchObject([{ close: 184.319 }]);
      expect(result.engineErrorWarnings).toEqual([]);
    },
    60_000,
  );
});
