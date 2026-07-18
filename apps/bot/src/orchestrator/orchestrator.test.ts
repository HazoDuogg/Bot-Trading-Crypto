import { describe, expect, it } from 'vitest';
import { processCandle, type ProcessCandleInput } from './orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../entry/entryRouter.js';
import { openPosition, type SlTpManagerInput } from '../risk/slTpManager.js';

function c(open: number, close: number, high: number, low: number, timestamp = 0): CandleData {
  return { timestamp, open, close, high, low, volume: 100 };
}

function makeCandles(
  count: number,
  intervalMs: number,
  priceAt: (i: number) => number,
  rangeAt: (i: number) => number,
  startTs: number = Date.UTC(2024, 0, 1),
): CandleData[] {
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

// Enough history for detectRegime() to not throw, regardless of what regime it lands on — used
// for step-3 (already-open-position) tests where the regime result itself is irrelevant.
function sufficientDummyCandles() {
  return {
    candles5m: makeCandles(320, 300_000, (i) => 100 + i * 0.001, () => 1),
    candles15m: makeCandles(325, 900_000, (i) => 100 + i * 0.001, () => 1),
    candles1h: makeCandles(40, 3_600_000, (i) => 100 + i * 0.001, () => 1),
    candles1m: makeCandles(50, 60_000, () => 100, () => 0.5),
    candles1d: makeCandles(30, 24 * 60 * 60_000, () => 100, () => 1),
  };
}

const baseConfig: OrchestratorConfig = {
  entryRouterConfig: DEFAULT_ENTRY_ROUTER_CONFIG,
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 20,
  maxMarginCap: 50,
  leverage: 30,
  riskPoolMaxPct: 0.1,
  isLowConfidenceOrLowLiquidity: false,
};

const trendLongInput: SlTpManagerInput = {
  scenario: 'TREND',
  entryPrice: 100,
  slPrice: 99, // R = 1
  side: 'LONG',
  tpPlan: 'PLAN_A',
  positionSize: 990,
  takerFeeRate: 0.0004,
};

function stateWithOpenPosition(position: ReturnType<typeof openPosition>): SymbolState {
  return {
    regimeState: { previousRegime: null, previousCandidateRegime: null, streakCount: 0 },
    openPosition: position,
    openMeta: {
      regime: MarketRegime.TREND_RIDER,
      setupType: 'OB',
      entryTimestamp: 0,
      actualRiskDollar: 10,
      marginRequired: 33.33,
      riskMultiplier: 1.0,
    },
  };
}

function baseInput(overrides: Partial<ProcessCandleInput> = {}): ProcessCandleInput {
  return {
    symbol: 'BTCUSDT',
    ...sufficientDummyCandles(),
    accountBalance: 400,
    otherOpenPositionsRisk: [],
    ...overrides,
  };
}

describe('processCandle — Step 3: managing an already-open TREND position', () => {
  it('SL-first rule: candle touching BOTH TP1 and current SL closes at SL, not TP1', () => {
    const pos = openPosition(trendLongInput); // TP1=101.2, SL=99
    const state = stateWithOpenPosition(pos);
    // candle range covers both 101.2 (TP1) and 99 (SL)
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100, 100, 102, 98)];

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'SL' });
  });

  it('fills TP1 (moves SL to breakeven+fee) when only TP1 is touched, position stays open', () => {
    const pos = openPosition(trendLongInput);
    const state = stateWithOpenPosition(pos);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100.5, 101.5, 101.6, 100.4)]; // touches TP1 (101.2), not SL (99)

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition?.closed).toBe(false);
    expect(result.symbolState.openPosition?.filledTiers).toContain('TP1');
    expect(result.symbolState.openPosition?.currentSlPrice).toBeGreaterThan(99); // moved to breakeven+fee
    expect(result.event).toBeNull();
  });

  it('fills TP2 (moves SL to TP1 price) once TP1 already filled and TP2 is touched', () => {
    const afterTp1 = openPosition(trendLongInput);
    const posAfterTp1 = { ...afterTp1, filledTiers: ['TP1' as const], currentSlPrice: 100.08, remainingPositionSize: 990 * 0.6 };
    const state = stateWithOpenPosition(posAfterTp1);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(102, 102.6, 102.7, 101.9)]; // touches TP2 (102.5)

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition?.closed).toBe(false);
    expect(result.symbolState.openPosition?.filledTiers).toContain('TP2');
    expect(result.symbolState.openPosition?.currentSlPrice).toBe(101.2); // TP1 price
    expect(result.event).toBeNull();
  });

  // TICKET-016: this SL is the post-TP1 breakeven+fee stop (TP1 already realized), not a raw loss
  // — must carry a distinct label from the pre-TP1 'SL' case above.
  it('closes with exitReason BREAKEVEN_SL when SL is touched after TP1 filled, before TP2', () => {
    const afterTp1 = openPosition(trendLongInput);
    const posAfterTp1 = { ...afterTp1, filledTiers: ['TP1' as const], currentSlPrice: 100.08, remainingPositionSize: 990 * 0.6 };
    const state = stateWithOpenPosition(posAfterTp1);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100, 100, 100.5, 100)]; // touches SL (100.08), not TP2 (102.5)

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'BREAKEVEN_SL' });
  });

  it('SL-first rule after TP1 filled: candle touching BOTH TP2 and SL closes at BREAKEVEN_SL, not TP2', () => {
    const afterTp1 = openPosition(trendLongInput);
    const posAfterTp1 = { ...afterTp1, filledTiers: ['TP1' as const], currentSlPrice: 100.08, remainingPositionSize: 990 * 0.6 };
    const state = stateWithOpenPosition(posAfterTp1);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100, 100, 103, 100)]; // covers both TP2 (102.5) and SL (100.08)

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'BREAKEVEN_SL' });
  });

  it('Runner phase: trails SL up on a favorable candle without closing', () => {
    const base = openPosition(trendLongInput);
    const runnerPos = { ...base, filledTiers: ['TP1' as const, 'TP2' as const], currentSlPrice: 101.2, remainingPositionSize: 990 * 0.3 };
    const state = stateWithOpenPosition(runnerPos);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(103, 104, 104.2, 102.9)]; // favorable move, doesn't touch SL

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition?.closed).toBe(false);
    expect(result.symbolState.openPosition?.currentSlPrice).toBeGreaterThanOrEqual(101.2); // ratchet, never loosens
    expect(result.event).toBeNull();
  });

  it('Runner phase: closes with exitReason RUNNER_SL when the (trailed) SL is touched', () => {
    const base = openPosition(trendLongInput);
    const runnerPos = { ...base, filledTiers: ['TP1' as const, 'TP2' as const], currentSlPrice: 101.2, remainingPositionSize: 990 * 0.3 };
    const state = stateWithOpenPosition(runnerPos);
    // candle drops straight through the existing Runner SL (101.2), no favorable move first
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(101, 100.5, 101.1, 100)];

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'RUNNER_SL' });
    expect((result.event as { accountBalanceAfter: number }).accountBalanceAfter).not.toBe(400); // balance updated by realized PNL
  });
});

