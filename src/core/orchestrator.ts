/**
 * TICKET-14X-A — real onCandle wiring detectEntry/checkExit/computeOrderSizes together.
 * TICKET-15X-A — registry + atr15 are now maintained state, extended incrementally
 * via advanceRegistry as new M15 candles arrive, instead of rebuilt from scratch
 * on every call. detectEntry/checkExit/computeOrderSizes are unchanged as the
 * verified core; only how the registry/atr15 reach detectEntry changed.
 * TICKET-16X-B — M5 history is now a bounded rolling window (M5_WINDOW_SIZE)
 * instead of an unboundedly growing array, so a very long backtest doesn't
 * make every onCandle call scan a bigger and bigger M5 array. Trade-off: a
 * retest that happens more than M5_WINDOW_SIZE candles after its zone formed
 * falls outside the window and gets missed — acceptable per the ticket.
 * TICKET-17X-A — tradeLog: per-order records for the backtest report, plus
 * "directionCorrect" at 15/30/60 M5 candles after entry — tracked completely
 * independently of checkExit/SL/TP (same horizons as TICKET-04X-AA, converted
 * from M15 to M5 units), to separate "bias was right" from "trade actually won".
 * TICKET-21X-A — H1 history tracked the same shape as M15 (grows, no window),
 * but with no registry/ATR of its own — detectSwingPoints (via detectEntry's
 * own computeH1TradingRange call) is cheap enough not to need one.
 * TICKET-24X-A — realizedPnl now nets out entry/exit fees (Binance Futures
 * VIP0, no BNB discount): entry is always taker, exit is maker on TP_HIT
 * (limit fill) and taker on SL_HIT (market fill).
 */
import type { Candle } from "./types.js";
import { detectEntry } from "../entry/entryRouter.js";
import { checkExit } from "../exit/exitManager.js";
import { computeStopLoss, computeOrderSizes, type OrderSize } from "../risk/positionSizer.js";
import { computeTargets, decideTradeSplit } from "../entry/targets.js";
import { advanceRegistry, type Zone } from "../entry/zoneRegistry.js";
import { calculateTR } from "../regime/adxDiCompare.js";
import { startOfUtcDay, type ClosedTrade } from "../risk/dailyThrottle.js";
import { computeConfluenceScore } from "../entry/confluenceScore.js";
import { MIN_CANDLES as MIN_DAILY_CANDLES } from "../regime/regimeDetector.js";

const ATR_PERIOD = 14; // matches computeAdxDi's default period — kept in lockstep for numeric parity
const DIRECTION_CHECK_HORIZONS = [15, 30, 60] as const; // M5 candles after entry (= 5/10/20 M15 candles, TICKET-04X-AA)

// ~10.4 days of M5 — working default, not yet verified. Revisit if a backtest shows setups
// missed because a real retest took longer than this to arrive.
export const M5_WINDOW_SIZE = 3000;

export const TAKER_FEE_PCT = 0.0005; // 0.05%, Binance Futures VIP0, no BNB discount
export const MAKER_FEE_PCT = 0.0002; // 0.02%, Binance Futures VIP0, no BNB discount

export interface OpenOrder extends OrderSize {
  closed: boolean;
  tradeRecord: TradeRecord;
}

export interface OpenPosition {
  direction: "UP" | "DOWN";
  orders: OpenOrder[];
}

export interface TradeRecord {
  direction: "UP" | "DOWN";
  confluenceScoreAtEntry: number;
  splitMode: "SINGLE" | "SPLIT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTick: number; // global M5 tick count at entry, for direction-check horizon lookups
  exitReason: "SL_HIT" | "TP_HIT" | null; // null while still open
  exitPrice: number | null;
  realizedPnl: number | null;
  closeTime: number | null;
  directionCorrect15: boolean | null;
  directionCorrect30: boolean | null;
  directionCorrect60: boolean | null;
}

export interface OrchestratorState {
  openPosition: OpenPosition | null;
  closedTrades: ClosedTrade[];
  tradeLog: TradeRecord[];
  equity: number;
  m15CandleCount: number;
  h1CandleCount: number;
  m5WindowCount: number;
}

export type OnCandleResult = { action: "NONE" | "ORDER_CLOSED" | "ENTRY_OPENED" };

