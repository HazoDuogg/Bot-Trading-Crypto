/**
 * TICKET-130 — wiring-level tests for the Neutral 5m Direction Selector's integration into
 * tryMomentumDirect() (orchestrator.ts). Kept in its own file (not appended to orchestrator.test.ts)
 * so vi.mock('./neutral5mDirectionSelector.js', ...) stays scoped to just these tests — the mock
 * only ever matters when config.neutral5mDirectionSelectorEnabled===true AND regime===NEUTRAL_TRANSITION
 * (both required before orchestrator.ts even calls computeDirection5m()), so it cannot affect any
 * other test file's real-selector-math behavior.
 *
 * These tests deliberately do NOT re-verify the selector's own LONG/SHORT/NONE math (that's
 * neutral5mDirectionSelector.test.ts's job) — they verify the WIRING: does the orchestrator call the
 * selector only when it should, and does it correctly reject only the disagreeing side.
 */
import { describe, expect, it, vi } from 'vitest';

const { computeDirection5mMock } = vi.hoisted(() => ({ computeDirection5mMock: vi.fn() }));
vi.mock('./neutral5mDirectionSelector.js', () => ({ computeDirection5m: computeDirection5mMock }));

import { processCandle, type ProcessCandleInput } from './orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../entry/entryRouter.js';
import {
  DEFAULT_MOMENTUM_FILTER_CONFIG,
  DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
} from '../xgbFilter/config.js';
import { detectRegime } from '../regime/regimeDetector.js';

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

const baseConfig: OrchestratorConfig = {
  entryRouterConfig: DEFAULT_ENTRY_ROUTER_CONFIG,
  tpPlan: 'PLAN_A',
  takerFeeRate: 0.0004,
  riskDollarOrPercent: 20,
  maxMarginCap: 50,
  leverage: 30,
  riskPoolMaxPct: 0.1,
  isLowConfidenceOrLowLiquidity: false,
  momentumFilterConfig: DEFAULT_MOMENTUM_FILTER_CONFIG,
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, // stays disabled throughout — cascade never fires
  planAutoSelectionConfig: DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
  maxConcurrentPositionsPerSymbol: 1,
  momentumDirectEnabled: true,
  momentumDirectThreshold: 0, // ALWAYS_CLEARS — real scores are always in [0,1]
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 0.5,
  momentumDirectTpRMultiple: 2.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
};

// Same "grey zone" 1h oscillation as orchestrator.test.ts's own NEUTRAL_TRANSITION fixture (neither
// <=SIDEWAY_ADX_THRESHOLD(20) nor persistently >=TREND_ENTER_ADX(32)) combined with the flat,
// featureless 5m/15m/1m used by the MOMENTUM_DIRECT describe block there (no OB/FVG/Sweep anywhere,
// so the cascade finds nothing regardless — isolates this test to tryMomentumDirect() only).
function neutralMomentumDirectFixture(): Omit<ProcessCandleInput, 'symbol' | 'accountBalance' | 'allOpenPositionsRisk'> {
  let prevClose = 100;
  const candles1h: CandleData[] = Array.from({ length: 40 }, (_, i) => {
    const close = 100 + Math.sin(i * 0.5) * 0.5 + i * 0.05;
    const open = i === 0 ? close : prevClose;
    const candle = { timestamp: i * 3_600_000, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 };
    prevClose = close;
    return candle;
  });

  const candles5m = makeCandles(320, 300_000, () => 100, () => 0.5);
  const candles15m = makeCandles(325, 900_000, () => 100, () => 1);
  const candles1m = makeCandles(50, 60_000, () => 100, () => 0.5);
  const fullCandles1h = makeCandles(250, 3_600_000, (i) => 100 + i * 2, () => 1);

  return { candles5m, candles15m, candles1h, candles1m, candles1d: makeCandles(30, 24 * 60 * 60_000, () => 100, () => 1), candles1hMomentum: fullCandles1h };
}

function baseInput(): ProcessCandleInput {
  return { symbol: 'BTCUSDT', ...neutralMomentumDirectFixture(), accountBalance: 400, allOpenPositionsRisk: [] };
}

// TREND_RIDER fixture (from orchestrator.test.ts's own MOMENTUM_DIRECT describe block) — used only
// to prove the selector is NEVER consulted outside NEUTRAL_TRANSITION.
function trendRiderMomentumDirectFixture(): ProcessCandleInput {
  const fullCandles1h = makeCandles(250, 3_600_000, (i) => 100 + i * 2, () => 1);
  const candles1h = fullCandles1h.slice(-40);
  const candles5m = makeCandles(320, 300_000, () => 100, () => 0.5);
  const candles15m = makeCandles(325, 900_000, () => 100, () => 1);
  const candles1m = makeCandles(50, 60_000, () => 100, () => 0.5);
  return {
    symbol: 'BTCUSDT',
    candles5m,
    candles15m,
    candles1h,
    candles1m,
    candles1d: makeCandles(30, 24 * 60 * 60_000, () => 100, () => 1),
    candles1hMomentum: fullCandles1h,
    accountBalance: 400,
    allOpenPositionsRisk: [],
  };
}

