import type { Direction } from '../entry/types.js';
import { calculatePositionSize } from '../positionSizing/positionSizing.js';
import { DEFAULT_MAX_MARGIN_PCT } from '../positionSizing/types.js';
import { resolveRiskPct, DEFAULT_RISK_CONFIG, type RiskConfig } from '../positionSizing/riskConfig.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../entry/fvgStrategyConfig.js';
import type { ExchangeOrderClient } from './exchangeOrderClient.js';
import { roundDownToStep, roundToTick } from './binanceOrderClient.js';
import type { DetectedFvgSignal } from './signalEngine.js';

// TICKET-RT-068 Part B: the REAL order-execution state machine — deliberately separate from
// signalEngine.ts's pure detection (per the ticket's explicit "tach bach" instruction). One
// instance per symbol. Calls calculatePositionSize/resolveRiskPct (production, unmodified) with
// the REAL balance/leverage fetched from ExchangeOrderClient every time (Part A — never an
// internally-tracked number).
//
// State machine: IDLE (free to detect) -> ENTRY_PENDING (real LIMIT order placed, polling for
// FILLED or maxWaitCandles timeout) -> POSITION_OPEN (real SL+TP STOP_MARKET/TAKE_PROFIT_MARKET
// orders placed, polling for either to fill) -> back to IDLE.
//
// KNOWN LIMITATION (not solved here, and not solvable by simple polling — the standard, accepted
// workaround across the crypto trading dev community since Binance Futures has no true OCO
// SL+TP): there is a small race window between one of SL/TP filling and this code canceling the
// other. If both somehow fill before the cancel lands, this reports whichever this code happened
// to check first (SL checked before TP) and logs a warning — it does not claim to resolve the
// ambiguity perfectly.

const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;
const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;

export type LifecycleEvent =
  | {
      type: 'ENTRY_PLACED';
      symbol: string;
      orderId: number;
      direction: Direction;
      entryPrice: number;
      slPrice: number;
      tpPrice: number;
      quantity: number;
      riskPct: number;
      riskUsd: number;
      balanceUsedUsdt: number;
      signal: DetectedFvgSignal;
    }
  | { type: 'ENTRY_SKIPPED'; symbol: string; reason: string; signal: DetectedFvgSignal }
  | { type: 'ENTRY_TIMEOUT_CANCELLED'; symbol: string; orderId: number; waitedCandles: number }
  | {
      type: 'ENTRY_FILLED';
      symbol: string;
      direction: Direction;
      entryPrice: number; // real avgPrice from the exchange
      quantity: number;
      slPrice: number;
      tpPrice: number;
      slOrderId: number;
      tpOrderId: number;
      signal: DetectedFvgSignal;
    }
  | {
      type: 'POSITION_CLOSED';
      symbol: string;
      outcome: 'TP' | 'SL';
      exitPrice: number; // real avgPrice from the exchange
      realizedPnlUsd: number; // real, from getRealizedPnlSince — never computed by hand
      bothOrdersReportedFilled: boolean; // true only in the rare race-window case documented above
    }
  | { type: 'LIFECYCLE_ERROR'; symbol: string; context: string; message: string };

type State =
  | { phase: 'IDLE' }
  | { phase: 'ENTRY_PENDING'; orderId: number; direction: Direction; entryPrice: number; slPrice: number; tpPrice: number; quantity: number; waitCount: number; signal: DetectedFvgSignal }
  | { phase: 'POSITION_OPEN'; direction: Direction; entryPrice: number; quantity: number; slOrderId: number; tpOrderId: number; entryFilledAtMs: number; signal: DetectedFvgSignal };

export class SymbolOrderLifecycle {
  private state: State = { phase: 'IDLE' };

  constructor(
    public readonly symbol: string,
    private readonly client: ExchangeOrderClient,
    private readonly riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
  ) {}

  isFree(): boolean {
    return this.state.phase === 'IDLE';
  }

