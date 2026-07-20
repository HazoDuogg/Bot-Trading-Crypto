import { describe, expect, it } from 'vitest';
import { applyHysteresis, classifyCandidate, detectRegime, type HysteresisState } from './regimeDetector.js';
import { MarketRegime, type CandleData, type ComputedMetrics } from './types.js';
import { RegimeConfig } from './config.js';
import { sessionRelativeVolumeRatio } from './indicators.js';

// TICKET-007 Phần A — not covered by the reduced-test-scope memo (that memo applies to
// slTpManager.ts only). DANGER_ZONE: bypass N_CANDLE_CONFIRM entering, keep it leaving.

describe('applyHysteresis — DANGER_ZONE fast in / slow out', () => {
  it('confirms DANGER_ZONE immediately on the very first call (previous = null)', () => {
    const result = applyHysteresis(MarketRegime.DANGER_ZONE, null);
    expect(result.regime).toBe(MarketRegime.DANGER_ZONE);
    expect(result.streakCount).toBe(0);
  });

  it('confirms DANGER_ZONE immediately from any other confirmed state, bypassing N_CANDLE_CONFIRM', () => {
    const previous: HysteresisState = {
      regime: MarketRegime.SIDEWAY_SCALPER,
      candidateRegime: MarketRegime.SIDEWAY_SCALPER,
      streakCount: 0,
    };
    const result = applyHysteresis(MarketRegime.DANGER_ZONE, previous);
    expect(result.regime).toBe(MarketRegime.DANGER_ZONE);
    expect(result.streakCount).toBe(0);
  });

  it('does not leave DANGER_ZONE until the new candidate holds for N_CANDLE_CONFIRM consecutive calls', () => {
    let state: HysteresisState = { regime: MarketRegime.DANGER_ZONE, candidateRegime: MarketRegime.DANGER_ZONE, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM - 1; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
      expect(state.regime).toBe(MarketRegime.DANGER_ZONE); // still held
    }
  });

  it('leaves DANGER_ZONE once the new candidate holds for exactly N_CANDLE_CONFIRM consecutive calls', () => {
    let state: HysteresisState = { regime: MarketRegime.DANGER_ZONE, candidateRegime: MarketRegime.DANGER_ZONE, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
    }
    expect(state.regime).toBe(MarketRegime.TREND_RIDER);
    expect(state.streakCount).toBe(0);
  });

  it('non-DANGER_ZONE transitions still require N_CANDLE_CONFIRM (regression check, unchanged)', () => {
    let state: HysteresisState = { regime: MarketRegime.SIDEWAY_SCALPER, candidateRegime: MarketRegime.SIDEWAY_SCALPER, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM - 1; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
      expect(state.regime).toBe(MarketRegime.SIDEWAY_SCALPER); // still held
    }
    state = applyHysteresis(MarketRegime.TREND_RIDER, state);
    expect(state.regime).toBe(MarketRegime.TREND_RIDER);
  });
});

