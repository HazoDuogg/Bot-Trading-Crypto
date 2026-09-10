import type { EntrySignal, TradePlan } from "../core/types.js";

export function sizePosition(signal: EntrySignal, accountBalance: number): TradePlan {
  void signal;
  void accountBalance;
  throw new Error("not implemented");
}