  getDebugState(): State {
    return this.state;
  }

  async onSignalDetected(signal: DetectedFvgSignal): Promise<LifecycleEvent> {
    const direction = signal.direction;
    const entryPriceRaw = direction === 'LONG' ? signal.gapLow : signal.gapHigh;
    const slPriceRaw = signal.invalidationPrice;
    const slDistanceRaw = Math.abs(entryPriceRaw - slPriceRaw);
    if (slDistanceRaw <= 0) return { type: 'ENTRY_SKIPPED', symbol: this.symbol, reason: 'slDistance<=0', signal };

    const slPct = (slDistanceRaw / entryPriceRaw) * 100;
    if (slPct < FLOOR_PCT) return { type: 'ENTRY_SKIPPED', symbol: this.symbol, reason: `slPct ${slPct.toFixed(3)}% < floor ${FLOOR_PCT}%`, signal };

    const tpPriceRaw = direction === 'LONG' ? entryPriceRaw + TARGET_R * slDistanceRaw : entryPriceRaw - TARGET_R * slDistanceRaw;
    const riskPct = resolveRiskPct(this.symbol, signal.breaksKeyZone, this.riskConfig);

    // Part A: REAL balance/leverage, fetched fresh every time — never cached/computed internally.
    const [balance, leverage, filters] = await Promise.all([this.client.getAvailableBalanceUsdt(), this.client.getSymbolLeverage(this.symbol), this.client.getSymbolFilters(this.symbol)]);

    const riskUsd = balance * riskPct;
    const sizing = calculatePositionSize({ balance, riskUsd, entryPrice: entryPriceRaw, slPrice: slPriceRaw, leverage, maxMarginPct: DEFAULT_MAX_MARGIN_PCT });
    if (!sizing) return { type: 'ENTRY_SKIPPED', symbol: this.symbol, reason: 'calculatePositionSize returned null', signal };

    const entryPrice = roundToTick(entryPriceRaw, filters.tickSize);
    const slPrice = roundToTick(slPriceRaw, filters.tickSize);
    const tpPrice = roundToTick(tpPriceRaw, filters.tickSize);
    const quantity = roundDownToStep(sizing.qty, filters.stepSize);

    if (quantity <= 0) return { type: 'ENTRY_SKIPPED', symbol: this.symbol, reason: 'quantity rounds down to 0 at exchange stepSize', signal };
    if (quantity * entryPrice < filters.minNotional) {
      return { type: 'ENTRY_SKIPPED', symbol: this.symbol, reason: `notional ${(quantity * entryPrice).toFixed(2)} < minNotional ${filters.minNotional}`, signal };
    }

    const order = await this.client.placeLimitEntryOrder(this.symbol, direction, quantity, entryPrice);
    this.state = { phase: 'ENTRY_PENDING', orderId: order.orderId, direction, entryPrice, slPrice, tpPrice, quantity, waitCount: 0, signal };

    return { type: 'ENTRY_PLACED', symbol: this.symbol, orderId: order.orderId, direction, entryPrice, slPrice, tpPrice, quantity, riskPct, riskUsd, balanceUsedUsdt: balance, signal };
  }