describe('processCandle — Step 3: COUNTER_TREND position', () => {
  const counterTrendInput: SlTpManagerInput = { ...trendLongInput, scenario: 'COUNTER_TREND', slPrice: 99.3 };

  it('SL-first rule applies to COUNTER_TREND too when both TP and SL are touched in the same candle', () => {
    const pos = openPosition(counterTrendInput); // TP = 100.7, SL = 99.3
    const state = stateWithOpenPosition(pos);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100, 100, 100.8, 99.2)]; // touches both

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'SL' });
  });

  it('closes at COUNTER_TREND_TP (100% close, no tiers) when only the TP is touched', () => {
    const pos = openPosition(counterTrendInput);
    const state = stateWithOpenPosition(pos);
    const candles5m = [...sufficientDummyCandles().candles5m.slice(0, -1), c(100.3, 100.6, 100.8, 100.2)];

    const result = processCandle(baseInput({ candles5m }), state, baseConfig);

    expect(result.event).toMatchObject({ type: 'CLOSE', exitReason: 'COUNTER_TREND_TP' });
  });
});

describe('processCandle — no open position, entry pipeline wiring', () => {
  it('returns no event and stays flat when routeEntry finds nothing (regime/entry produce no setup)', () => {
    const result = processCandle(baseInput(), INITIAL_SYMBOL_STATE, baseConfig);
    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toBeNull();
    expect(result.accountBalance).toBe(400); // unchanged, no trade happened
  });

  // Full pipeline: 1h monotonic uptrend (-> high ADX, adxDirection1h=UP) + 5m range-spike tail
  // containing a real OB pattern (-> TREND_RIDER classifies, OB confirms) + 1m higher-low/mini-BOS
  // pattern starting at the OB candle's own timestamp (-> MSS confirms) should open a real LONG
  // position, going through detectRegime -> routeEntry -> DynamicRMarginSizer -> riskPool -> slTpManager.
  function fullOpenFlowFixture() {
    const candles1h = makeCandles(40, 3_600_000, (i) => 100 + i * 2, () => 1); // clean uptrend -> high ADX

    const fillerCount = 310; // ATR_PERIOD_5M(14) + ATR_PCT_LOOKBACK_5M(300) needs >=313 total 5m candles
    const filler5m = makeCandles(fillerCount, 300_000, () => 100, () => 0.5);
    const obPattern5m: CandleData[] = [
      c(99, 99, 100, 98),
      c(100.5, 100.5, 102, 99),
      c(103, 103, 105, 101), // swing high (105)
      c(101, 101, 102, 100),
      c(99, 99, 100, 98),
      c(101, 99, 101, 99), // OB candidate (down), zone [99, 101]
      c(99, 102, 102.5, 99),
      c(102, 106, 106, 101.5), // BOS confirmed, close 106 > 105
    ];
    const lastFillerTs = filler5m[filler5m.length - 1].timestamp;
    const obPatternWithTs = obPattern5m.map((candle, i) => ({ ...candle, timestamp: lastFillerTs + (i + 1) * 300_000 }));
    const candles5m = [...filler5m, ...obPatternWithTs];
    const obCandleIndex = fillerCount + 5; // the down candle in obPatternWithTs

    const candles15m = makeCandles(325, 900_000, () => 100, () => 1);

    // 1m MSS pattern (BULLISH, "between" logic per TICKET-009), timestamped from the OB candle onward.
    const mssStartTs = candles5m[obCandleIndex].timestamp;
    const mssPattern1m: CandleData[] = [
      c(99.5, 99.5, 100, 99),
      c(99.25, 99.25, 100, 98.5),
      c(97.5, 97.5, 99.5, 96), // swing low (96)
      c(99.25, 99.25, 100, 98.5),
      c(99.5, 99.5, 100, 99),
      c(100.5, 100.5, 102, 99), // swing high BETWEEN the two lows (102)
      c(99.25, 99.25, 100, 98.5),
      c(99.5, 99.5, 100, 99),
      c(98.75, 98.75, 99.5, 98), // higher-low vs the first low
      c(99.25, 99.25, 100, 98.5),
      c(99.5, 99.5, 100, 99),
      c(102.5, 103, 103.2, 102.3), // MSS confirmed here, close = 103
    ].map((candle, i) => ({ ...candle, timestamp: mssStartTs + i * 60_000 }));

    return { candles5m, candles15m, candles1h, candles1m: mssPattern1m };
  }

  it('opens a real LONG position via OB when regime=TREND_RIDER and MSS confirms', () => {
    const fixture = fullOpenFlowFixture();
    const result = processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.symbolState.regimeState.previousRegime).toBe(MarketRegime.TREND_RIDER);
    expect(result.event).toMatchObject({ type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', setupType: 'OB', regime: MarketRegime.TREND_RIDER });
    expect(result.symbolState.openPosition).not.toBeNull();
    expect(result.symbolState.openPosition?.side).toBe('LONG');
    expect(result.symbolState.openMeta?.actualRiskDollar).toBeGreaterThan(0);
    expect(result.symbolState.openMeta?.marginRequired).toBeLessThanOrEqual(baseConfig.maxMarginCap);
  });

  it('skips the entry (SKIPPED event, no position) when the risk pool is already full for other symbols', () => {
    const fixture = fullOpenFlowFixture();
    const result = processCandle(
      baseInput({ ...fixture, otherOpenPositionsRisk: [{ id: 'ETHUSDT', actualRiskDollar: 39 }] }), // pool cap = 10% * 400 = 40
      INITIAL_SYMBOL_STATE,
      baseConfig,
    );

    expect(result.symbolState.openPosition).toBeNull();
    expect(result.event).toMatchObject({ type: 'SKIPPED', reason: 'RISK_POOL_EXCEEDED' });
    expect(result.accountBalance).toBe(400);
  });
});
