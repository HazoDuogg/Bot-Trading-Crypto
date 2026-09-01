import { describe, expect, it } from 'vitest';
import {
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
});
