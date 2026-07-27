import { describe, expect, it } from 'vitest';
import { SentEventTracker } from './dedupe.js';

describe('SentEventTracker', () => {
  it('markSent returns true the first time a key is seen, false on every repeat', () => {
    const tracker = new SentEventTracker();
    expect(tracker.markSent('BTCUSDT-open-123')).toBe(true);
    expect(tracker.markSent('BTCUSDT-open-123')).toBe(false);
    expect(tracker.markSent('BTCUSDT-open-123')).toBe(false);
  });

  it('different keys are tracked independently', () => {
    const tracker = new SentEventTracker();
    expect(tracker.markSent('a')).toBe(true);
    expect(tracker.markSent('b')).toBe(true);
    expect(tracker.hasSent('a')).toBe(true);
    expect(tracker.hasSent('c')).toBe(false);
  });

  it('reset() clears all tracked keys', () => {
    const tracker = new SentEventTracker();
    tracker.markSent('a');
    tracker.reset();
    expect(tracker.hasSent('a')).toBe(false);
    expect(tracker.markSent('a')).toBe(true);
  });
});