// TICKET-014 Phần A — post-crash chop was producing 1-candle ADX spikes that classifyCandidate
// mistook for TREND_RIDER. adx1h must clear the threshold for TREND_ADX_PERSISTENCE_CANDLES
// consecutive 1H candles now, not just the latest one.
describe('classifyCandidate — TREND_RIDER ADX persistence (TICKET-014 Phần A)', () => {
  const nonTrendMetrics = {
    atrPercentile5m: 100, // clears TREND_ENTER_ATR_PCT.enter (65) — isolates the ADX persistence check
    bbWidthPercentile15m: 50, // clears COMPRESSION's <=10 threshold
    atrTrend5m: 'flat' as const,
    volumeZScore5m: 0, // stays under DANGER's volume threshold
  };

  it('does NOT match TREND_RIDER when adx1h only clears the threshold on the latest candle', () => {
    const metrics: ComputedMetrics = { adx1h: 40, adx1hRecent: [20, 22, 40], ...nonTrendMetrics };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('matches TREND_RIDER when adx1h clears the threshold for the whole persistence window', () => {
    const metrics: ComputedMetrics = { adx1h: 40, adx1hRecent: [35, 38, 40], ...nonTrendMetrics };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.TREND_RIDER);
  });

  it('does NOT match TREND_RIDER when adx1hRecent is shorter than the persistence window (insufficient history)', () => {
    const metrics: ComputedMetrics = { adx1h: 40, adx1hRecent: [40], ...nonTrendMetrics };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });
});

// TICKET-014 Phần B — after a confirmed DANGER_ZONE, TREND_RIDER candidates are forced down to
// NEUTRAL_TRANSITION for POST_DANGER_COOLDOWN_HOURS, regardless of Phần A persistence passing.
describe('detectRegime — Post-Danger Cooldown (TICKET-014 Phần B)', () => {
  function makeCandles(count: number, intervalMs: number, priceAt: (i: number) => number, rangeAt: (i: number) => number): CandleData[] {
    const startTs = Date.UTC(2024, 0, 1);
    const candles: CandleData[] = [];
    let prevClose = priceAt(0);
    for (let i = 0; i < count; i++) {
      const close = priceAt(i);
      const open = i === 0 ? close : prevClose;
      const range = rangeAt(i);
      const high = Math.max(open, close) + range / 2;
      const low = Math.min(open, close) - range / 2;
      candles.push({ timestamp: startTs + i * intervalMs, open, high, low, close, volume: 1000 });
      prevClose = close;
    }
    return candles;
  }

  function trendInput() {
    return {
      candles1h: makeCandles(40, 3_600_000, (i) => 100 + i * 2, () => 1), // sustained uptrend -> persistent high ADX
      candles5m: makeCandles(320, 300_000, (i) => 100 + i * 0.01, (i) => (i >= 300 ? 5 : 0.5)),
      candles15m: makeCandles(325, 900_000, (i) => 100 + i * 0.01, () => 1),
    };
  }

  // TICKET-015: flat 1h price -> adx1h=0 (well under SIDEWAY_ADX_THRESHOLD), 5m range trending
  // down -> atrPercentile5m low (avoids VOLATILE_CHOP's >=70 branch checked earlier in priority).
  function sidewayInput() {
    return {
      candles1h: makeCandles(40, 3_600_000, () => 100, () => 1),
      candles5m: makeCandles(320, 300_000, () => 100, (i) => 5 - i * (4.7 / 320)),
      candles15m: makeCandles(325, 900_000, (i) => 100 + (i % 3 === 0 ? 0.2 : -0.1), () => 1),
    };
  }

  // TICKET-015: 15m close oscillation collapses to near-zero late in the window -> bbWidthPercentile15m
  // near 0 (<= COMPRESSION_BBW_PCT_THRESHOLD) and atrTrend5m 'decreasing' (5m range tapering off too).
  function compressionInput() {
    return {
      candles1h: makeCandles(40, 3_600_000, (i) => 100 + i * 2, () => 1),
      candles15m: makeCandles(325, 900_000, (i) => 100 + Math.sin(i) * (i < 300 ? 2 : 0.05), () => 1),
      candles5m: makeCandles(320, 300_000, () => 100, (i) => (i >= 250 ? 2 - (i - 250) * 0.02 : 2)),
    };
  }

  it('forces the candidate down to NEUTRAL_TRANSITION while inside the cooldown window (would otherwise be TREND_RIDER)', () => {
    const input = trendInput();
    const now = input.candles5m[input.candles5m.length - 1].timestamp;
    const recentDangerZoneTs = now - 1 * 60 * 60 * 1000; // 1h ago, well within the 72h cooldown

    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: recentDangerZoneTs });

    expect(output.candidateRegime).toBe(MarketRegime.NEUTRAL_TRANSITION);
    expect(output.regime).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('lets TREND_RIDER through once the cooldown window has fully elapsed', () => {
    const input = trendInput();
    const now = input.candles5m[input.candles5m.length - 1].timestamp;
    const oldDangerZoneTs = now - (RegimeConfig.POST_DANGER_COOLDOWN_HOURS + 1) * 60 * 60 * 1000;

    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: oldDangerZoneTs });

    expect(output.candidateRegime).toBe(MarketRegime.TREND_RIDER);
  });

  // TICKET-015: cooldown suppression extended to SIDEWAY_SCALPER and COMPRESSION (same shared
  // detectBoxBreakout() false-breakout root cause as TREND_RIDER), not just TREND_RIDER.
  it('forces SIDEWAY_SCALPER candidate down to NEUTRAL_TRANSITION during cooldown', () => {
    const input = sidewayInput();
    const now = input.candles5m[input.candles5m.length - 1].timestamp;
    const recentDangerZoneTs = now - 1 * 60 * 60 * 1000;

    const withoutCooldown = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: null });
    expect(withoutCooldown.candidateRegime).toBe(MarketRegime.SIDEWAY_SCALPER); // sanity: fixture really is SIDEWAY_SCALPER

    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: recentDangerZoneTs });
    expect(output.candidateRegime).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('forces COMPRESSION candidate down to NEUTRAL_TRANSITION during cooldown', () => {
    const input = compressionInput();
    const now = input.candles5m[input.candles5m.length - 1].timestamp;
    const recentDangerZoneTs = now - 1 * 60 * 60 * 1000;

    const withoutCooldown = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: null });
    expect(withoutCooldown.candidateRegime).toBe(MarketRegime.COMPRESSION); // sanity: fixture really is COMPRESSION

    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: recentDangerZoneTs });
    expect(output.candidateRegime).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('is a no-op when there has never been a confirmed DANGER_ZONE', () => {
    const input = trendInput();
    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: null });
    expect(output.candidateRegime).toBe(MarketRegime.TREND_RIDER);
  });

  it('records lastDangerZoneTimestamp (= current candle timestamp) when the confirmed regime is DANGER_ZONE', () => {
    // Extreme 5m range spike (-> atrPercentile5m ~100) + a single huge volume spike on the last
    // candle (-> volumeZScore5m >> 2.5) -> DANGER_ZONE, confirmed immediately (fast-in hysteresis).
    const count5m = 320;
    const candles1h = makeCandles(40, 3_600_000, (i) => 100 + i * 0.5, () => 1);
    const candles5m = makeCandles(count5m, 300_000, (i) => 100 + i * 0.01, (i) => (i >= 315 ? 8 : 0.5)).map((c, i) => ({
      ...c,
      volume: i === count5m - 1 ? 5000 : 100,
    }));
    const candles15m = makeCandles(325, 900_000, (i) => 100 + i * 0.01, () => 1);

    const output = detectRegime({ candles5m, candles15m, candles1h, previousRegime: null, previousDangerZoneTimestamp: null });

    expect(output.regime).toBe(MarketRegime.DANGER_ZONE);
    expect(output.lastDangerZoneTimestamp).toBe(candles5m[candles5m.length - 1].timestamp);
  });

  it('does not touch lastDangerZoneTimestamp when the confirmed regime is not DANGER_ZONE', () => {
    const input = trendInput();
    const priorTs = 123456789;
    const output = detectRegime({ ...input, previousRegime: null, previousDangerZoneTimestamp: priorTs });
    expect(output.lastDangerZoneTimestamp).toBe(priorTs); // carried forward unchanged
  });
});

