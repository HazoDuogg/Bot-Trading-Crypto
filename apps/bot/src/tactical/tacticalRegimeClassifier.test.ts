import { describe, expect, it } from 'vitest';
import {
  applyTacticalHysteresis,
  classifyTactical,
  classifyTacticalCandidate,
  computeReturnInAtr5m,
  TacticalConfig,
  TacticalState,
  type TacticalCandleInput,
  type TacticalHysteresisState,
} from './tacticalRegimeClassifier.js';
import type { CandleData, ComputedMetrics } from '../regime/types.js';

function candle(overrides: Partial<CandleData> = {}): CandleData {
  return { timestamp: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 1000, ...overrides };
}

/**
 * TICKET-126: quiet-candle warmup so wilderATRSeries (period=14, RegimeConfig.ATR_PERIOD_5M) has
 * enough history to produce a defined ATR — needed for computeReturnInAtr5m() to be defined at all.
 * Flat range (TR=1 every candle, no gaps since open=close=`closeValue`) converges ATR to exactly 1,
 * making the trailing return delta easy to reason about in ATR units.
 */
function quietWarmup(closeValue: number, count = 14): CandleData[] {
  return Array.from({ length: count }, () => candle({ open: closeValue, close: closeValue, high: closeValue + 0.5, low: closeValue - 0.5 }));
}

function metrics(overrides: Partial<ComputedMetrics> = {}): ComputedMetrics {
  return { atrPercentile5m: 50, bbWidthPercentile15m: 50, volumeZScore5m: 0, atrTrend5m: 'flat', ...overrides };
}

const NEUTRAL_CANDLES: CandleData[] = [
  candle({ open: 100, close: 100.2 }),
  candle({ open: 100.2, close: 100.4 }),
  candle({ open: 100.4, close: 100.2 }),
  candle({ open: 100.2, close: 100.5 }),
];

describe('computeReturnInAtr5m — TICKET-126 unit-normalized tactical return feature', () => {
  it('returns undefined when fewer than 2 candles', () => {
    expect(computeReturnInAtr5m([candle()])).toBeUndefined();
    expect(computeReturnInAtr5m([])).toBeUndefined();
  });

  it('returns undefined when ATR cannot be computed yet (fewer than ATR_PERIOD_5M candles)', () => {
    const shortHistory = [...quietWarmup(100, 5), candle({ open: 100, close: 100.8 })];
    expect(computeReturnInAtr5m(shortHistory)).toBeUndefined();
  });

  it('computes (close - previousClose) / atr5mRaw using the same wilderATRSeries/lastDefined helpers as computeMomentumCrossFeatures()', () => {
    const candles = [...quietWarmup(100), candle({ open: 100, close: 100.8, high: 101.3, low: 99.7 })];
    const result = computeReturnInAtr5m(candles);
    expect(result).toBeCloseTo(0.767123, 5);
  });

  it('is negative for a down move, and uses the PREVIOUS candle close (not this candle\'s own open) as the baseline', () => {
    // This candle's own open->close is actually slightly UP (100.3 -> 100.4), but the previous
    // candle (quiet warmup) closed at 100 — so close-to-close (100.4 - 100 relative to the prior
    // candle) is still positive; flip the sign by starting the previous candle's close above this one.
    const candles = [...quietWarmup(100.8), candle({ open: 100, close: 100, high: 100.5, low: 99.5 })];
    // previousClose here is the LAST quiet candle's close (100.8), this candle's own close is 100 —
    // close-to-close delta = 100 - 100.8 = -0.8 (negative), distinct from candleReturnPct's
    // open-to-close-of-the-same-candle definition (100 - 100 = 0) used by volAdjReturn5m.
    const result = computeReturnInAtr5m(candles);
    expect(result).toBeLessThan(0);
  });

  it('is price-scale independent: a coin at a tiny price and a coin at a huge price with the same proportional move produce comparable ratios', () => {
    const quiet = (closeValue: number, rangeFrac: number): CandleData[] =>
      Array.from({ length: 14 }, () => candle({ open: closeValue, close: closeValue, high: closeValue * (1 + rangeFrac), low: closeValue * (1 - rangeFrac) }));
    const lowPriceCandles = [...quiet(0.5, 0.01), candle({ open: 0.5, close: 0.504, high: 0.5045, low: 0.4995 })];
    const highPriceCandles = [...quiet(100000, 0.01), candle({ open: 100000, close: 100800, high: 101000, low: 99000 })];
    const lowResult = computeReturnInAtr5m(lowPriceCandles);
    const highResult = computeReturnInAtr5m(highPriceCandles);
    expect(lowResult).toBeDefined();
    expect(highResult).toBeDefined();
    // Both roughly a fraction of their own ATR — same order of magnitude, unlike volAdjReturn5m
    // which would differ by orders of magnitude between a ~$0.5 coin and a ~$100k coin.
    expect(Math.abs(lowResult! - highResult!)).toBeLessThan(1);
  });
});

