import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_ROUTER_CONFIG, routeEntry, type EntryRouterInput } from './entryRouter.js';
import type { FunnelEvent } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { RegimeConfig } from '../regime/config.js';
import { lastDefined, wilderATRSeries } from '../regime/indicators.js';
import { EntryConfig } from './config.js';

function c(open: number, close: number, high: number, low: number): CandleData {
  return { timestamp: 0, open, close, high, low, volume: 100 };
}

// Filler candles pad the 5m series so wilderATRSeries (period 14) has enough history; their tiny,
// identical range never produces a fractal (ties always fail the strict swing-point comparison),
// so they don't interfere with the OB pattern appended after them.
const filler: CandleData[] = Array.from({ length: 14 }, () => c(9, 9, 9.5, 8.5));

// Same OB pattern as detectors/orderBlock.test.ts's BULLISH case, shifted 14 candles later.
const trendCandles5m: CandleData[] = [
  ...filler,
  c(9, 9, 10, 8),
  c(10.5, 10.5, 12, 9),
  c(13, 13, 15, 11), // swing high (15)
  c(11, 11, 12, 10),
  c(9, 9, 10, 8),
  c(11, 9, 11, 9), // OB candidate (down), zone [9, 11]
  c(9, 12, 12.5, 9),
  c(12, 16, 16, 11.5), // BOS confirmed
];

// Same MSS pattern as detectors/marketStructureShift.test.ts's BULLISH case (TICKET-009: reference
// high must already exist BETWEEN the two lows, not form after).
const mssCandles: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.25, 9.25, 10, 8.5),
  c(7.5, 7.5, 9.5, 6), // swing low #1 (6)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // swing high BETWEEN the two lows (12)
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(8.75, 8.75, 9.5, 8), // swing low #2 (8) — higher-low vs index 2
  c(9.25, 9.25, 10, 8.5),
  c(9.5, 9.5, 10, 9),
  c(12.5, 13, 13.2, 12.3), // MSS confirmed here, close = 13
];

// EntryConfig.BOX_LOOKBACK_M defaults to 40 — pad with filler candles safely inside [90,110] so
// they don't shift the box, keeping the same box-defining shape as detectors/boxBreakout.test.ts.
const box15mFiller: CandleData[] = Array.from({ length: 35 }, () => c(100, 100, 100, 95));
// No down candle anywhere (all flat open===close except the sweep candle, which is up) -> no OB
// candidate. No 3-candle window gaps either -> no FVG. Only a valid Liquidity Sweep exists.
const sweepFiller: CandleData[] = Array.from({ length: 14 }, () => c(9, 9, 9.5, 8.5));
const sweepOnlyCandles5m: CandleData[] = [
  ...sweepFiller,
  c(9, 9, 10, 8),
  c(8, 8, 9.5, 7),
  c(7, 7, 9, 5), // swing low (5)
  c(8, 8, 9.5, 7),
  c(9, 9, 10, 8),
  c(5.3, 5.5, 6, 3), // sweep candle: low=3<5, close=5.5>5, lowerWickRatio=(5.3-3)/3=0.77
];

const box15m: CandleData[] = [
  ...box15mFiller,
  c(100, 101, 105, 95),
  c(101, 103, 108, 92),
  c(103, 100, 110, 90),
  c(100, 102, 107, 93),
  c(102, 101, 106, 91),
];

function baseInput(overrides: Partial<EntryRouterInput>): EntryRouterInput {
  return {
    regime: MarketRegime.VOLATILE_CHOP,
    symbol: 'BTCUSDT',
    adxDirection1h: undefined,
    macroDirection: undefined,
    candles5m: [],
    candles15m: [],
    candlesMss: [],
    bbWidthPercentile15m: undefined,
    volumeZScore5m: undefined,
    ...overrides,
  };
}