// TICKET-026 Phần B — MANIPULATED joins DANGER_ZONE as a FAST_IN_SLOW_OUT_REGIMES member: confirm
// entering immediately, still require N_CANDLE_CONFIRM to leave. Mirrors the DANGER_ZONE block above.
describe('applyHysteresis — MANIPULATED fast in / slow out', () => {
  it('confirms MANIPULATED immediately on the very first call (previous = null)', () => {
    const result = applyHysteresis(MarketRegime.MANIPULATED, null);
    expect(result.regime).toBe(MarketRegime.MANIPULATED);
    expect(result.streakCount).toBe(0);
  });

  it('confirms MANIPULATED immediately from any other confirmed state, bypassing N_CANDLE_CONFIRM', () => {
    const previous: HysteresisState = { regime: MarketRegime.SIDEWAY_SCALPER, candidateRegime: MarketRegime.SIDEWAY_SCALPER, streakCount: 0 };
    const result = applyHysteresis(MarketRegime.MANIPULATED, previous);
    expect(result.regime).toBe(MarketRegime.MANIPULATED);
    expect(result.streakCount).toBe(0);
  });

  it('does not leave MANIPULATED until the new candidate holds for N_CANDLE_CONFIRM consecutive calls', () => {
    let state: HysteresisState = { regime: MarketRegime.MANIPULATED, candidateRegime: MarketRegime.MANIPULATED, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM - 1; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
      expect(state.regime).toBe(MarketRegime.MANIPULATED); // still held
    }
  });

  it('leaves MANIPULATED once the new candidate holds for exactly N_CANDLE_CONFIRM consecutive calls', () => {
    let state: HysteresisState = { regime: MarketRegime.MANIPULATED, candidateRegime: MarketRegime.MANIPULATED, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
    }
    expect(state.regime).toBe(MarketRegime.TREND_RIDER);
    expect(state.streakCount).toBe(0);
  });

  it('DANGER_ZONE and MANIPULATED both fast-in independently — switching straight from one to the other still confirms immediately', () => {
    const fromDanger: HysteresisState = { regime: MarketRegime.DANGER_ZONE, candidateRegime: MarketRegime.DANGER_ZONE, streakCount: 0 };
    const result = applyHysteresis(MarketRegime.MANIPULATED, fromDanger);
    expect(result.regime).toBe(MarketRegime.MANIPULATED);
    expect(result.streakCount).toBe(0);
  });
});

