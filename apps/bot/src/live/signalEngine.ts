import type { Candle } from '../noTradeZone/types.js';
import type { Direction } from '../entry/types.js';
import { checkNoTradeZone } from '../noTradeZone/noTradeZone.js';
import { classifyTrendH1 } from '../trend/trendH1.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../entry/fvg.js';
import { DEFAULT_FVG_STRATEGY_CONFIG } from '../entry/fvgStrategyConfig.js';
import { computeAtr } from '../noTradeZone/atr.js';
import { findKeyZones } from '../zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../regime/types.js';
import { resolveRiskPct, DEFAULT_RISK_CONFIG, type RiskConfig } from '../positionSizing/riskConfig.js';

// TICKET-RT-067 Part C: per-symbol signal state machine. Calls the EXACT SAME production pure
// functions every backtest script since RT-051 has used — classifyTrendH1, detectFvg,
// checkNoTradeZone, resolveRiskPct, plus their necessary supporting pieces computeAtr/findKeyZones
// (used identically by every one of those backtest scripts to feed breaksKeyZone into
// resolveRiskPct) — none of them modified, none reimplemented. This module only decides WHEN to
// call them, restructured for an event-driven live feed instead of an index-driven backtest loop.
//
// Deliberately OUT OF SCOPE for this monitoring-only ticket (RT-067 places no orders): no
// calculatePositionSize/admitPosition/exposureTracker — those govern real position sizing/
// portfolio margin, meaningless before any capital is actually at risk. "Virtual open" below only
// gates re-detection per symbol (mirrors checkpoint 1: one signal at a time per symbol, matching
// backtest semantics) — it does not simulate qty/notional/portfolio exposure.

const H1_EMA_PERIOD = 200;
const ATR_PERIOD = 14;
const KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};
const FLOOR_PCT = DEFAULT_FVG_STRATEGY_CONFIG.minSlPctFloor;
const MAX_WAIT_CANDLES = DEFAULT_FVG_STRATEGY_CONFIG.maxWaitCandles;
const TARGET_R = DEFAULT_FVG_STRATEGY_CONFIG.targetRMultiple;
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

// Buffer caps: bound memory/compute for a 24/7 process. 300 H1 candles gives EMA200 a 100-candle
// warmup margin (see binanceRestPollingFeed.ts's DEFAULT_LOOKBACK_CANDLES for the same reasoning);
// 300 M15 candles (~3 days) is far more than detectFvg (3 candles) or checkNoTradeZone's internal
// lookback (~20-35 candles) or maxWaitCandles (20) ever need.
const H1_BUFFER_CAP = 300;
const M15_BUFFER_CAP = 300;

export interface PendingFvg {
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  waitCount: number;
  breaksKeyZone: boolean;
}

export interface VirtualOpenTrade {
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  entryOpenTime: number;
}

export interface SignalEvent {
  type: 'SIGNAL';
  symbol: string;
  direction: Direction;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  riskPct: number;
  breaksKeyZone: boolean;
  entryOpenTime: number;
}

export interface VirtualCloseEvent {
  type: 'VIRTUAL_CLOSE';
  symbol: string;
  outcome: 'TP' | 'SL';
  entryPrice: number;
  exitPrice: number;
}

export type SignalEngineEvent = SignalEvent | VirtualCloseEvent;

export class SymbolSignalEngine {
  private h1Buffer: Candle[] = [];
  private m15Buffer: Candle[] = [];
  private pending: PendingFvg | null = null;
  private open: VirtualOpenTrade | null = null;
  private cachedZonesForH1Length = -1;
  private cachedZones: ReturnType<typeof findKeyZones> = [];

  constructor(
    public readonly symbol: string,
    private readonly riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
  ) {}

  onNewH1Candle(candle: Candle): void {
    this.pushH1(candle);
  }

  private pushH1(candle: Candle): void {
    this.h1Buffer.push(candle);
    this.trimH1();
  }
  private trimH1(): void {
    if (this.h1Buffer.length > H1_BUFFER_CAP) this.h1Buffer.splice(0, this.h1Buffer.length - H1_BUFFER_CAP);
  }
  private trimM15(): void {
    if (this.m15Buffer.length > M15_BUFFER_CAP) this.m15Buffer.splice(0, this.m15Buffer.length - M15_BUFFER_CAP);
  }

