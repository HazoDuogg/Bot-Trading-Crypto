import { describe, expect, it } from 'vitest';
import { detectRegime } from './regimeDetector.js';
import { MarketRegime, type CandleData } from './types.js';
import { RegimeConfig } from './config.js';
import { computeCorrelatedRiskRatio } from './correlatedRisk.js';
import {
  bollingerBandwidthSeries,
  percentileRankSeries,
  sessionRelativeVolumeRatio,
  smaSeries,
  stdDevSeries,
  trendDirection,
  wickRatios,
  wilderADXSeries,
  wilderATRSeries,
  zScoreSeries,
} from './indicators.js';

/**
 * TICKET-G2 — regression coverage for the Regime layer's INPUT contract (timestamps, candle
 * closure, warm-up/lookback, multi-timeframe alignment, live/backtest input parity) and for
 * indicators.ts, which had no test file of its own before this ticket.
 *
 * Several tests here deliberately PIN a divergence that G2 found and did NOT fix (fixing them is
 * out of G2's bounded scope — see data/g2-findings-and-remediation.md F-01/F-02). They exist so the
 * behaviour is visible and cannot change silently in either direction.
 */

function flat(count: number, intervalMs: number, startTs: number, volume = 1000): CandleData[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: startTs + i * intervalMs, open: 100, high: 100.5, low: 99.5, close: 100, volume }));
}

/** Mild oscillation + slow drift — keeps adx1h inside the 20..32 gap, same isolation trick regimeDetector.test.ts uses. */
function moderateAdx1h(count: number, startTs: number): CandleData[] {
  let prevClose = 100;
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i * 0.5) * 0.5 + i * 0.05;
    const open = i === 0 ? close : prevClose;
    const candle = { timestamp: startTs + i * 3_600_000, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 };
    prevClose = close;
    return candle;
  });
}

const T0 = Date.UTC(2024, 0, 1);

// ---------------------------------------------------------------- indicators.ts (previously untested)
describe('G2 — indicators.ts warm-up boundaries and window semantics', () => {
  it('wilderATRSeries is NaN before `period` candles and defined from index period-1 onward', () => {
    const atr = wilderATRSeries(flat(40, 300_000, T0), 14);
    expect(atr.slice(0, 13).every(Number.isNaN)).toBe(true);
    expect(Number.isNaN(atr[13])).toBe(false);
    expect(atr.length).toBe(40); // series functions always return input length
  });

  it('wilderATRSeries seeds with the simple mean of the first `period` true ranges', () => {
    const atr = wilderATRSeries(flat(20, 300_000, T0), 14);
    expect(atr[13]).toBeCloseTo(1.0, 10); // flat candles: TR == high-low == 1.0 every candle
  });

  it('wilderADXSeries needs strictly more than period*2 candles before producing any value', () => {
    expect(wilderADXSeries(moderateAdx1h(27, T0), 14).every(Number.isNaN)).toBe(true);
    expect(wilderADXSeries(moderateAdx1h(60, T0), 14).some((v) => !Number.isNaN(v))).toBe(true);
  });

  it('percentileRankSeries window includes the value itself and stays NaN until the window is full', () => {
    const values = [1, 2, 3, 4, 5];
    const pct = percentileRankSeries(values, 3);
    expect(Number.isNaN(pct[0])).toBe(true);
    expect(Number.isNaN(pct[1])).toBe(true);
    expect(pct[2]).toBeCloseTo(100, 10); // 3 is the max of [1,2,3]
    expect(percentileRankSeries([5, 4, 3], 3)[2]).toBeCloseTo((1 / 3) * 100, 10);
  });

  it('percentileRankSeries refuses any window containing a NaN (no partial-window shortcut)', () => {
    expect(Number.isNaN(percentileRankSeries([NaN, 2, 3], 3)[2])).toBe(true);
  });

  it('zScoreSeries uses the population stddev over the trailing window, 0 when the window has no variance', () => {
    expect(zScoreSeries([5, 5, 5, 5], 4)[3]).toBe(0);
    const z = zScoreSeries([0, 0, 0, 3], 4)[3];
    expect(z).toBeCloseTo((3 - 0.75) / Math.sqrt(((0.75 ** 2) * 3 + 2.25 ** 2) / 4), 10);
  });

  it('smaSeries/stdDevSeries/bollingerBandwidthSeries agree with the direct formula', () => {
    const candles = flat(25, 900_000, T0).map((c, i) => ({ ...c, close: 100 + i }));
    const closes = candles.map((c) => c.close);
    const mid = smaSeries(closes, 20)[24];
    const sd = stdDevSeries(closes, 20)[24];
    expect(mid).toBeCloseTo(closes.slice(5, 25).reduce((a, b) => a + b, 0) / 20, 10);
    expect(bollingerBandwidthSeries(candles, 20)[24]).toBeCloseTo(((4 * sd) / mid) * 100, 10);
  });

  it('sessionRelativeVolumeRatio compares against the SAME time-of-day slot 288 candles back, not a rolling mean', () => {
    const candles = Array.from({ length: 288 * 2 + 1 }, (_, i) => ({ timestamp: T0 + i * 300_000, open: 1, high: 1, low: 1, close: 1, volume: i % 288 === 0 ? 1000 : 10 }));
    const ratio = sessionRelativeVolumeRatio(candles, 14);
    expect(ratio[288 * 2]).toBeCloseTo(1, 10); // slot 0 on day 2 vs slot 0 on days 0 and 1 — all 1000
    expect(Number.isNaN(ratio[100])).toBe(true); // less than one full day of history behind it
  });

  it('wickRatios matches the documented fraction-of-range formula and is 0/0 for a zero-range candle', () => {
    expect(wickRatios({ timestamp: 0, open: 10, high: 20, low: 0, close: 12, volume: 1 })).toEqual({ upperWickRatio: 0.4, lowerWickRatio: 0.5 });
    expect(wickRatios({ timestamp: 0, open: 5, high: 5, low: 5, close: 5, volume: 1 })).toEqual({ upperWickRatio: 0, lowerWickRatio: 0 });
  });

  it('trendDirection compares the latest value against exactly lookbackN periods back', () => {
    expect(trendDirection([1, 2, 3, 4], 3)).toBe('increasing');
    expect(trendDirection([4, 3, 2, 1], 3)).toBe('decreasing');
    expect(trendDirection([1, 9, 9, 1], 3)).toBe('flat');
  });
});