describe('classifyTacticalCandidate — NEUTRAL_COMPRESSION', () => {
  it('matches when ATR%/BBW% low, ATR decreasing, volume not expanding, no structural break', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 10, bbWidthPercentile15m: 5, volumeZScore5m: 0.2, atrTrend5m: 'decreasing' }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
      hasStructuralBreak: false,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_COMPRESSION);
    expect(result.side).toBeNull();
    expect(result.confidence).toBe(1);
    expect(result.isFastEnter).toBe(false);
    expect(result.dataSufficient).toBe(true);
  });

  it('does not match compression once a structural break is present (falls through)', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 10, bbWidthPercentile15m: 5, volumeZScore5m: 0.2, atrTrend5m: 'decreasing' }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
      hasStructuralBreak: true,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.NEUTRAL_COMPRESSION);
  });

  it('marks dataSufficient=false and defaults to NEUTRAL_COMPRESSION when required metrics are missing', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: undefined }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.dataSufficient).toBe(false);
    expect(result.state).toBe(TacticalState.NEUTRAL_COMPRESSION);
    expect(result.reasonCodes).toEqual(['INSUFFICIENT_METRICS']);
  });
});

describe('classifyTacticalCandidate — NEUTRAL_EXPANSION', () => {
  const strongUpCandle = candle({ open: 100, close: 103, high: 103.1, low: 99.9 }); // body ~0.96, big push up

  it('matches when ATR trend increasing, volume expanding, strong body, high ATR%, directional return ok', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 70, bbWidthPercentile15m: 60, volumeZScore5m: 2.0, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: 1.5, emaRatioFast: 1.01, emaRatioSlow: 1.01 },
      candles5m: [...NEUTRAL_CANDLES, strongUpCandle],
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(result.side).toBe('LONG');
    expect(result.confidence).toBe(1);
  });

  it('SHORT side for a strong down candle', () => {
    const strongDownCandle = candle({ open: 100, close: 97, high: 100.1, low: 96.9 });
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 70, bbWidthPercentile15m: 60, volumeZScore5m: 2.0, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: -1.5, emaRatioFast: 0.99, emaRatioSlow: 0.99 },
      candles5m: [...NEUTRAL_CANDLES, strongDownCandle],
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(result.side).toBe('SHORT');
  });

  it('isFastEnter=true on a big volume spike (>= VOLUME_EXPANSION_FAST_ENTER_ZSCORE)', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 70, bbWidthPercentile15m: 60, volumeZScore5m: TacticalConfig.VOLUME_EXPANSION_FAST_ENTER_ZSCORE, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: 1.5, emaRatioFast: 1.01, emaRatioSlow: 1.01 },
      candles5m: [...NEUTRAL_CANDLES, strongUpCandle],
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(result.isFastEnter).toBe(true);
  });

  it('isFastEnter=false for a bare-minimum expansion match (no spike, no BOS, ATR% below fast-enter bar)', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 55, bbWidthPercentile15m: 60, volumeZScore5m: 1.5, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: 1.0, emaRatioFast: 1.01, emaRatioSlow: 1.01 },
      candles5m: [...NEUTRAL_CANDLES, strongUpCandle],
      hasStructuralBreak: false,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(result.isFastEnter).toBe(false);
  });

  it('does not match when body ratio is weak (small push, mostly wick)', () => {
    const weakBodyCandle = candle({ open: 100, close: 100.1, high: 103, low: 97 }); // tiny body, huge range
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 70, bbWidthPercentile15m: 60, volumeZScore5m: 2.0, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: 1.5, emaRatioFast: 1.01, emaRatioSlow: 1.01 },
      candles5m: [...NEUTRAL_CANDLES, weakBodyCandle],
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.NEUTRAL_EXPANSION);
  });
});

