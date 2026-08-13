/**
 * TICKET-G2R — regression tests for the two P0 remediations.
 *   P0-1 (F-01): paged 5m session-volume backfill in LiveCandleFeed + explicit readiness state.
 *   P0-2 (F-02): cross-symbol correlation joins by timestamp, never by array index.
 * Same convention as regime/g2RegimeIntegrity.test.ts (behavioral, no source-scanning).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveCandleFeed, SESSION_VOLUME_WINDOW_5M, DEFAULT_WINDOW_SIZES, type CandleData as FeedCandle } from '../live/liveCandleFeed.js';
import { computeCorrelatedRiskRatio } from './correlatedRisk.js';
import { sessionRelativeVolumeRatio } from './indicators.js';
import { RegimeConfig } from './config.js';
import { detectRegime } from './regimeDetector.js';
import { MarketRegime, type CandleData } from './types.js';

const FIVE_MIN = 5 * 60_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function rawKline(c: FeedCandle): [number, string, string, string, string, string] {
  return [c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)];
}
const mockOk = (candles: FeedCandle[]) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => candles.map(rawKline) });

/** A contiguous ascending 5m series ending at `endTs`. */
function series5m(endTs: number, count: number, volume = 1000): FeedCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const timestamp = endTs - (count - 1 - i) * FIVE_MIN;
    return { timestamp, open: 100, high: 100.5, low: 99.5, close: 100, volume };
  });
}

function parseUrl(url: string): { interval: string; limit: number; startTime?: number; endTime?: number } {
  const u = new URL(url);
  return {
    interval: u.searchParams.get('interval') ?? '',
    limit: Number(u.searchParams.get('limit') ?? '0'),
    startTime: u.searchParams.has('startTime') ? Number(u.searchParams.get('startTime')) : undefined,
    endTime: u.searchParams.has('endTime') ? Number(u.searchParams.get('endTime')) : undefined,
  };
}

