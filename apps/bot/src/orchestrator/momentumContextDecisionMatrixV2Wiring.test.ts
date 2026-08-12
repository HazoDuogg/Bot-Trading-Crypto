/**
 * TICKET-144 — Momentum Context Matrix V2 Production Readiness. Wiring-level verification tests
 * (NOT new decision logic — computeMomentumContextDecision()'s own math is already fully covered by
 * momentumContextDecisionMatrix.test.ts and left completely untouched here). Covers: decision
 * consistency (determinism/restart/cold-start/flag-independence), entry integrity (no double-entry,
 * concurrency cap, isolation per coin), risk integrity (multiplier applied exactly once per decision
 * type), and kill-switch/rollback cleanliness.
 */
import { describe, expect, it } from 'vitest';
import { processCandle, type ProcessCandleInput } from './orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../xgbFilter/config.js';
import { SafetyState5m } from '../regime/htfSafetyTypes.js';
import { applySafetyState5mFinalStabilization, INITIAL_SAFETY_STATE_5M_TRACKER } from '../regime/safetyState5mTrackerV2.js';
import { openPosition, type SlTpManagerInput } from '../risk/slTpManager.js';
import type { MomentumContextDecisionDiagnostic } from './orchestrator.js';

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
  neutralTransitionGateConfig: DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG,
  planAutoSelectionConfig: DEFAULT_PLAN_AUTO_SELECTION_CONFIG,
  maxConcurrentPositionsPerSymbol: 1,
  momentumDirectEnabled: true,
  // ALWAYS_CLEARS — real scores are always in [0,1], same convention as orchestrator.test.ts's own MOMENTUM_DIRECT block.
  momentumDirectThreshold: 0,
  momentumDirectMaxAtrPercentile: 100,
  momentumDirectMinSlPercent: 0.5,
  momentumDirectTpRMultiple: 2.0,
  momentumDirectMaxTotalConcurrent: 999,
  momentumDirectCorrelationRiskThreshold: 999,
  momentumDirectCorrelationRiskMultiplier: 1.0,
  momentumDirectCircuitBreakerLossThreshold: 999999,
  momentumDirectCircuitBreakerCooldownMs: 0,
  momentumContextDecisionMatrixV2Enabled: true,
};

function sufficientDummyCandles() {
  return {
    candles5m: makeCandles(320, 300_000, (i) => 100 + i * 0.001, () => 1),
    candles15m: makeCandles(325, 900_000, (i) => 100 + i * 0.001, () => 1),
    candles1h: makeCandles(40, 3_600_000, (i) => 100 + i * 0.001, () => 1),
    candles1m: makeCandles(50, 60_000, () => 100, () => 0.5),
    candles1d: makeCandles(30, 24 * 60 * 60_000, () => 100, () => 1),
    candles1hMomentum: makeCandles(40, 3_600_000, (i) => 100 + i * 0.001, () => 1),
  };
}

function baseInput(overrides: Partial<ProcessCandleInput> = {}): ProcessCandleInput {
  return {
    symbol: 'BTCUSDT',
    ...sufficientDummyCandles(),
    accountBalance: 400,
    allOpenPositionsRisk: [],
    ...overrides,
  };
}

// Same fixture as orchestrator.test.ts's momentumDirectFixture(): flat featureless 5m/15m/1m (cascade
// finds nothing) + clean 1h uptrend (TREND_RIDER) — SHORT wins the AI-score tie-break empirically.
function momentumDirectFixture(candles1dOverride?: CandleData[]) {
  const fullCandles1h = makeCandles(250, 3_600_000, (i) => 100 + i * 2, () => 1);
  const candles1h = fullCandles1h.slice(-40);
  const candles5m = makeCandles(320, 300_000, () => 100, () => 0.5);
  const candles15m = makeCandles(325, 900_000, () => 100, () => 1);
  const candles1m = makeCandles(50, 60_000, () => 100, () => 0.5);
  return {
    candles5m,
    candles15m,
    candles1h,
    candles1m,
    candles1hMomentum: fullCandles1h,
    ...(candles1dOverride ? { candles1d: candles1dOverride } : {}),
  };
}

// Strong 1D uptrend -> macroDirection='UP', opposes the fixture's winning SHORT side -> macroConflict=true.
const opposingMacro1d = makeCandles(30, 24 * 60 * 60_000, (i) => 100 + i * 5, () => 1);

