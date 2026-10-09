/**
 * Type shapes for config/symbols.json, config/risk.json, config/fees.json.
 * Every one of those files' real values are marked "status":"provisional"
 * (or "undecided" for fees.fillModel) - these types describe the SHAPE,
 * not a claim that the values are final.
 *
 * Deliberately placed at src/ top level, not inside src/config/ - that
 * folder already holds an EARLIER, differently-scoped config module
 * (env var reading/validation, see src/config/README.md) from a prior
 * implementation attempt. See docs/decisions.md for the proposal to
 * relocate that prior work to research/ - pending approval, nothing
 * under src/config/ has been touched.
 */

export type Status = "provisional" | "locked" | "undecided" | "rejected";

export interface SymbolConfig {
  symbol: string;
  variant: string;
  sides: ("long" | "short")[];
  status: Status;
  gate: "sma200" | "trend_structure" | "none";
  buffer_mult: number;
  rr_mult: number;
  exit_style: "trail" | "fixed_tp";
  note?: string;
}

export interface SymbolsConfigFile {
  status: Status;
  note?: string;
  symbols: SymbolConfig[];
}

export interface RiskConfigFile {
  status: Status;
  note?: string;
  risk_per_trade_pct: { value: number; status: Status };
  margin_cap_pct: { value: number; status: Status; basis: "margin" | "notional"; note?: string };
  leverage: Record<string, { value: number; status: Status }>;
  circuit_breaker: {
    status: Status;
    mode: string;
    consecutive_losses_threshold: number;
    scope: string;
    note?: string;
    rejected_alternative?: string;
  };
}

export interface FeesConfigFile {
  status: Status;
  note?: string;
  fee_pct_per_fill: { value: number; status: Status; note?: string };
  fill_model: { value: string; status: Status; options: string[]; note?: string };
}