describe('routeEntry — TREND_RIDER (OB + MSS)', () => {
  it('produces a LONG DraftSetup via OB when adxDirection1h=UP and MSS confirms', () => {
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'UP',
      candles5m: trendCandles5m,
      candlesMss: mssCandles,
    });
    const result = routeEntry(input);

    const atr = lastDefined(wilderATRSeries(trendCandles5m, RegimeConfig.ATR_PERIOD_5M));
    expect(atr).toBeDefined();
    const expectedSl = 9 - EntryConfig.SL_BUFFER_ATR_MULTIPLIER * (atr as number);

    expect(result).toEqual({
      side: 'LONG',
      entryPrice: 13, // mssCandles[11].close
      slPrice: expectedSl,
      setupType: 'OB',
      regime: MarketRegime.TREND_RIDER,
      riskMultiplier: 1.0,
    });
  });

  it('falls back to SWEEP (priority 3) when no OB or FVG exists, still gated by MSS', () => {
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'UP',
      candles5m: sweepOnlyCandles5m,
      candlesMss: mssCandles,
    });
    const result = routeEntry(input);

    const atr = lastDefined(wilderATRSeries(sweepOnlyCandles5m, RegimeConfig.ATR_PERIOD_5M));
    expect(atr).toBeDefined();
    const expectedSl = 3 - EntryConfig.SL_BUFFER_ATR_MULTIPLIER * (atr as number); // sweep candle's low (3)

    expect(result).toEqual({
      side: 'LONG',
      entryPrice: 13, // mssCandles[11].close
      slPrice: expectedSl,
      setupType: 'SWEEP',
      regime: MarketRegime.TREND_RIDER,
      riskMultiplier: 1.0,
    });
  });

  it('returns null when adxDirection1h is FLAT (no clear direction, no entry)', () => {
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'FLAT',
      candles5m: trendCandles5m,
      candlesMss: mssCandles,
    });
    expect(routeEntry(input)).toBeNull();
  });

  it('returns null when a zone is found but MSS has not confirmed yet', () => {
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'UP',
      candles5m: trendCandles5m,
      candlesMss: mssCandles.slice(0, 11), // MSS confirmation candle not included yet
    });
    expect(routeEntry(input)).toBeNull();
  });
});

describe('routeEntry — SIDEWAY_SCALPER / COMPRESSION (box breakout)', () => {
  it('produces a LONG DraftSetup on a confirmed box breakout for SIDEWAY_SCALPER', () => {
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });
    expect(routeEntry(input)).toEqual({
      side: 'LONG',
      entryPrice: 115,
      slPrice: 90, // box low
      setupType: 'BOX_BREAKOUT',
      regime: MarketRegime.SIDEWAY_SCALPER,
      riskMultiplier: 1.0,
    });
  });

  it('COMPRESSION stays "armed" (null) until a breakout actually confirms', () => {
    const input = baseInput({
      regime: MarketRegime.COMPRESSION,
      candles15m: box15m,
      candles5m: [c(103, 105, 106, 102)], // inside the box, no breakout
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });
    expect(routeEntry(input)).toBeNull();
  });

  it('COMPRESSION produces a DraftSetup once breakout confirms (same detector as SIDEWAY_SCALPER)', () => {
    const input = baseInput({
      regime: MarketRegime.COMPRESSION,
      candles15m: box15m,
      candles5m: [c(89, 85, 89.5, 84)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });
    expect(routeEntry(input)).toMatchObject({ side: 'SHORT', setupType: 'BOX_BREAKOUT', regime: MarketRegime.COMPRESSION });
  });
});

// TICKET-018 — extends the TICKET-017 macro trend filter to Box Breakout, gated behind a SECOND,
// independent flag (macroTrendFilterAppliesToBoxBreakout) on top of macroTrendFilterEnabled.
describe('routeEntry — Macro Trend Filter applied to Box Breakout (TICKET-018)', () => {
  it('blocks a SIDEWAY_SCALPER LONG breakout when both flags are on and macroDirection opposes it (DOWN)', () => {
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)], // breaks UP -> LONG
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
      macroDirection: 'DOWN',
    });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true, macroTrendFilterAppliesToBoxBreakout: true });
    expect(result).toBeNull();
  });

  it('does NOT block the same setup when macroTrendFilterAppliesToBoxBreakout is false (default — unchanged from TICKET-017)', () => {
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
      macroDirection: 'DOWN',
    });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true, macroTrendFilterAppliesToBoxBreakout: false });
    expect(result?.side).toBe('LONG');
  });

  it('does NOT block when macroTrendFilterEnabled is false, even if macroTrendFilterAppliesToBoxBreakout is true', () => {
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
      macroDirection: 'DOWN',
    });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: false, macroTrendFilterAppliesToBoxBreakout: true });
    expect(result?.side).toBe('LONG');
  });

  it('COMPRESSION stays "armed" (null, same as the un-confirmed-breakout case) when its breakout is blocked by the filter, not treated as a used-up opportunity', () => {
    const input = baseInput({
      regime: MarketRegime.COMPRESSION,
      candles15m: box15m,
      candles5m: [c(89, 85, 89.5, 84)], // breaks DOWN -> SHORT
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
      macroDirection: 'UP', // opposes the SHORT breakout
    });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true, macroTrendFilterAppliesToBoxBreakout: true });
    expect(result).toBeNull();
  });
});