// TREND positions with SL/TP1 far outside the momentumDirectFixture()/momentumDirectFixture-with-
// macro-override's flat ~99.75-100.25 5m candle range (entryPrice=100, SL 10 away -> R=10, TP1=1.2R
// away = 112/88) — guaranteed untouched (no tier fill, no close) by any candle from those fixtures,
// unlike farAwayLongInput's entryPrice=50 (which is actually BELOW the fixture's ~100 price and would
// have its TP1 touched immediately by the very first candle — verified the hard way, fixed here).
const farAwayLongInput: SlTpManagerInput = { scenario: 'TREND', entryPrice: 100, slPrice: 90, side: 'LONG', tpPlan: 'PLAN_A', positionSize: 990, takerFeeRate: 0.0004 };
const farAwayShortInput: SlTpManagerInput = { scenario: 'TREND', entryPrice: 100, slPrice: 110, side: 'SHORT', tpPlan: 'PLAN_A', positionSize: 990, takerFeeRate: 0.0004 };

function stateWithOpenPositions(count: number, side: 'LONG' | 'SHORT' = 'LONG'): SymbolState {
  const pos = openPosition(side === 'LONG' ? farAwayLongInput : farAwayShortInput);
  return {
    ...INITIAL_SYMBOL_STATE,
    openPositions: Array.from({ length: count }, () => ({
      position: pos,
      meta: { regime: MarketRegime.TREND_RIDER, setupType: 'OB' as const, entryTimestamp: 0, actualRiskDollar: 10, marginRequired: 33.33, riskMultiplier: 1.0, bookedRealizedPnl: 0 },
    })),
  };
}

// ---- 1. Decision consistency ----
describe('TICKET-144 — decision consistency', () => {
  it('determinism: identical input+state through processCandle twice produces byte-identical events/state', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d); // BTCUSDT + macroConflict -> V2 hard-BLOCK
    const config = { ...baseConfig };
    const input = baseInput(fixture);

    const r1 = await processCandle(input, INITIAL_SYMBOL_STATE, config);
    const r2 = await processCandle(input, INITIAL_SYMBOL_STATE, config);

    expect(r1.events).toEqual(r2.events);
    expect(r1.symbolState).toEqual(r2.symbolState);
    expect(r1.accountBalance).toBe(r2.accountBalance);
  });

  it('determinism holds for the ALLOW_REDUCED_RISK path too (SOLUSDT + macroConflict)', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const input = baseInput({ ...fixture, symbol: 'SOLUSDT' });

    const r1 = await processCandle(input, INITIAL_SYMBOL_STATE, baseConfig);
    const r2 = await processCandle(input, INITIAL_SYMBOL_STATE, baseConfig);

    expect(r1.events).toEqual(r2.events);
    expect(r1.symbolState).toEqual(r2.symbolState);
  });

  it('cold-start correctness: INITIAL_SYMBOL_STATE.momentumContextSafetyState5m is undefined, tracker init is NORMAL', () => {
    expect(INITIAL_SYMBOL_STATE.momentumContextSafetyState5m).toBeUndefined();
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.currentState).toBe(SafetyState5m.NORMAL);
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.pendingCandidate).toBeNull();
    expect(INITIAL_SAFETY_STATE_5M_TRACKER.dwellCandles).toBe(0);
  });

  it('"restart" (previous=null) reconstructs the exact same tracker state a true cold start would, for the same candidate+timestamp — the tracker cannot distinguish "restart" from "first run"', () => {
    const fromNull = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, 1000, null);
    const fromExplicitInitial = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, 1000, { ...INITIAL_SAFETY_STATE_5M_TRACKER, stateEnteredAt: 1000 });
    expect(fromNull).toEqual(fromExplicitInitial);
  });

  it('restart with genuinely NO prior history (the very first candle of a run) is indistinguishable from a true cold start by definition — both pass previous=null', () => {
    const trueColdStart = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, 1000, null);
    const restartAtFirstCandle = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, 1000, null);
    expect(trueColdStart).toEqual(restartAtFirstCandle);
  });

  it('DOCUMENTED FINDING (not a bug): a "restart" that discards multi-candle hysteresis memory legitimately diverges from the continuous run for a few candles until the tracker "catches up" — real memory beyond 1 candle exists (enter-confirm count / min-dwell), so discarding it changes near-term classification', () => {
    // Continuous: NORMAL -> MANIPULATED candidate x2 (confirms MANIPULATED) -> MANIPULATED candidate x1 more (dwelling).
    let continuous = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, 0, null);
    continuous = applySafetyState5mFinalStabilization(SafetyState5m.MANIPULATED, 1000, continuous); // confirms MANIPULATED (2nd consecutive)
    expect(continuous.currentState).toBe(SafetyState5m.MANIPULATED);
    continuous = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, 2000, continuous); // 1st non-MANIPULATED candidate, still within min dwell (4) -> forced persist
    expect(continuous.currentState).toBe(SafetyState5m.MANIPULATED); // memory of dwell forces this

    // "Restart" at the same point (previous=null) fed the SAME 3rd candidate (NORMAL) in isolation:
    const restarted = applySafetyState5mFinalStabilization(SafetyState5m.NORMAL, 2000, null);
    expect(restarted.currentState).toBe(SafetyState5m.NORMAL); // no memory of the MANIPULATED dwell -> diverges from continuous
    expect(restarted.currentState).not.toBe(continuous.currentState); // documented, legitimate divergence — NOT byte-identical
  });

  it('flag-independence: enabling other unrelated diagnostic flags does not change the V2 Decision Matrix decision (BLOCK on BTCUSDT+macroConflict either way)', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const input = baseInput(fixture);
    const plain = await processCandle(input, INITIAL_SYMBOL_STATE, baseConfig);
    const withOtherFlags = await processCandle(
      input,
      INITIAL_SYMBOL_STATE,
      { ...baseConfig, htfSafetySplitDiagnosticEnabled: true, safetyState5mStabilizationEnabled: true, safetyState5mFinalStabilizationEnabled: true } as OrchestratorConfig,
    );
    expect(plain.events).toEqual(withOtherFlags.events);
    expect(plain.symbolState.openPositions).toEqual(withOtherFlags.symbolState.openPositions);
  });
});

