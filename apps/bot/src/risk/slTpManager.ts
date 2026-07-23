/**
 * Implements docs/vicion-bot-quan-ly-vi-the-v1.md. Pure-function/state-object design: caller
 * holds a `ManagedPositionState` and feeds it through the event functions as fills happen.
 * TREND -> Mục 5 (3-tier TP + Runner). COUNTER_TREND -> Mục 7 (single TP, no SL choreography).
 */

export type Scenario = 'TREND' | 'COUNTER_TREND';
export type Side = 'LONG' | 'SHORT';
export type TpPlan = 'PLAN_A' | 'PLAN_B';

export interface SlTpManagerInput {
  scenario: Scenario;
  entryPrice: number;
  /** SL price already computed upstream (Position Sizing / Entry layer) — not recomputed here. */
  slPrice: number;
  side: Side;
  /** Only meaningful when scenario === 'TREND' (Mục 3); ignored for COUNTER_TREND. */
  tpPlan: TpPlan;
  /** Original notional size (USD) of the whole position. */
  positionSize: number;
  /** Decimal fraction, e.g. 0.0004 for 0.04%. Read from config — never hard-code at the call site. */
  takerFeeRate: number;
  /**
   * TICKET-059 — only meaningful when scenario === 'COUNTER_TREND'; ignored for TREND. When set,
   * computeTpLevels() uses this EXACT price for the single COUNTER_TREND_TP exit instead of the
   * default entry±COUNTER_TREND_TP_R(1R) formula — needed for MOMENTUM_DIRECT's fixed 0.5% target,
   * which must stay independent of the ATR-based SL distance (R varies per trade with volatility;
   * the momentum model was calibrated (TICKET-023) against a fixed % move, not a fixed R-multiple).
   * Omitted (undefined) reproduces the exact pre-TICKET-059 COUNTER_TREND behavior (entry±1R).
   */
  tpPriceOverride?: number;
}

export interface TpLevel {
  label: 'TP1' | 'TP2' | 'TP3_RUNNER' | 'COUNTER_TREND_TP';
  /** Fixed price target, or null for TP3_RUNNER — Mục 5.3: "không đặt target cứng 5R", trailing-managed instead. */
  price: number | null;
  rMultiple: number | null;
  /** Fraction (0-1) of the ORIGINAL positionSize to close at this tier. */
  closePercent: number;
}

export type FilledTier = 'TP1' | 'TP2' | 'TP3_RUNNER' | 'COUNTER_TREND_TP' | 'SL';

export interface ManagedPositionState {
  scenario: Scenario;
  side: Side;
  entryPrice: number;
  initialSlPrice: number;
  /** 1R = |entryPrice - initialSlPrice|, computed once at open (Mục 3). */
  r: number;
  tpPlan: TpPlan;
  positionSize: number;
  takerFeeRate: number;
  tpLevels: TpLevel[];
  currentSlPrice: number;
  filledTiers: FilledTier[];
  remainingPositionSize: number;
  /** Best price reached during the Runner phase (basis for Giveback Protection, Mục 5.4). Null until Runner starts. */
  runnerPeakPrice: number | null;
  closed: boolean;
}

// ---- PM-given constants (not TODO_CONFIRM — these are literal numbers from the doc) ----

const TP_PLANS: Record<TpPlan, { tp1R: number; tp1Pct: number; tp2R: number; tp2Pct: number; tp3Pct: number }> = {
  PLAN_A: { tp1R: 1.2, tp1Pct: 0.4, tp2R: 2.5, tp2Pct: 0.3, tp3Pct: 0.3 }, // Mục 5.1, Phương án A
  PLAN_B: { tp1R: 1, tp1Pct: 0.3, tp2R: 2, tp2Pct: 0.3, tp3Pct: 0.4 }, // Mục 5.1, Phương án B
};

/** Mục 5.3: "5R là trần lý tưởng (cap), không phải target cố định" — informational only, never auto-exits at this level. */
export const RUNNER_IDEAL_CAP_R = 5;
export const COUNTER_TREND_TP_R = 1; // Mục 7
export const GIVEBACK_LOCK_PCT_NORMAL = 0.6; // Mục 5.4
export const GIVEBACK_LOCK_PCT_LOW_CONFIDENCE = 0.7; // Mục 5.4
export const ATR_TRAILING_MULTIPLIER = 2.5; // Mục 5.3.2