// TICKET-026 Phần A — MANIPULATED: repeated 2-sided wick sweeps (reuses regime/indicators.ts's
// wickRatios(), same formula entry/detectors/liquiditySweep.ts uses), without a volume spike.
describe('classifyCandidate — MANIPULATED (TICKET-026 Phần A)', () => {
  // Deliberately fails every OTHER branch (DANGER/TREND/COMPRESSION/CHOP/SIDEWAY) so the only
  // question being tested is the MANIPULATED condition itself — falls through to NEUTRAL_TRANSITION
  // whenever MANIPULATED does NOT match, same isolation style as the TREND_RIDER persistence tests above.
  const neutralMetrics = {
    adx1h: 25, // > SIDEWAY_ADX_THRESHOLD(20); adx1hRecent below has insufficient length anyway -> no TREND_RIDER
    adx1hRecent: [25],
    atrPercentile5m: 50, // < CHOP_ATR_PCT_THRESHOLD(70) and < DANGER_ATR_PCT_THRESHOLD(95)
    bbWidthPercentile15m: 50, // > COMPRESSION_BBW_PCT_THRESHOLD(10)
    atrTrend5m: 'flat' as const,
    volumeZScore5m: 0, // < DANGER_VOLUME_ZSCORE_THRESHOLD(2.5) and < MANIPULATED_MAX_VOLUME_ZSCORE(1.5)
  };

  it('matches MANIPULATED when BOTH sides show >= MANIPULATED_MIN_SWEEPS_EACH_SIDE sweeps and volume is normal', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, upperSweepCount5m: 2, lowerSweepCount5m: 2 };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.MANIPULATED);
  });

  it('does NOT match MANIPULATED when only ONE side repeats (real trend, not manipulation)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, upperSweepCount5m: 5, lowerSweepCount5m: 0 };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('does NOT match MANIPULATED when volume is abnormally high (real volatility, per DANGER_ZONE, not staged manipulation)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, upperSweepCount5m: 3, lowerSweepCount5m: 3, volumeZScore5m: 2.0 };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('does NOT match MANIPULATED when the lookback window has not fully populated yet (counts undefined)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, upperSweepCount5m: undefined, lowerSweepCount5m: undefined };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });
});