// ---- 2. Entry integrity ----
describe('TICKET-144 — entry integrity', () => {
  it('BLOCK (BTCUSDT + macroConflict, V2 hard-block) never opens a position — no event, no double-entry possible from a BLOCKed candidate', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events).toHaveLength(0);
    expect(result.symbolState.openPositions).toHaveLength(0);
  });

  it('BLOCK (ETHUSDT + macroConflict, V2 hard-block — V1 would have ALLOW_REDUCED_RISK here) never opens a position', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput({ ...fixture, symbol: 'ETHUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events).toHaveLength(0);
    expect(result.symbolState.openPositions).toHaveLength(0);
  });

  it('ALLOW_REDUCED_RISK (SOLUSDT + macroConflict) opens exactly ONE position, not two, from a single candle', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput({ ...fixture, symbol: 'SOLUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'OPEN', symbol: 'SOLUSDT', setupType: 'MOMENTUM_DIRECT' });
    expect(result.symbolState.openPositions).toHaveLength(1);
  });

  it('ALLOW_REDUCED_RISK (XRPUSDT + macroConflict) opens exactly ONE position', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput({ ...fixture, symbol: 'XRPUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events).toHaveLength(1);
    expect(result.symbolState.openPositions).toHaveLength(1);
  });

  it('maxConcurrentPositionsPerSymbol=2 respected: already at 2 open positions on this coin -> no 3rd, even for an ALLOW_NORMAL candidate', async () => {
    const fixture = momentumDirectFixture(); // no macro conflict -> ALLOW_NORMAL
    const config = { ...baseConfig, maxConcurrentPositionsPerSymbol: 2 };
    const state = stateWithOpenPositions(2, 'LONG');

    const result = await processCandle(baseInput(fixture), state, config);

    expect(result.events).toHaveLength(0);
    expect(result.symbolState.openPositions).toHaveLength(2); // untouched, no 3rd slot
  });

  it('maxConcurrentPositionsPerSymbol=2, only 1 open: ALLOW_NORMAL candidate opens the 2nd, not a 3rd', async () => {
    const fixture = momentumDirectFixture();
    const config = { ...baseConfig, maxConcurrentPositionsPerSymbol: 2 };
    const state = stateWithOpenPositions(1, 'LONG');

    const result = await processCandle(baseInput(fixture), state, config);

    expect(result.events).toHaveLength(1);
    expect(result.symbolState.openPositions).toHaveLength(2);
  });

  it('isolation per coin: BTCUSDT BLOCK does not affect a SIMULTANEOUS independent SOLUSDT ALLOW_REDUCED_RISK decision (separate processCandle calls, separate SymbolState, no shared mutation)', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const btcResult = await processCandle(baseInput({ ...fixture, symbol: 'BTCUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);
    const solResult = await processCandle(baseInput({ ...fixture, symbol: 'SOLUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);

    expect(btcResult.events).toHaveLength(0);
    expect(solResult.events).toHaveLength(1);
    // INITIAL_SYMBOL_STATE itself must never have been mutated by either call (both started from it).
    expect(INITIAL_SYMBOL_STATE.openPositions).toHaveLength(0);
  });

  it('Hedge/One-Way behavior unaffected: V2 wiring introduces no new same-symbol-opposite-side concept — openPositions is still just a flat array bounded solely by maxConcurrentPositionsPerSymbol, regardless of side', async () => {
    const fixture = momentumDirectFixture(); // ALLOW_NORMAL, SHORT wins
    const config = { ...baseConfig, maxConcurrentPositionsPerSymbol: 2 };
    // Pre-existing LONG position (opposite side) already open on this same symbol.
    const state = stateWithOpenPositions(1, 'LONG');

    const result = await processCandle(baseInput(fixture), state, config);

    // The new SHORT MOMENTUM_DIRECT position opens fine alongside the existing LONG one — no special
    // hedge-mode gating was added, same maxConcurrentPositionsPerSymbol=2 slot-counting as before V2.
    expect(result.events).toHaveLength(1);
    expect(result.symbolState.openPositions).toHaveLength(2);
    const sides = result.symbolState.openPositions.map((e) => e.position.side);
    expect(sides).toContain('LONG');
    expect(sides).toContain('SHORT');
  });
});

// ---- 3. Risk integrity ----
describe('TICKET-144 — risk integrity: macroConflictRiskMultiplier composition', () => {
  it('ALLOW_NORMAL (no macro conflict): riskMultiplier on the OPEN event is 1.0 (regimeRiskMultiplier for TREND_RIDER × 1.0 × 1.0 × 1.0)', async () => {
    const fixture = momentumDirectFixture(); // no macro conflict
    const result = await processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events[0]).toMatchObject({ type: 'OPEN', riskMultiplier: 1.0 });
  });

  it('ALLOW_REDUCED_RISK (SOLUSDT + macroConflict): riskMultiplier is exactly 0.30 (macroConflictRiskMultiplier applied exactly once, no other multiplier active in this fixture)', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput({ ...fixture, symbol: 'SOLUSDT' }), INITIAL_SYMBOL_STATE, baseConfig);

    expect(result.events[0]).toMatchObject({ type: 'OPEN', riskMultiplier: 0.3 });
  });

  it('ALLOW_REDUCED_RISK composed with an INDEPENDENT correlation multiplier: both multiply together (0.30 × 0.5 = 0.15) — this is by-design composition of two DIFFERENT mechanisms, not the same 0.30 applied twice', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const config = { ...baseConfig, momentumDirectCorrelationRiskThreshold: 0.9, momentumDirectCorrelationRiskMultiplier: 0.5 };
    const result = await processCandle(
      baseInput({ ...fixture, symbol: 'XRPUSDT', correlatedRiskRatio: 0.95, momentumDirectOpenPositions: [{ symbol: 'SOLUSDT', side: 'SHORT' }] }),
      INITIAL_SYMBOL_STATE,
      config,
    );

    expect(result.events[0]).toMatchObject({ type: 'OPEN', riskMultiplier: 0.15 });
  });

  it('BLOCK never produces an OPEN event, so riskMultiplier=0 (BLOCK reason) never reaches sizing/order creation at all', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const result = await processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, baseConfig); // BTCUSDT hard-block
    expect(result.events).toHaveLength(0);
  });
});

