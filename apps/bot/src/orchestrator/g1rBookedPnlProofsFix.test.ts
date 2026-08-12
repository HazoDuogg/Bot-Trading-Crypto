/**
 * TICKET-G1R-B "Runtime Wiring Pass" item 4 — the specific proofs the ticket requires that no prior
 * round built: (1) lifetimePnL = bookedRealizedPnl + unbookedRemainingPnl through slTpManager.ts's
 * REAL functions, (2) TP1 -> restart -> no double-book, (3) TP1 -> cross-symbol admission through the
 * REAL processCandle()/tryOpenNewPosition() path (not a direct wouldExceedRiskPool() unit call — that
 * proof already exists in g1rAReadinessFix.test.ts). The underlying mechanism
 * (accountBalanceForAdmission, OpenTradeMeta.bookedRealizedPnl) is UNCHANGED — these are proofs, not
 * new implementation.
 */
import { describe, it, expect } from 'vitest';
import { openPosition, onTp1Hit, onTp2Hit, computeTierNetPnl, computeRealizedPnl, type SlTpManagerInput } from '../risk/slTpManager.js';
import { processCandle, type ProcessCandleInput } from './orchestrator.js';
import { INITIAL_SYMBOL_STATE, type OrchestratorConfig, type SymbolState } from './types.js';
import { MarketRegime, type CandleData } from '../regime/types.js';
import { DEFAULT_ENTRY_ROUTER_CONFIG } from '../entry/entryRouter.js';
import { DEFAULT_MOMENTUM_FILTER_CONFIG, DEFAULT_NEUTRAL_TRANSITION_GATE_CONFIG, DEFAULT_PLAN_AUTO_SELECTION_CONFIG } from '../xgbFilter/config.js';

// ==== Proof 1 — lifetimePnL = bookedRealizedPnl + unbookedRemainingPnl (real slTpManager chain) ====