// TICKET-036: re-enabled (TICKET-012 had it hard-disabled). routeEntry() now picks the same
// cascade TREND_RIDER/SIDEWAY_SCALPER use, per entryStyleForNeutral — the hard Momentum Gate that
// decides whether this DraftSetup is actually allowed through lives in orchestrator.ts, not here.
describe('routeEntry — NEUTRAL_TRANSITION re-enabled (TICKET-036)', () => {
  it('produces a LONG DraftSetup via OB+MSS (TREND_STYLE) when entryStyleForNeutral=TREND_STYLE', () => {
    const input = baseInput({
      regime: MarketRegime.NEUTRAL_TRANSITION,
      adxDirection1h: 'UP',
      candles5m: trendCandles5m,
      candlesMss: mssCandles,
    });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, entryStyleForNeutral: 'TREND_STYLE' });

    const atr = lastDefined(wilderATRSeries(trendCandles5m, RegimeConfig.ATR_PERIOD_5M));
    expect(atr).toBeDefined();
    const expectedSl = 9 - EntryConfig.SL_BUFFER_ATR_MULTIPLIER * (atr as number);

    expect(result).toEqual({
      side: 'LONG',
      entryPrice: 13,
      slPrice: expectedSl,
      setupType: 'OB',
      regime: MarketRegime.NEUTRAL_TRANSITION,
      riskMultiplier: 1.0, // TICKET-036: no more fixed 0.5 — gate replaces it
    });
  });

  it('returns null via TREND_STYLE when adxDirection1h is FLAT, same as TREND_RIDER would', () => {
    const input = baseInput({
      regime: MarketRegime.NEUTRAL_TRANSITION,
      adxDirection1h: 'FLAT',
      candles5m: trendCandles5m,
      candlesMss: mssCandles,
    });
    expect(routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, entryStyleForNeutral: 'TREND_STYLE' })).toBeNull();
  });

  it('produces a LONG DraftSetup on a confirmed box breakout when entryStyleForNeutral=SIDEWAY_STYLE (the config default)', () => {
    const input = baseInput({
      regime: MarketRegime.NEUTRAL_TRANSITION,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });
    expect(routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG)).toEqual({
      side: 'LONG',
      entryPrice: 115,
      slPrice: 90,
      setupType: 'BOX_BREAKOUT',
      regime: MarketRegime.NEUTRAL_TRANSITION,
      riskMultiplier: 1.0,
    });
  });

  it('returns null via SIDEWAY_STYLE when no breakout has confirmed yet, same as COMPRESSION would', () => {
    const input = baseInput({
      regime: MarketRegime.NEUTRAL_TRANSITION,
      candles15m: box15m,
      candles5m: [c(103, 105, 106, 102)], // inside the box, no breakout
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });
    expect(routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG)).toBeNull();
  });
});

describe('routeEntry — unmapped regimes return null, not an error', () => {
  it.each([
    MarketRegime.VOLATILE_CHOP,
    MarketRegime.DANGER_ZONE,
    MarketRegime.EVENT_RISK,
    MarketRegime.CORRELATED_RISK,
    MarketRegime.LOW_LIQUIDITY,
    MarketRegime.MANIPULATED,
  ])('%s -> null', (regime) => {
    expect(routeEntry(baseInput({ regime }))).toBeNull();
  });
});

