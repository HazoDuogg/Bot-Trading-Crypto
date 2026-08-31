import { describe, expect, it } from 'vitest';
import {
  createPendingLimitOrder,
  evaluatePendingLimitOrder,
} from './pendingLimitLifecycle.js';
import type { CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;

function m5(
  startIso: string,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  const startTimeMs = Date.parse(startIso);
  return { startTimeMs, endTimeMs: startTimeMs + 5 * minute, open, high, low, close };
}

function tradePlan(direction: 'LONG' | 'SHORT'): CasperTradePlan {
  const c1 =
    direction === 'LONG'
      ? m5('2026-07-15T13:45:00Z', 101, 105, 99, 103)
      : m5('2026-07-15T13:45:00Z', 108, 111, 105, 107);
  const c2 = m5('2026-07-15T13:50:00Z', 103, 112, 102, 110);
  const c3 = m5('2026-07-15T13:55:00Z', 109, 113, 107, 111);
  return {
    state: 'VALID_TRADE_PLAN',
    direction,
    entryType: 'LIMIT',
    entry: 105,
    stopLoss: direction === 'LONG' ? 99 : 111,
    riskPerUnit: 6,
    targets: direction === 'LONG' ? { '1.5R': 114, '2.0R': 117 } : { '1.5R': 96, '2.0R': 93 },
    fvgLow: direction === 'LONG' ? 105 : 103,
    fvgHigh: direction === 'LONG' ? 107 : 105,
    tradingDay: '2026-07-15',
    sourceCandles: { c1, c2, c3 },
  };
}

describe('pending limit lifecycle', () => {
  it('creates a pending order only after C3 closes', () => {
    const plan = tradePlan('LONG');

    expect(createPendingLimitOrder(plan)).toEqual({
      state: 'PENDING',
      direction: 'LONG',
      entry: 105,
      stopLoss: 99,
      targets: { '1.5R': 114, '2.0R': 117 },
      createdAtMs: plan.sourceCandles.c3.endTimeMs,
      tradingDay: '2026-07-15',
    });
  });

  it('fills a LONG at exact entry touch on the first future candle', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const fillCandle = m5('2026-07-15T14:00:00Z', 108, 110, 105, 107);
    const result = evaluatePendingLimitOrder(pending, fillCandle, fillCandle.endTimeMs);

    expect(result).toMatchObject({
      state: 'FILLED',
      fillPrice: 105,
      filledAtMs: fillCandle.endTimeMs,
    });
  });

  it('fills a SHORT at exact entry touch', () => {
    const pending = createPendingLimitOrder(tradePlan('SHORT'));
    const fillCandle = m5('2026-07-15T14:00:00Z', 102, 105, 100, 103);

    expect(
      evaluatePendingLimitOrder(pending, fillCandle, fillCandle.endTimeMs),
    ).toMatchObject({ state: 'FILLED', fillPrice: 105 });
  });

  it('keeps LONG and SHORT pending when entry is not touched', () => {
    const longOrder = createPendingLimitOrder(tradePlan('LONG'));
    const shortOrder = createPendingLimitOrder(tradePlan('SHORT'));
    const aboveEntry = m5('2026-07-15T14:00:00Z', 108, 110, 106, 109);
    const belowEntry = m5('2026-07-15T14:00:00Z', 102, 104, 99, 101);

    expect(evaluatePendingLimitOrder(longOrder, aboveEntry, aboveEntry.endTimeMs)).toBe(
      longOrder,
    );
    expect(evaluatePendingLimitOrder(shortOrder, belowEntry, belowEntry.endTimeMs)).toBe(
      shortOrder,
    );
  });

  it('rejects a candle from before order activation', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const earlier = m5('2026-07-15T13:50:00Z', 103, 110, 100, 105);

    expect(evaluatePendingLimitOrder(pending, earlier, earlier.endTimeMs)).toEqual({
      state: 'INVALID',
      reason: 'PRE_ACTIVATION_CANDLE',
    });
  });

  it('never uses C3 for retroactive fill', () => {
    const plan = tradePlan('LONG');
    plan.sourceCandles.c3 = {
      ...plan.sourceCandles.c3,
      low: 100,
    };
    const pending = createPendingLimitOrder(plan);

    expect(
      evaluatePendingLimitOrder(
        pending,
        plan.sourceCandles.c3,
        plan.sourceCandles.c3.endTimeMs,
      ),
    ).toEqual({ state: 'INVALID', reason: 'PRE_ACTIVATION_CANDLE' });
  });

  it('fills at exact entry without LONG or SHORT price improvement', () => {
    const longOrder = createPendingLimitOrder(tradePlan('LONG'));
    const shortOrder = createPendingLimitOrder(tradePlan('SHORT'));
    const longCross = m5('2026-07-15T14:00:00Z', 108, 109, 100, 103);
    const shortCross = m5('2026-07-15T14:00:00Z', 102, 110, 101, 108);

    expect(
      evaluatePendingLimitOrder(longOrder, longCross, longCross.endTimeMs),
    ).toMatchObject({ state: 'FILLED', fillPrice: 105 });
    expect(
      evaluatePendingLimitOrder(shortOrder, shortCross, shortCross.endTimeMs),
    ).toMatchObject({ state: 'FILLED', fillPrice: 105 });
  });

  it('does not fill a LONG when the full candle is below entry', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const belowEntry = m5('2026-07-15T14:00:00Z', 100, 104, 98, 102);

    expect(evaluatePendingLimitOrder(pending, belowEntry, belowEntry.endTimeMs)).toBe(
      pending,
    );
  });

  it('does not fill a SHORT when the full candle is above entry', () => {
    const pending = createPendingLimitOrder(tradePlan('SHORT'));
    const aboveEntry = m5('2026-07-15T14:00:00Z', 108, 110, 106, 109);

    expect(evaluatePendingLimitOrder(pending, aboveEntry, aboveEntry.endTimeMs)).toBe(
      pending,
    );
  });

  it('prevents duplicate fill and preserves the first fill timestamp', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const first = m5('2026-07-15T14:00:00Z', 108, 109, 100, 103);
    const second = m5('2026-07-15T14:05:00Z', 107, 108, 99, 104);
    const filled = evaluatePendingLimitOrder(pending, first, first.endTimeMs);

    expect(evaluatePendingLimitOrder(filled, second, second.endTimeMs)).toBe(filled);
    expect(filled).toMatchObject({ filledAtMs: first.endTimeMs, fillPrice: 105 });
  });

  it('does not revive a cancelled order', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const cutoffCandle = m5('2026-07-15T15:55:00Z', 108, 110, 105, 107);
    const cancelled = evaluatePendingLimitOrder(
      pending,
      cutoffCandle,
      cutoffCandle.endTimeMs,
    );
    const later = m5('2026-07-15T16:00:00Z', 108, 110, 105, 107);

    expect(evaluatePendingLimitOrder(cancelled, later, later.endTimeMs)).toBe(cancelled);
  });

  it('rejects a fill candle from the wrong New York trading day', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const nextDay = m5('2026-07-16T14:00:00Z', 108, 110, 105, 107);

    expect(evaluatePendingLimitOrder(pending, nextDay, nextDay.endTimeMs)).toEqual({
      state: 'INVALID',
      reason: 'INVALID_CANDLE',
    });
  });

  it('fails closed on malformed OHLC', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const malformed = m5('2026-07-15T14:00:00Z', 108, 100, 106, 107);

    expect(evaluatePendingLimitOrder(pending, malformed, malformed.endTimeMs)).toEqual({
      state: 'INVALID',
      reason: 'INVALID_CANDLE',
    });
  });

  it('cancels instead of filling from the 11:55-12:00 candle', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const ambiguous = m5('2026-07-15T15:55:00Z', 108, 110, 105, 107);
    const result = evaluatePendingLimitOrder(pending, ambiguous, ambiguous.endTimeMs);

    expect(result).toMatchObject({
      state: 'CANCELLED',
      cancelledAtMs: Date.parse('2026-07-15T16:00:00Z'),
    });
    expect(result).not.toHaveProperty('fillPrice');
  });

  it('does not fill after 12:00 New York', () => {
    const pending = createPendingLimitOrder(tradePlan('SHORT'));
    const afterCutoff = m5('2026-07-15T16:00:00Z', 102, 105, 100, 103);

    expect(
      evaluatePendingLimitOrder(pending, afterCutoff, afterCutoff.endTimeMs),
    ).toMatchObject({ state: 'CANCELLED', cancelledAtMs: Date.parse('2026-07-15T16:00:00Z') });
  });

  it('records only FILLED when the fill candle also spans SL and both targets', () => {
    const pending = createPendingLimitOrder(tradePlan('LONG'));
    const ambiguousOutcome = m5('2026-07-15T14:00:00Z', 108, 118, 98, 110);
    const result = evaluatePendingLimitOrder(
      pending,
      ambiguousOutcome,
      ambiguousOutcome.endTimeMs,
    );

    expect(result).toMatchObject({ state: 'FILLED', fillPrice: 105 });
    expect(result).not.toHaveProperty('outcome');
  });

  it('does not create a pending order from an invalid trade plan', () => {
    expect(
      createPendingLimitOrder({ state: 'INVALID_TRADE_PLAN', reason: 'INVALID_RISK' }),
    ).toEqual({ state: 'INVALID', reason: 'INVALID_TRADE_PLAN' });
  });
});