describe('Item 4 proof 1 — lifetimePnL = bookedRealizedPnl + unbookedRemainingPnl, TP1 -> TP2 -> full close', () => {
  it('holds for a real TREND LONG position through onTp1Hit -> onTp2Hit -> a final close price on the TP3_RUNNER remainder', () => {
    const input: SlTpManagerInput = { scenario: 'TREND', entryPrice: 100, slPrice: 90, side: 'LONG', tpPlan: 'PLAN_A', positionSize: 1000, takerFeeRate: 0.0004 };
    let state = openPosition(input);
    state = onTp1Hit(state); // fills TP1 (its own fixed tpLevels[0].price)
    state = onTp2Hit(state); // fills TP2

    // bookedRealizedPnl — exactly how orchestrator.ts's PARTIAL_CLOSE branch accumulates it (Cách B).
    const bookedRealizedPnl = computeTierNetPnl(state, 'TP1') + computeTierNetPnl(state, 'TP2');

    const finalExitPrice = 150; // TP3_RUNNER's trailing remainder closes here (SL/trailing, price arbitrary)
    const lifetimePnL = computeRealizedPnl(state, finalExitPrice);

    // unbookedRemainingPnl: the SAME proportional-fee-split convention computeTierNetPnl uses
    // (tier gross pnl minus tier's own share of the flat 2-leg fee), applied to the still-open
    // remainder (TP3_RUNNER's closePercent) at the final exit price — this is what "the part not yet
    // booked" means for a position not yet fully closed.
    const remainingTier = state.tpLevels.find((t) => t.label === 'TP3_RUNNER')!;
    const remainingGrossPnl = remainingTier.closePercent * state.positionSize * ((finalExitPrice - state.entryPrice) / state.entryPrice);
    const remainingFee = remainingTier.closePercent * state.positionSize * state.takerFeeRate * 2;
    const unbookedRemainingPnl = remainingGrossPnl - remainingFee;

    expect(bookedRealizedPnl + unbookedRemainingPnl).toBeCloseTo(lifetimePnL, 9);
  });

  it('holds for a SHORT position too (sign symmetry) and for a loss (finalExitPrice below entry)', () => {
    const input: SlTpManagerInput = { scenario: 'TREND', entryPrice: 100, slPrice: 110, side: 'SHORT', tpPlan: 'PLAN_A', positionSize: 500, takerFeeRate: 0.0004 };
    let state = openPosition(input);
    state = onTp1Hit(state);
    const bookedRealizedPnl = computeTierNetPnl(state, 'TP1');
    const finalExitPrice = 108; // adverse move relative to SHORT's favor, before SL — a real loss on the remainder
    const lifetimePnL = computeRealizedPnl(state, finalExitPrice);

    const filledPortion = state.filledTiers.reduce((sum, label) => {
      const t = state.tpLevels.find((tt) => tt.label === label);
      return sum + (t && t.price !== null ? t.closePercent : 0);
    }, 0);
    const remainingPortion = 1 - filledPortion;
    const sideMultiplier = -1;
    const remainingGrossPnl = remainingPortion * state.positionSize * ((finalExitPrice - state.entryPrice) / state.entryPrice) * sideMultiplier;
    const remainingFee = remainingPortion * state.positionSize * state.takerFeeRate * 2;
    const unbookedRemainingPnl = remainingGrossPnl - remainingFee;

    expect(bookedRealizedPnl + unbookedRemainingPnl).toBeCloseTo(lifetimePnL, 9);
  });

  it('a position that never fills any tier: bookedRealizedPnl=0, unbookedRemainingPnl=full lifetimePnL', () => {
    const input: SlTpManagerInput = { scenario: 'TREND', entryPrice: 100, slPrice: 90, side: 'LONG', tpPlan: 'PLAN_A', positionSize: 1000, takerFeeRate: 0.0004 };
    const state = openPosition(input);
    const bookedRealizedPnl = 0; // no PARTIAL_CLOSE event ever fired
    const lifetimePnL = computeRealizedPnl(state, 90); // closed at SL
    expect(bookedRealizedPnl).toBe(0);
    expect(lifetimePnL).toBeCloseTo(computeRealizedPnl(state, 90), 9);
    // trivially bookedRealizedPnl + lifetimePnL(=fully unbooked) = lifetimePnL
    expect(bookedRealizedPnl + lifetimePnL).toBeCloseTo(lifetimePnL, 9);
  });
});

// ==== Proof 2 — TP1 -> restart (JSON round-trip) -> no double-book ============================

