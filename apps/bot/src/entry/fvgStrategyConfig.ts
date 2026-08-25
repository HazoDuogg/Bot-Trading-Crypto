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
// targetRMultiple: RT-045 backtest-confirmed, 1.5 -> 2.10 (RT-033's original fully-verified value).
//   RT-042/043/044 swept 1.5-2.30R in 0.05-0.1R steps on the same 358-trade set: 2.10R gave
//   PnL=$653.72, PF=1.613, n=358, winRate=52.8% — confirmed part of a genuine continuing uptrend
//   (RT-044 re-tested 2.10-2.30R and found the curve still climbing, not reverting), not an isolated
//   peak like the confirmed-but-local dip at 1.80R (RT-043). See RT-042/043/044 reports for the full
//   sweep tables this was chosen from.
// minSlPctFloor: RT-028/029 backtest-confirmed — PF peak (1.48) at 0.5%, robust across >=4/5 coin.
export const DEFAULT_FVG_STRATEGY_CONFIG: FvgStrategyConfig = {
  maxWaitCandles: 20,
  targetRMultiple: 2.1, // RT-045 backtest-confirmed — see RT-042/043/044 sweep reports
  minSlPctFloor: 0.5,
};
