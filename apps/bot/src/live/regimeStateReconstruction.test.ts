/**
 * TICKET-G3R — failure-policy matrix for cold-start regime-state reconstruction.
 * Every case here asserts BOTH the reconstruction outcome AND that the resulting source decision
 * fails CLOSED for new entries (`UNAVAILABLE`) whenever no trustworthy state exists.
 */
import { describe, it, expect } from 'vitest';
import {
  reconstructRegimeStatesAcrossSymbols,
  checkReconstructionInputIntegrity,
  decideRegimeStateSource,
  isTailContiguous,
  formatRegimeReconstructionLog,
  RECON_REQUIRED_5M,
  RECON_REQUIRED_15M,
  RECON_REQUIRED_1H,
  MS_5M,
  MS_15M,
  MS_1H,
  PERSISTED_REGIME_STATE_MAX_STALENESS_MS,
  type SymbolCandleHistory,
} from './regimeStateReconstruction.js';
import { isCandleClosed } from './liveCandleFeed.js';
import type { CandleData } from '../regime/types.js';
import type { RegimeHysteresisState } from '../orchestrator/types.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const BASE_TS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Deterministic pseudo-random walk — no Math.random, so every run of this suite is identical. */
function makeCandles(count: number, intervalMs: number, seed: number, endTs: number): CandleData[] {
  const out: CandleData[] = [];
  let price = 100 + seed;
  let s = seed * 7919 + 13;
  for (let i = count - 1; i >= 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const drift = ((s % 2000) - 1000) / 20000; // +/- 5%
    price = Math.max(1, price * (1 + drift));
    const high = price * 1.004;
    const low = price * 0.996;
    out.push({ timestamp: endTs - i * intervalMs, open: price, high, low, close: price, volume: 1000 + (s % 500) });
  }
  return out;
}

function makeHistory(seed: number, opts: { extra5m?: number; extra15m?: number; extra1h?: number } = {}): SymbolCandleHistory {
  const end5m = BASE_TS;
  return {
    candles5m: makeCandles(RECON_REQUIRED_5M + (opts.extra5m ?? 0), MS_5M, seed, end5m),
    candles15m: makeCandles(RECON_REQUIRED_15M + (opts.extra15m ?? 0), MS_15M, seed + 1, end5m - MS_15M + MS_5M),
    candles1h: makeCandles(RECON_REQUIRED_1H + (opts.extra1h ?? 0), MS_1H, seed + 2, end5m - MS_1H + MS_5M),
  };
}

function fullHistoryBySymbol(): Record<string, SymbolCandleHistory> {
  return Object.fromEntries(SYMBOLS.map((s, i) => [s, makeHistory(i + 1)]));
}

const REPLAY_STEPS_FOR_TEST = 4; // integrity requirements are unchanged by this; it only shortens the replay loop

function runRecon(historyBySymbol: Record<string, SymbolCandleHistory>) {
  return reconstructRegimeStatesAcrossSymbols({ symbols: SYMBOLS, historyBySymbol, replaySteps: REPLAY_STEPS_FOR_TEST });
}

const PERSISTED_STATE: RegimeHysteresisState = {
  previousRegime: 'TREND_RIDER' as RegimeHysteresisState['previousRegime'],
  previousCandidateRegime: 'TREND_RIDER' as RegimeHysteresisState['previousCandidateRegime'],
  streakCount: 0,
  previousDangerZoneTimestamp: BASE_TS - 3600_000,
};

// ---- sizing / warm-up invariants ---------------------------------------------------------------

describe('G3R warm-up sizing', () => {
  it('requires 15m and 1h history proportional to the 5m replay span (no 5m-only deep backfill)', () => {
    // 1440 replayed 5m steps consume 480 15m candles and 120 1h candles on top of each timeframe's
    // own decision window — this is the ticket's explicit cross-timeframe synchronisation rule.
    expect(RECON_REQUIRED_5M).toBe(4032 + 1440);
    expect(RECON_REQUIRED_15M).toBe(325 + 480);
    expect(RECON_REQUIRED_1H).toBe(40 + 120);
  });

  it('covers strictly more than the 72h post-DANGER cooldown', () => {
    expect(1440 * MS_5M).toBeGreaterThan(72 * 3600_000);
  });
});

// ---- happy path ---------------------------------------------------------------------------------