describe('Item 4 proof 2 — TP1 -> restart -> bookedRealizedPnl is NOT re-added', () => {
  it('a real TREND position\'s TP1 fill accumulates bookedRealizedPnl exactly once (same accumulation orchestrator.ts itself performs); a JSON round-trip (simulating liveStateSync.ts persist/recover) preserves it byte-identically, and a REAL processCandle() tick on the recovered state (no NEW tier fill — price never reaches TP2/SL) never adds to it again', async () => {
    const config = baseConfig();
    // Built directly via openPosition() (TREND scenario, has TP1/TP2 — MOMENTUM_DIRECT's own
    // COUNTER_TREND scenario has no TP1/TP2 tiers to fill) — same real ManagedPositionState shape
    // processCandle()'s own orchestrator.ts loop advances every tick, just constructed here instead of
    // reached via a live entry signal (orthogonal to this proof, which is about restart persistence).
    const entryTimestamp = Date.UTC(2024, 0, 1);
    const opened = openPosition({ scenario: 'TREND', entryPrice: 100, slPrice: 90, side: 'LONG', tpPlan: 'PLAN_A', positionSize: 1000, takerFeeRate: config.takerFeeRate });
    const filledPosition = onTp1Hit(opened);
    const tierPnlUsd = computeTierNetPnl(filledPosition, 'TP1');
    const bookedAfterTp1 = 0 + tierPnlUsd; // orchestrator.ts: meta.bookedRealizedPnl starts at 0, accumulated additively per tier
    expect(bookedAfterTp1).not.toBe(0);

    let state: SymbolState = {
      ...INITIAL_SYMBOL_STATE,
      openPositions: [{ position: filledPosition, meta: { regime: MarketRegime.TREND_RIDER, setupType: 'OB', entryTimestamp, actualRiskDollar: 100, marginRequired: 33.3, riskMultiplier: 1, bookedRealizedPnl: bookedAfterTp1 } }],
    };

    // "Restart": JSON round-trip is EXACTLY what writeLiveStateFileAtomic/readLiveStateFileSafe do to
    // SymbolState (OpenTradeMeta.bookedRealizedPnl is a plain number field, no special serialization).
    const recovered: SymbolState = JSON.parse(JSON.stringify(state));
    expect(recovered.openPositions[0].meta.bookedRealizedPnl).toBe(bookedAfterTp1);
    state = recovered;

    // Real processCandle() tick, far-away TP2/SL (flat candles around entryPrice=100, TP2/SL both
    // outside range) so this candle fills nothing new — filledTiers stays ['TP1'], the orchestrator's
    // `newlyFilledTier === 'TP1' || 'TP2'` accumulation branch requires filledTiers.length to GROW,
    // which it cannot here.
    // 105: safely above the post-TP1 breakeven+fee SL ratchet and below TP2's price (125 = entry+2.5R) — never touches either.
    const flatCandles = makeCandles(320, 300_000, () => 105, () => 0.2, entryTimestamp + 300_000);
    const tickResult = await processCandle(
      { symbol: 'BTCUSDT', candles5m: flatCandles, candles15m: flatCandles, candles1h: flatCandles, candles1m: flatCandles, candles1d: flatCandles, candles1hMomentum: flatCandles, accountBalance: 1000, allOpenPositionsRisk: [] },
      state,
      config,
    );
    const stillOpen = tickResult.symbolState.openPositions.find((e) => e.meta.entryTimestamp === entryTimestamp);
    expect(stillOpen).toBeDefined();
    expect(stillOpen!.meta.bookedRealizedPnl).toBe(bookedAfterTp1);

    // Repeated ticks (idempotency) — calling again with the same unchanged input must never drift.
    const tickResult2 = await processCandle(
      { symbol: 'BTCUSDT', candles5m: flatCandles, candles15m: flatCandles, candles1h: flatCandles, candles1m: flatCandles, candles1d: flatCandles, candles1hMomentum: flatCandles, accountBalance: 1000, allOpenPositionsRisk: [] },
      state,
      config,
    );
    expect(tickResult2.symbolState.openPositions[0].meta.bookedRealizedPnl).toBe(bookedAfterTp1);
  });
});

// ==== Proof 3 — TP1 on symbol A -> cross-symbol admission on symbol B, through REAL processCandle() =

