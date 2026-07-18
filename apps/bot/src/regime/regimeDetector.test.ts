import { describe, expect, it } from 'vitest';
import { applyHysteresis, classifyCandidate, detectRegime, type HysteresisState } from './regimeDetector.js';
import { MarketRegime, type CandleData, type ComputedMetrics } from './types.js';
import { RegimeConfig } from './config.js';

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