describe('G3R reconstruction happy path', () => {
  it('rebuilds a non-null regime state from complete history and reports COMPLETE input quality', () => {
    const result = runRecon(fullHistoryBySymbol());
    for (const s of SYMBOLS) {
      const r = result[s];
      expect(r.status).toBe('OK');
      if (r.status !== 'OK') return;
      expect(r.regimeState.previousRegime).not.toBeNull();
      expect(r.telemetry.inputQuality).toBe('COMPLETE');
      expect(r.telemetry.replayedCandles).toBe(REPLAY_STEPS_FOR_TEST);
      expect(r.telemetry.replayEnd).toBe(BASE_TS);
    }
  });

  it('telemetry log carries every required field and no secrets', () => {
    const result = runRecon(fullHistoryBySymbol());
    const r = result[SYMBOLS[0]];
    if (r.status !== 'OK') throw new Error('expected OK');
    const line = formatRegimeReconstructionLog(SYMBOLS[0], 'RECONSTRUCTED', r.telemetry, 'ok');
    for (const field of ['symbol=', 'stateSource=', 'replayStart=', 'replayEnd=', 'replayedCandles=', 'previousRegime=', 'candidateRegime=', 'streakCount=', 'lastDangerZoneTimestamp=', 'cooldownRemainingMinutes=', 'inputQuality=']) {
      expect(line).toContain(field);
    }
    expect(line).not.toMatch(/apiKey|secret|token|balance|walletBalance/i);
  });
});

// ---- the 11 named failure cases -----------------------------------------------------------------

describe('G3R failure case 1 — no persisted file', () => {
  it('uses reconstruction and admits entries', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('RECONSTRUCTED');
  });
});

describe('G3R failure case 2 — persisted file corrupt', () => {
  it('ignores the corrupt persisted state and reconstructs instead', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({ persistedFileStatus: 'CORRUPT', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('RECONSTRUCTED');
  });

  it('a structurally-broken persisted regimeState never wins, even when its anchor is newer', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: { previousRegime: 'TREND_RIDER', streakCount: 'nope' } as unknown as RegimeHysteresisState, regimeStateCandleTimestamp: BASE_TS + MS_5M },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS,
    });
    expect(decision.source).toBe('RECONSTRUCTED');
  });
});

describe('G3R failure case 3 — persisted state stale', () => {
  it('rejects a persisted anchor older than the staleness limit', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: BASE_TS - PERSISTED_REGIME_STATE_MAX_STALENESS_MS - MS_5M },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS,
    });
    expect(decision.source).toBe('RECONSTRUCTED');
  });

  it('a stale persisted state with NO usable reconstruction fails CLOSED, never falls back to it', () => {
    const broken = fullHistoryBySymbol();
    broken[SYMBOLS[0]].candles5m = broken[SYMBOLS[0]].candles5m.slice(1);
    const recon = runRecon(broken);
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: BASE_TS - 10 * 24 * 3600_000 },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS,
    });
    expect(decision.source).toBe('UNAVAILABLE');
  });
});

describe('G3R failure case 4 — missing 5m history', () => {
  it('returns INSUFFICIENT_5M_HISTORY and blocks entries', () => {
    const h = fullHistoryBySymbol();
    h[SYMBOLS[0]].candles5m = h[SYMBOLS[0]].candles5m.slice(1);
    const recon = runRecon(h);
    expect(recon[SYMBOLS[0]].status).toBe('INVALID');
    if (recon[SYMBOLS[0]].status === 'INVALID') expect((recon[SYMBOLS[0]] as { reason: string }).reason).toBe('INSUFFICIENT_5M_HISTORY');
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('UNAVAILABLE');
  });

  it('the OTHER symbols are invalidated too — correlatedRiskRatio is a cross-symbol input', () => {
    const h = fullHistoryBySymbol();
    h[SYMBOLS[0]].candles5m = h[SYMBOLS[0]].candles5m.slice(1);
    const recon = runRecon(h);
    expect(recon[SYMBOLS[1]].status).toBe('INVALID');
    if (recon[SYMBOLS[1]].status === 'INVALID') expect((recon[SYMBOLS[1]] as { reason: string }).reason).toBe('CROSS_SYMBOL_INPUT_INVALID');
  });
});