export function priceAtR(entryPrice: number, r: number, rMultiple: number, side: Side): number {
  const direction = side === 'LONG' ? 1 : -1;
  return entryPrice + direction * rMultiple * r;
}

function isSlImprovement(side: Side, current: number, proposed: number): boolean {
  return side === 'LONG' ? proposed > current : proposed < current;
}

function assertTrendScenario(state: ManagedPositionState, action: string): void {
  if (state.scenario !== 'TREND') {
    throw new Error(`SlTpManager: ${action} only applies to scenario TREND (Mục 5), got ${state.scenario}`);
  }
}

export function computeTpLevels(
  input: Pick<SlTpManagerInput, 'scenario' | 'entryPrice' | 'slPrice' | 'side' | 'tpPlan' | 'tpPriceOverride'>,
): TpLevel[] {
  const r = Math.abs(input.entryPrice - input.slPrice);

  if (input.scenario === 'COUNTER_TREND') {
    // Mục 7: single TP, chốt sạch 100%, no tiers. Default entry±1R, UNLESS tpPriceOverride is set
    // (TICKET-059) — then rMultiple is null (a fixed-price target isn't meaningfully an R-multiple;
    // R varies per trade with ATR-based SL width, so "how many R away" isn't a fixed number here).
    const usingOverride = input.tpPriceOverride !== undefined;
    return [
      {
        label: 'COUNTER_TREND_TP',
        price: usingOverride ? (input.tpPriceOverride as number) : priceAtR(input.entryPrice, r, COUNTER_TREND_TP_R, input.side),
        rMultiple: usingOverride ? null : COUNTER_TREND_TP_R,
        closePercent: 1,
      },
    ];
  }

  const plan = TP_PLANS[input.tpPlan];
  return [
    {
      label: 'TP1',
      price: priceAtR(input.entryPrice, r, plan.tp1R, input.side),
      rMultiple: plan.tp1R,
      closePercent: plan.tp1Pct,
    },
    {
      label: 'TP2',
      price: priceAtR(input.entryPrice, r, plan.tp2R, input.side),
      rMultiple: plan.tp2R,
      closePercent: plan.tp2Pct,
    },
    { label: 'TP3_RUNNER', price: null, rMultiple: null, closePercent: plan.tp3Pct },
  ];
}

export function openPosition(input: SlTpManagerInput): ManagedPositionState {
  if (input.entryPrice <= 0) {
    throw new Error(`SlTpManager: entryPrice must be > 0, got ${input.entryPrice}`);
  }
  if (input.positionSize <= 0) {
    throw new Error(`SlTpManager: positionSize must be > 0, got ${input.positionSize}`);
  }
  if (input.takerFeeRate < 0) {
    throw new Error(`SlTpManager: takerFeeRate must be >= 0, got ${input.takerFeeRate}`);
  }
  const r = Math.abs(input.entryPrice - input.slPrice);
  if (r === 0) {
    throw new Error('SlTpManager: slPrice cannot equal entryPrice (R would be 0)');
  }

  return {
    scenario: input.scenario,
    side: input.side,
    entryPrice: input.entryPrice,
    initialSlPrice: input.slPrice,
    r,
    tpPlan: input.tpPlan,
    positionSize: input.positionSize,
    takerFeeRate: input.takerFeeRate,
    tpLevels: computeTpLevels(input),
    currentSlPrice: input.slPrice,
    filledTiers: [],
    remainingPositionSize: input.positionSize,
    runnerPeakPrice: null,
    closed: false,
  };
}

// ---- Mục 6: fee accounting ----

/** feeBuffer = positionSize × takerFeeRate × 2 (Mục 6). Total round-trip fee for the whole trade — fixed regardless of how many tiers it exits through, since exit fractions always sum to positionSize. */
export function computeFeeBufferDollar(positionSize: number, takerFeeRate: number): number {
  return positionSize * takerFeeRate * 2;
}

/** feeBuffer / baseAssetQty (positionSize/entryPrice), reduces to entryPrice * takerFeeRate * 2. */
export function computeFeeBufferPriceOffset(entryPrice: number, takerFeeRate: number): number {
  return entryPrice * takerFeeRate * 2;
}

