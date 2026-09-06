import { describe, it, expect } from 'vitest';
import { isSpreadTooHigh } from './spreadCheck.js';

describe('isSpreadTooHigh', () => {
  it('blocks when spread% exceeds threshold', () => {
    // mid=100, spread=0.1 -> 0.1%
    expect(isSpreadTooHigh(99.95, 100.05, 0.075)).toBe(true);
  });

  it('allows when spread% is under threshold', () => {
    expect(isSpreadTooHigh(99.99, 100.01, 0.075)).toBe(false);
  });
});
