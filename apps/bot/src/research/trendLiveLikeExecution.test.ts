import { describe, expect, it } from 'vitest';
import type { Candle } from '../noTradeZone/types.js';
import { generateTrendCandidates } from './trendLiveLikeCandidates.js';
import type { TrendCandidate } from './trendLiveLikeExecution.js';
import { applyOneActivePerSymbol, simulateConventional, simulateLiveLike, summarizeExecution, type ExecutionScenario, type SymbolReplayData } from './trendLiveLikeExecution.js';

const MINUTE = 60_000;
const M15 = 15 * MINUTE;

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

function candidate(decisionTimestamp = M15): TrendCandidate {
  return { symbol: 'BTCUSDT', signalOpenTime: decisionTimestamp - M15, decisionTimestamp, direction: 'LONG', entryPrice: 100, slPrice: 90, tpPrice: 121, gapLow: 100, gapHigh: 101 };
}

function scenario(overrides: Partial<ExecutionScenario> = {}): ExecutionScenario {
  return { id: 'touch', label: 'Touch', fillBufferBps: 0, latencyMs: 0, slippageBps: 1, entryFeeRate: 0.0002, slFeeRate: 0.0005, tpFeeRate: 0.0005, ...overrides };
}

function replay(first: Candle, second?: Candle): SymbolReplayData {
  const minutes: Candle[] = [];
  for (let index = 0; index < 30; index++) minutes.push(candle(M15 + index * MINUTE, 110, 110, 105, 108));
  minutes[0] = first;
  if (second) minutes[1] = second;
  const m15 = [
    candle(M15, 110, Math.max(...minutes.slice(0, 15).map((item) => item.high)), Math.min(...minutes.slice(0, 15).map((item) => item.low)), 108),
    candle(2 * M15, 108, Math.max(...minutes.slice(15).map((item) => item.high)), Math.min(...minutes.slice(15).map((item) => item.low)), 108),
  ];
  return { m15, m15IndexByOpenTime: new Map(m15.map((item, index) => [item.openTime, index])), minuteByOpenTime: new Map(minutes.map((item) => [item.openTime, item])) };
}

describe('trend-following live-like execution', () => {
  it('creates the FVG candidate only after M15 close and excludes an unclosed future H1 candle', () => {
    const h1 = Array.from({ length: 201 }, (_, index) => candle(index * 60 * MINUTE, 100, 101, 99, index === 200 ? 10_000 : 100));
    const base = 200 * 60 * MINUTE;
    const m15 = [candle(base, 100, 101, 99, 100), candle(base + M15, 100, 104, 100, 104), candle(base + 2 * M15, 102, 103, 102, 102.5)];
    const generated = generateTrendCandidates('BTCUSDT', m15, h1);
    expect(generated.candidates).toHaveLength(1);
    expect(generated.candidates[0]).toMatchObject({ direction: 'LONG', decisionTimestamp: base + 3 * M15 });
  });

  it('does not fill before the decision timestamp under sub-minute latency mapping', () => {
    const data = replay(candle(M15, 110, 110, 99.995, 105), candle(M15 + MINUTE, 108, 110, 105, 108));
    expect(simulateLiveLike(candidate(), data, scenario()).fillTime).toBe(M15);
    expect(simulateLiveLike(candidate(), data, scenario({ latencyMs: 500 })).fillTime).toBeNull();
  });

  it('requires deterministic trade-through and handles fill-candle ambiguity SL-first', () => {
    const touchOnly = replay(candle(M15, 110, 110, 99.995, 105));
    expect(simulateLiveLike(candidate(), touchOnly, scenario({ fillBufferBps: 1 })).fillTime).toBeNull();
    const ambiguous = simulateLiveLike(candidate(), replay(candle(M15, 110, 122, 89, 100)), scenario());
    expect(ambiguous.status).toBe('LOSS');
    expect(ambiguous.netR).toBeLessThan(-1);
  });

  it('keeps the conventional gap-intersection comparator distinct from a real LIMIT touch', () => {
    const data = replay(candle(M15, 110, 110, 100.5, 105));
    expect(simulateConventional(candidate(), data, scenario()).fillTime).toBe(M15);
    expect(simulateLiveLike(candidate(), data, scenario()).fillTime).toBeNull();
  });

  it('does not backfill a passed LIMIT until reset and recross', () => {
    const data = replay(candle(M15, 99, 99.5, 98, 99));
    data.minuteByOpenTime.set(M15 + MINUTE, candle(M15 + MINUTE, 99, 101, 99, 101));
    data.minuteByOpenTime.set(M15 + 2 * MINUTE, candle(M15 + 2 * MINUTE, 101, 102, 99, 100));
    expect(simulateLiveLike(candidate(), data, scenario()).fillTime).toBe(M15 + 2 * MINUTE);
  });

  it('mirrors SHORT execution and charges exit fees', () => {
    const short = { ...candidate(), direction: 'SHORT' as const, entryPrice: 100, slPrice: 110, tpPrice: 79, gapLow: 99, gapHigh: 100 };
    const data = replay(candle(M15, 90, 101, 90, 95), candle(M15 + MINUTE, 95, 99, 78, 80));
    const result = simulateLiveLike(short, data, scenario({ fillBufferBps: 1 }));
    expect(result.status).toBe('WIN');
    expect(result.netR).toBeLessThan(2.1);
  });

  it('applies one active lifecycle per symbol chronologically', () => {
    const data = replay(candle(M15, 110, 110, 99, 105), candle(M15 + MINUTE, 105, 122, 104, 121));
    const first = simulateLiveLike(candidate(), data, scenario());
    const constrained = applyOneActivePerSymbol([first, { ...first, candidate: candidate(M15 + MINUTE) }]);
    expect(constrained.map((result) => result.status)).toEqual(['WIN', 'PRODUCTION_SKIPPED']);
    expect(summarizeExecution(constrained)).toMatchObject({ candidates: 2, filled: 1, skipped: 1, wins: 1 });
  });
});
