import { describe, expect, it } from 'vitest';
import { runCasperHistoricalBacktest } from './historicalBacktest.js';
import type { CasperHistoricalDataset } from './historicalBacktest.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;
const at = (iso: string) => Date.parse(iso);

function candle(
  start: string,
  durationMinutes: number,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  const startTimeMs = at(start);
  return {
    startTimeMs,
    endTimeMs: startTimeMs + durationMinutes * minute,
    open,
    high,
    low,
    close,
  };
}

function longWinDay(): CasperHistoricalDataset {
  return {
    symbol: 'TEST',
    m15: [candle('2026-07-15T13:30:00Z', 15, 100, 110, 90, 100)],
    m5: [
      candle('2026-07-15T13:45:00Z', 5, 100, 105, 98, 102),
      candle('2026-07-15T13:50:00Z', 5, 102, 114, 101, 109),
      candle('2026-07-15T13:55:00Z', 5, 111, 115, 106, 113),
    ],
    m1: [
      candle('2026-07-15T14:00:00Z', 1, 106, 107, 104, 106),
      candle('2026-07-15T14:01:00Z', 1, 107, 120, 106, 119),
    ],
  };
}

const zeroCosts = {
  entryFeeRate: 0,
  exitFeeRate: 0,
  entrySlippageRate: 0,
  exitSlippageRate: 0,
};

function run(dataset: CasperHistoricalDataset, costs = zeroCosts) {
  return runCasperHistoricalBacktest(dataset, { costs });
}

function shortLossDay(): CasperHistoricalDataset {
  return {
    symbol: 'TEST',
    m15: [candle('2026-07-16T13:30:00Z', 15, 100, 110, 90, 100)],
    m5: [
      candle('2026-07-16T13:45:00Z', 5, 100, 102, 95, 98),
      candle('2026-07-16T13:50:00Z', 5, 98, 99, 91, 92),
      candle('2026-07-16T13:55:00Z', 5, 89, 94, 85, 87),
    ],
    m1: [
      candle('2026-07-16T14:00:00Z', 1, 96, 96, 94, 95),
      candle('2026-07-16T14:01:00Z', 1, 96, 103, 90, 101),
    ],
  };
}

function minuteCandles(
  startMs: number,
  count: number,
  values: [number, number, number, number] = [120, 121, 119, 120],
): CasperCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const candleStart = startMs + index * minute;
    return {
      startTimeMs: candleStart,
      endTimeMs: candleStart + minute,
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
    };
  });
}

function genericFvgDay(): CasperHistoricalDataset {
  const dataset = longWinDay();
  return {
    ...dataset,
    m5: [
      candle('2026-07-15T13:45:00Z', 5, 96, 100, 95, 98),
      candle('2026-07-15T13:50:00Z', 5, 98, 104, 97, 102),
      candle('2026-07-15T13:55:00Z', 5, 102, 106, 101, 105),
    ],
  };
}

function twoDirectionDay(): CasperHistoricalDataset {
  const dataset = longWinDay();
  const m1 = minuteCandles(at('2026-07-15T14:00:00Z'), 32, [100, 101, 99, 100]);
  m1[0] = candle('2026-07-15T14:00:00Z', 1, 106, 107, 104, 106);
  m1[1] = candle('2026-07-15T14:01:00Z', 1, 107, 120, 106, 119);
  m1[30] = candle('2026-07-15T14:30:00Z', 1, 96, 96, 94, 95);
  m1[31] = candle('2026-07-15T14:31:00Z', 1, 96, 103, 90, 101);
  return {
    ...dataset,
    m5: [
      ...dataset.m5,
      candle('2026-07-15T14:15:00Z', 5, 100, 102, 95, 98),
      candle('2026-07-15T14:20:00Z', 5, 98, 99, 91, 92),
      candle('2026-07-15T14:25:00Z', 5, 89, 94, 85, 87),
    ],
    m1,
  };
}

