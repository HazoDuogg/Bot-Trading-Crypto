// Buoc 5b — Portfolio Exposure Tracker (stateful, deliberately separate from the pure Buoc 5/5a
// calculatePositionSize()). Caller holds ExposureTrackerState externally and feeds it back in on
// every admit/close call — same pattern as this codebase's other stateful sequences (no hidden
// mutable state inside this module).

export interface ExposureTrackerConfig {
  maxTotalUsedMargin: number; // fraction of balance, e.g. 0.7 = 70% portfolio-wide margin cap
  minRiskFraction: number; // floor as a fraction of the candidate's pre-scale-down actualRiskUsd, e.g. 0.3 = 30%
}

// TODO_CONFIRM: chosen from TICKET-RT-015 sweep (skip/scale-down counts across 1093 signals,
// 5 coin, 90 days) — cap=70% has diminishing returns past this point (70%->80% only rescues
export const DEFAULT_EXPOSURE_TRACKER_CONFIG: ExposureTrackerConfig = {
  maxTotalUsedMargin: 0.7,
  minRiskFraction: 0.4, // was 0.3
};

export interface OpenPosition {
  id: string;
  symbol: string;
  requiredMargin: number;
  actualRiskUsd: number;
}

export interface ExposureTrackerState {
  openPositions: OpenPosition[];
}

export const EMPTY_EXPOSURE_STATE: ExposureTrackerState = { openPositions: [] };

// Candidate values come from Buoc 5a (calculatePositionSize()'s output) — i.e. already clamped by
// the per-trade margin cap, before any portfolio-level scaling. candidate.actualRiskUsd is the
// "risk$ goc" that minRiskFraction is measured against.
export interface AdmitCandidateInput {
  id: string;
  symbol: string;
  qty: number;
  notional: number;
  requiredMargin: number;
  actualRiskUsd: number;
}

export interface AdmitResult {
  admitted: boolean;
  scaledDown: boolean;
  qty: number;
  notional: number;
  requiredMargin: number;
  actualRiskUsd: number;
}

function skipResult(): AdmitResult {
  return { admitted: false, scaledDown: false, qty: 0, notional: 0, requiredMargin: 0, actualRiskUsd: 0 };
}

export function usedMargin(state: ExposureTrackerState): number {
  return state.openPositions.reduce((sum, p) => sum + p.requiredMargin, 0);
}

// Invariants (see exposureTracker.test.ts):
//  1. usedMargin(nextState) never exceeds balance*config.maxTotalUsedMargin.
//  2. Never scales UP — a candidate that already fits within headroom is admitted unchanged, never
//     inflated to consume the rest of the headroom.
//  3. A scale-down that would push actualRiskUsd below minRiskFraction*candidate.actualRiskUsd is
//     rejected outright (skip) instead of opening an undersized position.
export function admitPosition(
  state: ExposureTrackerState,
  config: ExposureTrackerConfig,
  balance: number,
  candidate: AdmitCandidateInput,
): { result: AdmitResult; nextState: ExposureTrackerState } {
  if (balance <= 0 || candidate.requiredMargin <= 0 || candidate.actualRiskUsd <= 0) {
    return { result: skipResult(), nextState: state };
  }

  const cap = balance * config.maxTotalUsedMargin;
  const headroom = cap - usedMargin(state);
  if (headroom <= 0) {
    return { result: skipResult(), nextState: state };
  }

  if (candidate.requiredMargin <= headroom) {
    const position: OpenPosition = {
      id: candidate.id,
      symbol: candidate.symbol,
      requiredMargin: candidate.requiredMargin,
      actualRiskUsd: candidate.actualRiskUsd,
    };
    return {
      result: {
        admitted: true,
        scaledDown: false,
        qty: candidate.qty,
        notional: candidate.notional,
        requiredMargin: candidate.requiredMargin,
        actualRiskUsd: candidate.actualRiskUsd,
      },
      nextState: { openPositions: [...state.openPositions, position] },
    };
  }

  const scaleFactor = headroom / candidate.requiredMargin;
  const scaledRiskUsd = candidate.actualRiskUsd * scaleFactor;
  const minAllowedRisk = config.minRiskFraction * candidate.actualRiskUsd;

  if (scaledRiskUsd < minAllowedRisk) {
    return { result: skipResult(), nextState: state };
  }

  const scaledQty = candidate.qty * scaleFactor;
  const scaledNotional = candidate.notional * scaleFactor;
  const scaledMargin = headroom; // exact cap fill, avoids compounding fp drift from requiredMargin*scaleFactor

  const position: OpenPosition = {
    id: candidate.id,
    symbol: candidate.symbol,
    requiredMargin: scaledMargin,
    actualRiskUsd: scaledRiskUsd,
  };
  return {
    result: {
      admitted: true,
      scaledDown: true,
      qty: scaledQty,
      notional: scaledNotional,
      requiredMargin: scaledMargin,
      actualRiskUsd: scaledRiskUsd,
    },
    nextState: { openPositions: [...state.openPositions, position] },
  };
}

export function closePosition(state: ExposureTrackerState, id: string): ExposureTrackerState {
  return { openPositions: state.openPositions.filter((p) => p.id !== id) };
}
