import { describe, expect, it } from 'vitest';
import { validatePositionSizingInput, type PositionSizingInput } from './types.js';

const baseInput: PositionSizingInput = {
  accountBalance: 100,
  riskDollarOrPercent: 5,
  entryPrice: 50000,
  slDistancePercent: 0.01,
  leverage: 30,
  maxMarginCap: 12.5,
};

const badValues = [NaN, Infinity, -Infinity, 0, -1];

describe('validatePositionSizingInput — Number.isFinite guards (TICKET-LIVE-R2A item 2)', () => {
  for (const bad of badValues) {
    it(`rejects accountBalance=${bad}`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, accountBalance: bad })).toThrow();
    });
    it(`rejects riskDollarOrPercent=${bad}`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, riskDollarOrPercent: bad })).toThrow();
    });
    it(`rejects leverage=${bad}`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, leverage: bad })).toThrow();
    });
    it(`rejects entryPrice=${bad}`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, entryPrice: bad })).toThrow();
    });
    it(`rejects slDistancePercent=${bad}`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, slDistancePercent: bad })).toThrow();
    });
    it(`rejects maxMarginCap=${bad} when provided`, () => {
      expect(() => validatePositionSizingInput({ ...baseInput, maxMarginCap: bad })).toThrow();
    });
  }

  it('accepts maxMarginCap=undefined (no cap)', () => {
    expect(() => validatePositionSizingInput({ ...baseInput, maxMarginCap: undefined })).not.toThrow();
  });

  it('accepts a fully valid input', () => {
    expect(() => validatePositionSizingInput(baseInput)).not.toThrow();
  });
});