// ------------------------------------------------------------------ P0-1: paged session-volume backfill
describe('G2R P0-1 — LiveCandleFeed seeds the full 4033-candle 5m session-volume window by paging', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  // The "exchange": a long contiguous 5m history the mock serves ranges out of, capped at 1500/request.
  const NEWEST = T0 + 6000 * FIVE_MIN;
  const EXCHANGE = series5m(NEWEST, 8000);
  const BINANCE_CAP = 1500;

  function serveRange(startTime: number | undefined, endTime: number | undefined, limit: number, cap = BINANCE_CAP): FeedCandle[] {
    const effective = Math.min(limit, cap);
    if (startTime === undefined && endTime === undefined) return EXCHANGE.slice(EXCHANGE.length - effective);
    const inRange = EXCHANGE.filter((c) => (startTime === undefined || c.timestamp >= startTime) && (endTime === undefined || c.timestamp <= endTime));
    return inRange.slice(Math.max(0, inRange.length - effective)); // newest-first truncation, like a bounded endTime query
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires 4033 closed candles and reserves one extra 5m buffer slot for the forming candle', () => {
    expect(SESSION_VOLUME_WINDOW_5M).toBe(RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS * 288 + 1);
    expect(SESSION_VOLUME_WINDOW_5M).toBe(4033);
    expect(DEFAULT_WINDOW_SIZES['5m']).toBe(SESSION_VOLUME_WINDOW_5M + 1);
  });

  it('pages the 5m seed across MULTIPLE requests (4033 > 1500 per-request cap) and ends up READY immediately after start()', async () => {
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      return Promise.resolve(mockOk(serveRange(q.startTime, q.endTime, q.limit)));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const fiveMinCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes('interval=5m'));
    expect(fiveMinCalls.length).toBeGreaterThanOrEqual(3); // ceil(4033/1500) = 3
    expect(feed.getCandles('BTCUSDT', '5m')).toHaveLength(DEFAULT_WINDOW_SIZES['5m']);

    // "không phụ thuộc thời gian bot đã chạy": ready at t=now, with zero elapsed runtime.
    const ready = feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN + 2_000);
    expect(ready.status).toBe('READY');
    expect(ready.candles).toHaveLength(SESSION_VOLUME_WINDOW_5M);
  }, 30_000);

  it('is READY after start() when Binance returns 4033 closed candles plus the forming candle', async () => {
    const formingTs = NEWEST;
    const nowMs = formingTs + FIVE_MIN - 1;
    const exchangeWithForming = series5m(formingTs, SESSION_VOLUME_WINDOW_5M + 1);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      const inRange = exchangeWithForming.filter((c) => (q.startTime === undefined || c.timestamp >= q.startTime) && (q.endTime === undefined || c.timestamp <= q.endTime));
      return Promise.resolve(mockOk(inRange.slice(Math.max(0, inRange.length - Math.min(q.limit, BINANCE_CAP)))));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const window = feed.getSessionVolumeWindow('BTCUSDT', nowMs);
    expect(window.status).toBe('READY');
    expect(feed.getClosedCandles('BTCUSDT', '5m', nowMs)).toHaveLength(SESSION_VOLUME_WINDOW_5M);
    expect(window.candles).toHaveLength(SESSION_VOLUME_WINDOW_5M);
    dateNow.mockRestore();
  }, 30_000);

  it('never asks for more than Binance\'s 1500-kline per-request cap on any single seed page', async () => {
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      return Promise.resolve(mockOk(serveRange(q.startTime, q.endTime, q.limit)));
    });
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();
    for (const [url] of fetchMock.mock.calls) expect(parseUrl(url as string).limit).toBeLessThanOrEqual(1500);
  }, 30_000);

  it('deduplicates OVERLAPPING pages (an exchange re-serving candles already held) and stays sorted ascending', async () => {
    // Every page deliberately overlaps the previous one by 200 candles.
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      const base = serveRange(q.startTime, q.endTime, q.limit);
      if (base.length === 0) return Promise.resolve(mockOk([]));
      const overlapStart = base[base.length - 1].timestamp + FIVE_MIN;
      const overlap = EXCHANGE.filter((c) => c.timestamp >= overlapStart && c.timestamp < overlapStart + 200 * FIVE_MIN);
      return Promise.resolve(mockOk([...base, ...overlap]));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const buf = feed.getCandles('BTCUSDT', '5m');
    expect(new Set(buf.map((c) => c.timestamp)).size).toBe(buf.length); // zero duplicates
    for (let i = 1; i < buf.length; i++) expect(buf[i].timestamp).toBeGreaterThan(buf[i - 1].timestamp);
  }, 30_000);

  it('repairs a MISSING page (hole in the middle) via the range-request path before start() returns', async () => {
    const HOLE_FROM = NEWEST - 2000 * FIVE_MIN;
    const HOLE_TO = HOLE_FROM + 4 * FIVE_MIN;
    let allowHoleRepair = false;
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      let out = serveRange(q.startTime, q.endTime, q.limit);
      // Targeted repair request (small explicit range inside the hole) is served in full.
      if (q.startTime !== undefined && q.startTime >= HOLE_FROM && q.endTime !== undefined && q.endTime <= HOLE_TO) allowHoleRepair = true;
      if (!allowHoleRepair) out = out.filter((c) => c.timestamp < HOLE_FROM || c.timestamp > HOLE_TO);
      return Promise.resolve(mockOk(out));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const buf = feed.getCandles('BTCUSDT', '5m');
    for (let i = 1; i < buf.length; i++) expect(buf[i].timestamp - buf[i - 1].timestamp).toBe(FIVE_MIN); // contiguous
  }, 30_000);

  it('a PARTIAL response (exchange returns fewer candles than asked) leaves an explicit INSUFFICIENT_WARMUP state, never a silent "volume normal"', async () => {
    // Exchange only ever has 900 5m candles — far short of 4033.
    const SHORT = series5m(NEWEST, 900);
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      const inRange = SHORT.filter((c) => (q.startTime === undefined || c.timestamp >= q.startTime) && (q.endTime === undefined || c.timestamp <= q.endTime));
      return Promise.resolve(mockOk(inRange.slice(Math.max(0, inRange.length - Math.min(q.limit, BINANCE_CAP)))));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const w = feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN + 2_000);
    expect(w.status).toBe('INSUFFICIENT_WARMUP');
    expect(w.reason).toBe('NOT_ENOUGH_CANDLES');
    expect(w.candles).toBeUndefined(); // no fabricated/averaged stand-in
    expect(w.required).toBe(SESSION_VOLUME_WINDOW_5M);
  }, 30_000);

  it('a FAILED seed page surfaces through onError and still reports INSUFFICIENT_WARMUP (fail-closed, no partial window handed out)', async () => {
    let fiveMinCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      fiveMinCalls++;
      if (fiveMinCalls === 1) return Promise.resolve(mockOk(serveRange(undefined, undefined, q.limit)));
      return Promise.reject(new Error('page fetch exploded'));
    });

    const onError = vi.fn();
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', onError, pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    expect(onError).toHaveBeenCalled();
    expect(feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN + 2_000).status).toBe('INSUFFICIENT_WARMUP');
  }, 60_000);

  it('a GAP inside the window is INSUFFICIENT_WARMUP, not READY — the metric indexes i-288*k and a hole would compare the wrong time-of-day slot', async () => {
    // Enough candles overall, but with one hole that survives (repair range also returns nothing).
    const HOLE_TS = NEWEST - 1000 * FIVE_MIN;
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      return Promise.resolve(mockOk(serveRange(q.startTime, q.endTime, q.limit).filter((c) => c.timestamp !== HOLE_TS)));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const w = feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN + 2_000);
    expect(w.status).toBe('INSUFFICIENT_WARMUP');
    expect(w.reason).toBe('GAP_IN_WINDOW');
  }, 30_000);

  it('only CLOSED candles reach the session-volume window (the still-forming candle is excluded)', async () => {
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      return Promise.resolve(mockOk(serveRange(q.startTime, q.endTime, q.limit)));
    });
    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    // "now" is mid-way through NEWEST's own interval -> NEWEST is still forming.
    const forming = feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN - 1);
    expect(forming.candles?.[forming.candles.length - 1].timestamp).not.toBe(NEWEST);
    const closed = feed.getSessionVolumeWindow('BTCUSDT', NEWEST + FIVE_MIN + 2_000);
    expect(closed.candles?.[closed.candles.length - 1].timestamp).toBe(NEWEST);
  }, 30_000);

  it('RESTART PARITY — a second, independently constructed feed over the SAME exchange data produces a byte-identical window and identical downstream regime input', async () => {
    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      return Promise.resolve(mockOk(serveRange(q.startTime, q.endTime, q.limit)));
    });

    const nowMs = NEWEST + FIVE_MIN + 2_000;
    const feedA = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feedA.start();
    feedA.stop();
    const feedB = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feedB.start();
    feedB.stop();

    const a = feedA.getSessionVolumeWindow('BTCUSDT', nowMs);
    const b = feedB.getSessionVolumeWindow('BTCUSDT', nowMs);
    expect(a.status).toBe('READY');
    expect(JSON.stringify(b.candles)).toBe(JSON.stringify(a.candles));
    // and the metric the window exists for is identical too
    const ratioA = sessionRelativeVolumeRatio(a.candles as CandleData[], RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    const ratioB = sessionRelativeVolumeRatio(b.candles as CandleData[], RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS);
    expect(ratioB).toEqual(ratioA);
  }, 60_000);

  it('the seeded window is exactly what LOW_LIQUIDITY needs — a low-volume last candle now REACHES LOW_LIQUIDITY through the live feed path', async () => {
    // Same construction as g2RegimeIntegrity's F-01 fixture, but delivered through the real feed.
    const days = RegimeConfig.LOW_LIQUIDITY_SESSION_LOOKBACK_DAYS + 1;
    const total = days * 288;
    const endTs = T0 + (total - 1) * FIVE_MIN;
    const built = series5m(endTs, total);
    built[built.length - 1] = { ...built[built.length - 1], volume: 50 };

    fetchMock.mockImplementation((url: string) => {
      const q = parseUrl(url);
      if (q.interval !== '5m') return Promise.resolve(mockOk([{ timestamp: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
      const inRange = built.filter((c) => (q.startTime === undefined || c.timestamp >= q.startTime) && (q.endTime === undefined || c.timestamp <= q.endTime));
      return Promise.resolve(mockOk(inRange.slice(Math.max(0, inRange.length - Math.min(q.limit, BINANCE_CAP)))));
    });

    const feed = new LiveCandleFeed({ symbols: ['BTCUSDT'], baseUrl: 'https://example.test', pollIntervalsMs: { '5m': 999_999 } });
    await feed.start();
    feed.stop();

    const w = feed.getSessionVolumeWindow('BTCUSDT', endTs + FIVE_MIN + 2_000);
    expect(w.status).toBe('READY');

    const flat15 = Array.from({ length: 325 }, (_, i) => ({ timestamp: T0 + i * 900_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }));
    const flat1h = Array.from({ length: 40 }, (_, i) => ({ timestamp: T0 + i * 3_600_000, open: 100, high: 101, low: 99, close: 100 + (i % 2), volume: 1000 }));
    const out = detectRegime({
      candles5m: (w.candles as CandleData[]).slice(-320),
      candles15m: flat15,
      candles1h: flat1h,
      candles5mSessionVolume: w.candles as CandleData[],
      previousRegime: null,
    });
    expect(out.computedMetrics.lowLiquidityRatio).toBeLessThan(RegimeConfig.LOW_LIQUIDITY_VOLUME_RATIO_THRESHOLD.enter);
    expect(out.candidateRegime).toBe(MarketRegime.LOW_LIQUIDITY);
  }, 30_000);
});

// ------------------------------------------------------------------ P0-2: timestamp-joined correlation
describe('G2R P0-2 — computeCorrelatedRiskRatio joins by timestamp, never by array index', () => {
  const HOUR = 3_600_000;
  const mk = (seed: number, n: number, shiftCandles = 0): CandleData[] =>
    Array.from({ length: n }, (_, i) => {
      const idx = i + shiftCandles;
      return { timestamp: T0 + idx * HOUR, open: 100, high: 101, low: 99, close: 100 + Math.sin(idx * seed) * 5, volume: 1000 };
    });

  const W = RegimeConfig.CORRELATED_RISK_WINDOW_CANDLES;

  it('GENERAL CASE — a series shifted by one candle yields the SAME correlation (result independent of each file\'s start index)', () => {
    const base = { BTCUSDT: mk(0.3, 60), ETHUSDT: mk(0.31, 60), SOLUSDT: mk(0.29, 60) };
    const aligned = computeCorrelatedRiskRatio({ ...base, XRPUSDT: mk(0.37, 60) }, W, 'BTCUSDT');
    const shifted = computeCorrelatedRiskRatio({ ...base, XRPUSDT: mk(0.37, 60, 1) }, W, 'BTCUSDT');
    expect(shifted[59]).toBeCloseTo(aligned[59], 12);
  });

  it('GENERAL CASE — shifting EVERY non-anchor symbol by a different amount still yields the aligned answer', () => {
    const aligned = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 80), ETHUSDT: mk(0.31, 80), SOLUSDT: mk(0.29, 80), XRPUSDT: mk(0.37, 80) }, W, 'BTCUSDT');
    const shifted = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 80), ETHUSDT: mk(0.31, 80, 1), SOLUSDT: mk(0.29, 80, 2), XRPUSDT: mk(0.37, 80, 3) }, W, 'BTCUSDT');
    expect(shifted[79]).toBeCloseTo(aligned[79], 12);
  });

  it('XRP-LIKE CASE — the real defect: XRP one candle ahead of BTC/ETH/SOL no longer shifts the return matrix', () => {
    const btc = mk(0.3, 60);
    const eth = mk(0.31, 60);
    const sol = mk(0.29, 60);
    const xrpAligned = mk(0.37, 60);
    const xrpOffset = mk(0.37, 60, 1); // exactly the +1-index / +1-interval offset G2 measured
    const a = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: eth, SOLUSDT: sol, XRPUSDT: xrpAligned }, W, 'BTCUSDT');
    const b = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: eth, SOLUSDT: sol, XRPUSDT: xrpOffset }, W, 'BTCUSDT');
    expect(b[59]).toBeCloseTo(a[59], 12);
  });

  it('MISSING-TIMESTAMP POLICY — a symbol with a hole inside the window is EXCLUDED from the average, never filled from a neighbouring candle', () => {
    const btc = mk(0.3, 60);
    const eth = mk(0.31, 60);
    const solHoley = mk(0.29, 60).filter((c) => c.timestamp !== T0 + 55 * HOUR);
    const withHole = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: eth, SOLUSDT: solHoley }, W, 'BTCUSDT');
    const ethOnly = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: eth }, W, 'BTCUSDT');
    // SOL contributed nothing -> identical to the ETH-only average (not a shifted 2-symbol blend).
    expect(withHole[59]).toBeCloseTo(ethOnly[59], 12);
  });

  it('MISSING-TIMESTAMP POLICY — when NO other symbol can supply a complete matching window the result is NaN, never a partial number', () => {
    const btc = mk(0.3, 60);
    const disjoint = mk(0.31, 60, 500); // no overlapping timestamps at all
    const out = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: disjoint }, W, 'BTCUSDT');
    expect(Number.isNaN(out[59])).toBe(true);
  });

  it('a return spanning a GAP is rejected — both endpoints of every compared return must be the anchor\'s own instants', () => {
    const btc = mk(0.3, 60);
    // ETH keeps the closing instant of the window but its predecessor is 2 hours back (a hole).
    const eth = mk(0.31, 60).filter((c) => c.timestamp !== T0 + 58 * HOUR);
    const out = computeCorrelatedRiskRatio({ BTCUSDT: btc, ETHUSDT: eth }, W, 'BTCUSDT');
    expect(Number.isNaN(out[59])).toBe(true);
  });

  it('identical, fully-aligned inputs still produce the ordinary answer (no regression in the normal path)', () => {
    const out = computeCorrelatedRiskRatio({ BTCUSDT: mk(0.3, 60), ETHUSDT: mk(0.3, 60) }, W, 'BTCUSDT');
    expect(out[59]).toBeCloseTo(1, 10); // identical series -> perfect correlation
  });
});