// TICKET-026 — full pipeline: real candle data with genuine 2-sided wick sweeps in the trailing
// MANIPULATED_LOOKBACK_CANDLES window should classify MANIPULATED end-to-end (computeMetrics's
// sweep-counting, not just classifyCandidate's decision in isolation, per the tests above).
describe('detectRegime — MANIPULATED integration (TICKET-026)', () => {
  function c(open: number, close: number, high: number, low: number, timestamp: number): CandleData {
    return { timestamp, open, close, high, low, volume: 1000 }; // constant volume -> volumeZScore5m = 0
  }

  function makeFlatCandles(count: number, intervalMs: number, startTs: number): CandleData[] {
    const candles: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      candles.push(c(100, 100, 100.5, 99.5, startTs + i * intervalMs));
    }
    return candles;
  }

  it('classifies MANIPULATED when the last 10 5m candles alternate big upper/lower wicks with flat volume', () => {
    const candles1h = makeFlatCandles(40, 3_600_000, Date.UTC(2024, 0, 1)); // flat -> adx1h ~ 0, well under every ADX-based threshold
    const candles15m = makeFlatCandles(325, 900_000, Date.UTC(2024, 0, 1));

    const fillerCount = 310; // same margin as other full-pipeline fixtures in this file
    const filler5m = makeFlatCandles(fillerCount, 300_000, Date.UTC(2024, 0, 1));
    const lastFillerTs = filler5m[filler5m.length - 1].timestamp;

    // 10 candles, alternating a big upper wick (open=close=100, high=110) and a big lower wick
    // (open=close=100, high=101, low=90) — upperWickRatio/lowerWickRatio ~0.91 > 0.65 threshold on
    // the respective side each time -> 5 upper-sweep + 5 lower-sweep candles, both >= MANIPULATED_MIN_SWEEPS_EACH_SIDE(2).
    const manipulatedTail: CandleData[] = Array.from({ length: RegimeConfig.MANIPULATED_LOOKBACK_CANDLES }, (_, i) =>
      i % 2 === 0 ? c(100, 100, 110, 99, lastFillerTs + (i + 1) * 300_000) : c(100, 100, 101, 90, lastFillerTs + (i + 1) * 300_000),
    );
    const candles5m = [...filler5m, ...manipulatedTail];

    const output = detectRegime({ candles5m, candles15m, candles1h, previousRegime: null });

    expect(output.computedMetrics.upperSweepCount5m).toBe(5);
    expect(output.computedMetrics.lowerSweepCount5m).toBe(5);
    expect(output.computedMetrics.volumeZScore5m).toBe(0);
    expect(output.candidateRegime).toBe(MarketRegime.MANIPULATED);
    expect(output.regime).toBe(MarketRegime.MANIPULATED); // fast-in — confirmed on the very first call
  });
});