describe('classifyTacticalCandidate — MICRO_TREND', () => {
  const persistUpCandles: CandleData[] = [
    // TICKET-126: quiet warmup so wilderATRSeries has enough history for computeReturnInAtr5m()
    // to be defined — RETURN_HELD now checks returnInAtr5m, not the (crossFeatures-only) volAdjReturn5m.
    ...quietWarmup(100),
    candle({ open: 100, close: 100.6, high: 100.7, low: 99.9 }),
    candle({ open: 100.6, close: 101.2, high: 101.3, low: 100.5 }),
    candle({ open: 101.2, close: 101.8, high: 101.9, low: 101.1 }),
    candle({ open: 101.8, close: 102.4, high: 102.5, low: 101.7 }),
  ];

  it('matches when EMA aligned up, structural break confirmed, not choppy, return held', () => {
    const input: TacticalCandleInput = {
      // Deliberately NOT expansion-eligible (atrTrend flat, ATR% mid) so MICRO_TREND is reached.
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: { volAdjReturn5m: 0.4, emaRatioFast: 1.01, emaRatioSlow: 1.005 },
      candles5m: persistUpCandles,
      hasStructuralBreak: true,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.MICRO_TREND);
    expect(result.side).toBe('LONG');
    expect(result.isFastEnter).toBe(true); // BOS confirmed => fast-enter eligible per ticket spec
  });

  it('SHORT side when EMA aligned down', () => {
    const persistDownCandles: CandleData[] = [
      ...quietWarmup(102.4),
      candle({ open: 102.4, close: 101.8, high: 102.5, low: 101.7 }),
      candle({ open: 101.8, close: 101.2, high: 101.9, low: 101.1 }),
      candle({ open: 101.2, close: 100.6, high: 101.3, low: 100.5 }),
      candle({ open: 100.6, close: 100, high: 100.7, low: 99.9 }),
    ];
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: { volAdjReturn5m: -0.4, emaRatioFast: 0.99, emaRatioSlow: 0.995 },
      candles5m: persistDownCandles,
      hasStructuralBreak: true,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.MICRO_TREND);
    expect(result.side).toBe('SHORT');
  });

  it('does not match without a structural break, even with EMA alignment', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: { volAdjReturn5m: 0.4, emaRatioFast: 1.01, emaRatioSlow: 1.005 },
      candles5m: persistUpCandles,
      hasStructuralBreak: false,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.MICRO_TREND);
  });

  it('does not match when crossFeatures is undefined (no EMA data to align)', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: undefined,
      candles5m: persistUpCandles,
      hasStructuralBreak: true,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.MICRO_TREND);
  });
});

describe('classifyTacticalCandidate — MICRO_CHOP', () => {
  it('matches on repeated direction flips + wick-heavy + weak body', () => {
    const choppyCandles: CandleData[] = [
      candle({ open: 100, close: 100.5 }),
      candle({ open: 100.5, close: 99.8 }),
      candle({ open: 99.8, close: 100.6 }),
      // Current candle: small body, big wick both sides.
      candle({ open: 100.6, close: 100.55, high: 101.5, low: 99.5 }),
    ];
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 50, bbWidthPercentile15m: 50, volumeZScore5m: 0.3, atrTrend5m: 'flat' }),
      crossFeatures: undefined,
      candles5m: choppyCandles,
      hasStructuralBreak: false,
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.MICRO_CHOP);
    expect(result.side).toBeNull();
    expect(result.isFastEnter).toBe(false);
  });
});

