import { describe, expect, it } from 'vitest';
import { replayCasperM1Execution } from './m1ExecutionReplay.js';
import {
  createPendingLimitOrder,
  evaluatePendingLimitOrder,
} from './pendingLimitLifecycle.js';
import type { CasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

const minute = 60_000;

function candle(
  startIso: string,
  durationMinutes: number,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  const startTimeMs = Date.parse(startIso);
  return {
    startTimeMs,
    endTimeMs: startTimeMs + durationMinutes * minute,
    open,
    high,
    low,
    close,
  };
}

function m1(startIso: string, open: number, high: number, low: number, close: number) {
  return candle(startIso, 1, open, high, low, close);
}

function tradePlan(direction: 'LONG' | 'SHORT'): CasperTradePlan {
  const c1 =
    direction === 'LONG'
      ? candle('2026-07-15T13:45:00Z', 5, 101, 105, 99, 103)
      : candle('2026-07-15T13:45:00Z', 5, 108, 111, 105, 107);
  const c2 = candle('2026-07-15T13:50:00Z', 5, 103, 112, 102, 110);
  const c3 = candle('2026-07-15T13:55:00Z', 5, 109, 113, 107, 111);
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

function replay(plan: CasperTradePlan, candles: CasperCandle[]) {
  return replayCasperM1Execution({
    tradePlan: plan,
    pendingOrder: createPendingLimitOrder(plan),
    candles,
  });
}

describe('replayCasperM1Execution', () => {
  it('ignores pre-C3 M1 and fills LONG at exact entry on the first future M1', () => {
    const plan = tradePlan('LONG');
    const beforeActivation = m1('2026-07-15T13:59:00Z', 106, 108, 105, 107);
    const firstFuture = m1('2026-07-15T14:00:00Z', 107, 108, 105, 106);

    expect(replay(plan, [beforeActivation, firstFuture])).toEqual({
      state: 'FILLED',
      direction: 'LONG',
      entry: 105,
      stopLoss: 99,
      targets: { '1.5R': 114, '2.0R': 117 },
      createdAtMs: plan.sourceCandles.c3.endTimeMs,
      filledAtMs: firstFuture.endTimeMs,
      fillPrice: 105,
      tradingDay: '2026-07-15',
      variants: { '1.5R': 'OPEN', '2.0R': 'OPEN' },
    });
  });

  it('fills SHORT at exact entry with no price improvement', () => {
    const plan = tradePlan('SHORT');
    const fill = m1('2026-07-15T14:00:00Z', 106, 110, 105, 108);

    expect(replay(plan, [fill])).toMatchObject({
      state: 'FILLED',
      direction: 'SHORT',
      fillPrice: 105,
      filledAtMs: fill.endTimeMs,
    });
  });

  it('keeps an untouched order pending', () => {
    const plan = tradePlan('LONG');
    const noTouch = m1('2026-07-15T14:00:00Z', 108, 110, 106, 109);

    expect(replay(plan, [noTouch])).toMatchObject({ state: 'PENDING', direction: 'LONG' });
  });

  it('uses the first M1 touch instead of an M5 fill timestamp', () => {
    const plan = tradePlan('LONG');
    const pending = createPendingLimitOrder(plan);
    const m5Fill = candle('2026-07-15T14:00:00Z', 5, 108, 110, 100, 107);
    const m5Filled = evaluatePendingLimitOrder(pending, m5Fill, m5Fill.endTimeMs);
    const noTouch = m1('2026-07-15T14:00:00Z', 108, 110, 106, 109);
    const firstM1Touch = m1('2026-07-15T14:02:00Z', 107, 108, 105, 106);
    const result = replayCasperM1Execution({
      tradePlan: plan,
      pendingOrder: m5Filled,
      candles: [noTouch, firstM1Touch],
    });

    expect(result).toMatchObject({
      state: 'FILLED',
      filledAtMs: firstM1Touch.endTimeMs,
      fillPrice: 105,
    });
    expect(result).not.toMatchObject({ filledAtMs: m5Fill.endTimeMs });
  });

  it('lets M1 confirm a pre-noon fill hidden by the conservative M5 cancellation', () => {
    const plan = tradePlan('LONG');
    const pending = createPendingLimitOrder(plan);
    const ambiguousM5 = candle('2026-07-15T15:55:00Z', 5, 108, 110, 100, 107);
    const m5Cancelled = evaluatePendingLimitOrder(
      pending,
      ambiguousM5,
      ambiguousM5.endTimeMs,
    );
    const preciseM1Fill = m1('2026-07-15T15:58:00Z', 107, 108, 105, 106);

    expect(
      replayCasperM1Execution({
        tradePlan: plan,
        pendingOrder: m5Cancelled,
        candles: [preciseM1Fill],
      }),
    ).toMatchObject({ state: 'FILLED', filledAtMs: preciseM1Fill.endTimeMs });
  });

  it('fails closed on malformed or non-chronological M1 data', () => {
    const plan = tradePlan('LONG');
    const malformed = candle('2026-07-15T14:00:00Z', 2, 107, 108, 105, 106);
    const first = m1('2026-07-15T14:01:00Z', 107, 108, 105, 106);
    const earlier = m1('2026-07-15T14:00:00Z', 107, 108, 105, 106);

    expect(replay(plan, [malformed])).toEqual({
      state: 'INVALID',
      reason: 'INVALID_M1_DATA',
    });
    expect(replay(plan, [first, earlier])).toEqual({
      state: 'INVALID',
      reason: 'NON_CHRONOLOGICAL_M1',
    });
  });

  it('rejects unaligned and non-finite M1 OHLC', () => {
    const plan = tradePlan('LONG');
    const unaligned = m1('2026-07-15T14:00:30Z', 107, 108, 105, 106);
    const nonFinite = m1('2026-07-15T14:00:00Z', 107, Number.NaN, 105, 106);

    expect(replay(plan, [unaligned]).state).toBe('INVALID');
    expect(replay(plan, [nonFinite]).state).toBe('INVALID');
  });

  it('rejects M1 data from the wrong New York trading day', () => {
    const plan = tradePlan('LONG');
    const wrongDay = m1('2026-07-16T14:00:00Z', 107, 108, 105, 106);

    expect(replay(plan, [wrongDay])).toEqual({
      state: 'INVALID',
      reason: 'INVALID_M1_DATA',
    });
  });

  it('records LONG and SHORT stop losses on a later M1', () => {
    const longFill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const longStop = m1('2026-07-15T14:01:00Z', 104, 108, 99, 102);
    const shortFill = m1('2026-07-15T14:00:00Z', 104, 105, 103, 104);
    const shortStop = m1('2026-07-15T14:01:00Z', 106, 111, 100, 108);

    expect(replay(tradePlan('LONG'), [longFill, longStop])).toMatchObject({
      variants: { '1.5R': 'LOSS', '2.0R': 'LOSS' },
    });
    expect(replay(tradePlan('SHORT'), [shortFill, shortStop])).toMatchObject({
      variants: { '1.5R': 'LOSS', '2.0R': 'LOSS' },
    });
  });

  it('records LONG 1.5R while 2.0R remains open', () => {
    const fill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const target1 = m1('2026-07-15T14:01:00Z', 108, 114, 103, 112);

    expect(replay(tradePlan('LONG'), [fill, target1])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'OPEN' },
    });
  });

  it('records SHORT 1.5R while 2.0R remains open', () => {
    const fill = m1('2026-07-15T14:00:00Z', 104, 105, 103, 104);
    const target1 = m1('2026-07-15T14:01:00Z', 101, 108, 96, 98);

    expect(replay(tradePlan('SHORT'), [fill, target1])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'OPEN' },
    });
  });

  it('records LONG and SHORT 2.0R wins independently', () => {
    const longFill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const longTarget2 = m1('2026-07-15T14:01:00Z', 112, 117, 103, 116);
    const shortFill = m1('2026-07-15T14:00:00Z', 104, 105, 103, 104);
    const shortTarget2 = m1('2026-07-15T14:01:00Z', 100, 108, 93, 95);

    expect(replay(tradePlan('LONG'), [longFill, longTarget2])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'WIN' },
    });
    expect(replay(tradePlan('SHORT'), [shortFill, shortTarget2])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'WIN' },
    });
  });

  it('keeps 1.5R WIN while 2.0R later becomes LOSS', () => {
    const fill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const target1 = m1('2026-07-15T14:01:00Z', 108, 114, 103, 112);
    const reversal = m1('2026-07-15T14:02:00Z', 107, 110, 99, 101);

    expect(replay(tradePlan('LONG'), [fill, target1, reversal])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'LOSS' },
    });
  });

  it('marks same-M1 SL and TP as ambiguous after an earlier fill', () => {
    const fill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const both = m1('2026-07-15T14:01:00Z', 108, 118, 98, 110);

    expect(replay(tradePlan('LONG'), [fill, both])).toMatchObject({
      variants: { '1.5R': 'AMBIGUOUS', '2.0R': 'AMBIGUOUS' },
    });
  });

  it('marks fill plus SL on the same M1 as ambiguous', () => {
    const fillAndStop = m1('2026-07-15T14:00:00Z', 106, 108, 99, 104);

    expect(replay(tradePlan('LONG'), [fillAndStop])).toMatchObject({
      variants: { '1.5R': 'AMBIGUOUS', '2.0R': 'AMBIGUOUS' },
    });
  });

  it('marks only the relevant fill-candle TP variant as ambiguous', () => {
    const fillAndTarget1 = m1('2026-07-15T14:00:00Z', 106, 114, 104, 112);

    expect(replay(tradePlan('LONG'), [fillAndTarget1])).toMatchObject({
      variants: { '1.5R': 'AMBIGUOUS', '2.0R': 'OPEN' },
    });
  });

  it('never changes terminal WIN to LOSS or terminal LOSS to WIN', () => {
    const fill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const win = m1('2026-07-15T14:01:00Z', 108, 118, 103, 116);
    const laterStop = m1('2026-07-15T14:02:00Z', 107, 110, 99, 101);
    const loss = m1('2026-07-15T14:01:00Z', 104, 108, 99, 102);
    const laterTarget = m1('2026-07-15T14:02:00Z', 108, 118, 103, 116);

    expect(replay(tradePlan('LONG'), [fill, win, laterStop])).toMatchObject({
      variants: { '1.5R': 'WIN', '2.0R': 'WIN' },
    });
    expect(replay(tradePlan('LONG'), [fill, loss, laterTarget])).toMatchObject({
      variants: { '1.5R': 'LOSS', '2.0R': 'LOSS' },
    });
  });

  it('cancels an unfilled order at the 12:00 New York boundary', () => {
    const plan = tradePlan('LONG');
    const ambiguousCutoff = m1('2026-07-15T15:59:00Z', 106, 108, 105, 107);

    expect(replay(plan, [ambiguousCutoff])).toEqual({
      state: 'CANCELLED',
      direction: 'LONG',
      entry: 105,
      stopLoss: 99,
      targets: { '1.5R': 114, '2.0R': 117 },
      createdAtMs: plan.sourceCandles.c3.endTimeMs,
      cancelledAtMs: Date.parse('2026-07-15T16:00:00Z'),
      tradingDay: '2026-07-15',
    });
  });

  it('does not auto-close a filled position at 12:00 New York', () => {
    const fillBeforeNoon = m1('2026-07-15T15:58:00Z', 106, 107, 105, 106);
    const afterNoon = m1('2026-07-15T16:00:00Z', 107, 110, 103, 108);

    expect(replay(tradePlan('LONG'), [fillBeforeNoon, afterNoon])).toMatchObject({
      state: 'FILLED',
      variants: { '1.5R': 'OPEN', '2.0R': 'OPEN' },
    });
  });

  it('leaves a same-day position OPEN when replay data ends', () => {
    const fill = m1('2026-07-15T14:00:00Z', 106, 107, 105, 106);
    const lastSameDay = m1('2026-07-16T03:58:00Z', 107, 110, 103, 108);

    expect(replay(tradePlan('LONG'), [fill, lastSameDay])).toMatchObject({
      state: 'FILLED',
      variants: { '1.5R': 'OPEN', '2.0R': 'OPEN' },
    });
  });

  it('fails closed if pending order and M15/M5 trade plan disagree', () => {
    const plan = tradePlan('LONG');
    const pending = createPendingLimitOrder(plan);
    if (pending.state === 'INVALID') throw new Error('fixture must be pending');
    const mismatched = { ...pending, direction: 'SHORT' as const };

    expect(
      replayCasperM1Execution({ tradePlan: plan, pendingOrder: mismatched, candles: [] }),
    ).toEqual({ state: 'INVALID', reason: 'PLAN_ORDER_MISMATCH' });
  });
});
