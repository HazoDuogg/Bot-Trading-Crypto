import { describe, it, expect } from 'vitest';
import { parseJsonlLines, filterPositionClosedInWindow, computeWeeklyStats, formatWeeklySummaryMessage } from './weeklySummary.js';
import type { LiveEventRecord } from './eventRecord.js';

function closedRecord(overrides: Partial<LiveEventRecord>): LiveEventRecord {
  return { timestampUtc: '2026-08-25T12:00:00.000Z', symbol: 'BTCUSDT', strategy: 'FVG H1+M15', eventKind: 'POSITION_CLOSED', resultOutcome: 'TP', resultPnlUsd: 10, raw: {}, ...overrides };
}

describe('parseJsonlLines', () => {
  it('parses newline-separated JSON objects, skipping blank lines', () => {
    const content = `${JSON.stringify(closedRecord({}))}\n\n${JSON.stringify(closedRecord({ symbol: 'ETHUSDT' }))}\n`;
    const records = parseJsonlLines(content);
    expect(records).toHaveLength(2);
    expect(records[1].symbol).toBe('ETHUSDT');
  });

  it('returns an empty array for empty content', () => {
    expect(parseJsonlLines('')).toEqual([]);
  });
});

describe('filterPositionClosedInWindow', () => {
  it('keeps only POSITION_CLOSED events whose timestampUtc falls in [windowStart, windowEnd)', () => {
    const start = Date.parse('2026-08-24T00:00:00.000Z');
    const end = Date.parse('2026-08-31T00:00:00.000Z');
    const records: LiveEventRecord[] = [
      closedRecord({ timestampUtc: '2026-08-23T23:59:59.000Z' }), // before window
      closedRecord({ timestampUtc: '2026-08-24T00:00:00.000Z' }), // start, inclusive
      closedRecord({ timestampUtc: '2026-08-30T23:59:59.000Z' }), // inside
      closedRecord({ timestampUtc: '2026-08-31T00:00:00.000Z' }), // end, exclusive
      { ...closedRecord({ timestampUtc: '2026-08-25T00:00:00.000Z' }), eventKind: 'ENTRY_PLACED' }, // wrong kind
    ];
    const filtered = filterPositionClosedInWindow(records, start, end);
    expect(filtered).toHaveLength(2);
  });
});

describe('computeWeeklyStats', () => {
  it('returns zeroed stats for an empty list', () => {
    const stats = computeWeeklyStats([]);
    expect(stats).toEqual({ n: 0, wins: 0, losses: 0, winRatePct: 0, pnlUsd: 0, profitFactor: 0, bySymbol: {} });
  });

  it('computes n/wins/losses/winrate/pnl/profitFactor across mixed outcomes', () => {
    const records = [
      closedRecord({ symbol: 'BTCUSDT', resultOutcome: 'TP', resultPnlUsd: 30 }),
      closedRecord({ symbol: 'BTCUSDT', resultOutcome: 'SL', resultPnlUsd: -10 }),
      closedRecord({ symbol: 'ETHUSDT', resultOutcome: 'TP', resultPnlUsd: 20 }),
      closedRecord({ symbol: 'ETHUSDT', resultOutcome: 'SL', resultPnlUsd: -15 }),
    ];
    const stats = computeWeeklyStats(records);
    expect(stats.n).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.winRatePct).toBe(50);
    expect(stats.pnlUsd).toBe(25);
    expect(stats.profitFactor).toBeCloseTo(50 / 25, 5);
  });

  it('breaks down n/winrate/pnl per symbol independently', () => {
    const records = [
      closedRecord({ symbol: 'BTCUSDT', resultPnlUsd: 30 }),
      closedRecord({ symbol: 'BTCUSDT', resultPnlUsd: -10 }),
      closedRecord({ symbol: 'ETHUSDT', resultPnlUsd: 20 }),
    ];
    const stats = computeWeeklyStats(records);
    expect(stats.bySymbol.BTCUSDT).toEqual({ n: 2, wins: 1, winRatePct: 50, pnlUsd: 20 });
    expect(stats.bySymbol.ETHUSDT).toEqual({ n: 1, wins: 1, winRatePct: 100, pnlUsd: 20 });
  });

  it('profitFactor is Infinity when there are wins and zero losses', () => {
    const stats = computeWeeklyStats([closedRecord({ resultPnlUsd: 10 })]);
    expect(stats.profitFactor).toBe(Infinity);
  });

  it('profitFactor is 0 when there are no wins at all', () => {
    const stats = computeWeeklyStats([closedRecord({ resultPnlUsd: -10 })]);
    expect(stats.profitFactor).toBe(0);
  });
});

describe('formatWeeklySummaryMessage', () => {
  const windowStart = new Date('2026-08-24T00:00:00.000Z');
  const windowEnd = new Date('2026-08-31T00:00:00.000Z');

  it('reports "khong co lenh nao" when n=0, never silently empty', () => {
    const msg = formatWeeklySummaryMessage(computeWeeklyStats([]), windowStart, windowEnd);
    expect(msg).toMatch(/không có lệnh nào/i);
    expect(msg).toContain('2026-08-24');
    expect(msg).toContain('2026-08-31');
  });

  it('includes n/winrate/PF/pnl and a per-symbol breakdown table when there are trades', () => {
    const stats = computeWeeklyStats([
      closedRecord({ symbol: 'BTCUSDT', resultPnlUsd: 30 }),
      closedRecord({ symbol: 'ETHUSDT', resultPnlUsd: -10 }),
    ]);
    const msg = formatWeeklySummaryMessage(stats, windowStart, windowEnd);
    expect(msg).toContain('Tổng lệnh: 2');
    expect(msg).toContain('50.0%');
    expect(msg).toContain('BTCUSDT');
    expect(msg).toContain('ETHUSDT');
    expect(msg).toContain('+20.00');
  });
});