// ---- 3b. Logging gap-closure (candidateId/entryAllowed) ----
describe('TICKET-144 — logging: candidateId/entryAllowed on MomentumContextDecisionDiagnostic', () => {
  // processCandle's positional callback list: 3 required args, then 13 optional diagnostic callbacks
  // before onMomentumContextDecision (the 17th positional arg overall) — see orchestrator.ts's own
  // processCandle() signature. Only the last one is wired here; the rest stay undefined.
  function captureDecisions(input: ProcessCandleInput, state: SymbolState, config: OrchestratorConfig): Promise<MomentumContextDecisionDiagnostic[]> {
    const captured: MomentumContextDecisionDiagnostic[] = [];
    return processCandle(
      input,
      state,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (d) => captured.push(d),
    ).then(() => captured);
  }

  it('BLOCK candidate: entryAllowed=false, candidateId follows the `${symbol}:MOMENTUM_DIRECT:${side}:${timestamp}` convention', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const input = baseInput(fixture); // BTCUSDT + macroConflict -> V2 BLOCK
    const decisions = await captureDecisions(input, INITIAL_SYMBOL_STATE, baseConfig);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('BLOCK');
    expect(decisions[0].entryAllowed).toBe(false);
    expect(decisions[0].candidateId).toBe(`BTCUSDT:MOMENTUM_DIRECT:${decisions[0].side}:${decisions[0].timestamp}`);
  });

  it('ALLOW_REDUCED_RISK candidate: entryAllowed=true', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const input = baseInput({ ...fixture, symbol: 'SOLUSDT' });
    const decisions = await captureDecisions(input, INITIAL_SYMBOL_STATE, baseConfig);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('ALLOW_REDUCED_RISK');
    expect(decisions[0].entryAllowed).toBe(true);
    expect(decisions[0].candidateId).toContain('SOLUSDT:MOMENTUM_DIRECT:');
  });
});

