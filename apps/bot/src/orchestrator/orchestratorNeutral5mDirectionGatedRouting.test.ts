/**
 * TICKET-131 — wiring-level tests for Neutral 5m Direction-Gated Setup Routing's integration into
 * tryOpenNewPosition() (orchestrator.ts), the NEUTRAL_TRANSITION-and-setupType!=='MOMENTUM_DIRECT'
 * block. Kept in its own file (not appended to orchestrator.test.ts) so
 * vi.mock('./neutral5mDirectionGatedRouting.js', ...) stays scoped to just these tests — the mock
 * only ever matters when config.neutral5mDirectionGatedRoutingEnabled===true AND
 * neutralTransitionGateConfig.neutralTransitionTradingEnabled===false AND regime===NEUTRAL_TRANSITION
 * with a non-MOMENTUM_DIRECT candidate, so it cannot affect any other test file.
 *
 * These tests deliberately do NOT re-verify the relaxed selector's own LONG/SHORT/NONE math (that's
 * neutral5mDirectionGatedRouting.test.ts's job) — they verify the WIRING: does the orchestrator only
 * consult the new routing when it should, does neutralTransitionTradingEnabled's own value stay
 * untouched, does an agreeing candidate still have to clear the existing AI gate, and is
 * tryMomentumDirect()/MOMENTUM_DIRECT completely unaffected.
 */
import { describe, expect, it, vi } from 'vitest';

const { computeDirection5mRelaxedMock } = vi.hoisted(() => ({ computeDirection5mRelaxedMock: vi.fn() }));
vi.mock('./neutral5mDirectionGatedRouting.js', () => ({ computeDirection5mRelaxed: computeDirection5mRelaxedMock }));

import { processCandle, type ProcessCandleInput } from './orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../xgbFilter/config.js';
import { detectRegime } from '../regime/regimeDetector.js';

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
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, // stays disabled — production default
  planAutoSelectionConfig: DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
  maxConcurrentPositionsPerSymbol: 1,
  momentumDirectEnabled: false,
  momentumDirectThreshold: 0.75,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 0.5,
  momentumDirectTpRMultiple: 2.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
};

// Same OB+MSS LONG pattern/grey-zone-1h NEUTRAL_TRANSITION fixture as orchestrator.test.ts's own
// TICKET-036 describe block (neutralTransitionFixture()) — routeEntry() builds a real LONG 'OB'
// DraftSetup in NEUTRAL_TRANSITION, so this test file exercises the exact candidate type TICKET-131 targets.
function neutralTransitionObFixture(): Omit<ProcessCandleInput, 'symbol' | 'accountBalance' | 'allOpenPositionsRisk'> {
  let prevClose = 100;
  const candles1h: CandleData[] = Array.from({ length: 40 }, (_, i) => {
    const close = 100 + Math.sin(i * 0.5) * 0.5 + i * 0.05;
    const open = i === 0 ? close : prevClose;
    const candle = { timestamp: i * 3_600_000, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 };
    prevClose = close;
    return candle;
  });

  const fillerCount = 310;
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
  const obCandleIndex = fillerCount + 5;

  const candles15m = makeCandles(325, 900_000, () => 100, () => 1);

  const mssStartTs = candles5m[obCandleIndex].timestamp;
  const mssPattern1m: CandleData[] = [
    c(99.5, 99.5, 100, 99),
    c(99.25, 99.25, 100, 98.5),
    c(97.5, 97.5, 99.5, 96),
    c(99.25, 99.25, 100, 98.5),
    c(99.5, 99.5, 100, 99),
    c(100.5, 100.5, 102, 99),
    c(99.25, 99.25, 100, 98.5),
    c(99.5, 99.5, 100, 99),
    c(98.75, 98.75, 99.5, 98),
    c(99.25, 99.25, 100, 98.5),
    c(99.5, 99.5, 100, 99),
    c(102.5, 103, 103.2, 102.3),
  ].map((candle, i) => ({ ...candle, timestamp: mssStartTs + i * 60_000 }));

  const candles1hMomentum = makeCandles(250, 3_600_000, (i) => 100 + i * 0.1, () => 1);
  const candles1d = makeCandles(30, 24 * 60 * 60_000, () => 100, () => 1);

  return { candles5m, candles15m, candles1h, candles1m: mssPattern1m, candles1hMomentum, candles1d };
}

function baseInput(): ProcessCandleInput {
  return { symbol: 'BTCUSDT', ...neutralTransitionObFixture(), accountBalance: 400, allOpenPositionsRisk: [] };
}

const neutralEntryRouterConfig = { ...DEFAULT_ENTRY_ROUTER_CONFIG, entryStyleForNeutral: 'TREND_STYLE' as const };