function realizedPnl(order: OpenOrder, exitPrice: number, direction: "UP" | "DOWN", exitReason: "SL_HIT" | "TP_HIT"): number {
  const sign = direction === "UP" ? 1 : -1;
  const grossPnl = sign * order.quantity * (exitPrice - order.entryPrice);
  const entryFee = order.quantity * order.entryPrice * TAKER_FEE_PCT; // entry is always taker
  const exitFeeRate = exitReason === "TP_HIT" ? MAKER_FEE_PCT : TAKER_FEE_PCT; // TP=maker, SL=taker
  const exitFee = order.quantity * exitPrice * exitFeeRate;
  return grossPnl - entryFee - exitFee;
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
  const tradeLog: TradeRecord[] = [];
  const pendingDirectionChecks: TradeRecord[] = [];
  let m5TickCount = 0;

  const m15History: Candle[] = [];
  const atr15: number[] = [];
  const trSum = { sum: 0, count: 0 };
  let registry: Zone[] = [];
  const h1History: Candle[] = []; // grows unbounded, same as m15History — no registry/ATR needed for it
  const m5History: Candle[] = []; // rolling window, capped at M5_WINDOW_SIZE

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

  function ingestH1(newH1Candles: Candle[]): void {
    for (const candle of newH1Candles) h1History.push(candle);
  }

  function ingestM5(newM5Candles: Candle[]): void {
    for (const candle of newM5Candles) {
      m5History.push(candle);
      m5TickCount += 1;
    }
    if (m5History.length > M5_WINDOW_SIZE) m5History.splice(0, m5History.length - M5_WINDOW_SIZE);
  }

  /** Resolves any pending 15/30/60-candle direction checks that this tick's close now answers. */
  function resolveDirectionChecks(latestClose: number): void {
    for (let i = pendingDirectionChecks.length - 1; i >= 0; i--) {
      const rec = pendingDirectionChecks[i];
      const elapsed = m5TickCount - rec.entryTick;
      const correct = rec.direction === "UP" ? latestClose > rec.entryPrice : latestClose < rec.entryPrice;
      if (elapsed === 15) rec.directionCorrect15 = correct;
      else if (elapsed === 30) rec.directionCorrect30 = correct;
      else if (elapsed === 60) rec.directionCorrect60 = correct;
      if (elapsed >= 60) pendingDirectionChecks.splice(i, 1);
    }
  }

  return {
    getState(): OrchestratorState {
      return {
        openPosition,
        closedTrades: [...closedTrades],
        tradeLog: [...tradeLog],
        equity: currentEquity(),
        m15CandleCount: m15History.length,
        h1CandleCount: h1History.length,
        m5WindowCount: m5History.length,
      };
    },

    /**
     * One call per newly-closed M5 candle. `newH1Candles`/`newM15Candles`/`newM5Candles` carry only
     * the candle(s) that just closed (H1/M15 usually empty — only non-empty on their own closing tick).
     * Exactly one of manage-open-position / look-for-entry runs, per TICKET-14X-A's design.
     */
    onCandle(dailyCandles: Candle[], newH1Candles: Candle[], newM15Candles: Candle[], newM5Candles: Candle[]): OnCandleResult {
      ingestH1(newH1Candles);
      ingestM15(newM15Candles);
      ingestM5(newM5Candles);
      if (m5History.length === 0) return { action: "NONE" };
      const latestM5 = m5History[m5History.length - 1];
      resolveDirectionChecks(latestM5.close);

      if (openPosition) {
        let anyClosed = false;
        for (const order of openPosition.orders) {
          if (order.closed) continue;
          const result = checkExit(order, openPosition.direction, latestM5);
          if (result.reason === "NONE") continue;
          order.closed = true;
          anyClosed = true;
          const pnl = realizedPnl(order, result.exitPrice as number, openPosition.direction, result.reason);
          closedTrades.push({ closeTime: latestM5.closeTime, realizedPnl: pnl });
          order.tradeRecord.exitReason = result.reason;
          order.tradeRecord.exitPrice = result.exitPrice;
          order.tradeRecord.realizedPnl = pnl;
          order.tradeRecord.closeTime = latestM5.closeTime;
        }
        if (openPosition.orders.every((o) => o.closed)) openPosition = null;
        return { action: anyClosed ? "ORDER_CLOSED" : "NONE" };
      }

      if (currentEquity() <= 0) return { action: "NONE" }; // account is blown, stop permanently

      if (m15History.length === 0 || dailyCandles.length < MIN_DAILY_CANDLES) return { action: "NONE" };

      const startOfDayEquity = equityAtStartOfDay(initialEquity, closedTrades, latestM5.closeTime);
      const setup = detectEntry(dailyCandles, registry, h1History, m5History, closedTrades, startOfDayEquity);
      if (!setup) return { action: "NONE" };

      const atrAtEntry = atr15[atr15.length - 1];
      const entryPrice = latestM5.close;
      const slPrice = computeStopLoss(setup.direction, setup.zone, atrAtEntry);

      const targets = computeTargets(setup.direction, entryPrice, registry, dailyCandles);
      const splitDecision = decideTradeSplit(setup.direction, entryPrice, targets);

      const orders = computeOrderSizes(splitDecision, setup.direction, entryPrice, slPrice, currentEquity());
      if (!orders) return { action: "NONE" };

      const confluenceScoreAtEntry = computeConfluenceScore(setup.zone);
      const splitMode = splitDecision.mode as "SINGLE" | "SPLIT"; // orders!==null rules out INSUFFICIENT_DATA (computeOrderSizes returns null for it)
      const openOrders = orders.map((o) => {
        const tradeRecord: TradeRecord = {
          direction: setup.direction,
          confluenceScoreAtEntry,
          splitMode,
          entryPrice: o.entryPrice,
          stopLoss: o.stopLoss,
          takeProfit: o.takeProfit,
          entryTick: m5TickCount,
          exitReason: null,
          exitPrice: null,
          realizedPnl: null,
          closeTime: null,
          directionCorrect15: null,
          directionCorrect30: null,
          directionCorrect60: null,
        };
        tradeLog.push(tradeRecord);
        pendingDirectionChecks.push(tradeRecord);
        return { ...o, closed: false, tradeRecord };
      });

      openPosition = { direction: setup.direction, orders: openOrders };
      return { action: "ENTRY_OPENED" };
    },
  };
}