export function computeBreakevenPlusFeeSlPrice(entryPrice: number, side: Side, takerFeeRate: number): number {
  const offset = computeFeeBufferPriceOffset(entryPrice, takerFeeRate);
  return side === 'LONG' ? entryPrice + offset : entryPrice - offset;
}

// ---- Mục 5.2: SL choreography after each TP tier (TREND only) ----

export function onTp1Hit(state: ManagedPositionState): ManagedPositionState {
  assertTrendScenario(state, 'onTp1Hit');
  if (state.filledTiers.includes('TP1')) {
    throw new Error('SlTpManager: TP1 already filled');
  }
  const tp1 = state.tpLevels.find((t) => t.label === 'TP1');
  if (!tp1) {
    throw new Error('SlTpManager: no TP1 level for this position');
  }

  // "Dời SL về entryPrice + phí round-trip TOÀN BỘ 3 lần chốt dự kiến" — NOT just TP1's own fee.
  const newSl = computeBreakevenPlusFeeSlPrice(state.entryPrice, state.side, state.takerFeeRate);

  return {
    ...state,
    currentSlPrice: newSl,
    filledTiers: [...state.filledTiers, 'TP1'],
    remainingPositionSize: state.remainingPositionSize - tp1.closePercent * state.positionSize,
  };
}

export function onTp2Hit(state: ManagedPositionState): ManagedPositionState {
  assertTrendScenario(state, 'onTp2Hit');
  if (!state.filledTiers.includes('TP1')) {
    throw new Error('SlTpManager: TP2 hit before TP1 — inconsistent fill sequence');
  }
  if (state.filledTiers.includes('TP2')) {
    throw new Error('SlTpManager: TP2 already filled');
  }
  const tp1 = state.tpLevels.find((t) => t.label === 'TP1');
  const tp2 = state.tpLevels.find((t) => t.label === 'TP2');
  if (!tp1 || tp1.price === null || !tp2) {
    throw new Error('SlTpManager: no TP1/TP2 level for this position');
  }

  return {
    ...state,
    currentSlPrice: tp1.price, // "Dời SL lên đúng mức giá TP1"
    filledTiers: [...state.filledTiers, 'TP2'],
    remainingPositionSize: state.remainingPositionSize - tp2.closePercent * state.positionSize,
  };
}

// ---- Mục 5.3: Runner (TP3) trailing — two mechanisms, caller/config picks which is active ----

/** Structure trailing: caller supplies the proposed SL (swing high/low, computed elsewhere); this just validates it's not worse (ratchet), silently ignoring it otherwise. */
export function applyStructureTrailing(state: ManagedPositionState, proposedSlPrice: number): ManagedPositionState {
  assertTrendScenario(state, 'applyStructureTrailing');
  if (!state.filledTiers.includes('TP2')) {
    throw new Error('SlTpManager: Runner trailing only applies after TP2 has been hit (Mục 5.2/5.3)');
  }
  if (!isSlImprovement(state.side, state.currentSlPrice, proposedSlPrice)) {
    return state;
  }
  return { ...state, currentSlPrice: proposedSlPrice };
}

/** ATR trailing: distance = ATR_TRAILING_MULTIPLIER * atr5m. atr5m comes from the Regime module — not recomputed here (Mục 5.3.2). */
export function applyAtrTrailing(
  state: ManagedPositionState,
  currentPrice: number,
  atr5m: number,
): ManagedPositionState {
  assertTrendScenario(state, 'applyAtrTrailing');
  if (!state.filledTiers.includes('TP2')) {
    throw new Error('SlTpManager: Runner trailing only applies after TP2 has been hit (Mục 5.2/5.3)');
  }
  if (atr5m <= 0) {
    throw new Error(`SlTpManager: atr5m must be > 0, got ${atr5m}`);
  }
  const distance = ATR_TRAILING_MULTIPLIER * atr5m;
  const proposedSl = state.side === 'LONG' ? currentPrice - distance : currentPrice + distance;
  return applyStructureTrailing(state, proposedSl);
}

// ---- Mục 5.4: Giveback Protection (Runner phase only) ----