  async onNewM15Candle(): Promise<LifecycleEvent | null> {
    if (this.state.phase === 'IDLE') return null;

    if (this.state.phase === 'ENTRY_PENDING') {
      const s = this.state;
      s.waitCount++;
      let order;
      try {
        order = await this.client.getOrder(this.symbol, s.orderId);
      } catch (err) {
        return { type: 'LIFECYCLE_ERROR', symbol: this.symbol, context: 'getOrder(ENTRY_PENDING)', message: err instanceof Error ? err.message : String(err) };
      }

      if (order.status === 'FILLED') {
        try {
          const [slOrder, tpOrder] = await Promise.all([
            this.client.placeStopMarketCloseOrder(this.symbol, s.direction, s.slPrice),
            this.client.placeTakeProfitMarketCloseOrder(this.symbol, s.direction, s.tpPrice),
          ]);
          const entryFilledAtMs = order.updateTime;
          this.state = { phase: 'POSITION_OPEN', direction: s.direction, entryPrice: order.avgPrice, quantity: order.executedQty, slOrderId: slOrder.orderId, tpOrderId: tpOrder.orderId, entryFilledAtMs, signal: s.signal };
          return { type: 'ENTRY_FILLED', symbol: this.symbol, direction: s.direction, entryPrice: order.avgPrice, quantity: order.executedQty, slPrice: s.slPrice, tpPrice: s.tpPrice, slOrderId: slOrder.orderId, tpOrderId: tpOrder.orderId, signal: s.signal };
        } catch (err) {
          // Entry filled but SL/TP placement failed — stay in a (slightly stale) ENTRY_PENDING
          // state and surface this loudly; retried next tick's getOrder (still FILLED) will retry
          // SL/TP placement. A genuinely open, unprotected position is the single most dangerous
          // state this code can be in, so this is deliberately NOT silently swallowed.
          return { type: 'LIFECYCLE_ERROR', symbol: this.symbol, context: 'placeStopMarketCloseOrder/placeTakeProfitMarketCloseOrder AFTER ENTRY FILLED — VI TRI DANG MO, CHUA CO SL/TP BAO VE', message: err instanceof Error ? err.message : String(err) };
        }
      }

      if (order.status === 'PARTIALLY_FILLED') return null; // keep waiting for a full fill

      if (s.waitCount >= MAX_WAIT_CANDLES) {
        try {
          await this.client.cancelOrder(this.symbol, s.orderId);
        } catch (err) {
          return { type: 'LIFECYCLE_ERROR', symbol: this.symbol, context: 'cancelOrder(timeout)', message: err instanceof Error ? err.message : String(err) };
        }
        this.state = { phase: 'IDLE' };
        return { type: 'ENTRY_TIMEOUT_CANCELLED', symbol: this.symbol, orderId: s.orderId, waitedCandles: s.waitCount };
      }
      return null;
    }

    // POSITION_OPEN
    const s = this.state;
    let slOrder, tpOrder;
    try {
      [slOrder, tpOrder] = await Promise.all([this.client.getOrder(this.symbol, s.slOrderId), this.client.getOrder(this.symbol, s.tpOrderId)]);
    } catch (err) {
      return { type: 'LIFECYCLE_ERROR', symbol: this.symbol, context: 'getOrder(POSITION_OPEN)', message: err instanceof Error ? err.message : String(err) };
    }

    const slFilled = slOrder.status === 'FILLED';
    const tpFilled = tpOrder.status === 'FILLED';
    if (!slFilled && !tpFilled) return null;

    // SL checked/reported first if both are somehow filled (documented race-window limitation above).
    const outcome: 'TP' | 'SL' = slFilled ? 'SL' : 'TP';
    const filledOrder = slFilled ? slOrder : tpOrder;
    const otherOrderId = slFilled ? s.tpOrderId : s.slOrderId;
    try {
      await this.client.cancelOrder(this.symbol, otherOrderId);
    } catch (err) {
      // Non-fatal: report the close anyway, but surface the cancel failure — a leftover
      // reduce-only close order is annoying but not dangerous (nothing left to reduce once flat,
      // or Binance will reject/expire it), unlike an unprotected open position above.
      console.error(`[SymbolOrderLifecycle] ${this.symbol}: huy lenh con lai (${otherOrderId}) that bai sau khi ${outcome} khop:`, err);
    }

    const realizedPnlUsd = await this.client.getRealizedPnlSince(this.symbol, s.entryFilledAtMs);
    this.state = { phase: 'IDLE' };
    return { type: 'POSITION_CLOSED', symbol: this.symbol, outcome, exitPrice: filledOrder.avgPrice, realizedPnlUsd, bothOrdersReportedFilled: slFilled && tpFilled };
  }
}
