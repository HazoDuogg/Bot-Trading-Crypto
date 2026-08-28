import type { Candle } from '../noTradeZone/types.js';
import type { Direction } from '../entry/types.js';
import { checkNoTradeZone } from '../noTradeZone/noTradeZone.js';
import { classifyTrendH1 } from '../trend/trendH1.js';
import { createEmaTracker } from '../regime/ema.js';
import { createAtrTracker } from '../noTradeZone/atr.js';
import { detectFvg, DEFAULT_FVG_CONFIG } from '../entry/fvg.js';
import { computeAtr } from '../noTradeZone/atr.js';
import { findKeyZones } from '../zones/keyZones.js';
import { DEFAULT_REGIME_CONFIG } from '../regime/types.js';

// TICKET-RT-067 Part C, RESTRUCTURED by TICKET-RT-068 Part B: this module is now PURE DETECTION
// only — it decides "does a fresh FVG signal exist right now", nothing about order execution. The
// RT-067 version also simulated fills (candle touches gap -> treat as filled) and tracked a
// simulated "open" position waiting for a simulated SL/TP touch; TICKET-RT-068 replaces ALL of
// that with real order placement/tracking, which belongs in the execution layer
// (orderLifecycle.ts) since it depends on real exchange state (order status, real elapsed time,
// real fills) that this pure module has no way to know about — exactly what the ticket asked for:
// "tach bach: phan phat hien (giu nguyen logic thuan tuy hien co) va phan thuc thi".
//
// Still calls the exact same production pure functions as every prior ticket: classifyTrendH1,
// detectFvg, checkNoTradeZone — plus their necessary supporting pieces computeAtr/findKeyZones
// (used identically by every backtest script since RT-051 to feed breaksKeyZone) — none modified,
// none reimplemented.
//
// TICKET-RT-068 Part C: also computes the 4 "regime" fields (trend, trendAgeH1Candles,
// atrPercentileH1, distanceFromEma200H1Pct — confirmed with Vinh Tam over chat: these 4 describe
// market REGIME specifically, as opposed to this-FVG's-own entry reason (breaksKeyZone/
// keyZoneDistancePct) or M15-level momentum) attached to each detected signal for display. Same
// incremental-EMA/ATR-tracker approach as rt065FeatureAuditThreeYear.ts (RT-065, frozen — logic
// COPIED here per the ticket's explicit instruction, that file itself not imported/modified) —
// using RT-065 Part B's createEmaTracker/createAtrTracker (production, src/regime/ema.ts and
// src/noTradeZone/atr.ts, unmodified) for O(1)-per-candle tracking instead of recomputing from
// scratch, since this engine runs 24/7 and must stay cheap over a long-running H1 buffer.

const H1_EMA_PERIOD = 200;
const ATR_PERIOD = 14;
const ATR_PERCENTILE_WINDOW = 100;
const KEY_ZONE_CONFIG = {
  swingPivotWidth: DEFAULT_REGIME_CONFIG.swingPivotWidth,
  clusterToleranceAtrMultiplier: 0.5,
  minTouches: 2,
  maxZoneAgeCandles: 500,
};
const MIN_CANDLE2_BODY_RATIO = DEFAULT_FVG_CONFIG.minCandle2BodyRatio;

// Buffer caps: bound memory/compute for a 24/7 process (same reasoning as RT-067 — 300 H1 gives
// EMA200 a 100-candle warmup margin; 300 M15 is far more than detectFvg/checkNoTradeZone ever need).
const H1_BUFFER_CAP = 300;
const M15_BUFFER_CAP = 300;

export interface RegimeSnapshot {
  trend: 'UPTREND' | 'DOWNTREND';
  trendAgeH1Candles: number;
  atrPercentileH1: number;
  distanceFromEma200H1Pct: number;
}

export interface DetectedFvgSignal {
  type: 'FVG_DETECTED';
  symbol: string;
  direction: Direction;
  gapLow: number;
  gapHigh: number;
  invalidationPrice: number;
  breaksKeyZone: boolean;
  detectedAtOpenTime: number;
  regime: RegimeSnapshot;
  atrH1Pct: number; // RT-077: Soft Veto Option-C feature, same definition as rt076FeatureAuditDoge.ts
  keyZoneDistancePct: number | null;
}

export class SymbolSignalEngine {
  private h1Buffer: Candle[] = [];
  private m15Buffer: Candle[] = [];
  private cachedZonesForH1Length = -1;
  private cachedZones: ReturnType<typeof findKeyZones> = [];

  private readonly emaTracker = createEmaTracker(H1_EMA_PERIOD);
  private readonly atrTracker = createAtrTracker(ATR_PERIOD);
  private currentEma: number | null = null;
  private currentAtr: number | null = null;
  private trend: 'UPTREND' | 'DOWNTREND' | null = null;
  private trendChangeH1Cursor = 0;
  private h1CandleCount = 0;
  private atrHistory: number[] = [];

  constructor(public readonly symbol: string) {}