// TICKET-011 — reproduces the real bug found in the 60-day backtest: a trade opened at an
// entryPrice up to ~85 minutes stale, because detectMarketStructureShift returns the FIRST
// confirming candle in the window, which can be an old historical point. Uses real timestamps
// (unlike the fixtures above, which all use timestamp: 0 and so never exercised this path).
describe('routeEntry — MSS staleness (TICKET-011)', () => {
  const FIVE_MIN = 300_000;
  const ONE_MIN = 60_000;
  const baseTs = Date.UTC(2024, 0, 1);

  function cTs(open: number, close: number, high: number, low: number, timestamp: number): CandleData {
    return { timestamp, open, close, high, low, volume: 100 };
  }

  const trendCandles5mTimed: CandleData[] = trendCandles5m.map((candle, i) => ({ ...candle, timestamp: baseTs + i * FIVE_MIN }));
  const obCandleIndex = 19; // 14 filler + pattern index 5 (the down candle)
  const zoneTimestamp = trendCandles5mTimed[obCandleIndex].timestamp;

  // Same "between" MSS pattern used elsewhere, as a reusable shape (12 candles, confirms at its own last index).
  const mssShape: Array<[number, number, number, number]> = [
    [9.5, 9.5, 10, 9],
    [9.25, 9.25, 10, 8.5],
    [7.5, 7.5, 9.5, 6],
    [9.25, 9.25, 10, 8.5],
    [9.5, 9.5, 10, 9],
    [10.5, 10.5, 12, 9],
    [9.25, 9.25, 10, 8.5],
    [9.5, 9.5, 10, 9],
    [8.75, 8.75, 9.5, 8],
    [9.25, 9.25, 10, 8.5],
    [9.5, 9.5, 10, 9],
    [12.5, 13, 13.2, 12.3], // confirms here (local index 11), close = 13
  ];

  function mssShapeAt(startTs: number): CandleData[] {
    return mssShape.map(([o, cl, h, l], i) => cTs(o, cl, h, l, startTs + i * ONE_MIN));
  }

  it('ignores an MSS confirmation that happened BEFORE the zone formed, using the one after it instead', () => {
    const oldConfirmation = mssShapeAt(zoneTimestamp - 20 * ONE_MIN); // entirely before the OB candle
    const freshConfirmation = mssShapeAt(zoneTimestamp + ONE_MIN); // after, ending at "now"
    const candlesMss = [...oldConfirmation, ...freshConfirmation];

    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5mTimed, candlesMss });
    const result = routeEntry(input);

    expect(result?.entryPrice).toBe(13); // freshConfirmation's close, not oldConfirmation's
  });

  it('rejects an MSS confirmation that is after the zone but too far from "now" (the actual bug)', () => {
    const confirmation = mssShapeAt(zoneTimestamp + ONE_MIN); // confirms 85+ min before "now" once staleFiller is appended
    const staleFiller = Array.from({ length: 6 }, (_, i) => cTs(9, 9, 9.5, 8.5, confirmation[confirmation.length - 1].timestamp + (i + 1) * ONE_MIN));
    const candlesMss = [...confirmation, ...staleFiller]; // confirmation is now 6 candles from the end (tolerance is 5)

    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5mTimed, candlesMss });
    const result = routeEntry(input);

    expect(result).toBeNull(); // stale — must NOT open a trade at the old price
  });

  it('accepts an MSS confirmation within the staleness tolerance window', () => {
    const confirmation = mssShapeAt(zoneTimestamp + ONE_MIN);
    const recentFiller = Array.from({ length: 3 }, (_, i) => cTs(9, 9, 9.5, 8.5, confirmation[confirmation.length - 1].timestamp + (i + 1) * ONE_MIN));
    const candlesMss = [...confirmation, ...recentFiller]; // confirmation is 3 candles from the end (within tolerance of 5)

    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5mTimed, candlesMss });
    const result = routeEntry(input);

    expect(result?.entryPrice).toBe(13);
  });
});

// TICKET-017 Phần A — mirrors detectOrderBlock/detectMarketStructureShift's own BEARISH test
// fixtures (orderBlock.test.ts / marketStructureShift.test.ts), padded with the same neutral
// filler used for the BULLISH fixtures above, so a SHORT setup exists to test the filter against.
const bearishTrendCandles5m: CandleData[] = [
  ...filler,
  c(9, 9, 10, 8),
  c(10.5, 10.5, 12, 9),
  c(9, 9, 10, 5), // swing low (5)
  c(10.5, 10.5, 12, 9),
  c(9, 9, 10, 8),
  c(9, 11, 11, 9), // OB candidate (up), zone [9, 11]
  c(11, 8, 11, 7.5),
  c(8, 4, 8.5, 4), // BOS confirmed, close 4 < 5
];
const bearishMssCandles: CandleData[] = [
  c(9.5, 9.5, 10, 9),
  c(9.75, 9.75, 10.5, 9),
  c(11.5, 11.5, 13, 10), // swing high #1 (13)
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(8, 8, 10, 6), // swing low BETWEEN the two highs (6)
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(10.5, 10.5, 12, 9), // swing high #2 (12) — lower-high vs index 2
  c(9.75, 9.75, 10.5, 9),
  c(9.5, 9.5, 10, 9),
  c(6.5, 5, 6.8, 4.8), // MSS confirmed here, close = 5
];