describe('G3R failure case 5 — missing 15m warm-up', () => {
  it('a deep 5m buffer does NOT compensate for a short 15m buffer', () => {
    const h = fullHistoryBySymbol();
    h[SYMBOLS[0]].candles5m = makeCandles(RECON_REQUIRED_5M * 2, MS_5M, 1, BASE_TS); // twice as much 5m
    h[SYMBOLS[0]].candles15m = h[SYMBOLS[0]].candles15m.slice(1); // one 15m candle short
    expect(checkReconstructionInputIntegrity(h[SYMBOLS[0]])).toBe('INSUFFICIENT_15M_WARMUP');
    const recon = runRecon(h);
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('UNAVAILABLE');
  });
});

describe('G3R failure case 6 — missing 1h warm-up', () => {
  it('returns INSUFFICIENT_1H_WARMUP and blocks entries', () => {
    const h = fullHistoryBySymbol();
    h[SYMBOLS[0]].candles1h = h[SYMBOLS[0]].candles1h.slice(1);
    expect(checkReconstructionInputIntegrity(h[SYMBOLS[0]])).toBe('INSUFFICIENT_1H_WARMUP');
    const recon = runRecon(h);
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('UNAVAILABLE');
  });
});

describe('G3R failure case 7 — gap inside the replay window', () => {
  it('detects a hole in the 5m window even when the total count is sufficient', () => {
    const h = fullHistoryBySymbol();
    const c = h[SYMBOLS[0]].candles5m;
    c.splice(c.length - 500, 1); // remove one candle mid-window
    c.unshift({ ...c[0], timestamp: c[0].timestamp - MS_5M }); // keep the count at the required value
    expect(checkReconstructionInputIntegrity(h[SYMBOLS[0]])).toBe('GAP_IN_5M_WINDOW');
    const recon = runRecon(h);
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[0]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('UNAVAILABLE');
  });

  it('detects a hole in the 15m and 1h windows too', () => {
    const h15 = fullHistoryBySymbol();
    const a = h15[SYMBOLS[0]].candles15m;
    a.splice(a.length - 200, 1);
    a.unshift({ ...a[0], timestamp: a[0].timestamp - MS_15M });
    expect(checkReconstructionInputIntegrity(h15[SYMBOLS[0]])).toBe('GAP_IN_15M_WINDOW');

    const h1h = fullHistoryBySymbol();
    const b = h1h[SYMBOLS[0]].candles1h;
    b.splice(b.length - 50, 1);
    b.unshift({ ...b[0], timestamp: b[0].timestamp - MS_1H });
    expect(checkReconstructionInputIntegrity(h1h[SYMBOLS[0]])).toBe('GAP_IN_1H_WINDOW');
  });
});

describe('G3R failure case 8 — a backfill page failed', () => {
  it('a short buffer left behind by a failed seed page blocks entries rather than trading on it', () => {
    // seedBackfill() gives up and returns after a failed page, leaving whatever it already had.
    const h = fullHistoryBySymbol();
    h[SYMBOLS[1]].candles5m = h[SYMBOLS[1]].candles5m.slice(-1500); // only the first page landed
    const recon = runRecon(h);
    expect(recon[SYMBOLS[1]].status).toBe('INVALID');
    const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[SYMBOLS[1]], latestClosedCandleTimestamp: BASE_TS });
    expect(decision.source).toBe('UNAVAILABLE');
  });
});

describe('G3R failure case 9 — detectRegime throws during the replay', () => {
  it('reports RECONSTRUCTION_EXCEPTION for every symbol and blocks entries', () => {
    const h = fullHistoryBySymbol();
    // Flat 1h candles make Wilder ADX undefined, which classifyCandidate() rejects by throwing —
    // the integrity check cannot see this (count and contiguity are both fine), so it is caught here.
    h[SYMBOLS[0]].candles1h = h[SYMBOLS[0]].candles1h.map((c) => ({ ...c, open: 50, high: 50, low: 50, close: 50 }));
    const recon = runRecon(h);
    expect(recon[SYMBOLS[0]].status).toBe('INVALID');
    if (recon[SYMBOLS[0]].status === 'INVALID') expect((recon[SYMBOLS[0]] as { reason: string }).reason).toBe('RECONSTRUCTION_EXCEPTION');
    for (const s of SYMBOLS) {
      const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[s], latestClosedCandleTimestamp: BASE_TS });
      expect(decision.source).toBe('UNAVAILABLE');
    }
  });
});

