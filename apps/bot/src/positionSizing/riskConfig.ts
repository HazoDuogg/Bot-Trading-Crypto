// TICKET-RT-057: production risk-per-trade source of truth. Previously "risk %" had no shared
// config at all — calculatePositionSize() just takes riskUsd as whatever the caller supplies, and
// every RT-032..056 backtest script computed its own local riskUsd from a private RISK_PCT=0.01
// constant. This is the first ticket to land a shared, symbol-aware risk config in src/ — the
// "RT-055 HYPEUSDT breaksKeyZone logic" the RT-057 ticket referenced as already-settled did not
// actually exist anywhere in production code (verified: no commit, no file, zero grep hits for
// breaksKeyZone/RISK_PCT anywhere under src/positionSizing or src/entry) — confirmed with Vinh Tam
// before writing this file, which now lands BOTH pieces together: HYPEUSDT's two-tier split and the
// four-coin bump.
//
// Values backtest-confirmed via RT-056's near-live 1-year simulation, Config B:
// n=1217, PnL=$2628.76, PF=1.551, maxDrawdown=1.24% of a $10,000 reference equity curve. HYPEUSDT's
// own numbers were verified UNCHANGED between RT-056's Config A/B (n=577, PnL=$999.72 in both) —
// confirming the four-coin bump doesn't touch HYPEUSDT's own risk. hypeKeyZoneRiskPct=1.5% traces to
// RT-052's M=1.5 multiplier sweep on HYPEUSDT's breaksKeyZone=true trades specifically.
export interface RiskConfig {
  fourCoinRiskPct: number; // BTCUSDT/ETHUSDT/SOLUSDT/XRPUSDT — every trade, flat
  hypeBaselineRiskPct: number; // HYPEUSDT, breaksKeyZone=false — unchanged from the original 1.0%
  hypeKeyZoneRiskPct: number; // HYPEUSDT, breaksKeyZone=true only
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  fourCoinRiskPct: 0.015,
  hypeBaselineRiskPct: 0.01,
  hypeKeyZoneRiskPct: 0.015,
};

export function resolveRiskPct(symbol: string, breaksKeyZone: boolean, config: RiskConfig = DEFAULT_RISK_CONFIG): number {
  if (symbol === 'HYPEUSDT') {
    return breaksKeyZone ? config.hypeKeyZoneRiskPct : config.hypeBaselineRiskPct;
  }
  return config.fourCoinRiskPct;
}
