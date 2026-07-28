import { describe, it, expect } from 'vitest';
import { wouldExceedMaxTotalMargin } from './riskPool.js';

describe('wouldExceedMaxTotalMargin (TICKET-101 Việc 2)', () => {
  it('undefined maxTotalMarginPct = no cap, never blocks regardless of margin already in use', () => {
    expect(wouldExceedMaxTotalMargin(1_000_000, 500, 100, undefined)).toBe(false);
  });

  it('rejects when existing + candidate margin exceeds the cap', () => {
    // accountBalance=100, maxTotalMarginPct=0.5 -> cap=$50. Existing=$45, candidate=$10 -> $55 > $50.
    expect(wouldExceedMaxTotalMargin(45, 10, 100, 0.5)).toBe(true);
  });

  it('allows when existing + candidate margin stays within the cap', () => {
    // cap=$50. Existing=$30, candidate=$10 -> $40 <= $50.
    expect(wouldExceedMaxTotalMargin(30, 10, 100, 0.5)).toBe(false);
  });

  it('boundary: exactly at the cap does NOT count as exceeding it (uses strict >)', () => {
    // cap=$50 exactly. Existing=$40, candidate=$10 -> $50 == $50, not "over".
    expect(wouldExceedMaxTotalMargin(40, 10, 100, 0.5)).toBe(false);
  });

  it('a single large existing position can already exceed the cap on its own (candidate=0)', () => {
    // cap=$50. Existing=$60 already over, candidate=0 -> still exceeded.
    expect(wouldExceedMaxTotalMargin(60, 0, 100, 0.5)).toBe(true);
  });

  it('throws on non-positive accountBalance (same "an toàn" convention as checkRiskPool)', () => {
    expect(() => wouldExceedMaxTotalMargin(0, 10, 0, 0.5)).toThrow(/accountBalance must be > 0/);
  });
});
