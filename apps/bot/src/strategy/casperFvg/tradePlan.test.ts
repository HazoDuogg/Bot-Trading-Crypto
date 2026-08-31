import { describe, expect, it } from 'vitest';
import type { BreakoutFvgResult } from './breakoutFvg.js';
import { createCasperTradePlan } from './tradePlan.js';
import type { CasperCandle } from './types.js';

type ValidFvg = Extract<BreakoutFvgResult, { c1: CasperCandle }>;

function candle(
  startTimeMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
): CasperCandle {
  return { startTimeMs, endTimeMs: startTimeMs + 300_000, open, high, low, close };
}

function bullishFvg(): ValidFvg {
  const c1 = candle(0, 101, 105, 99, 103);
  const c2 = candle(300_000, 103, 112, 102, 110);
  const c3 = candle(600_000, 109, 113, 107, 111);
  return {
    state: 'VALID_BULLISH_FVG',
    direction: 'BULLISH',
    fvgLow: 105,
    fvgHigh: 107,
    c1,
    c2,
    c3,
    tradingDay: '2026-07-15',
  };
}

function bearishFvg(): ValidFvg {
  const c1 = candle(0, 108, 111, 105, 107);
  const c2 = candle(300_000, 107, 108, 98, 100);
  const c3 = candle(600_000, 101, 103, 97, 99);
  return {
    state: 'VALID_BEARISH_FVG',
    direction: 'BEARISH',
    fvgLow: 103,
    fvgHigh: 105,
    c1,
    c2,
    c3,
    tradingDay: '2026-07-15',
  };
}

describe('createCasperTradePlan', () => {
  it('creates the source LONG limit plan from the bullish FVG and C1 wick', () => {
    const fvg = bullishFvg();

    expect(createCasperTradePlan(fvg)).toEqual({
      state: 'VALID_TRADE_PLAN',
      direction: 'LONG',
      entryType: 'LIMIT',
      entry: 105,
      stopLoss: 99,
      riskPerUnit: 6,
      targets: { '1.5R': 114, '2.0R': 117 },
      fvgLow: 105,
      fvgHigh: 107,
      tradingDay: '2026-07-15',
      sourceCandles: { c1: fvg.c1, c2: fvg.c2, c3: fvg.c3 },
    });
  });

  it('creates the source SHORT limit plan from the bearish FVG and C1 wick', () => {
    const fvg = bearishFvg();

    expect(createCasperTradePlan(fvg)).toEqual({
      state: 'VALID_TRADE_PLAN',
      direction: 'SHORT',
      entryType: 'LIMIT',
      entry: 105,
      stopLoss: 111,
      riskPerUnit: 6,
      targets: { '1.5R': 96, '2.0R': 93 },
      fvgLow: 103,
      fvgHigh: 105,
      tradingDay: '2026-07-15',
      sourceCandles: { c1: fvg.c1, c2: fvg.c2, c3: fvg.c3 },
    });
  });

  it('uses exact FVG edges rather than midpoint entries', () => {
    const longPlan = createCasperTradePlan(bullishFvg());
    const shortPlan = createCasperTradePlan(bearishFvg());

    expect(longPlan).toMatchObject({ entry: 105 });
    expect(shortPlan).toMatchObject({ entry: 105 });
    expect(longPlan).not.toMatchObject({ entry: 106 });
    expect(shortPlan).not.toMatchObject({ entry: 104 });
  });

  it('rejects zero risk', () => {
    const fvg = bullishFvg();
    fvg.c1 = candle(0, 105, 105, 105, 105);

    expect(createCasperTradePlan(fvg)).toEqual({
      state: 'INVALID_TRADE_PLAN',
      reason: 'INVALID_RISK',
    });
  });

  it('rejects non-finite risk', () => {
    const fvg = bullishFvg();
    fvg.fvgLow = Number.POSITIVE_INFINITY;

    expect(createCasperTradePlan(fvg)).toEqual({
      state: 'INVALID_TRADE_PLAN',
      reason: 'INVALID_RISK',
    });
  });

  it('rejects positive absolute distance when the stop is on the wrong side', () => {
    const longFvg = bullishFvg();
    longFvg.fvgLow = 98;
    const shortFvg = bearishFvg();
    shortFvg.fvgHigh = 112;

    expect(createCasperTradePlan(longFvg)).toMatchObject({
      state: 'INVALID_TRADE_PLAN',
      reason: 'INVALID_RISK',
    });
    expect(createCasperTradePlan(shortFvg)).toMatchObject({
      state: 'INVALID_TRADE_PLAN',
      reason: 'INVALID_RISK',
    });
  });

  it('does not create plans from non-valid FVG results', () => {
    const results: BreakoutFvgResult[] = [
      { state: 'NO_FVG', tradingDay: '2026-07-15' },
      { state: 'INVALID_DATA', tradingDay: '2026-07-15' },
      { state: 'WINDOW_CLOSED', tradingDay: '2026-07-15' },
    ];

    for (const result of results) {
      expect(createCasperTradePlan(result)).toEqual({
        state: 'INVALID_TRADE_PLAN',
        reason: 'NON_VALID_FVG',
      });
    }
  });

  it('preserves the exact FVG values and source candle references', () => {
    const fvg = bullishFvg();
    const plan = createCasperTradePlan(fvg);

    expect(plan).toMatchObject({ fvgLow: 105, fvgHigh: 107 });
    expect(plan.state).toBe('VALID_TRADE_PLAN');
    if (plan.state !== 'VALID_TRADE_PLAN') return;
    expect(plan.sourceCandles.c1).toBe(fvg.c1);
    expect(plan.sourceCandles.c2).toBe(fvg.c2);
    expect(plan.sourceCandles.c3).toBe(fvg.c3);
  });
});