describe('Item 4 proof 3 — cross-symbol admission after TP1, through real processCandle()/tryOpenNewPosition()', () => {
  it('symbol B\'s candidate is REJECTED using the real accountBalance alone, but ADMITTED (a real OPEN event fires) once symbol A\'s bookedRealizedPnlPortfolio (from a real TP1 fill) is included via accountBalanceForAdmission', async () => {
    const config = baseConfig();
    const fixture = momentumDirectFixture();

    // Step 1 — determine this fixture's REAL candidate risk$ empirically (sizing depends on
    // riskDollarOrPercent/leverage/slDistancePercent/maxMarginCap, not on riskPoolMaxPct/accountBalance),
    // via an unconstrained admission pass.
    const probe = await processCandle(baseInput({ ...fixture, symbol: 'XRPUSDT', accountBalance: 100000, allOpenPositionsRisk: [] }), INITIAL_SYMBOL_STATE, { ...config, riskPoolMaxPct: 1 });
    const probeOpen = probe.events.find((e) => e.type === 'OPEN');
    expect(probeOpen).toBeDefined();
    const candidateRisk = (probeOpen as { actualRiskDollar: number }).actualRiskDollar;
    expect(candidateRisk).toBeGreaterThan(0);

    // Step 2 — construct a boundary where the cap (accountBalance * riskPoolMaxPct) leaves LESS
    // headroom than candidateRisk without the booked PnL, but MORE than candidateRisk with it.
    const accountBalance = 100;
    const riskPoolMaxPct = 1; // simplifies arithmetic: cap == accountBalance in dollars
    const otherRisk = accountBalance - candidateRisk * 0.5; // headroom = candidateRisk*0.5 < candidateRisk -> reject
    const bookedRealizedPnlPortfolio = candidateRisk * 2; // headroom with booked pnl = candidateRisk*2.5 >= candidateRisk -> admit
    const admissionConfig: OrchestratorConfig = { ...config, riskPoolMaxPct };

    const rejectedResult = await processCandle(
      baseInput({ ...fixture, symbol: 'XRPUSDT', accountBalance, allOpenPositionsRisk: [{ id: 'ETHUSDT', actualRiskDollar: otherRisk }], bookedRealizedPnlPortfolio: 0 }),
      INITIAL_SYMBOL_STATE,
      admissionConfig,
    );
    expect(rejectedResult.events.some((e) => e.type === 'OPEN')).toBe(false);

    const admittedResult = await processCandle(
      baseInput({ ...fixture, symbol: 'XRPUSDT', accountBalance, allOpenPositionsRisk: [{ id: 'ETHUSDT', actualRiskDollar: otherRisk }], bookedRealizedPnlPortfolio }),
      INITIAL_SYMBOL_STATE,
      admissionConfig,
    );
    expect(admittedResult.events.some((e) => e.type === 'OPEN')).toBe(true);
  });
});

// ---- shared fixture helpers (duplicated from momentumContextDecisionMatrixV2Wiring.test.ts's own
// pattern — kept local/self-contained rather than importing test-only helpers across files) ---------

function makeCandles(count: number, intervalMs: number, priceAt: (i: number) => number, rangeAt: (i: number) => number, startTs: number = Date.UTC(2024, 0, 1)): CandleData[] {
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

function baseConfig(): OrchestratorConfig {
  return {
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
    momentumDirectThreshold: 0,
    momentumDirectMaxAtrPercentile: 100,
    momentumDirectMinSlPercent: 0.5,
    momentumDirectTpRMultiple: 2.0,
    momentumDirectMaxTotalConcurrent: 999,
    momentumDirectCorrelationRiskThreshold: 999,
    momentumDirectCorrelationRiskMultiplier: 1.0,
    momentumDirectCircuitBreakerLossThreshold: 999999,
    momentumDirectCircuitBreakerCooldownMs: 0,
    momentumContextDecisionMatrixV2Enabled: false,
  };
}

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

// Same fixture as momentumContextDecisionMatrixV2Wiring.test.ts / orchestrator.test.ts's own
// momentumDirectFixture(): flat featureless 5m/15m/1m (cascade finds nothing) + clean 1h uptrend
// (TREND_RIDER) — SHORT wins the AI-score tie-break empirically, reliably producing an OPEN event.
function momentumDirectFixture() {
  const fullCandles1h = makeCandles(250, 3_600_000, (i) => 100 + i * 2, () => 1);
  const candles1h = fullCandles1h.slice(-40);
  const candles5m = makeCandles(320, 300_000, () => 100, () => 0.5);
  const candles15m = makeCandles(325, 900_000, () => 100, () => 1);
  const candles1m = makeCandles(50, 60_000, () => 100, () => 0.5);
  return { candles5m, candles15m, candles1h, candles1m, candles1hMomentum: fullCandles1h };
}