describe('classifyTacticalCandidate — TICKET-125 per-side hasStructuralBreak ({ LONG, SHORT } form)', () => {
  const persistUpCandles: CandleData[] = [
    // TICKET-126: quiet warmup so wilderATRSeries has enough history for computeReturnInAtr5m()
    // to be defined — RETURN_HELD now checks returnInAtr5m, not the (crossFeatures-only) volAdjReturn5m.
    ...quietWarmup(100),
    candle({ open: 100, close: 100.6, high: 100.7, low: 99.9 }),
    candle({ open: 100.6, close: 101.2, high: 101.3, low: 100.5 }),
    candle({ open: 101.2, close: 101.8, high: 101.9, low: 101.1 }),
    candle({ open: 101.8, close: 102.4, high: 102.5, low: 101.7 }),
  ];

  it('MICRO_TREND (LONG candidate) matches when only the LONG side has a break, even if SHORT does not', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: { volAdjReturn5m: 0.4, emaRatioFast: 1.01, emaRatioSlow: 1.005 },
      candles5m: persistUpCandles,
      hasStructuralBreak: { LONG: true, SHORT: false },
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.MICRO_TREND);
    expect(result.side).toBe('LONG');
  });

  it('MICRO_TREND (LONG candidate) does NOT match when only the SHORT side has a break (wrong side)', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 45, bbWidthPercentile15m: 40, volumeZScore5m: 0.5, atrTrend5m: 'flat' }),
      crossFeatures: { volAdjReturn5m: 0.4, emaRatioFast: 1.01, emaRatioSlow: 1.005 },
      candles5m: persistUpCandles,
      hasStructuralBreak: { LONG: false, SHORT: true },
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.MICRO_TREND);
  });

  it('NEUTRAL_COMPRESSION NO_STRUCTURAL_BREAK requires BOTH sides false — a break on either side still blocks it', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 10, bbWidthPercentile15m: 5, volumeZScore5m: 0.2, atrTrend5m: 'decreasing' }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
      hasStructuralBreak: { LONG: false, SHORT: true },
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).not.toBe(TacticalState.NEUTRAL_COMPRESSION);
  });

  it('NEUTRAL_COMPRESSION matches when both LONG and SHORT are false', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 10, bbWidthPercentile15m: 5, volumeZScore5m: 0.2, atrTrend5m: 'decreasing' }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
      hasStructuralBreak: { LONG: false, SHORT: false },
    };
    const result = classifyTacticalCandidate(input);
    expect(result.state).toBe(TacticalState.NEUTRAL_COMPRESSION);
  });
});