describe('routeEntry — Macro Trend Filter (TICKET-017 Phần A)', () => {
  it('blocks a LONG setup when enabled and macroDirection is DOWN (opposing the 1D trend)', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', macroDirection: 'DOWN', candles5m: trendCandles5m, candlesMss: mssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true });
    expect(result).toBeNull();
  });

  it('blocks a SHORT setup when enabled and macroDirection is UP (opposing the 1D trend)', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'DOWN', macroDirection: 'UP', candles5m: bearishTrendCandles5m, candlesMss: bearishMssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true });
    expect(result).toBeNull();
  });

  it('allows a LONG setup through when macroDirection is aligned (UP)', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', macroDirection: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true });
    expect(result?.side).toBe('LONG');
  });

  it('does not block when macroDirection is FLAT, regardless of side', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', macroDirection: 'FLAT', candles5m: trendCandles5m, candlesMss: mssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true });
    expect(result?.side).toBe('LONG');
  });

  it('does not block anything when macroTrendFilterEnabled is false, regardless of macroDirection', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', macroDirection: 'DOWN', candles5m: trendCandles5m, candlesMss: mssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: false });
    expect(result?.side).toBe('LONG');
  });
});

describe('routeEntry — OB disabled per symbol (TICKET-017 Phần B)', () => {
  it('skips OB and falls back to FVG/Sweep for a symbol in obDisabledSymbols (does not block the entry outright)', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, symbol: 'XRPUSDT', adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles });
    const withoutFilter = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG);
    expect(withoutFilter?.setupType).toBe('OB'); // sanity: this fixture really does produce an OB setup

    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, obDisabledSymbols: ['XRPUSDT'] });
    expect(result).not.toBeNull();
    expect(result?.setupType).not.toBe('OB'); // OB skipped — falls through to FVG (this fixture also contains a valid FVG)
  });

  it('does not disable OB for symbols not in obDisabledSymbols', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, symbol: 'BTCUSDT', adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles });
    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, obDisabledSymbols: ['XRPUSDT'] });
    expect(result?.setupType).toBe('OB'); // unaffected — BTCUSDT is not the disabled symbol
  });
});