describe('tryOpenNewPosition — Neutral 5m Direction-Gated Routing wiring (TICKET-131)', () => {
  it('sanity: the fixture resolves to NEUTRAL_TRANSITION with a real LONG OB candidate', () => {
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

  it('both flags default (off): reproduces exact pre-TICKET-131 behavior — no event at all, computeDirection5mRelaxed never called', async () => {
    computeDirection5mRelaxedMock.mockReset();
    const config: OrchestratorConfig = { ...baseConfig, entryRouterConfig: neutralEntryRouterConfig }; // both neutralTransitionTradingEnabled and the new flag stay at their defaults (false/undefined)

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mRelaxedMock).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(0); // NOT SKIPPED — byte-identical to before this ticket
    expect(config.neutralTransitionGateConfig.neutralTransitionTradingEnabled).toBe(false); // never written to
  });

  it('routing flag on, neutralTransitionTradingEnabled still false: direction5m disagrees with the LONG candidate -> rejected exactly like before, computeDirection5mRelaxed IS consulted', async () => {
    computeDirection5mRelaxedMock.mockReset();
    computeDirection5mRelaxedMock.mockReturnValue({ direction5m: 'SHORT', structuralBreakDiagnostic: 'NONE' });
    const config: OrchestratorConfig = { ...baseConfig, entryRouterConfig: neutralEntryRouterConfig, neutral5mDirectionGatedRoutingEnabled: true };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mRelaxedMock).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(0); // rejected -> { event: null } path, same shape as the disabled case
    expect(config.neutralTransitionGateConfig.neutralTransitionTradingEnabled).toBe(false);
  });

  it('routing flag on, direction5m===NONE: candidate rejected (NONE never matches a defined side)', async () => {
    computeDirection5mRelaxedMock.mockReset();
    computeDirection5mRelaxedMock.mockReturnValue({ direction5m: 'NONE', structuralBreakDiagnostic: 'NONE' });
    const config: OrchestratorConfig = { ...baseConfig, entryRouterConfig: neutralEntryRouterConfig, neutral5mDirectionGatedRoutingEnabled: true };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(result.events).toHaveLength(0);
  });

  it('routing flag on, direction5m agrees (LONG) with the LONG candidate: falls through to the existing AI gate, which still independently rejects on an impossible threshold', async () => {
    computeDirection5mRelaxedMock.mockReset();
    computeDirection5mRelaxedMock.mockReturnValue({ direction5m: 'LONG', structuralBreakDiagnostic: 'LONG' });
    const config: OrchestratorConfig = {
      ...baseConfig,
      entryRouterConfig: neutralEntryRouterConfig,
      neutral5mDirectionGatedRoutingEnabled: true,
      neutralTransitionGateConfig: { neutralTransitionTradingEnabled: false, neutralTransitionMomentumGateThreshold: 1.01 }, // impossible to clear
    };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    // The routing let it through, but the UNMODIFIED AI gate below still independently rejects it —
    // this must surface as SKIPPED/NEUTRAL_GATE_REJECTED (proves the AI gate still runs, unweakened).
    expect(result.events[0]).toMatchObject({ type: 'SKIPPED', reason: 'NEUTRAL_GATE_REJECTED' });
  });

  it('routing flag on, direction5m agrees (LONG) AND the existing AI gate threshold is trivially cleared: trade actually opens as OB/LONG/NEUTRAL_TRANSITION', async () => {
    computeDirection5mRelaxedMock.mockReset();
    computeDirection5mRelaxedMock.mockReturnValue({ direction5m: 'LONG', structuralBreakDiagnostic: 'LONG' });
    const config: OrchestratorConfig = {
      ...baseConfig,
      entryRouterConfig: neutralEntryRouterConfig,
      neutral5mDirectionGatedRoutingEnabled: true,
      neutralTransitionGateConfig: { neutralTransitionTradingEnabled: false, neutralTransitionMomentumGateThreshold: 0 }, // always clears
    };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(result.events[0]).toMatchObject({ type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', setupType: 'OB', regime: MarketRegime.NEUTRAL_TRANSITION });
    expect(config.neutralTransitionGateConfig.neutralTransitionTradingEnabled).toBe(false); // still never written to, even on the accepted+opened path
  });

  it('neutralTransitionTradingEnabled=true (the original production path) never consults the new routing at all, regardless of the new flag', async () => {
    computeDirection5mRelaxedMock.mockReset();
    computeDirection5mRelaxedMock.mockReturnValue({ direction5m: 'SHORT', structuralBreakDiagnostic: 'NONE' }); // would reject LONG if (wrongly) consulted
    const config: OrchestratorConfig = {
      ...baseConfig,
      entryRouterConfig: neutralEntryRouterConfig,
      neutral5mDirectionGatedRoutingEnabled: true,
      neutralTransitionGateConfig: { neutralTransitionTradingEnabled: true, neutralTransitionMomentumGateThreshold: 0 },
    };

    const result = await processCandle(baseInput(), INITIAL_SYMBOL_STATE, config);

    expect(computeDirection5mRelaxedMock).not.toHaveBeenCalled();
    expect(result.events[0]).toMatchObject({ type: 'OPEN', side: 'LONG', setupType: 'OB', regime: MarketRegime.NEUTRAL_TRANSITION });
  });
});