describe('applyTacticalHysteresis', () => {
  function candidateOf(state: TacticalState, isFastEnter = false): ReturnType<typeof classifyTacticalCandidate> {
    return { state, side: null, reasonCodes: [], confidence: 1, isFastEnter, dataSufficient: true };
  }

  it('confirms the very first candidate immediately (previous = null)', () => {
    const result = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_CHOP), null);
    expect(result.state).toBe(TacticalState.MICRO_CHOP);
    expect(result.recentCandidates).toEqual([TacticalState.MICRO_CHOP]);
  });

  it('holds the confirmed state on a single differing candidate (1 of 3, below the 2/3 threshold)', () => {
    let state: TacticalHysteresisState = { state: TacticalState.NEUTRAL_COMPRESSION, side: null, confidence: 1, reasonCodes: [], recentCandidates: [TacticalState.NEUTRAL_COMPRESSION] };
    state = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_TREND), state);
    expect(state.state).toBe(TacticalState.NEUTRAL_COMPRESSION); // still held
  });

  it('confirms a new state once 2 of the last 3 candidates agree (normal, non-fast-enter transition)', () => {
    let state: TacticalHysteresisState = { state: TacticalState.NEUTRAL_COMPRESSION, side: null, confidence: 1, reasonCodes: [], recentCandidates: [TacticalState.NEUTRAL_COMPRESSION] };
    state = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_TREND), state); // 1/3
    expect(state.state).toBe(TacticalState.NEUTRAL_COMPRESSION);
    state = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_TREND), state); // 2/3 -> confirm
    expect(state.state).toBe(TacticalState.MICRO_TREND);
  });

  it('confirms immediately on a single fast-enter candidate, bypassing the 2/3 window', () => {
    const state: TacticalHysteresisState = { state: TacticalState.NEUTRAL_COMPRESSION, side: null, confidence: 1, reasonCodes: [], recentCandidates: [TacticalState.NEUTRAL_COMPRESSION] };
    const result = applyTacticalHysteresis(candidateOf(TacticalState.NEUTRAL_EXPANSION, true), state);
    expect(result.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(result.recentCandidates).toEqual([TacticalState.NEUTRAL_EXPANSION]);
  });

  it('refreshing the same confirmed state never requires re-confirmation', () => {
    let state: TacticalHysteresisState = { state: TacticalState.MICRO_TREND, side: null, confidence: 1, reasonCodes: [], recentCandidates: [TacticalState.MICRO_TREND] };
    state = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_TREND), state);
    expect(state.state).toBe(TacticalState.MICRO_TREND);
    expect(state.recentCandidates).toEqual([TacticalState.MICRO_TREND, TacticalState.MICRO_TREND]);
  });

  it('a state cannot flip away after only 1 candle losing its condition (needs >= 2 of the last 3)', () => {
    let state: TacticalHysteresisState = { state: TacticalState.NEUTRAL_COMPRESSION, side: null, confidence: 1, reasonCodes: [], recentCandidates: [TacticalState.NEUTRAL_COMPRESSION, TacticalState.NEUTRAL_COMPRESSION] };
    state = applyTacticalHysteresis(candidateOf(TacticalState.MICRO_CHOP), state); // 1 candle differs
    expect(state.state).toBe(TacticalState.NEUTRAL_COMPRESSION); // still held — exit needs >= 2
  });
});

describe('classifyTactical (candidate + hysteresis combined)', () => {
  it('returns dataSufficient=false without throwing when metrics are missing, and does not update hysteresis to a fabricated state beyond the documented default', () => {
    const input: TacticalCandleInput = {
      computedMetrics: metrics({ bbWidthPercentile15m: undefined }),
      crossFeatures: undefined,
      candles5m: NEUTRAL_CANDLES,
    };
    const result = classifyTactical(input, null);
    expect(result.dataSufficient).toBe(false);
    expect(result.state).toBe(TacticalState.NEUTRAL_COMPRESSION);
  });

  it('threads hysteresisState through consecutive calls (caller feeds previous output back in)', () => {
    const strongExpansionInput: TacticalCandleInput = {
      computedMetrics: metrics({ atrPercentile5m: 95, bbWidthPercentile15m: 80, volumeZScore5m: 3.0, atrTrend5m: 'increasing' }),
      crossFeatures: { volAdjReturn5m: 2.0, emaRatioFast: 1.02, emaRatioSlow: 1.02 },
      candles5m: [...NEUTRAL_CANDLES, candle({ open: 100, close: 104, high: 104.1, low: 99.9 })],
    };
    const first = classifyTactical(strongExpansionInput, null);
    expect(first.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    const second = classifyTactical(strongExpansionInput, first.hysteresisState);
    expect(second.state).toBe(TacticalState.NEUTRAL_EXPANSION);
    expect(second.hysteresisState.recentCandidates.length).toBe(2);
  });
});
