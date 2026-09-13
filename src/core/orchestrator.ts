import type { Candle } from "./types.js";

export interface OrchestratorDeps {
  detectRegime: (candles: Candle[]) => unknown;
  detectDirection: (candles: Candle[]) => unknown;
  detectEntry: (dailyCandles: Candle[], m15Candles: Candle[], m5Candles: Candle[]) => unknown;
  sizePosition: (signal: unknown) => unknown;
  manageExit: (position: unknown, candle: Candle) => unknown;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  return {
    onCandle(candle: Candle, history: Candle[]) {
      void candle;
      void history;
      void deps;
      throw new Error("not implemented");
    },
  };
}