  onNewH1Candle(candle: Candle): void {
    this.h1Buffer.push(candle);
    if (this.h1Buffer.length > H1_BUFFER_CAP) this.h1Buffer.splice(0, this.h1Buffer.length - H1_BUFFER_CAP);

    this.currentEma = this.emaTracker.next(candle.close);
    this.currentAtr = this.atrTracker.next(candle);
    if (this.currentAtr !== null) {
      this.atrHistory.push(this.currentAtr);
      if (this.atrHistory.length > ATR_PERCENTILE_WINDOW) this.atrHistory.shift();
    }
    this.h1CandleCount++;
    if (this.currentEma !== null) {
      const newTrend: 'UPTREND' | 'DOWNTREND' = candle.close >= this.currentEma ? 'UPTREND' : 'DOWNTREND';
      if (newTrend !== this.trend) {
        this.trend = newTrend;
        this.trendChangeH1Cursor = this.h1CandleCount;
      }
    }
  }

  /**
   * Call once per new closed M15 candle. `freeToDetect` = true when the execution layer has no
   * active order/position for this symbol (mirrors checkpoint 1: one trade at a time per symbol —
   * that gating now lives in the execution layer, since it depends on real order/position state
   * this pure module has no way to observe). Returns a detected signal or null.
   */
  checkForNewSignal(candle: Candle, freeToDetect: boolean): DetectedFvgSignal | null {
    this.m15Buffer.push(candle);
    if (this.m15Buffer.length > M15_BUFFER_CAP) this.m15Buffer.splice(0, this.m15Buffer.length - M15_BUFFER_CAP);

    if (!freeToDetect) return null;
    if (this.h1Buffer.length === 0) return null;

    const h1Window = this.h1Buffer;
    const m15Window = this.m15Buffer;
    const closePrice = h1Window[h1Window.length - 1].close;

    const ntz = checkNoTradeZone({
      nowMs: candle.openTime + 15 * 60 * 1000,
      bid: closePrice,
      ask: closePrice,
      h1Candles: h1Window,
      m15Candles: m15Window,
    });
    if (ntz.blocked) return null;

    const trend = classifyTrendH1(h1Window, H1_EMA_PERIOD);
    if (trend === null) return null;
    const trendDirection: Direction = trend === 'UPTREND' ? 'LONG' : 'SHORT';

    if (m15Window.length < 3) return null;
    const n = m15Window.length;
    const fvg = detectFvg(m15Window[n - 3], m15Window[n - 2], m15Window[n - 1], { minCandle2BodyRatio: MIN_CANDLE2_BODY_RATIO });
    if (!fvg.isFvg || fvg.direction !== trendDirection || fvg.gapLow === undefined || fvg.gapHigh === undefined || fvg.invalidationPrice === undefined) {
      return null;
    }

    if (h1Window.length !== this.cachedZonesForH1Length) {
      this.cachedZonesForH1Length = h1Window.length;
      const atrValues = computeAtr(h1Window, ATR_PERIOD);
      const atrH1 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
      this.cachedZones = atrH1 > 0 ? findKeyZones(h1Window, atrH1, KEY_ZONE_CONFIG) : [];
    }
    const gapLow = fvg.gapLow;
    const gapHigh = fvg.gapHigh;
    const breaksKeyZone = this.cachedZones.some((z) => z.price >= gapLow && z.price <= gapHigh);
    const entryPrice = fvg.direction === 'LONG' ? gapLow : gapHigh;
    const keyZoneDistancePct = this.cachedZones.length > 0 ? Math.min(...this.cachedZones.map((z) => (Math.abs(z.price - entryPrice) / entryPrice) * 100)) : null;
    const atrH1Pct = this.currentAtr !== null ? (this.currentAtr / closePrice) * 100 : NaN;

    const atrPercentileH1 = this.currentAtr !== null && this.atrHistory.length > 0 ? (this.atrHistory.filter((v) => v <= this.currentAtr!).length / this.atrHistory.length) * 100 : NaN;
    const distanceFromEma200H1Pct = this.currentEma !== null ? ((closePrice - this.currentEma) / this.currentEma) * 100 : NaN;

    return {
      type: 'FVG_DETECTED',
      symbol: this.symbol,
      direction: fvg.direction,
      gapLow,
      gapHigh,
      invalidationPrice: fvg.invalidationPrice,
      breaksKeyZone,
      detectedAtOpenTime: candle.openTime,
      atrH1Pct,
      keyZoneDistancePct,
      regime: {
        trend,
        trendAgeH1Candles: this.h1CandleCount - this.trendChangeH1Cursor,
        atrPercentileH1,
        distanceFromEma200H1Pct,
      },
    };
  }

  /** For diagnostics/tests only — not used for detection decisions. */
  getDebugState() {
    return { h1Count: this.h1Buffer.length, m15Count: this.m15Buffer.length, trend: this.trend, currentEma: this.currentEma, currentAtr: this.currentAtr };
  }
}