// TICKET-042 — Entry Funnel Analytics: pure observability, routeEntry()'s decision logic must be
// byte-for-byte identical whether or not a caller passes onFunnelEvent.
describe('routeEntry — Entry Funnel Analytics (TICKET-042)', () => {
  function collect(): { events: FunnelEvent[]; onFunnelEvent: (symbol: string, timestamp: number, event: FunnelEvent) => void } {
    const events: FunnelEvent[] = [];
    return { events, onFunnelEvent: (_symbol, _timestamp, event) => events.push(event) };
  }

  it('fires SETUP(pass) -> MACRO(pass) -> MSS(pass) in that order for a fully successful TREND_STYLE setup', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).not.toBeNull(); // sanity: this fixture really does produce a DraftSetup
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: true },
      { stage: 'MSS', passed: true },
    ]);
  });

  it('fires only SETUP(fail, NO_SETUP_FOUND) when no OB/FVG/Sweep exists', () => {
    const { events, onFunnelEvent } = collect();
    // `filler` alone: 14 identical flat candles, never produces a fractal (per its own doc comment) -> no OB/FVG/Sweep.
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: filler, candlesMss: mssCandles });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([{ stage: 'SETUP', passed: false, reason: 'NO_SETUP_FOUND' }]);
  });

  it('fires SETUP(pass) -> MACRO(fail, MACRO_TREND_OPPOSITE) and stops there when the macro filter blocks', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', macroDirection: 'DOWN', candles5m: trendCandles5m, candlesMss: mssCandles });

    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true }, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: false, reason: 'MACRO_TREND_OPPOSITE' },
    ]);
  });

  // TICKET-043: mssCandles.slice(0, 11) has both the higher-low pair AND the reference high already
  // formed between them (same fixture as marketStructureShift.test.ts's own NEVER_BROKE_REFERENCE
  // case) — the confirming break candle (index 11) just hasn't happened yet in this window.
  it('fires SETUP(pass) -> MACRO(pass) -> MSS(fail, NEVER_BROKE_REFERENCE) when no reversal has confirmed yet', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'UP',
      candles5m: trendCandles5m,
      candlesMss: mssCandles.slice(0, 11), // MSS confirmation candle not included yet
    });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: true },
      { stage: 'MSS', passed: false, reason: 'NEVER_BROKE_REFERENCE' },
    ]);
  });

  it('fires SETUP(pass) -> MACRO(pass) -> MSS(fail, NO_HIGHER_LOW_PATTERN) when no higher-low pair ever forms', () => {
    const { events, onFunnelEvent } = collect();
    // Single swing low only (index 2, price 6) — no second low anywhere to compare against, so the
    // higher-low pattern itself can never be found (mirrors marketStructureShift.test.ts's own case).
    const noPatternMss: CandleData[] = [
      c(9.5, 9.5, 10, 9),
      c(9.25, 9.25, 10, 8.5),
      c(7.5, 7.5, 9.5, 6), // swing low #1 (6) — the only swing low in this window
      c(9.25, 9.25, 10, 8.5),
      c(9.5, 9.5, 10, 9),
    ];
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: noPatternMss });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: true },
      { stage: 'MSS', passed: false, reason: 'NO_HIGHER_LOW_PATTERN' },
    ]);
  });

  it('fires SETUP(pass) -> MACRO(pass) -> MSS(fail, NO_REFERENCE_BETWEEN) when the higher-low pair has no swing high between them', () => {
    const { events, onFunnelEvent } = collect();
    // Same fixture as marketStructureShift.test.ts's own NO_REFERENCE_BETWEEN case: higher-low pair
    // (A=6, B=6.5) forms, but no swing high exists between index 2 and index 5.
    const noReferenceMss: CandleData[] = [
      c(9.5, 9.5, 10, 9),
      c(9.25, 9.25, 10, 8.5),
      c(7.5, 7.5, 9.5, 6), // low A (6)
      c(9.25, 9.25, 10, 8.5),
      c(9.5, 9.5, 10, 9),
      c(8, 8, 9.5, 6.5), // low B (6.5, higher-low vs A) — no reference high between 2 and 5
      c(9.25, 9.25, 10, 8.5),
      c(9.5, 9.5, 10, 9),
    ];
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: noReferenceMss });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: true },
      { stage: 'MSS', passed: false, reason: 'NO_REFERENCE_BETWEEN' },
    ]);
  });

  // TICKET-044: candlesLate must equal candlesFromEnd (6) — the same value the staleness check itself compared against the tolerance.
  it('fires SETUP(pass) -> MACRO(pass) -> MSS(fail, MSS_TIMEOUT, candlesLate=6) when the confirmation is too stale', () => {
    const { events, onFunnelEvent } = collect();
    // mssCandles confirms at its own last index (candlesFromEnd=0) — append extra candles after it
    // so the confirmation is candlesFromEnd=6 positions from the end, past the default tolerance (5).
    const staleMssCandles = [...mssCandles, ...Array.from({ length: 6 }, () => c(9, 9, 9.5, 8.5))];
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: staleMssCandles });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([
      { stage: 'SETUP', passed: true, setupType: 'OB' },
      { stage: 'MACRO', passed: true },
      { stage: 'MSS', passed: false, reason: 'MSS_TIMEOUT', candlesLate: 6 },
    ]);
  });

  // TICKET-044: candlesLate must stay undefined for the 3 granular "never confirmed" reasons — only MSS_TIMEOUT sets it.
  it('leaves candlesLate undefined for the 3 granular MSS-not-confirmed reasons', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.TREND_RIDER,
      adxDirection1h: 'UP',
      candles5m: trendCandles5m,
      candlesMss: mssCandles.slice(0, 11), // NEVER_BROKE_REFERENCE case, per the earlier test
    });

    routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    const mssEvent = events.find((e) => e.stage === 'MSS');
    expect(mssEvent?.reason).toBe('NEVER_BROKE_REFERENCE');
    expect(mssEvent?.candlesLate).toBeUndefined();
  });

  it('fires BREAKOUT(pass) for a confirmed box breakout (SIDEWAY_SCALPER)', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)],
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).not.toBeNull();
    expect(events).toEqual([{ stage: 'BREAKOUT', passed: true }]);
  });

  // TICKET-053: 'NO_BREAKOUT_YET' replaced by classifyBoxBreakoutFailReason()'s 3 granular reasons —
  // only computed when a callback is listening, same opt-in pattern as classifyMssFailReason() (TICKET-043).
  it('fires BREAKOUT(fail, NO_EDGE_TOUCH) when COMPRESSION is still "armed" (close stays inside the box)', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.COMPRESSION,
      candles15m: box15m,
      candles5m: [c(103, 105, 106, 102)], // close 105 stays inside [90, 110], no breakout
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([{ stage: 'BREAKOUT', passed: false, reason: 'NO_EDGE_TOUCH' }]);
  });

  it('fires BREAKOUT(fail, BODY_TOO_SMALL) when close clears the box but the body is mostly wick', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(110.2, 110.8, 116, 110)], // close 110.8 > 110, but bodyRatio=0.6/6=0.1 < 0.5
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
    });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([{ stage: 'BREAKOUT', passed: false, reason: 'BODY_TOO_SMALL' }]);
  });

  it('fires BREAKOUT(fail, VOLUME_NOT_ELEVATED) when close clears the box + body is real but volume is not elevated', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)], // close 115 > 110, bodyRatio=4/5.5=0.73 >= 0.5
      bbWidthPercentile15m: 50,
      volumeZScore5m: 0.5, // below EntryConfig.BOX_BREAKOUT_MIN_VOLUME_ZSCORE
    });

    const result = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([{ stage: 'BREAKOUT', passed: false, reason: 'VOLUME_NOT_ELEVATED' }]);
  });

  it('fires BREAKOUT(fail, MACRO_TREND_OPPOSITE) when the box-breakout macro filter blocks (TICKET-018)', () => {
    const { events, onFunnelEvent } = collect();
    const input = baseInput({
      regime: MarketRegime.SIDEWAY_SCALPER,
      candles15m: box15m,
      candles5m: [c(111, 115, 116, 110.5)], // breaks UP -> LONG
      bbWidthPercentile15m: 50,
      volumeZScore5m: 1.5,
      macroDirection: 'DOWN',
    });

    const result = routeEntry(input, { ...DEFAULT_ENTRY_ROUTER_CONFIG, macroTrendFilterEnabled: true, macroTrendFilterAppliesToBoxBreakout: true }, onFunnelEvent);

    expect(result).toBeNull();
    expect(events).toEqual([{ stage: 'BREAKOUT', passed: false, reason: 'MACRO_TREND_OPPOSITE' }]);
  });

  // The single most important test in this ticket: omitting onFunnelEvent must reproduce the exact
  // pre-TICKET-042 result, byte-for-byte — proven by reusing the exact fixture/expectation from
  // 'routeEntry — TREND_RIDER (OB + MSS)' above, unmodified, called with no callback argument at all.
  it('produces the exact same result with onFunnelEvent omitted as every pre-existing test already relies on', () => {
    const input = baseInput({ regime: MarketRegime.TREND_RIDER, adxDirection1h: 'UP', candles5m: trendCandles5m, candlesMss: mssCandles });

    const withoutCallback = routeEntry(input);
    const { onFunnelEvent } = collect();
    const withCallback = routeEntry(input, DEFAULT_ENTRY_ROUTER_CONFIG, onFunnelEvent);

    expect(withoutCallback).toEqual(withCallback); // same DraftSetup regardless of observability
    expect(withoutCallback).toEqual({
      side: 'LONG',
      entryPrice: 13,
      slPrice: 9 - EntryConfig.SL_BUFFER_ATR_MULTIPLIER * (lastDefined(wilderATRSeries(trendCandles5m, RegimeConfig.ATR_PERIOD_5M)) as number),
      setupType: 'OB',
      regime: MarketRegime.TREND_RIDER,
      riskMultiplier: 1.0,
    });
  });
});