function updatePeak(side: Side, currentPeak: number | null, currentPrice: number): number {
  if (currentPeak === null) return currentPrice;
  return side === 'LONG' ? Math.max(currentPeak, currentPrice) : Math.min(currentPeak, currentPrice);
}

/** Locks 60% (or 70% if isLowConfidenceOrLowLiquidity, caller-supplied) of peak Runner profit. Ratchet-only, like the trailing functions above. */
export function updateGivebackProtection(
  state: ManagedPositionState,
  currentPrice: number,
  isLowConfidenceOrLowLiquidity: boolean,
): ManagedPositionState {
  assertTrendScenario(state, 'updateGivebackProtection');
  if (!state.filledTiers.includes('TP2')) {
    throw new Error('SlTpManager: Giveback Protection only applies during the Runner phase, after TP2 (Mục 5.2/5.4)');
  }

  const peak = updatePeak(state.side, state.runnerPeakPrice, currentPrice);
  const lockPct = isLowConfidenceOrLowLiquidity ? GIVEBACK_LOCK_PCT_LOW_CONFIDENCE : GIVEBACK_LOCK_PCT_NORMAL;
  const direction = state.side === 'LONG' ? 1 : -1;
  const peakProfitDistance = Math.abs(peak - state.entryPrice);
  const givebackSl = state.entryPrice + direction * lockPct * peakProfitDistance;

  const nextSl = isSlImprovement(state.side, state.currentSlPrice, givebackSl) ? givebackSl : state.currentSlPrice;

  return { ...state, runnerPeakPrice: peak, currentSlPrice: nextSl };
}

// ---- Mục 7: COUNTER_TREND — single exit, no SL choreography ----

export function onCounterTrendTpHit(state: ManagedPositionState): ManagedPositionState {
  if (state.scenario !== 'COUNTER_TREND') {
    throw new Error(`SlTpManager: onCounterTrendTpHit only applies to scenario COUNTER_TREND, got ${state.scenario}`);
  }
  return { ...state, filledTiers: [...state.filledTiers, 'COUNTER_TREND_TP'], remainingPositionSize: 0, closed: true };
}

/** Applies to either scenario — SL is hit, whatever remains open closes at the current SL price. */
export function onSlHit(state: ManagedPositionState): ManagedPositionState {
  return { ...state, filledTiers: [...state.filledTiers, 'SL'], remainingPositionSize: 0, closed: true };
}

// ---- Fill-price condition helpers ----

export function isTpHit(side: Side, currentPrice: number, tpPrice: number): boolean {
  return side === 'LONG' ? currentPrice >= tpPrice : currentPrice <= tpPrice;
}

export function isSlHitAtPrice(side: Side, currentPrice: number, slPrice: number): boolean {
  return side === 'LONG' ? currentPrice <= slPrice : currentPrice >= slPrice;
}

// ---- TICKET-010: realized PNL, for trade logging (orchestrator/backtest) ----

/**
 * Sums each filled tier's gross P&L at ITS OWN price (TP1/TP2/COUNTER_TREND_TP use their fixed
 * tpLevel price), plus the still-open remainder (TP3_RUNNER or a position that never reached a
 * tier) at `finalExitPrice` — the price the position actually closed at (SL or trailing SL).
 * Total fees = positionSize × takerFeeRate × 2 regardless of tier count (proven in Mục 6's
 * mandatory test), so they're subtracted once at the end rather than per leg.
 */
export function computeRealizedPnl(state: ManagedPositionState, finalExitPrice: number): number {
  const sideMultiplier = state.side === 'LONG' ? 1 : -1;
  let grossPnl = 0;
  let filledPortion = 0;

  for (const tier of state.tpLevels) {
    if (tier.price === null || !state.filledTiers.includes(tier.label)) continue;
    grossPnl += tier.closePercent * state.positionSize * ((tier.price - state.entryPrice) / state.entryPrice) * sideMultiplier;
    filledPortion += tier.closePercent;
  }

  const remainingPortion = 1 - filledPortion;
  if (remainingPortion > 0) {
    grossPnl += remainingPortion * state.positionSize * ((finalExitPrice - state.entryPrice) / state.entryPrice) * sideMultiplier;
  }

  const totalFees = state.positionSize * state.takerFeeRate * 2;
  return grossPnl - totalFees;
}