  /**
   * Processes one new CLOSED M15 candle through the same detection/pending/open state machine
   * every backtest script in this repo has used since RT-051 — returns an event when something
   * notification-worthy happens (a fresh signal, or a virtual position resolving), null otherwise.
   * H1 candles must be pushed via onNewH1Candle BEFORE the M15 candle at the same or later
   * wall-clock boundary, so trend classification always sees up-to-date H1 data (liveRunner
   * enforces this ordering — see its own file comment). Used for BOTH startup catch-up and live
   * polling — the caller decides whether to notify on the returned event (liveRunner suppresses
   * Telegram sends for catch-up-derived events, since notifying about a signal that already fully
   * resolved during downtime would just be noise; state is still updated correctly either way, so
   * an ongoing pending/open situation survives a restart intact).
   */
  onNewM15Candle(candle: Candle, nowMs: number): SignalEngineEvent | null {
    this.m15Buffer.push(candle);
    this.trimM15();

    if (this.h1Buffer.length === 0) return null; // no H1 history yet, nothing to do

    const m15Window = this.m15Buffer;
    const h1Window = this.h1Buffer;
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });

    if (this.open) {
      const o = this.open;
      const slTouched = o.direction === 'LONG' ? candle.low <= o.slPrice : candle.high >= o.slPrice;
      const tpTouched = o.direction === 'LONG' ? candle.high >= o.tpPrice : candle.low <= o.tpPrice;
      if (slTouched || tpTouched) {
        const outcome: 'TP' | 'SL' = slTouched ? 'SL' : 'TP';
        const exitPrice = outcome === 'TP' ? o.tpPrice : o.slPrice;
        this.open = null;
        return { type: 'VIRTUAL_CLOSE', symbol: this.symbol, outcome, entryPrice: o.entryPrice, exitPrice };
      }
      return null; // still open, nothing else to evaluate this candle
    }

    if (this.pending) {
      this.pending.waitCount++;
      const touchedGap = candle.low <= this.pending.gapHigh && candle.high >= this.pending.gapLow;

      if (touchedGap && !ntz.blocked) {
        const direction = this.pending.direction;
        const entryPrice = direction === 'LONG' ? this.pending.gapLow : this.pending.gapHigh;
        const slPrice = this.pending.invalidationPrice;
        const slDistance = Math.abs(entryPrice - slPrice);
        const breaksKeyZone = this.pending.breaksKeyZone;
        this.pending = null;

        if (slDistance > 0) {
          const slPct = (slDistance / entryPrice) * 100;
          if (slPct >= FLOOR_PCT) {
            const tpPrice = direction === 'LONG' ? entryPrice + TARGET_R * slDistance : entryPrice - TARGET_R * slDistance;
            const riskPct = resolveRiskPct(this.symbol, breaksKeyZone, this.riskConfig);
            this.open = { direction, entryPrice, slPrice, tpPrice, entryOpenTime: candle.openTime };
            return {
              type: 'SIGNAL',
              symbol: this.symbol,
              direction,
              entryPrice,
              slPrice,
              tpPrice,
              riskPct,
              breaksKeyZone,
              entryOpenTime: candle.openTime,
            };
          }
        }
        return null;
      } else if (this.pending.waitCount >= MAX_WAIT_CANDLES) {
        this.pending = null;
      }
      return null;
    }

    if (ntz.blocked) return null;

    const trend = classifyTrendH1(h1Window, H1_EMA_PERIOD);
    if (trend === null) return null;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    if (m15Window.length < 3) return null;
    const n = m15Window.length;
    const fvg = detectFvg(m15Window[n - 3], m15Window[n - 2], m15Window[n - 1], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
    if (fvg.isFvg && fvg.direction === trendDirection && fvg.gapLow !== undefined && fvg.gapHigh !== undefined && fvg.invalidationPrice !== undefined) {
      if (h1Window.length !== this.cachedZonesForH1Length) {
        this.cachedZonesForH1Length = h1Window.length;
        const atrValues = computeAtr(h1Window, ATR_PERIOD);
        const atrH1 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
        this.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, KEY_ZONE_CONFIG) : [];
      }
      const gapLow = fvg.gapLow;
      const gapHigh = fvg.gapHigh;
      const breaksKeyZone = this.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);
      this.pending = { direction: fvg.direction, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, invalidationPrice: fvg.invalidationPrice, waitCount: 0, breaksKeyZone };
    }
    return null;
  }

  /** For diagnostics/tests only — not used for detection decisions. */
  getDebugState() {
    return { h1Count: this.h1Buffer.length, m15Count: this.m15Buffer.length, pending: this.pending, open: this.open };
  }
}
