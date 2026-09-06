import { describe, expect, it } from 'vitest';
import {
  createTickOutlierExclusionPlan,
  inferTickSize,
  validatePricesAlignToTickSize,
} from './tickSizeInference.js';

describe('inferTickSize', () => {
  it('infers the finest repeatedly observed decimal grid and ignores one finer outlier', () => {
    const prices = Array.from({ length: 100 }, (_, index) => 20.1234 + (index % 7) * 0.0001);
    prices.push(20.12345678);

    expect(inferTickSize(prices)).toEqual({
      tickSize: 0.0001,
      supportingPrices: 100,
      outlierPrices: 1,
      source: 'M1_CLOSE_DECIMAL_GRID',
    });
  });

  it('does not silently accept a genuinely abnormal price after robust inference', () => {
    const normalPrices = Array.from({ length: 100 }, (_, index) => 20.12 + (index % 4) * 0.01);
    const abnormalPrice = 20.12345678;
    const inference = inferTickSize([...normalPrices, abnormalPrice]);

    expect(inference.tickSize).toBe(0.01);
    expect(() =>
      validatePricesAlignToTickSize([...normalPrices, abnormalPrice], inference.tickSize),
    ).toThrow('Price series contains 1 value(s) that do not align with inferred tickSize 0.01');
  });

  it('separates one observed-p95 outlier so the caller can exclude only that point', () => {
    const prices = [20.12, 20.13, 20.14, 20.12345678];

    expect(createTickOutlierExclusionPlan(prices, 0.01, 1)).toEqual({
      outliers: [{ index: 3, price: 20.12345678 }],
      outliersExcluded: 1,
    });
  });

  it('throws a hard error when outliers exceed the diagnostic-derived threshold', () => {
    const prices = [20.12, 20.13, 20.14, 20.12345678, 20.12987654];

    expect(() => createTickOutlierExclusionPlan(prices, 0.01, 1)).toThrow(
      'Tick-size outlier count 2 exceeds exclusion threshold 1',
    );
  });
});