describe('tryMomentumDirect — Neutral 5m Direction Selector wiring (TICKET-130)', () => {
  it('sanity: the NEUTRAL fixture really resolves to NEUTRAL_TRANSITION', () => {
    const input = baseInput();
    const regimeOutput = detectRegime({
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      candles1h: input.candles1h,
      previousRegime: null,
      previousCandidateRegime: null,
      streakCount: 0,
      previousDangerZoneTimestamp: null,
    });
    expect(regimeOutput.regime).toBe(MarketRegime.NEUTRAL_TRANSITION);
  });

  it('selector disabled (flag undefined): computeDirection5m is never called, both sides gated only by the AI threshold as before', async () => {
    computeDirection5mMock.mockReset();
    const config: OrchestratorConfig = { ...baseConfig }; // neutral5mDirectionSelectorEnabled omitted -> undefined
    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mMock).not.toHaveBeenCalled();
    expect(result.events[0]).toMatchObject({ type: 'OPEN', setupType: 'MOMENTUM_DIRECT', regime: MarketRegime.NEUTRAL_TRANSITION });
  });

  it('selector enabled + direction5m=LONG: SHORT candidate is rejected, LONG passes through unchanged', async () => {
    computeDirection5mMock.mockReset();
    computeDirection5mMock.mockReturnValue('LONG');
    const config: OrchestratorConfig = { ...baseConfig, neutral5mDirectionSelectorEnabled: true };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mMock).toHaveBeenCalledTimes(1);
    // Both LONG and SHORT clear the AI threshold=0 in this fixture; only LONG may survive the veto.
    expect(result.events[0]).toMatchObject({ type: 'OPEN', side: 'LONG', setupType: 'MOMENTUM_DIRECT', regime: MarketRegime.NEUTRAL_TRANSITION });
  });

  it('selector enabled + direction5m=SHORT: LONG candidate is rejected, SHORT passes through unchanged', async () => {
    computeDirection5mMock.mockReset();
    computeDirection5mMock.mockReturnValue('SHORT');
    const config: OrchestratorConfig = { ...baseConfig, neutral5mDirectionSelectorEnabled: true };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(result.events[0]).toMatchObject({ type: 'OPEN', side: 'SHORT', setupType: 'MOMENTUM_DIRECT', regime: MarketRegime.NEUTRAL_TRANSITION });
  });

  it('selector enabled + direction5m=NONE: existing NEUTRAL behavior unchanged (no rejection at all — higher-score side wins as before)', async () => {
    computeDirection5mMock.mockReset();
    computeDirection5mMock.mockReturnValue('NONE');
    const config: OrchestratorConfig = { ...baseConfig, neutral5mDirectionSelectorEnabled: true };
    const configDisabled: OrchestratorConfig = { ...baseConfig }; // control: selector fully off

    const resultWithSelector = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);
    const resultWithoutSelector = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, configDisabled);

    expect(resultWithSelector.events[0]).toMatchObject(resultWithoutSelector.events[0] as object);
  });

  it('regime !== NEUTRAL_TRANSITION (TREND_RIDER): computeDirection5m is never called even with the flag enabled', async () => {
    computeDirection5mMock.mockReset();
    computeDirection5mMock.mockReturnValue('SHORT'); // would reject LONG if it were (wrongly) consulted
    const config: OrchestratorConfig = { ...baseConfig, neutral5mDirectionSelectorEnabled: true };

    const result = await processCandle(trendRiderMomentumDirectFixture(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mMock).not.toHaveBeenCalled();
    // Sanity: this fixture's known winning side (see orchestrator.test.ts's MOMENTUM_DIRECT block) is
    // SHORT even in TREND_RIDER — proves the mock's 'SHORT' return value had no effect either way,
    // since it's never even invoked outside NEUTRAL_TRANSITION.
    expect(result.events[0]).toMatchObject({ type: 'OPEN', setupType: 'MOMENTUM_DIRECT', regime: MarketRegime.TREND_RIDER });
  });

  it('selector never itself enables NEUTRAL_TRANSITION trading: neutralTransitionGateConfig.neutralTransitionTradingEnabled stays exactly as configured (false, the default) even with the selector on', async () => {
    computeDirection5mMock.mockReset();
    computeDirection5mMock.mockReturnValue('LONG');
    const config: OrchestratorConfig = { ...baseConfig, neutral5mDirectionSelectorEnabled: true };
    expect(config.neutralTransitionGateConfig.neutralTransitionTradingEnabled).toBe(false);

    // The only way the cascade's own NEUTRAL_TRANSITION gate could fire is via routeEntry() finding
    // an OB/FVG/Sweep/BoxBreakout setup AND neutralTransitionTradingEnabled being true — this
    // fixture has no such pattern at all, and the config field is never mutated by the selector.
    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(config.neutralTransitionGateConfig.neutralTransitionTradingEnabled).toBe(false); // unchanged after the call
    // The only OPEN event present, if any, is MOMENTUM_DIRECT — never a cascade setupType (OB/FVG/BOX_BREAKOUT/SWEEP).
    for (const event of result.events) {
      if (event.type === 'OPEN') expect(event.setupType).toBe('MOMENTUM_DIRECT');
    }
  });
});
