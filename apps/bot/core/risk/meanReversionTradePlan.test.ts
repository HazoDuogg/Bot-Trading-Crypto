import { describe, expect, it } from 'vitest';
import { createMeanReversionTradePlan } from './meanReversionTradePlan.js';

const BASE = { entryPrice: 50_000, riskBudgetUsd: 3, leverage: 20, tickSize: 0.1, lotSize: 0.001 };

describe('createMeanReversionTradePlan', () => {
  it('builds a LONG plan: SL below entry, TP above entry, at the exact 1.5x ATR / (8/3)R multiples', () => {
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 100 });
    expect(plan).not.toBeNull();
    expect(plan!.direction).toBe('BULL');
    expect(plan!.riskPerUnit).toBe(150); // 1.5 * 100
    expect(plan!.stopLoss).toBe(50_000 - 150);
    expect(plan!.takeProfit).toBeCloseTo(50_000 + (8 / 3) * 150, 9);
    expect(plan!.positionSize).toBeCloseTo(0.02, 9); // floor(3/150=0.02, lotSize 0.001) = 0.02
    expect(plan!.requiredMargin).toBeCloseTo((0.02 * 50_000) / 20, 9);
  });

  it('builds a SHORT plan: SL above entry, TP below entry, mirrored signs', () => {
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'SHORT', atr14: 100 });
    expect(plan).not.toBeNull();
    expect(plan!.direction).toBe('BEAR');
    expect(plan!.riskPerUnit).toBe(150);
    expect(plan!.stopLoss).toBe(50_000 + 150);
    expect(plan!.takeProfit).toBeCloseTo(50_000 - (8 / 3) * 150, 9);
  });

  it('rejects ATR=0 instead of dividing by zero', () => {
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 0 })).toThrow('atr14');
  });

  it('rejects a negative or non-finite ATR the same way', () => {
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: -5 })).toThrow('atr14');
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: NaN })).toThrow('atr14');
  });

  it('returns null (not throw) when riskPerUnit is below the 3xtickSize SL floor', () => {
    // atr14=0.001 -> riskPerUnit=0.0015, far below 3*tickSize(0.1)=0.3.
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 0.001 });
    expect(plan).toBeNull();
  });

  it('accepts riskPerUnit exactly at the 3xtickSize floor (inclusive boundary, same convention as TICKET-04X-O)', () => {
    // atr14 chosen so riskPerUnit = 1.5*atr14 = 3*tickSize(0.1) = 0.3 exactly.
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 0.2 });
    expect(plan).not.toBeNull();
    expect(plan!.riskPerUnit).toBeCloseTo(0.3, 12);
  });

  it('rejects riskPerUnit just below the floor', () => {
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 0.2 - 1e-6 });
    expect(plan).toBeNull();
  });

  it('returns null (not a plan) when the risk-sized position rounds below one lot', () => {
    // riskBudgetUsd/riskPerUnit = 3/1_000_000 is far below lotSize=0.001 -> floors to 0.
    const plan = createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 1_000_000 / 1.5 });
    expect(plan).toBeNull();
  });

  it('rejects a non-positive entryPrice/riskBudgetUsd/leverage/lotSize', () => {
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 100, entryPrice: 0 })).toThrow();
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 100, riskBudgetUsd: -1 })).toThrow();
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 100, leverage: 0 })).toThrow();
    expect(() => createMeanReversionTradePlan({ ...BASE, signal: 'LONG', atr14: 100, lotSize: 0 })).toThrow();
  });
});