describe('runCasperHistoricalBacktest', () => {
  it('runs a synthetic full-day LONG win through the public pipeline', () => {
    const result = run(longWinDay());

    expect(result.state).toBe('COMPLETED');
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      direction: 'LONG',
      executionState: 'FILLED',
      outcomes: { '1.5R': 'WIN', '2.0R': 'WIN' },
    });
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].wins).toBe(1);
    expect(result.summaries.ALL_VALID_SETUPS['2.0R'].wins).toBe(1);
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].costDragR).toBe(0);
  });

  it('runs a SHORT loss and keeps RR summaries independent', () => {
    const result = run(shortLossDay());

    expect(result.traces[0]).toMatchObject({
      direction: 'SHORT',
      outcomes: { '1.5R': 'LOSS', '2.0R': 'LOSS' },
    });
    expect(result.summaries.ALL_VALID_SETUPS['1.5R']).toMatchObject({ losses: 1, grossR: -1 });
    expect(result.summaries.ALL_VALID_SETUPS['2.0R']).toMatchObject({ losses: 1, grossR: -1 });
  });

  it('does not trade without OR or for a generic in-range FVG', () => {
    const noOr = longWinDay();
    const withoutOr = run({ ...noOr, m15: [] });
    const generic = run(genericFvgDay());

    expect(withoutOr.traces).toHaveLength(0);
    expect(withoutOr.issues.some((issue) => issue.code === 'MISSING_OR_M15')).toBe(true);
    expect(generic.traces).toHaveLength(0);
  });

  it('does not treat an M5 candle crossing New York midnight as setup-window coverage', () => {
    const dataset = longWinDay();
    dataset.m5 = [
      ...dataset.m5,
      candle('2026-07-16T03:55:00Z', 5, 100, 101, 99, 100),
    ];
    const result = run(dataset);

    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].candidates).toBe(1);
    expect(result.issues.some((issue) => issue.code === 'MISSING_M5')).toBe(false);
  });

  it('preserves cancelled pending and ambiguous execution', () => {
    const pending = longWinDay();
    pending.m1 = minuteCandles(at('2026-07-15T14:00:00Z'), 120);
    const cancelled = run(pending);
    const ambiguousInput = longWinDay();
    ambiguousInput.m1 = [candle('2026-07-15T14:00:00Z', 1, 105, 120, 98, 110)];
    const ambiguous = run(ambiguousInput);

    expect(cancelled.traces[0].outcomes).toEqual({ '1.5R': 'CANCELLED', '2.0R': 'CANCELLED' });
    expect(cancelled.summaries.ALL_VALID_SETUPS['1.5R'].cancelled).toBe(1);
    expect(ambiguous.traces[0].outcomes).toEqual({ '1.5R': 'AMBIGUOUS', '2.0R': 'AMBIGUOUS' });
  });

  it('reports missing M1 coverage instead of inventing an outcome', () => {
    const dataset = longWinDay();
    dataset.m1 = [];
    const result = run(dataset);

    expect(result.traces[0].outcomes).toEqual({ '1.5R': 'INVALID', '2.0R': 'INVALID' });
    expect(result.issues.some((issue) => issue.code === 'MISSING_M1_COVERAGE')).toBe(true);
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].invalid).toBe(1);
  });

  it('keeps a filled position OPEN when supplied day data ends without an exit', () => {
    const dataset = longWinDay();
    dataset.m1 = [candle('2026-07-15T14:00:00Z', 1, 106, 107, 104, 106)];
    const result = run(dataset);

    expect(result.traces[0].outcomes).toEqual({ '1.5R': 'OPEN', '2.0R': 'OPEN' });
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].open).toBe(1);
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].grossR).toBe(0);
  });

  it('applies configured costs while retaining zero-cost control', () => {
    const result = run(longWinDay(), {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      entrySlippageRate: 0.001,
      exitSlippageRate: 0.001,
    });
    const summary = result.summaries.ALL_VALID_SETUPS['1.5R'];

    expect(summary.netR).toBeLessThan(summary.grossR);
    expect(summary.zeroCostControlR).toBe(1.5);
    expect(summary.costDragR).toBeGreaterThan(0);
  });

  it('supports chronological FIRST and complete ALL modes with opposite directions', () => {
    const result = run(twoDirectionDay());

    expect(result.traces.map((trace) => trace.direction)).toEqual(['LONG', 'SHORT']);
    expect(result.selectedTraceIndexes.FIRST_VALID_PER_DAY).toEqual([0]);
    expect(result.selectedTraceIndexes.ALL_VALID_SETUPS).toEqual([0, 1]);
    expect(result.summaries.FIRST_VALID_PER_DAY['1.5R'].validSetups).toBe(1);
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].validSetups).toBe(2);
  });

  it('keeps 1.5R WIN independent while 2R later becomes LOSS', () => {
    const dataset = longWinDay();
    dataset.m1 = [
      candle('2026-07-15T14:00:00Z', 1, 106, 107, 104, 106),
      candle('2026-07-15T14:01:00Z', 1, 107, 116, 106, 115),
      candle('2026-07-15T14:02:00Z', 1, 105, 106, 98, 99),
    ];
    const result = run(dataset);

    expect(result.traces[0].outcomes).toEqual({ '1.5R': 'WIN', '2.0R': 'LOSS' });
    expect(result.summaries.ALL_VALID_SETUPS['1.5R'].grossR).toBe(1.5);
    expect(result.summaries.ALL_VALID_SETUPS['2.0R'].grossR).toBe(-1);
  });

  it('fails closed for malformed candles and unsafe cost rates', () => {
    const malformed = longWinDay();
    malformed.m1 = [candle('2026-07-15T14:00:30Z', 1, 106, 107, 104, 106)];
    const invalidData = run(malformed);
    const unsafeRates = [-1, 1, Number.NaN, Number.POSITIVE_INFINITY];

    expect(invalidData.state).toBe('INVALID_DATA');
    expect(invalidData.issues[0].code).toBe('MALFORMED_CANDLE');
    for (const entryFeeRate of unsafeRates) {
      expect(run(longWinDay(), { ...zeroCosts, entryFeeRate }).state).toBe('INVALID_CONFIG');
    }
  });

  it('reports duplicate and out-of-order timestamps', () => {
    const duplicate = longWinDay();
    duplicate.m5 = [duplicate.m5[0], duplicate.m5[0], duplicate.m5[1], duplicate.m5[2]];
    const duplicateResult = run(duplicate);
    const outOfOrder = longWinDay();
    outOfOrder.m5 = [outOfOrder.m5[1], outOfOrder.m5[0], outOfOrder.m5[2]];
    const outOfOrderResult = run(outOfOrder);

    expect(duplicateResult.state).toBe('INVALID_DATA');
    expect(duplicateResult.issues.some((issue) => issue.code === 'DUPLICATE_TIMESTAMP')).toBe(true);
    expect(outOfOrderResult.state).toBe('INVALID_DATA');
    expect(outOfOrderResult.issues.some((issue) => issue.code === 'OUT_OF_ORDER_TIMESTAMP')).toBe(true);
  });

  it('is deterministic across identical reruns', () => {
    const first = run(twoDirectionDay());
    const second = run(twoDirectionDay());

    expect(second).toEqual(first);
  });
});
