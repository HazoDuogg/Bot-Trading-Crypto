/**
 * TICKET-14X-A — real onCandle wiring detectEntry/checkExit/computeOrderSizes together.
 * TICKET-15X-A — registry + atr15 are now maintained state, extended incrementally
 * via advanceRegistry as new M15 candles arrive, instead of rebuilt from scratch
 * on every call. detectEntry/checkExit/computeOrderSizes are unchanged as the
 * verified core; only how the registry/atr15 reach detectEntry changed.
 */
import type { Candle } from "./types.js";
import { detectEntry } from "../entry/entryRouter.js";
import { checkExit } from "../exit/exitManager.js";
import { computeStopLoss, computeOrderSizes, type OrderSize } from "../risk/positionSizer.js";
import { computeTargets, decideTradeSplit } from "../entry/targets.js";
import { advanceRegistry, type Zone } from "../entry/zoneRegistry.js";
import { calculateTR } from "../regime/adxDiCompare.js";
import { startOfUtcDay, type ClosedTrade } from "../risk/dailyThrottle.js";

const ATR_PERIOD = 14; // matches computeAdxDi's default period — kept in lockstep for numeric parity

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
  m15CandleCount: number;
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

/** One incremental Wilder-ATR step (same formula as computeAdxDi's atr) — avoids re-running it over the whole history each call. */
function extendAtr(atr15: number[], trSum: { sum: number; count: number }, prevCandle: Candle | null, newCandle: Candle): void {
  if (!prevCandle) {
    atr15.push(0); // no TR possible for the very first candle — matches computeAdxDi's own leading pad
    return;
  }
  const tr = calculateTR(newCandle.high, newCandle.low, prevCandle.close);
  if (trSum.count < ATR_PERIOD) {
    trSum.sum += tr;
    trSum.count += 1;
    atr15.push(trSum.sum / trSum.count);
  } else {
    atr15.push((atr15[atr15.length - 1] * (ATR_PERIOD - 1) + tr) / ATR_PERIOD);
  }
}

export function createOrchestrator(initialEquity: number) {
  let openPosition: OpenPosition | null = null;
  const closedTrades: ClosedTrade[] = [];

  const m15History: Candle[] = [];
  const atr15: number[] = [];
  const trSum = { sum: 0, count: 0 };
  let registry: Zone[] = [];

  function currentEquity(): number {
    return closedTrades.reduce((sum, t) => sum + t.realizedPnl, initialEquity);
  }

  function ingestM15(newM15Candles: Candle[]): void {
    for (const candle of newM15Candles) {
      const prevCandle = m15History.length > 0 ? m15History[m15History.length - 1] : null;
      m15History.push(candle);
      extendAtr(atr15, trSum, prevCandle, candle);
      registry = advanceRegistry(registry, m15History, atr15, m15History.length - 1);
    }
  }

  return {
    getState(): OrchestratorState {
      return { openPosition, closedTrades: [...closedTrades], equity: currentEquity(), m15CandleCount: m15History.length };
    },

    /**
     * One call per newly-closed M5 candle. `newM15Candles` carries any M15 candle(s) that
     * just closed alongside it (usually empty — only non-empty on the M15-closing tick).
     * Exactly one of manage-open-position / look-for-entry runs, per TICKET-14X-A's design.
     */
    onCandle(dailyCandles: Candle[], newM15Candles: Candle[], m5Candles: Candle[]): OnCandleResult {
      ingestM15(newM15Candles);
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

      if (m15History.length === 0) return { action: "NONE" };

      const startOfDayEquity = equityAtStartOfDay(initialEquity, closedTrades, latestM5.closeTime);
      const currentPrice = m15History[m15History.length - 1].close;
      const setup = detectEntry(dailyCandles, registry, atr15, currentPrice, m5Candles, closedTrades, startOfDayEquity);
      if (!setup) return { action: "NONE" };

      const atrAtEntry = atr15[atr15.length - 1];
      const entryPrice = latestM5.close;
      const slPrice = computeStopLoss(setup.direction, setup.zone, atrAtEntry);

      const targets = computeTargets(setup.direction, entryPrice, registry, dailyCandles);
      const splitDecision = decideTradeSplit(setup.direction, entryPrice, targets);

      const orders = computeOrderSizes(splitDecision, setup.direction, entryPrice, slPrice, currentEquity());
      if (!orders) return { action: "NONE" };

      openPosition = { direction: setup.direction, orders: orders.map((o) => ({ ...o, closed: false })) };
      return { action: "ENTRY_OPENED" };
    },
  };
}
