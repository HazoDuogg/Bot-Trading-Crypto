// TICKET-RT-033: entry-pipeline parameters for the FVG strategy that don't belong to detectFvg()
// itself (pattern recognition) — how long to wait for a fill, the fixed TP R:R, and the SL% floor.
// Gathered here from scripts/strategy1MeasureFvg.ts so the measurement script and any future
// production code share one source of truth instead of drifting apart.
export interface FvgStrategyConfig {
  maxWaitCandles: number;
  targetRMultiple: number;
  minSlPctFloor: number;
}

// maxWaitCandles: RT-031 swept 10-40, PF stayed flat (1.47-1.49) — not sensitive in that range, 20
//   (5 hours on M15) kept as-is.
// targetRMultiple: TODO_CONFIRM — STILL UNCONFIRMED. RT-031 measured 2.0 giving higher PnL$ ($699.58
//   vs $559.58) at comparable PF (1.50 vs 1.48), but this has NOT been explicitly confirmed as the
//   chosen value — kept at the fully-verified 1.5 until that confirmation happens. Do not change to
//   2.0 without that sign-off, even though the measured numbers look favorable.
// minSlPctFloor: RT-028/029 backtest-confirmed — PF peak (1.48) at 0.5%, robust across >=4/5 coin.
export const DEFAULT_FVG_STRATEGY_CONFIG: FvgStrategyConfig = {
  maxWaitCandles: 20,
  targetRMultiple: 1.5, // TODO_CONFIRM — see RT-031: 2.0 measured higher PnL$ at similar PF, not yet confirmed
  minSlPctFloor: 0.5,
};
