import { describe, it, expect } from 'vitest';
import { classifyStructure } from './structure.js';
import type { SwingPoint } from './types.js';

describe('classifyStructure', () => {
  it('classifies HH_HL when both highs and lows are rising', () => {
    const points: SwingPoint[] = [
      { index: 0, price: 100, type: 'low' },
      { index: 1, price: 105, type: 'high' },
      { index: 2, price: 102, type: 'low' },
      { index: 3, price: 108, type: 'high' },
    ];
    expect(classifyStructure(points)).toBe('HH_HL');
  });

  it('classifies LH_LL when both highs and lows are falling', () => {
    const points: SwingPoint[] = [
      { index: 0, price: 108, type: 'high' },
      { index: 1, price: 102, type: 'low' },
      { index: 2, price: 105, type: 'high' },
      { index: 3, price: 100, type: 'low' },
    ];
    expect(classifyStructure(points)).toBe('LH_LL');
  });

  it('returns UNCLEAR when highs and lows disagree', () => {
    const points: SwingPoint[] = [
      { index: 0, price: 100, type: 'low' },
      { index: 1, price: 105, type: 'high' },
      { index: 2, price: 98, type: 'low' }, // lower low
      { index: 3, price: 108, type: 'high' }, // but higher high
    ];
    expect(classifyStructure(points)).toBe('UNCLEAR');
  });

  it('returns UNCLEAR with insufficient swing points', () => {
    expect(classifyStructure([{ index: 0, price: 100, type: 'low' }])).toBe('UNCLEAR');
  });
});