// TICKET-028 — LOW_LIQUIDITY: session-relative volume (current volume vs the SAME time-of-day on
// prior days). Volume-only (no order book depth data available). Priority: right after MANIPULATED,
// before TREND_RIDER.
describe('classifyCandidate — LOW_LIQUIDITY (TICKET-028)', () => {
  // Deliberately fails every OTHER branch (DANGER/MANIPULATED/TREND/COMPRESSION/CHOP/SIDEWAY), same
  // isolation style as the MANIPULATED tests above — the only question under test is lowLiquidityRatio.
  const neutralMetrics = {
    adx1h: 25, // > SIDEWAY_ADX_THRESHOLD(20); adx1hRecent below has insufficient length -> no TREND_RIDER either
    adx1hRecent: [25],
    atrPercentile5m: 50, // < CHOP_ATR_PCT_THRESHOLD(70) and < DANGER_ATR_PCT_THRESHOLD(95)
    bbWidthPercentile15m: 50, // > COMPRESSION_BBW_PCT_THRESHOLD(10)
    atrTrend5m: 'flat' as const,
    volumeZScore5m: 0, // < DANGER_VOLUME_ZSCORE_THRESHOLD(2.5)
    upperSweepCount5m: 0, // < MANIPULATED_MIN_SWEEPS_EACH_SIDE(2)
    lowerSweepCount5m: 0,
  };

  it('matches LOW_LIQUIDITY when lowLiquidityRatio is below LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD (sufficient session history)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, lowLiquidityRatio: 0.1 };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.LOW_LIQUIDITY);
  });

  it('does NOT match LOW_LIQUIDITY when lowLiquidityRatio is at/above the threshold (volume normal for this time of day)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, lowLiquidityRatio: 0.9 };
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('does NOT throw and classifies normally when lowLiquidityRatio is undefined (insufficient session history — optional field, not in the mandatory-metrics check)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, lowLiquidityRatio: undefined };
    expect(() => classifyCandidate(metrics, null)).not.toThrow();
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('does NOT throw and classifies normally when lowLiquidityRatio is NaN (insufficient session history)', () => {
    const metrics: ComputedMetrics = { ...neutralMetrics, lowLiquidityRatio: NaN };
    expect(() => classifyCandidate(metrics, null)).not.toThrow();
    expect(classifyCandidate(metrics, null)).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });
});

// TICKET-028 — LOW_LIQUIDITY uses NORMAL symmetric N_CANDLE_CONFIRM hysteresis both ways, unlike
// DANGER_ZONE/MANIPULATED's fast-in/slow-out — thin liquidity is a slowly-changing session
// characteristic, not a shock requiring an immediate reaction. NOT added to FAST_IN_SLOW_OUT_REGIMES.
describe('applyHysteresis — LOW_LIQUIDITY normal hysteresis, not fast-in/slow-out (TICKET-028)', () => {
  it('does NOT confirm LOW_LIQUIDITY immediately from a different confirmed state — requires N_CANDLE_CONFIRM to ENTER, unlike DANGER_ZONE/MANIPULATED', () => {
    let state: HysteresisState = { regime: MarketRegime.SIDEWAY_SCALPER, candidateRegime: MarketRegime.SIDEWAY_SCALPER, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM - 1; i++) {
      state = applyHysteresis(MarketRegime.LOW_LIQUIDITY, state);
      expect(state.regime).toBe(MarketRegime.SIDEWAY_SCALPER); // still held
    }
    state = applyHysteresis(MarketRegime.LOW_LIQUIDITY, state);
    expect(state.regime).toBe(MarketRegime.LOW_LIQUIDITY); // confirmed only once the streak completes
  });

  it('also requires N_CANDLE_CONFIRM to LEAVE a confirmed LOW_LIQUIDITY (symmetric, same rule both directions)', () => {
    let state: HysteresisState = { regime: MarketRegime.LOW_LIQUIDITY, candidateRegime: MarketRegime.LOW_LIQUIDITY, streakCount: 0 };
    for (let i = 0; i < RegimeConfig.N_CANDLE_CONFIRM - 1; i++) {
      state = applyHysteresis(MarketRegime.TREND_RIDER, state);
      expect(state.regime).toBe(MarketRegime.LOW_LIQUIDITY); // still held
    }
    state = applyHysteresis(MarketRegime.TREND_RIDER, state);
    expect(state.regime).toBe(MarketRegime.TREND_RIDER);
  });
});

// TICKET-028 — sessionRelativeVolumeRatio itself: proves the metric compares against the SAME
// time-of-day on prior days, not a plain rolling/whole-day average (the entire reason
// zScoreSeries/percentileRankSeries were NOT reused for this metric).
describe('sessionRelativeVolumeRatio — session-relative, not a flat daily average (TICKET-028)', () => {
  const CANDLES_PER_DAY = 288;

  function buildCandles(days: number, quietSlotVolume: number, normalVolume: number, quietSlotIndex = 0): CandleData[] {
    const startTs = Date.UTC(2024, 0, 1);
    const candles: CandleData[] = [];
    for (let d = 0; d < days; d++) {
      for (let slot = 0; slot < CANDLES_PER_DAY; slot++) {
        const i = d * CANDLES_PER_DAY + slot;
        const volume = slot === quietSlotIndex ? quietSlotVolume : normalVolume;
        candles.push({ timestamp: startTs + i * 300_000, open: 100, high: 100.5, low: 99.5, close: 100, volume });
      }
    }
    return candles;
  }

  it('does NOT flag a candle as low volume when it matches its own recurring quiet-session baseline, even though far below the whole-day average', () => {
    // slot 0 of every day is a recurring quiet session (volume 100), every other slot is 1000 —
    // a whole-day average/z-score would flag slot 0 as a huge anomaly every single day.
    const candles = buildCandles(6, 100, 1000);
    const ratios = sessionRelativeVolumeRatio(candles, RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    const day6Slot0 = 5 * CANDLES_PER_DAY + 0;
    expect(ratios[day6Slot0]).toBeCloseTo(1.0, 5); // matches its own session baseline exactly -> ratio 1.0, not low
  });

  it('DOES flag a candle as low volume when it drops well below its own recurring session baseline', () => {
    const candles = buildCandles(6, 100, 1000);
    const day6Slot0 = 5 * CANDLES_PER_DAY + 0;
    candles[day6Slot0].volume = 10; // crashes to 10, well under this slot's usual 100
    const ratios = sessionRelativeVolumeRatio(candles, RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    expect(ratios[day6Slot0]).toBeLessThan(RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD.enter);
  });

  it('returns NaN for every index in the first day of any dataset (zero same-time-of-day history yet)', () => {
    const candles = buildCandles(1, 100, 1000);
    const ratios = sessionRelativeVolumeRatio(candles, RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    expect(ratios.every((r) => Number.isNaN(r))).toBe(true);
  });

  it('averages over however many prior same-time-of-day candles exist when fewer than lookbackDays are available (not an error)', () => {
    const candles = buildCandles(2, 100, 1000); // only 1 full prior day available, lookbackDays=14 requested
    const ratios = sessionRelativeVolumeRatio(candles, RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    const day2Slot0 = 1 * CANDLES_PER_DAY + 0;
    expect(ratios[day2Slot0]).toBeCloseTo(1.0, 5); // averaged over the single available prior day (100), current is 100 too
  });
});

// TICKET-028 — full pipeline: computeMetrics()'s lowLiquidityRatio wiring (via the dedicated
// candles5mSessionVolume field) feeding classifyCandidate() end-to-end, not just the isolated
// unit-level tests above.
describe('detectRegime — LOW_LIQUIDITY integration (TICKET-028)', () => {
  function c(volume: number, timestamp: number): CandleData {
    return { timestamp, open: 100, high: 100.5, low: 99.5, close: 100, volume }; // flat price -> adx1h ~ 0, bbWidth/atr stay boring
  }

  function makeFlatCandles(count: number, intervalMs: number, startTs: number, volume: number): CandleData[] {
    return Array.from({ length: count }, (_, i) => c(volume, startTs + i * intervalMs));
  }

  it('classifies LOW_LIQUIDITY end-to-end when the latest candle drops well below its own recurring session-volume baseline', () => {
    const startTs = Date.UTC(2024, 0, 1);
    const candles1h = makeFlatCandles(40, 3_600_000, startTs, 1000); // flat -> adx1h ~ 0, avoids TREND_RIDER/CHOP
    const candles15m = makeFlatCandles(325, 900_000, startTs, 1000); // avoids COMPRESSION

    const CANDLES_PER_DAY = 288;
    const days = RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS + 1; // full lookback + the "current" day
    const candles5mSessionVolume: CandleData[] = [];
    for (let d = 0; d < days; d++) {
      for (let slot = 0; slot < CANDLES_PER_DAY; slot++) {
        const i = d * CANDLES_PER_DAY + slot;
        const isLastCandle = d === days - 1 && slot === CANDLES_PER_DAY - 1;
        candles5mSessionVolume.push(c(isLastCandle ? 50 : 1000, startTs + i * 300_000)); // last candle's slot always 1000 historically, crashes to 50 now
      }
    }
    const candles5m = candles5mSessionVolume.slice(-320); // regime/entry's own smaller window — same underlying candles, matching real orchestrator wiring

    const output = detectRegime({ candles5m, candles15m, candles1h, previousRegime: null, candles5mSessionVolume });

    expect(output.computedMetrics.lowLiquidityRatio).toBeCloseTo(0.05, 2); // 50 / 1000
    expect(output.candidateRegime).toBe(MarketRegime.LOW_LIQUIDITY);
  });

  it('does not compute lowLiquidityRatio at all when candles5mSessionVolume is omitted (LOW_LIQUIDITY never fires, no error)', () => {
    const startTs = Date.UTC(2024, 0, 1);
    const candles1h = makeFlatCandles(40, 3_600_000, startTs, 1000);
    const candles15m = makeFlatCandles(325, 900_000, startTs, 1000);
    const candles5m = makeFlatCandles(320, 300_000, startTs, 1000);

    const output = detectRegime({ candles5m, candles15m, candles1h, previousRegime: null });

    expect(output.computedMetrics.lowLiquidityRatio).toBeUndefined();
    expect(output.candidateRegime).not.toBe(MarketRegime.LOW_LIQUIDITY);
  });
});
