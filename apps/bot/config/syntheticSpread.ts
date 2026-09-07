// AUTO-GENERATED ONCE by research/audits/computeSyntheticSpread.ts — TICKET-04X-S Step 0.
// LOCKED: computed once from real bookTicker data, never re-tuned after seeing backtest PnL.
//
// Source: median((bestAsk - bestBid) / 2) over a 200000-observation reservoir sample of
// every BTCUSDT bookTicker event across the 3 TICKET-04X-Q stress weeks (LOWEST_AVG_ADX 2024-01-15, MEDIAN_AVG_ADX 2023-12-18, HIGHEST_AVG_ADX 2023-12-11).
// 376037432 raw rows scanned across the 3 weeks; reservoir sampling used instead of an exact
// median because holding all 376037432 half-spread values in memory would reintroduce the OOM
// TICKET-04X-Q's fetch script hit — see that script's design note.
// Computed at: 2026-09-07T09:56:29.034Z

export const SYNTHETIC_HALF_SPREAD_SOURCE = {
  method: 'median of a reservoir sample of (bestAsk - bestBid) / 2 over 3 TICKET-04X-Q stress weeks',
  reservoirSize: 200000,
  totalRowsScanned: 376037432,
  rejectedRows: 0,
  computedAtIso: '2026-09-07T09:56:29.034Z',
} as const;

// Half-spread H (USD) used to synthesize a post-only entry/TP limit price in TICKET-04X-S: LONG
// entry rests at C - H, SHORT entry rests at C + H (see runMeanReversionFullBacktest.ts).
export const SYNTHETIC_HALF_SPREAD_USD = 0.049999999999272404;