describe('G3R failure case 10 — restart during a forming candle', () => {
  it('a still-forming candle never enters the replay; the anchor is the last CLOSED candle', () => {
    const h = fullHistoryBySymbol();
    const forming: CandleData = { timestamp: BASE_TS + MS_5M, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const withForming = [...h[SYMBOLS[0]].candles5m, forming];
    const nowMs = BASE_TS + MS_5M + 60_000; // one minute into the forming candle
    expect(isCandleClosed(forming, MS_5M, nowMs)).toBe(false);
    const closedOnly = withForming.filter((c) => isCandleClosed(c, MS_5M, nowMs));
    expect(closedOnly[closedOnly.length - 1].timestamp).toBe(BASE_TS);

    h[SYMBOLS[0]].candles5m = closedOnly;
    const recon = runRecon(h);
    const r = recon[SYMBOLS[0]];
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    expect(r.telemetry.replayEnd).toBe(BASE_TS);
    // Identical to the run that never saw the forming candle at all.
    const baseline = runRecon(fullHistoryBySymbol());
    if (baseline[SYMBOLS[0]].status !== 'OK') throw new Error('expected OK');
    expect(r.regimeState).toEqual((baseline[SYMBOLS[0]] as { regimeState: RegimeHysteresisState }).regimeState);
  });
});

describe('G3R failure case 11 — persisted state NEWER than reconstruction', () => {
  it('persisted wins and reconstruction never overwrites it with an older state', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: BASE_TS + MS_5M },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS + MS_5M,
    });
    expect(decision.source).toBe('PERSISTED');
    if (decision.source !== 'PERSISTED') return;
    expect(decision.regimeState).toEqual(PERSISTED_STATE);
    expect(decision.anchorTimestamp).toBe(BASE_TS + MS_5M);
  });

  it('a persisted anchor that is not on a 5m boundary is rejected', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: BASE_TS + 137 },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS,
    });
    expect(decision.source).toBe('RECONSTRUCTED');
  });

  it('a persisted record with no candle anchor at all (pre-G3R file) is rejected', () => {
    const recon = runRecon(fullHistoryBySymbol());
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: undefined },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: BASE_TS,
    });
    expect(decision.source).toBe('RECONSTRUCTED');
  });
});

describe('G3R total feed failure', () => {
  it('does not accept a persisted state whose freshness cannot be proven (no closed candle at all)', () => {
    const h = fullHistoryBySymbol();
    for (const s of SYMBOLS) h[s] = { candles5m: [], candles15m: [], candles1h: [] };
    const recon = runRecon(h);
    const decision = decideRegimeStateSource({
      persistedFileStatus: 'OK',
      persisted: { regimeState: PERSISTED_STATE, regimeStateCandleTimestamp: BASE_TS },
      reconstruction: recon[SYMBOLS[0]],
      latestClosedCandleTimestamp: null,
    });
    expect(decision.source).toBe('UNAVAILABLE');
  });
});

describe('G3R cross-symbol lockstep alignment', () => {
  it('refuses to replay when one symbol\'s 5m tail sits on different timestamps', () => {
    const h = fullHistoryBySymbol();
    // ETH one candle behind BTC — a lockstep replay would pair ETH's candle with BTC's correlatedRiskRatio.
    h[SYMBOLS[1]].candles5m = makeCandles(RECON_REQUIRED_5M, MS_5M, 2, BASE_TS - MS_5M);
    const recon = runRecon(h);
    expect(recon[SYMBOLS[1]].status).toBe('INVALID');
    if (recon[SYMBOLS[1]].status === 'INVALID') expect((recon[SYMBOLS[1]] as { reason: string }).reason).toBe('SYMBOL_TIMESTAMP_MISALIGNED');
    for (const s of SYMBOLS) {
      const decision = decideRegimeStateSource({ persistedFileStatus: 'NOT_FOUND', persisted: null, reconstruction: recon[s], latestClosedCandleTimestamp: BASE_TS });
      expect(decision.source).toBe('UNAVAILABLE');
    }
  });
});

// ---- helpers -------------------------------------------------------------------------------------

describe('isTailContiguous', () => {
  it('is true for an evenly-spaced tail and false when a candle is missing', () => {
    const c = makeCandles(100, MS_5M, 3, BASE_TS);
    expect(isTailContiguous(c, 100, MS_5M)).toBe(true);
    c.splice(50, 1);
    expect(isTailContiguous(c, 99, MS_5M)).toBe(false);
  });

  it('is false when fewer candles than requested exist', () => {
    expect(isTailContiguous(makeCandles(10, MS_5M, 4, BASE_TS), 11, MS_5M)).toBe(false);
  });
});