// ---------------------------------------------------------------- warm-up / lookback contract
describe('G2 — detectRegime warm-up and lookback contract', () => {
  it('throws the documented insufficient-history error rather than guessing when the 5m percentile window is not full', () => {
    expect(() => detectRegime({ candles5m: flat(50, 300_000, T0), candles15m: flat(325, 900_000, T0), candles1h: moderateAdx1h(40, T0) }))
      .toThrow(/insufficient candle history/);
  });

  it('needs ATR_PCT_LOOKBACK_5M + ATR_PERIOD_5M - 1 5m candles before atrPercentile5m is defined', () => {
    const need = RegimeConfig.ATR_PCT_LOOKBACK_5M + RegimeConfig.ATR_PERIOD_5M - 1;
    const c15 = flat(325, 900_000, T0);
    const c1h = moderateAdx1h(40, T0);
    expect(() => detectRegime({ candles5m: flat(need - 1, 300_000, T0), candles15m: c15, candles1h: c1h })).toThrow(/insufficient candle history/);
    expect(detectRegime({ candles5m: flat(need, 300_000, T0), candles15m: c15, candles1h: c1h }).computedMetrics.atrPercentile5m).toBeDefined();
  });

  it('needs BBW_PCT_LOOKBACK_15M + BB_PERIOD_15M - 1 15m candles before bbWidthPercentile15m is defined', () => {
    const need = RegimeConfig.BBW_PCT_LOOKBACK_15M + RegimeConfig.BB_PERIOD_15M - 1;
    const c5 = flat(320, 300_000, T0);
    const c1h = moderateAdx1h(40, T0);
    expect(() => detectRegime({ candles5m: c5, candles15m: flat(need - 1, 900_000, T0), candles1h: c1h })).toThrow(/insufficient candle history/);
    expect(detectRegime({ candles5m: c5, candles15m: flat(need, 900_000, T0), candles1h: c1h }).computedMetrics.bbWidthPercentile15m).toBeDefined();
  });

  it('the production WINDOW_5M(320)/WINDOW_15M(325)/WINDOW_1H(40) windows are all large enough for every mandatory metric', () => {
    const out = detectRegime({ candles5m: flat(320, 300_000, T0), candles15m: flat(325, 900_000, T0), candles1h: moderateAdx1h(40, T0) });
    for (const k of ['adx1h', 'atrPercentile5m', 'bbWidthPercentile15m', 'atrTrend5m', 'volumeZScore5m'] as const) {
      expect(out.computedMetrics[k]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------- closed-candle / no-look-ahead semantics
describe('G2 — closed-candle semantics and determinism', () => {
  const base = { candles5m: flat(320, 300_000, T0), candles15m: flat(325, 900_000, T0), candles1h: moderateAdx1h(40, T0) };

  it('is a pure function of its input window — identical input gives byte-identical classification (live/backtest parity by construction)', () => {
    const a = detectRegime({ ...base, previousRegime: MarketRegime.NEUTRAL_TRANSITION, streakCount: 1 });
    const b = detectRegime({ ...base, previousRegime: MarketRegime.NEUTRAL_TRANSITION, streakCount: 1 });
    expect(a.regime).toBe(b.regime);
    expect(a.candidateRegime).toBe(b.candidateRegime);
    expect(a.streakCount).toBe(b.streakCount);
    expect(a.computedMetrics).toEqual(b.computedMetrics);
  });

  const spike: CandleData = { timestamp: T0 + 320 * 300_000, open: 100, high: 140, low: 60, close: 130, volume: 500_000 };

  it('treats the LAST element of candles5m as the decision candle — appending one more candle changes the answer', () => {
    const before = detectRegime(base);
    const after = detectRegime({ ...base, candles5m: [...base.candles5m, spike] });
    expect(after.computedMetrics.volumeZScore5m).not.toBeCloseTo(before.computedMetrics.volumeZScore5m as number, 6);
  });

  it('never reads a candle the caller did not supply — truncating the window back to the pre-spike candles restores the pre-spike answer exactly', () => {
    const withSpike = detectRegime({ ...base, candles5m: [...base.candles5m, spike] });
    const truncated = detectRegime({ ...base, candles5m: [...base.candles5m, spike].slice(0, 320) });
    expect(truncated.computedMetrics).toEqual(detectRegime(base).computedMetrics);
    expect(truncated.computedMetrics.volumeZScore5m).not.toBeCloseTo(withSpike.computedMetrics.volumeZScore5m as number, 6);
  });

  it('uses the latest 5m candle timestamp (not the wall clock) as "now" for the post-DANGER cooldown', () => {
    const currentTs = base.candles5m[base.candles5m.length - 1].timestamp;
    const insideCooldown = detectRegime({ ...base, previousRegime: MarketRegime.TREND_RIDER, previousDangerZoneTimestamp: currentTs - 1000 });
    const outsideCooldown = detectRegime({ ...base, previousRegime: MarketRegime.TREND_RIDER, previousDangerZoneTimestamp: currentTs - (RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3_600_000 + 1) });
    // Wall clock is years away from T0, so a Date.now()-based cooldown would treat both as expired.
    expect(insideCooldown.lastDangerZoneTimestamp).toBe(currentTs - 1000);
    expect(outsideCooldown.lastDangerZoneTimestamp).toBe(currentTs - (RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3_600_000 + 1));
  });
});

// ---------------------------------------------------------------- F-05: post-DANGER cooldown dominance
describe('G2 F-05 — POST_DANGER_COOLDOWN_HOURS suppresses the three trading regimes', () => {
  // 40 strongly trending 1H candles -> adx1h clears TREND_ENTER_ADX for the full persistence window.
  const trending1h: CandleData[] = Array.from({ length: 40 }, (_, i) => ({ timestamp: T0 + i * 3_600_000, open: 100 + i * 2, high: 100 + i * 2 + 2.2, low: 100 + i * 2 - 0.1, close: 100 + i * 2 + 2, volume: 1000 }));
  // 5m candles whose ATR is rising hard at the end -> atrPercentile5m near 100.
  const rising5m: CandleData[] = Array.from({ length: 320 }, (_, i) => {
    const amp = i < 300 ? 0.2 : 6;
    return { timestamp: T0 + i * 300_000, open: 100, high: 100 + amp, low: 100 - amp, close: 100, volume: 1000 };
  });
  const c15 = flat(325, 900_000, T0);
  const now = rising5m[rising5m.length - 1].timestamp;

  it('classifies TREND_RIDER when no DANGER_ZONE has been seen', () => {
    expect(detectRegime({ candles5m: rising5m, candles15m: c15, candles1h: trending1h, previousRegime: MarketRegime.TREND_RIDER }).candidateRegime)
      .toBe(MarketRegime.TREND_RIDER);
  });

  it('forces that same TREND_RIDER candidate to NEUTRAL_TRANSITION for the whole 72h cooldown window', () => {
    const justInside = detectRegime({ candles5m: rising5m, candles15m: c15, candles1h: trending1h, previousRegime: MarketRegime.TREND_RIDER, previousDangerZoneTimestamp: now - (RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3_600_000 - 1) });
    expect(justInside.candidateRegime).toBe(MarketRegime.NEUTRAL_TRANSITION);
    const justOutside = detectRegime({ candles5m: rising5m, candles15m: c15, candles1h: trending1h, previousRegime: MarketRegime.TREND_RIDER, previousDangerZoneTimestamp: now - RegimeConfig.POST_DANGER_COOLDOWN_HOURS * 3_600_000 });
    expect(justOutside.candidateRegime).toBe(MarketRegime.TREND_RIDER);
  });
});

// ---------------------------------------------------------------- F-01: live/backtest input divergence
describe('G2 F-01 — candles5mSessionVolume is a live/backtest INPUT divergence, not a formula difference', () => {
  const CANDLES_PER_DAY = 288;
  const startTs = T0;
  const sessionVolume: CandleData[] = [];
  const days = RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS + 1;
  for (let d = 0; d < days; d++) {
    for (let slot = 0; slot < CANDLES_PER_DAY; slot++) {
      const i = d * CANDLES_PER_DAY + slot;
      const isLast = d === days - 1 && slot === CANDLES_PER_DAY - 1;
      sessionVolume.push({ timestamp: startTs + i * 300_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: isLast ? 50 : 1000 });
    }
  }
  const shared = { candles5m: sessionVolume.slice(-320), candles15m: flat(325, 900_000, startTs), candles1h: moderateAdx1h(40, startTs), previousRegime: null };

  it('backtest.ts-shaped input (session window supplied) reaches LOW_LIQUIDITY', () => {
    expect(detectRegime({ ...shared, candles5mSessionVolume: sessionVolume }).candidateRegime).toBe(MarketRegime.LOW_LIQUIDITY);
  });

  // TICKET-G2R P0-1: this shape is no longer what liveRunner.ts builds (it now supplies the window,
  // or blocks admission outright). Kept as the pin that OMITTING the field is what makes
  // LOW_LIQUIDITY unreachable — so the gap can never be silently reintroduced.
  it('session-window-OMITTED input makes LOW_LIQUIDITY structurally unreachable on the SAME candles', () => {
    const live = detectRegime(shared);
    expect(live.computedMetrics.lowLiquidityRatio).toBeUndefined();
    expect(live.candidateRegime).not.toBe(MarketRegime.LOW_LIQUIDITY);
  });

  it('both shapes agree on every other computed metric — the divergence is the missing input only', () => {
    const bt = detectRegime({ ...shared, candles5mSessionVolume: sessionVolume }).computedMetrics;
    const live = detectRegime(shared).computedMetrics;
    for (const k of ['adx1h', 'atrPercentile5m', 'bbWidthPercentile15m', 'atrTrend5m', 'volumeZScore5m'] as const) {
      expect(live[k]).toEqual(bt[k]);
    }
  });
});

// ---------------------------------------------------------------- F-02: cross-symbol index alignment
describe('G2 F-02 — computeCorrelatedRiskRatio depends on index alignment across symbols', () => {
  const mk = (seed: number, n: number, shift = 0): CandleData[] =>
    Array.from({ length: n }, (_, i) => ({ timestamp: T0 + (i + shift) * 3_600_000, open: 100, high: 101, low: 99, close: 100 + Math.sin((i + shift) * seed) * 5, volume: 1000 }));

  // TICKET-G2R P0-2 REMEDIATED: this assertion was inverted when the defect was fixed. G2 pinned the
  // BROKEN behavior (a one-index shift silently moved the number); the join is now by timestamp, so
  // the SAME instants are compared regardless of where each file starts, and the result is unchanged.
  it('G2R: shifting ONE symbol by a single index no longer changes the correlation — same timestamps compared either way', () => {
    const aligned = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 40), ETHUSDT: mk(0.31, 40), SOLUSDT: mk(0.29, 40), XRPUSDT: mk(0.3, 40) }, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    const shifted = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 40), ETHUSDT: mk(0.31, 40), SOLUSDT: mk(0.29, 40), XRPUSDT: mk(0.3, 40, 1) }, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    expect(shifted[39]).toBeCloseTo(aligned[39], 12);
  });

  it('produces NaN, never a partial-window number, before the anchor has a full window of returns', () => {
    const short = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 10), ETHUSDT: mk(0.31, 10) }, RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES, 'BTCUSDT');
    expect(short.every(Number.isNaN)).toBe(true);
  });
});
