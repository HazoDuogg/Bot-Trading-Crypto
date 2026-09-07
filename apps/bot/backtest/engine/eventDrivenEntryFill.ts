// TICKET-04X-Q Step 2: event-driven ENTRY FILL ONLY — no exit, no TP/SL, no PnL anywhere in this
// file. bookTicker is top-of-book only (no real queue position / traded volume ahead of our
// order) — this is still a conservative proxy, not a substitute for aggTrades-based fill modeling.
export type EntryFillOutcome = 'FILLED' | 'EXPIRED' | 'DATA_GAP_ABORT';

export interface BookTickerEvent {
  eventTime: number;
  bestBidPrice: number;
  bestAskPrice: number;
}

export interface EventDrivenEntryFillInput {
  direction: 'LONG' | 'SHORT';
  decisionAt: number;
  tickSize: number;
  n: number;
  // Must already be restricted to [decisionAt, decisionAt+ttlMs) and sorted ascending by
  // eventTime (Step 1's fetch script already both filters and stable-sorts each signal's window).
  events: readonly BookTickerEvent[];
  ttlMs?: number;
  maxGapMs?: number;
}

export interface EventDrivenEntryFillResult {
  outcome: EntryFillOutcome;
  limitPrice: number | null;
  filledAtEventTime: number | null;
  minutesToFill: number | null;
}

export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_GAP_MS = 30_000;

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}

export function simulateEventDrivenEntryFill(input: EventDrivenEntryFillInput): EventDrivenEntryFillResult {
  requirePositiveFinite(input.tickSize, 'tickSize');
  if (!Number.isFinite(input.n) || input.n < 0) throw new Error('n must be non-negative and finite');
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const maxGapMs = input.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const ttlEndExclusive = input.decisionAt + ttlMs;

  if (input.events.length === 0) {
    // No bookTicker data at all in [decisionAt, decisionAt+ttl) — cannot even establish an
    // entryQuote, let alone judge a fill. Not the same as a genuinely-observed non-fill.
    return { outcome: 'DATA_GAP_ABORT', limitPrice: null, filledAtEventTime: null, minutesToFill: null };
  }

  // Gap from decisionAt itself to the first observed quote.
  if (input.events[0].eventTime - input.decisionAt > maxGapMs) {
    return { outcome: 'DATA_GAP_ABORT', limitPrice: null, filledAtEventTime: null, minutesToFill: null };
  }

  const entryQuote = input.events[0];
  const limitPrice = input.direction === 'LONG' ? entryQuote.bestBidPrice : entryQuote.bestAskPrice;
  const buffer = input.n * input.tickSize;

  for (let i = 0; i < input.events.length; i += 1) {
    const event = input.events[i];
    if (i > 0) {
      const gap = event.eventTime - input.events[i - 1].eventTime;
      if (gap > maxGapMs) {
        return { outcome: 'DATA_GAP_ABORT', limitPrice, filledAtEventTime: null, minutesToFill: null };
      }
    }
    const filled = input.direction === 'LONG' ? event.bestAskPrice <= limitPrice - buffer : event.bestBidPrice >= limitPrice + buffer;
    if (filled) {
      return {
        outcome: 'FILLED',
        limitPrice,
        filledAtEventTime: event.eventTime,
        minutesToFill: (event.eventTime - input.decisionAt) / 60_000,
      };
    }
  }

  // Reached the end of available events without a fill. If the data itself stops well short of
  // the TTL boundary, that trailing silence is a gap too — we cannot claim a genuine EXPIRED
  // (never crossed) when we simply have no observations for part of the window.
  const lastEventTime = input.events[input.events.length - 1].eventTime;
  if (ttlEndExclusive - lastEventTime > maxGapMs) {
    return { outcome: 'DATA_GAP_ABORT', limitPrice, filledAtEventTime: null, minutesToFill: null };
  }

  return { outcome: 'EXPIRED', limitPrice, filledAtEventTime: null, minutesToFill: null };
}

export interface EventDrivenEntryFillTrackerInput {
  direction: 'LONG' | 'SHORT';
  decisionAt: number;
  tickSize: number;
  n: number;
  ttlMs?: number;
  maxGapMs?: number;
}

export interface EventDrivenEntryFillTracker {
  // Feed one event (any order is fine as long as calls are chronological); returns the terminal
  // result once resolved, or null while still waiting. Once resolved, further next() calls are
  // no-ops that just return the same result.
  next(event: BookTickerEvent): EventDrivenEntryFillResult | null;
  // Call once the caller knows no more events will arrive before the TTL boundary (e.g. the raw
  // data stream for the relevant day(s) has ended) to force a terminal EXPIRED/DATA_GAP_ABORT
  // verdict if next() never resolved one.
  finalize(): EventDrivenEntryFillResult;
}

// Same algorithm as simulateEventDrivenEntryFill above, restated as an incremental state machine
// (mirrors createAtrTracker's style) so a caller can feed events one at a time as they stream in,
// instead of buffering an entire TTL window's raw ticks in memory first. Cross-checked for exact
// equivalence with the batch function in the test file (same inputs -> same outputs).
export function createEventDrivenEntryFillTracker(input: EventDrivenEntryFillTrackerInput): EventDrivenEntryFillTracker {
  requirePositiveFinite(input.tickSize, 'tickSize');
  if (!Number.isFinite(input.n) || input.n < 0) throw new Error('n must be non-negative and finite');
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const maxGapMs = input.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const ttlEndExclusive = input.decisionAt + ttlMs;
  const buffer = input.n * input.tickSize;

  let resolved: EventDrivenEntryFillResult | null = null;
  let limitPrice: number | null = null;
  let lastEventTime: number | null = null;

  function resolve(result: EventDrivenEntryFillResult): EventDrivenEntryFillResult {
    resolved = result;
    return result;
  }

  return {
    next(event: BookTickerEvent): EventDrivenEntryFillResult | null {
      if (resolved !== null) return resolved;
      if (event.eventTime < input.decisionAt || event.eventTime >= ttlEndExclusive) return null; // outside window

      if (limitPrice === null) {
        if (event.eventTime - input.decisionAt > maxGapMs) {
          return resolve({ outcome: 'DATA_GAP_ABORT', limitPrice: null, filledAtEventTime: null, minutesToFill: null });
        }
        limitPrice = input.direction === 'LONG' ? event.bestBidPrice : event.bestAskPrice;
      } else if (event.eventTime - lastEventTime! > maxGapMs) {
        return resolve({ outcome: 'DATA_GAP_ABORT', limitPrice, filledAtEventTime: null, minutesToFill: null });
      }
      lastEventTime = event.eventTime;

      const filled = input.direction === 'LONG' ? event.bestAskPrice <= limitPrice - buffer : event.bestBidPrice >= limitPrice + buffer;
      if (filled) {
        return resolve({
          outcome: 'FILLED',
          limitPrice,
          filledAtEventTime: event.eventTime,
          minutesToFill: (event.eventTime - input.decisionAt) / 60_000,
        });
      }
      return null;
    },
    finalize(): EventDrivenEntryFillResult {
      if (resolved !== null) return resolved;
      if (limitPrice === null) {
        return resolve({ outcome: 'DATA_GAP_ABORT', limitPrice: null, filledAtEventTime: null, minutesToFill: null });
      }
      if (ttlEndExclusive - lastEventTime! > maxGapMs) {
        return resolve({ outcome: 'DATA_GAP_ABORT', limitPrice, filledAtEventTime: null, minutesToFill: null });
      }
      return resolve({ outcome: 'EXPIRED', limitPrice, filledAtEventTime: null, minutesToFill: null });
    },
  };
}
