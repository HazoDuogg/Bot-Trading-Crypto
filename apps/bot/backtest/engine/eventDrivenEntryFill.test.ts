import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_GAP_MS,
  DEFAULT_TTL_MS,
  createEventDrivenEntryFillTracker,
  simulateEventDrivenEntryFill,
  type BookTickerEvent,
  type EventDrivenEntryFillResult,
} from './eventDrivenEntryFill.js';

function ev(eventTime: number, bid: number, ask: number): BookTickerEvent {
  return { eventTime, bestBidPrice: bid, bestAskPrice: ask };
}

const DECISION_AT = 1_000_000;
const TICK_SIZE = 0.1;
const N = 1;

// Runs both the batch function and the incremental tracker on the same input and asserts they
// agree exactly — the tracker exists purely so fetchBookTickerStressWeeks.ts doesn't have to
// buffer a whole TTL window's raw ticks in memory, and must never silently diverge from the
// batch algorithm it mirrors.
function runBoth(input: {
  direction: 'LONG' | 'SHORT';
  events: BookTickerEvent[];
  decisionAt?: number;
  tickSize?: number;
  n?: number;
}): EventDrivenEntryFillResult {
  const base = { decisionAt: DECISION_AT, tickSize: TICK_SIZE, n: N, ...input };
  const batchResult = simulateEventDrivenEntryFill(base);

  const tracker = createEventDrivenEntryFillTracker(base);
  let trackerResult: EventDrivenEntryFillResult | null = null;
  for (const event of base.events) {
    trackerResult = tracker.next(event);
    if (trackerResult !== null) break;
  }
  if (trackerResult === null) trackerResult = tracker.finalize();

  expect(trackerResult).toEqual(batchResult);
  return batchResult;
}

describe('simulateEventDrivenEntryFill / createEventDrivenEntryFillTracker (equivalence)', () => {
  it('LONG: fills when best ask crosses limitPrice-buffer (limitPrice = entryQuote bid)', () => {
    const result = runBoth({
      direction: 'LONG',
      events: [
        ev(DECISION_AT, 100, 100.2), // entryQuote: limitPrice=100
        ev(DECISION_AT + 1000, 100, 100.15), // ask=100.15, need <= 100-0.1=99.9 -> not yet
        ev(DECISION_AT + 2000, 99.8, 99.85), // ask=99.85 <= 99.9 -> fills here
      ],
    });
    expect(result.outcome).toBe('FILLED');
    expect(result.limitPrice).toBe(100);
    expect(result.filledAtEventTime).toBe(DECISION_AT + 2000);
    expect(result.minutesToFill).toBeCloseTo(2000 / 60_000, 9);
  });

  it('SHORT: fills when best bid crosses limitPrice+buffer (limitPrice = entryQuote ask)', () => {
    const result = runBoth({
      direction: 'SHORT',
      events: [
        ev(DECISION_AT, 99.8, 100), // entryQuote: limitPrice=100
        ev(DECISION_AT + 1000, 99.95, 100.2), // bid=99.95, need >= 100.1 -> not yet
        ev(DECISION_AT + 2000, 100.15, 100.3), // bid=100.15 >= 100.1 -> fills here
      ],
    });
    expect(result.outcome).toBe('FILLED');
    expect(result.limitPrice).toBe(100);
    expect(result.filledAtEventTime).toBe(DECISION_AT + 2000);
  });

  it('EXPIRED: never crosses within a clean, gap-free TTL window', () => {
    const events: BookTickerEvent[] = [];
    for (let t = DECISION_AT; t < DECISION_AT + DEFAULT_TTL_MS; t += 10_000) {
      events.push(ev(t, 100, 100.2)); // static quote, never moves
    }
    const result = runBoth({ direction: 'LONG', events });
    expect(result.outcome).toBe('EXPIRED');
    expect(result.filledAtEventTime).toBeNull();
  });

  it('DATA_GAP_ABORT: no events at all', () => {
    const result = runBoth({ direction: 'LONG', events: [] });
    expect(result.outcome).toBe('DATA_GAP_ABORT');
  });

  it('DATA_GAP_ABORT: gap between two events exceeds maxGapMs', () => {
    const result = runBoth({
      direction: 'LONG',
      events: [ev(DECISION_AT, 100, 100.2), ev(DECISION_AT + DEFAULT_MAX_GAP_MS + 1, 100, 100.2)],
    });
    expect(result.outcome).toBe('DATA_GAP_ABORT');
  });

  it('DATA_GAP_ABORT: gap from decisionAt to the first event exceeds maxGapMs', () => {
    const result = runBoth({
      direction: 'LONG',
      events: [ev(DECISION_AT + DEFAULT_MAX_GAP_MS + 1, 100, 100.2)],
    });
    expect(result.outcome).toBe('DATA_GAP_ABORT');
  });

  it('DATA_GAP_ABORT: trailing silence from the last event to the TTL boundary exceeds maxGapMs', () => {
    const result = runBoth({
      direction: 'LONG',
      events: [ev(DECISION_AT, 100, 100.2)], // data stops immediately, TTL is 5 minutes away
    });
    expect(result.outcome).toBe('DATA_GAP_ABORT');
  });

  it('does not fill on an exact touch that does not clear the N-tick buffer', () => {
    const result = runBoth({
      direction: 'LONG',
      events: [ev(DECISION_AT, 100, 100.2), ev(DECISION_AT + 1000, 99.95, 100)], // ask=100, need <=99.9
    });
    expect(result.outcome).not.toBe('FILLED');
  });
});
