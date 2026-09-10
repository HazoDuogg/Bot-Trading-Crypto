export interface BacktestReport {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
}

export function buildBacktestReport(trades: unknown[]): BacktestReport {
  void trades;
  throw new Error("not implemented");
}