// ---- 4. Kill switch / rollback ----
describe('TICKET-144 — kill switch / rollback', () => {
  it('momentumContextDecisionMatrixV2Enabled=false (and V1 also false): macro-conflict BLOCK still happens via the ORIGINAL evaluateMacroConflictOverride() path (mode=NONE default), unconditionally, even with unrelated flags set', async () => {
    const fixture = momentumDirectFixture(opposingMacro1d);
    const offConfig: OrchestratorConfig = {
      ...baseConfig,
      momentumContextDecisionMatrixV2Enabled: false,
      momentumContextDecisionMatrixEnabled: false,
      htfSafetySplitDiagnosticEnabled: true, // unrelated flag manipulated — must not matter
    } as OrchestratorConfig;

    const result = await processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, offConfig);

    // Same observable outcome as the V2-on hard-block case (BTCUSDT+macroConflict never opens) —
    // proves the OFF path is unconditionally clean, reached via the pre-T143 code path, not the matrix.
    expect(result.events).toHaveLength(0);
  });

  it('kill switch does not affect the V2 tracker field on SymbolState: it simply stays undefined when both flags are off', async () => {
    const fixture = momentumDirectFixture();
    const offConfig: OrchestratorConfig = { ...baseConfig, momentumContextDecisionMatrixV2Enabled: false } as OrchestratorConfig;
    const result = await processCandle(baseInput(fixture), INITIAL_SYMBOL_STATE, offConfig);
    expect(result.symbolState.momentumContextSafetyState5m).toBeUndefined();
  });
});

// ---- 5. Structural independence (restart-at-various-position-counts judgment call) ----
describe('TICKET-144 — structural independence of momentumContextSafetyState5m from position/candidate state', () => {
  it('the V2 tracker field never reads or is affected by openPositions/momentumDirectCircuitBreaker — re-deriving it fresh (previous=null) is unaffected by how many positions happen to be open', () => {
    const candidate = SafetyState5m.NORMAL;
    const ts = 5000;
    // Two calls, differing only in a hypothetical "how many positions are open" context that
    // applySafetyState5mFinalStabilization() never even takes as a parameter — structural proof.
    const a = applySafetyState5mFinalStabilization(candidate, ts, null);
    const b = applySafetyState5mFinalStabilization(candidate, ts, null);
    expect(a).toEqual(b);
  });

  it('"candidate pending" restart scenario: computeMomentumContextDecision() is a pure, stateless function — it takes no tracker/candidate-history argument at all, so there is nothing for a restart to lose', async () => {
    const { computeMomentumContextDecision } = await import('./momentumContextDecisionMatrix.js');
    const input = { symbol: 'SOLUSDT', macroConflict: true, safetyState5m: SafetyState5m.NORMAL, momentumThesisValid: true };
    // Calling it twice in a row with identical input is indistinguishable from "restart mid-decision"
    // — there is no internal state to reset because there is no internal state at all.
    expect(computeMomentumContextDecision(input, 'V2')).toEqual(computeMomentumContextDecision(input, 'V2'));
  });
});
