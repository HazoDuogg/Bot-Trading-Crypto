// TICKET-RT-073 Part B: production leverage-per-symbol source of truth, used by liveRunner.ts to
// SET leverage on the exchange at startup. Previously no code anywhere ever set leverage — this is
// the first ticket to close that gap (RT-AUDIT-001 found the exchange's actual leverage silently
// drifted from this design: BTC=10x/SOL=20x/HYPE=20x observed vs. the intended values below —
// because nothing had ever pushed these values to the exchange). Same BTC/ETH=20x, SOL/HYPE=10x
// split used throughout the RT-05x/06x backtest scripts' local LEVERAGE constants.
export interface LeverageConfig {
  fourCoinLeverage: Record<string, number>; // per-symbol, not a single flat number — BTC/ETH differ from SOL/HYPE/XRP
}

export const DEFAULT_LEVERAGE_CONFIG: LeverageConfig = {
  fourCoinLeverage: {
    BTCUSDT: 20,
    ETHUSDT: 20,
    SOLUSDT: 10,
    HYPEUSDT: 10,
    DOGEUSDT: 10,
  },
};

// Deliberately throws (fail loud) on an unknown symbol rather than falling back to a default — the
// same "fail closed" spirit as resolveRiskPct's symbol check. This means adding a new symbol to
// liveRunner.ts's SYMBOLS without ALSO adding it here breaks startup immediately and loudly, instead
// of silently running with an unset/wrong leverage (the exact gap RT-AUDIT-001 found).
export function resolveLeverage(symbol: string, config: LeverageConfig = DEFAULT_LEVERAGE_CONFIG): number {
  const leverage = config.fourCoinLeverage[symbol];
  if (leverage === undefined) {
    throw new Error(`CORRECTION_REQUIRED: khong co leverage duoc cau hinh cho symbol "${symbol}" trong DEFAULT_LEVERAGE_CONFIG — them vao truoc khi khoi dong voi symbol nay.`);
  }
  return leverage;
}
