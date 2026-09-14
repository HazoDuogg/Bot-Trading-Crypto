/**
 * TICKET-14X-A — real onCandle: wires detectEntry/checkExit/computeOrderSizes
 * together with real, causal data. No breakeven/trailing (decided in TICKET-11X-A).
 * The dependency-injection scaffold is gone — every piece it stood in for is
 * now built and verified, so onCandle calls them directly instead of via deps.
 */
import type { Candle } from "./types.js";
import { detectEntry } from "../entry/entryRouter.js";
import { checkExit } from "../exit/exitManager.js";
import { computeStopLoss, computeOrderSizes, type OrderSize } from "../risk/positionSizer.js";
import { computeTargets, decideTradeSplit } from "../entry/targets.js";
import { buildInitialRegistry } from "../entry/zoneRegistry.js";
import { computeAdxDi } from "../regime/adxDiCompare.js";
import { startOfUtcDay, type ClosedTrade } from "../risk/dailyThrottle.js";

export interface OpenOrder extends OrderSize {
  closed: boolean;
}

export interface OpenPosition {
  direction: "UP" | "DOWN";
  orders: OpenOrder[];
}

export interface OrchestratorState {
  openPosition: OpenPosition | null;
  closedTrades: ClosedTrade[];
  equity: number;
}

export type OnCandleResult = { action: "NONE" | "ORDER_CLOSED" | "ENTRY_OPENED" };

function realizedPnl(order: OpenOrder, exitPrice: number, direction: "UP" | "DOWN"): number {
  const sign = direction === "UP" ? 1 : -1;
  return sign * order.quantity * (exitPrice - order.entryPrice);
}

/** Equity at the start of the UTC day containing `now`: initial balance plus every trade closed strictly before that day. */
export function equityAtStartOfDay(initialEquity: number, closedTrades: ClosedTrade[], now: number): number {
  const dayStart = startOfUtcDay(now);
  return closedTrades.filter((t) => t.closeTime < dayStart).reduce((sum, t) => sum + t.realizedPnl, initialEquity);
}

export function createOrchestrator(initialEquity: number) {
  let openPosition: OpenPosition | null = null;
  const closedTrades: ClosedTrade[] = [];

  function currentEquity(): number {
    return closedTrades.reduce((sum, t) => sum + t.realizedPnl, initialEquity);
  }

  return {
    getState(): OrchestratorState {
      return { openPosition, closedTrades: [...closedTrades], equity: currentEquity() };
    },

    /** One call per newly-closed M5 candle. Exactly one branch runs: manage an open position, or look for a new entry. */
    onCandle(dailyCandles: Candle[], m15Candles: Candle[], m5Candles: Candle[]): OnCandleResult {
      const latestM5 = m5Candles[m5Candles.length - 1];

      if (openPosition) {
        let anyClosed = false;
        for (const order of openPosition.orders) {
          if (order.closed) continue;
          const result = checkExit(order, openPosition.direction, latestM5);
          if (result.reason === "NONE") continue;
          order.closed = true;
          anyClosed = true;
          closedTrades.push({ closeTime: latestM5.closeTime, realizedPnl: realizedPnl(order, result.exitPrice as number, openPosition.direction) });
        }
        if (openPosition.orders.every((o) => o.closed)) openPosition = null;
        return { action: anyClosed ? "ORDER_CLOSED" : "NONE" };
      }

      const startOfDayEquity = equityAtStartOfDay(initialEquity, closedTrades, latestM5.closeTime);
      const setup = detectEntry(dailyCandles, m15Candles, m5Candles, closedTrades, startOfDayEquity);
      if (!setup) return { action: "NONE" };

      const { atr: atr15 } = computeAdxDi(m15Candles);
      const atrAtEntry = atr15[atr15.length - 1];
      const entryPrice = latestM5.close;
      const slPrice = computeStopLoss(setup.direction, setup.zone, atrAtEntry);

      const registry = buildInitialRegistry(m15Candles, atr15);
      const targets = computeTargets(setup.direction, entryPrice, registry, dailyCandles);
      const splitDecision = decideTradeSplit(setup.direction, entryPrice, targets);

      const orders = computeOrderSizes(splitDecision, setup.direction, entryPrice, slPrice, currentEquity());
      if (!orders) return { action: "NONE" };

      openPosition = { direction: setup.direction, orders: orders.map((o) => ({ ...o, closed: false })) };
      return { action: "ENTRY_OPENED" };
    },
  };
}
